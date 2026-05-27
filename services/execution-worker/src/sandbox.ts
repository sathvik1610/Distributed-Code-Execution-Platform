import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '@code-execution/logger';
import { redisPub } from './redis.js';
import { StreamChunk } from '@code-execution/contracts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = process.env.TEMP_DIR || path.resolve(__dirname, '../../../temp');

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
  await fs.mkdir(TEMP_DIR, { recursive: true });

  const ext = language === 'python' ? 'py' : 'js';
  const fileName = 'sub_' + jobId + '.' + ext;
  const hostFilePath = path.join(TEMP_DIR, fileName);

  await fs.writeFile(hostFilePath, code, 'utf-8');

  const containerName = 'sub_' + jobId;
  const imageName = 'runner-' + language;

  const dockerArgs = [
    'run',
    '--rm',
    '--name', containerName,
    '--network', 'none',
    '--memory', '128m',
    '--memory-swap', '128m',
    '--pids-limit', '50',
    '--read-only',
    '--tmpfs', '/tmp:rw,size=32m',
    '--user', 'runner',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '-v', hostFilePath + ':/app/code.' + ext + ':ro',
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

  const child = spawn('docker', dockerArgs);

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
    const text = data.toString('utf-8');
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

      // Read peak memory usage via docker stats immediately after container stops
      let memoryUsedBytes: number | null = null;
      try {
        memoryUsedBytes = await new Promise<number | null>((res) => {
          const statsProc = spawn('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', containerName]);
          let raw = '';
          statsProc.stdout.on('data', (d: Buffer) => { raw += d.toString(); });
          statsProc.on('close', () => {
            const match = raw.trim().match(/^([\d.]+)(\w+)/i);
            if (!match) { res(null); return; }
            const value = parseFloat(match[1]);
            const unit = match[2].toLowerCase();
            if (unit.startsWith('ki')) res(Math.round(value * 1024));
            else if (unit.startsWith('mi')) res(Math.round(value * 1024 * 1024));
            else if (unit.startsWith('gi')) res(Math.round(value * 1024 * 1024 * 1024));
            else res(Math.round(value));
          });
          statsProc.on('error', () => res(null));
        });
      } catch { memoryUsedBytes = null; }

      try { await fs.unlink(hostFilePath); }
      catch (err) { logger.error(err, 'Failed to delete temp file'); }

      if (code === 137 && !timedOut) oomKilled = true;

      resolve({ exitCode: code, stdout: stdoutAccumulator, stderr: stderrAccumulator,
                 timedOut, oomKilled, outputCapReached, executionTimeMs, memoryUsedBytes });
    });

    child.on('error', (err) => { clearTimeout(timeoutTimer); reject(err); });
  });
}
