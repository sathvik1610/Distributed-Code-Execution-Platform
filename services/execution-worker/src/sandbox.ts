import { spawn } from 'child_process';
import { logger } from '@code-execution/logger';
import { redisPub } from './redis.js';
import { StreamChunk } from '@code-execution/contracts';

// Hard accumulated output cap for DB persistence (64 KB)
const MAX_OUTPUT_SIZE = 64 * 1024;

// Hard pub/sub byte cap — container is killed if total output exceeds 1 MB.
// Prevents infinite-output attacks from flooding Redis pub/sub.
const MAX_PUBSUB_BYTES = 1 * 1024 * 1024;

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  oomKilled: boolean;
  outputCapReached: boolean;
  executionTimeMs: number;
  memoryUsedBytes: number | null;
}

export async function runInSandbox(
  jobId: string,
  code: string,
  language: 'python' | 'javascript',
  timeoutMs = 5000
): Promise<SandboxResult> {

  const containerName = 'sub_' + jobId;
  const imageName = 'runner-' + language;

  const dockerArgs = [
    'run',
    '-i', // Keep stdin open to stream user code string
    '--rm',
    '--name', containerName,
    '--network', 'none',
    '--memory', '128m',
    '--memory-swap', '128m',
    '--pids-limit', '50',
    '--read-only',
    '--tmpfs', '/tmp:rw,size=32m,mode=1777',
    '--user', 'runner',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    imageName
  ];

  logger.info({ jobId, containerName, language }, 'Spawning Docker sandbox container');

  const startTime = performance.now();
  let stdoutAccumulator = '';
  let stderrAccumulator = '';
  let timedOut = false;
  let oomKilled = false;
  let totalPublishedBytes = 0;
  let outputCapReached = false;
  let memoryUsedBytes: number | null = null;

  const child = spawn('docker', dockerArgs);

  // Pipe raw user code string over network/stdin stream to the secure container
  child.stdin.write(code);
  child.stdin.end();

  const timeoutTimer = setTimeout(() => {
    logger.warn({ jobId, containerName }, 'Execution timed out — killing container');
    timedOut = true;
    spawn('docker', ['kill', containerName]);
  }, timeoutMs);

  const publishChunk = (type: 'stdout' | 'stderr' | 'system', data: string) => {
    const chunk: StreamChunk = { type, data, timestamp: Date.now() };
    redisPub.publish('jobs:streams:' + jobId, JSON.stringify(chunk));
  };

  const handleOutput = (type: 'stdout' | 'stderr', data: Buffer, accumulator: string): string => {
    if (outputCapReached) return accumulator;
    let text = data.toString('utf-8');

    // Parse Linux Cgroup memory peak usage token if present in standard streams
    const memMatch = text.match(/___MEM_PEAK___:\s*(\d+)/);
    if (memMatch) {
      memoryUsedBytes = parseInt(memMatch[1], 10);
      text = text.replace(/___MEM_PEAK___:\s*\d+\r?\n?/, '');
    }

    if (text.length === 0) {
      return accumulator;
    }

    totalPublishedBytes += Buffer.byteLength(text, 'utf-8');
    if (totalPublishedBytes > MAX_PUBSUB_BYTES) {
      outputCapReached = true;
      logger.warn({ jobId, totalPublishedBytes }, 'Output cap exceeded (1 MB) — killing container');
      publishChunk('system', 'OUTPUT_LIMIT_EXCEEDED: container killed after exceeding 1 MB output cap');
      spawn('docker', ['kill', containerName]);
      return accumulator;
    }
    publishChunk(type, text);
    if (accumulator.length < MAX_OUTPUT_SIZE) return accumulator + text;
    return accumulator;
  };

  child.stdout.on('data', (data: Buffer) => { stdoutAccumulator = handleOutput('stdout', data, stdoutAccumulator); });
  child.stderr.on('data', (data: Buffer) => { stderrAccumulator = handleOutput('stderr', data, stderrAccumulator); });

  return new Promise<SandboxResult>((resolve, reject) => {
    child.on('close', async (code) => {
      clearTimeout(timeoutTimer);
      const endTime = performance.now();
      const executionTimeMs = Math.round(endTime - startTime);

      if (code === 137 && !timedOut) oomKilled = true;

      resolve({ exitCode: code, stdout: stdoutAccumulator, stderr: stderrAccumulator,
                 timedOut, oomKilled, outputCapReached, executionTimeMs, memoryUsedBytes });
    });

    child.on('error', (err) => { clearTimeout(timeoutTimer); reject(err); });
  });
}
