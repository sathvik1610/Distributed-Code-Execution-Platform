import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '@code-execution/logger';
import { redisPub } from './redis.js';
import { StreamChunk } from '@code-execution/contracts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the 'temp' folder dynamically relative to the module root (goes up from services/execution-worker/dist or src)
const TEMP_DIR = process.env.TEMP_DIR || path.resolve(__dirname, '../../../temp');
const MAX_OUTPUT_SIZE = 64 * 1024; // 64 KB limit to prevent OOM on worker

interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  oomKilled: boolean;
  executionTimeMs: number;
}

export async function runInSandbox(
  jobId: string,
  code: string,
  language: 'python' | 'javascript',
  timeoutMs = 5000
): Promise<SandboxResult> {
  // Ensure temp dir exists
  await fs.mkdir(TEMP_DIR, { recursive: true });

  const ext = language === 'python' ? 'py' : 'js';
  const fileName = `sub_${jobId}.${ext}`;
  const hostFilePath = path.join(TEMP_DIR, fileName);

  // Write user code to temporary file
  await fs.writeFile(hostFilePath, code, 'utf-8');

  const containerName = `sub_${jobId}`;
  const imageName = `runner-${language}`;

  // Assemble docker run arguments
  const dockerArgs = [
    'run',
    '--rm',
    '--name', containerName,
    '--network', 'none',
    '--memory', '128m',
    '--memory-swap', '128m',
    '--pids-limit', '50',
    '--read-only',
    '--user', 'runner',
    '--tmpfs', '/tmp',
    '-v', `${hostFilePath}:/app/code.${ext}:ro`,
    imageName
  ];

  logger.info({ jobId, containerName }, 'Spawning Docker sandbox container');

  const startTime = performance.now();
  let stdoutAccumulator = '';
  let stderrAccumulator = '';
  let timedOut = false;
  let oomKilled = false;

  const child = spawn('docker', dockerArgs);

  // Setup timeout timer
  const timeoutTimer = setTimeout(() => {
    logger.warn({ jobId, containerName }, 'Execution timed out. Killing container...');
    timedOut = true;
    // Kill the docker container via docker CLI to ensure it terminates
    spawn('docker', ['kill', containerName]);
  }, timeoutMs);

  // Publish log chunks to Redis pub/sub
  const publishChunk = (type: 'stdout' | 'stderr', data: string) => {
    const chunk: StreamChunk = {
      type,
      data,
      timestamp: Date.now()
    };
    redisPub.publish(`jobs:streams:${jobId}`, JSON.stringify(chunk));
  };

  child.stdout.on('data', (data: Buffer) => {
    const text = data.toString('utf-8');
    publishChunk('stdout', text);
    if (stdoutAccumulator.length < MAX_OUTPUT_SIZE) {
      stdoutAccumulator += text;
    }
  });

  child.stderr.on('data', (data: Buffer) => {
    const text = data.toString('utf-8');
    publishChunk('stderr', text);
    if (stderrAccumulator.length < MAX_OUTPUT_SIZE) {
      stderrAccumulator += text;
    }
  });

  return new Promise<SandboxResult>((resolve, reject) => {
    child.on('close', async (code) => {
      clearTimeout(timeoutTimer);
      const endTime = performance.now();
      const executionTimeMs = Math.round(endTime - startTime);

      // Clean up the temp file
      try {
        await fs.unlink(hostFilePath);
      } catch (err) {
        logger.error(err, `Failed to delete temp file ${hostFilePath}`);
      }

      // Check if container was killed due to Out of Memory (OOM)
      // Exit code 137 usually indicates the process was terminated by SIGKILL (e.g. OOM killer)
      if (code === 137 && !timedOut) {
        oomKilled = true;
      }

      resolve({
        exitCode: code,
        stdout: stdoutAccumulator,
        stderr: stderrAccumulator,
        timedOut,
        oomKilled,
        executionTimeMs
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      reject(err);
    });
  });
}
