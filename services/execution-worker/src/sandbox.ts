import { spawn } from 'child_process';
import { logger } from '@code-execution/logger';
import { dockerSpawnFailures } from '@code-execution/metrics';
import { redis, redisPub } from './redis.js';
import {
  StreamChunk,
  QUEUE_KEYS,
  MAX_RESULT_OUTPUT_BYTES,
  MAX_STREAM_OUTPUT_BYTES,
  MAX_STREAM_CHUNK_BYTES,
  STREAM_RETENTION_COUNT
} from '@code-execution/contracts';

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  oomKilled: boolean;
  outputTruncated: boolean;
  streamOutputLimitExceeded: boolean;
  executionTimeMs: number;
  memoryUsedBytes: number | null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

function appendWithinCap(current: string, next: string): { value: string; truncated: boolean } {
  const currentBytes = byteLength(current);
  if (currentBytes >= MAX_RESULT_OUTPUT_BYTES) {
    return { value: current, truncated: next.length > 0 };
  }

  const remaining = MAX_RESULT_OUTPUT_BYTES - currentBytes;
  const nextBytes = Buffer.from(next, 'utf-8');
  if (nextBytes.length <= remaining) {
    return { value: current + next, truncated: false };
  }

  return {
    value: current + nextBytes.subarray(0, remaining).toString('utf-8'),
    truncated: true
  };
}

function runDockerCommand(args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('docker', args);
    child.on('error', (err) => {
      logger.warn({ err, args }, 'Failed to start docker helper command');
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
}

async function removeStaleContainer(containerName: string, jobId: string): Promise<void> {
  const code = await runDockerCommand(['rm', '-f', containerName]);
  if (code === 0) {
    logger.warn({ jobId, containerName }, 'Removed stale sandbox container before retry');
  } else if (code !== null && code !== 1) {
    logger.warn({ jobId, containerName, code }, 'docker rm -f returned non-standard exit code before sandbox start');
  }
}

function splitForStream(text: string): string[] {
  if (byteLength(text) <= MAX_STREAM_CHUNK_BYTES) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let end = Math.min(remaining.length, MAX_STREAM_CHUNK_BYTES);
    while (end > 1 && byteLength(remaining.slice(0, end)) > MAX_STREAM_CHUNK_BYTES) {
      end = Math.floor(end * 0.9);
    }
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return chunks;
}

export async function runInSandbox(
  jobId: string,
  code: string,
  language: 'python' | 'javascript',
  timeoutMs = 5000
): Promise<SandboxResult> {

  const containerName = 'sub_' + jobId;
  const imageName = 'runner-' + language;
  const streamKey = QUEUE_KEYS.STREAM(jobId);

  const dockerArgs = [
    'run',
    '-i',
    '--rm',
    '--name', containerName,
    '--network', 'none',
    '--cpus', '1',
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
  let totalStreamBytes = 0;
  let outputTruncated = false;
  let streamOutputLimitExceeded = false;
  let memoryUsedBytes: number | null = null;
  let publishQueue = Promise.resolve();

  const publishChunk = (type: 'stdout' | 'stderr' | 'system', data: string) => {
    const chunk: StreamChunk = { type, data, timestamp: Date.now() };
    const serialized = JSON.stringify(chunk);
    publishQueue = publishQueue
      .then(async () => {
        await redis.xadd(streamKey, 'MAXLEN', '~', STREAM_RETENTION_COUNT, '*', 'payload', serialized);
        await redisPub.publish(streamKey, serialized);
      })
      .catch((err) => {
        logger.error({ err, jobId }, 'Failed to persist or publish stream chunk');
      });
  };

  const killContainer = (reason: string) => {
    logger.warn({ jobId, containerName, reason }, 'Killing sandbox container');
    const killer = spawn('docker', ['kill', containerName]);
    killer.on('error', (err) => logger.error({ err, jobId, containerName }, 'Failed to start docker kill'));
    killer.on('close', (code) => {
      if (code !== 0) logger.warn({ jobId, containerName, code }, 'docker kill exited non-zero');
    });
  };

  await removeStaleContainer(containerName, jobId);

  const child = spawn('docker', dockerArgs);

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    killContainer('timeout');
  }, timeoutMs);

  const handleOutput = (type: 'stdout' | 'stderr', data: Buffer, accumulator: string): string => {
    if (streamOutputLimitExceeded) return accumulator;
    let text = data.toString('utf-8');

    const memMatch = text.match(/___MEM_PEAK___:\s*(\d+)/);
    if (memMatch) {
      memoryUsedBytes = parseInt(memMatch[1], 10);
      text = text.replace(/___MEM_PEAK___:\s*\d+\r?\n?/, '');
    }

    if (text.length === 0) return accumulator;

    const incomingBytes = byteLength(text);
    if (totalStreamBytes + incomingBytes > MAX_STREAM_OUTPUT_BYTES) {
      streamOutputLimitExceeded = true;
      logger.warn({ jobId, totalStreamBytes: totalStreamBytes + incomingBytes }, 'Stream output cap exceeded');
      publishChunk('system', 'OUTPUT_LIMIT_EXCEEDED: container killed after exceeding 1 MB stream output cap');
      killContainer('stream-output-limit');
      return accumulator;
    }

    totalStreamBytes += incomingBytes;
    for (const chunk of splitForStream(text)) {
      publishChunk(type, chunk);
    }

    const capped = appendWithinCap(accumulator, text);
    if (capped.truncated) outputTruncated = true;
    return capped.value;
  };

  child.stdout.on('data', (data: Buffer) => { stdoutAccumulator = handleOutput('stdout', data, stdoutAccumulator); });
  child.stderr.on('data', (data: Buffer) => { stderrAccumulator = handleOutput('stderr', data, stderrAccumulator); });

  return new Promise<SandboxResult>((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      dockerSpawnFailures.inc();
      reject(err);
    });

    child.stdin.on('error', (err) => {
      logger.warn({ err, jobId }, 'Sandbox stdin error');
    });

    try {
      child.stdin.write(code);
      child.stdin.end();
    } catch (err) {
      clearTimeout(timeoutTimer);
      dockerSpawnFailures.inc();
      reject(err);
      return;
    }

    child.on('close', async (code) => {
      clearTimeout(timeoutTimer);
      const endTime = performance.now();
      const executionTimeMs = Math.round(endTime - startTime);

      if (code === 137 && !timedOut && !streamOutputLimitExceeded) oomKilled = true;

      await publishQueue;
      resolve({
        exitCode: code,
        stdout: stdoutAccumulator,
        stderr: stderrAccumulator,
        timedOut,
        oomKilled,
        outputTruncated,
        streamOutputLimitExceeded,
        executionTimeMs,
        memoryUsedBytes
      });
    });
  });
}