export enum SubmissionStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  TIMEOUT = 'TIMEOUT'
}

export const TERMINAL_STATUSES = new Set<SubmissionStatus>([
  SubmissionStatus.COMPLETED,
  SubmissionStatus.FAILED,
  SubmissionStatus.TIMEOUT
]);

export function isTerminalStatus(status: SubmissionStatus | string | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL_STATUSES.has(status as SubmissionStatus);
}

export enum ErrorCategory {
  SYNTAX_ERROR  = 'SYNTAX_ERROR',
  RUNTIME_ERROR = 'RUNTIME_ERROR',
  OOM           = 'OOM',
  TIMEOUT       = 'TIMEOUT',
  WORKER_CRASH  = 'WORKER_CRASH',
  UNKNOWN       = 'UNKNOWN'
}

const ALLOWED_TRANSITIONS: Record<SubmissionStatus, Set<SubmissionStatus>> = {
  [SubmissionStatus.PENDING]: new Set([SubmissionStatus.RUNNING]),
  [SubmissionStatus.RUNNING]: new Set([
    SubmissionStatus.COMPLETED,
    SubmissionStatus.FAILED,
    SubmissionStatus.TIMEOUT
  ]),
  [SubmissionStatus.COMPLETED]: new Set(),
  [SubmissionStatus.FAILED]: new Set(),
  [SubmissionStatus.TIMEOUT]: new Set()
};

export function isValidTransition(from: SubmissionStatus, to: SubmissionStatus): boolean {
  const transitions = ALLOWED_TRANSITIONS[from];
  return transitions ? transitions.has(to) : false;
}

export function validateTransition(from: SubmissionStatus, to: SubmissionStatus): void {
  if (!isValidTransition(from, to)) {
    throw new Error('Invalid status transition: ' + from + ' -> ' + to);
  }
}

export interface QueuePayload {
  jobId: string;
  userId?: string;
  code: string;
  language: 'python' | 'javascript';
  retryCount: number;
  submittedAt: string;
}

export interface StreamChunk {
  type: 'stdout' | 'stderr' | 'system';
  data: string;
  timestamp: number;
}

export interface SubmissionResult {
  jobId: string;
  status: SubmissionStatus;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
  errorCategory?: ErrorCategory | null;
  executionTimeMs?: number;
  memoryUsedBytes?: number | null;
  outputTruncated?: boolean;
  streamOutputLimitExceeded?: boolean;
}

export interface DLQPayload {
  jobId: string;
  userId?: string;
  code: string;
  language: 'python' | 'javascript';
  retryCount: number;
  submittedAt: string;
  failedAt: string;
  reason: string;
}

function makeProcessingKey(workerId: string): string { return 'jobs:queue:processing:' + workerId; }
function makeHeartbeatKey(workerId: string): string { return 'worker:heartbeat:' + workerId; }
function makeStreamKey(jobId: string): string { return 'jobs:streams:' + jobId; }

export const QUEUE_KEYS = {
  PENDING: 'jobs:queue:pending',
  PROCESSING: makeProcessingKey,
  DEAD_LETTER: 'jobs:queue:dead-letter',
  HEARTBEAT: makeHeartbeatKey,
  STREAM: makeStreamKey,
} as const;

export const MAX_RETRY_COUNT = 3;
export const HEARTBEAT_TTL_SECONDS = 15;
export const HEARTBEAT_INTERVAL_MS = 5000;
export const MAX_CODE_LENGTH = 65536;
export const MAX_RESULT_OUTPUT_BYTES = 64 * 1024;
export const MAX_STREAM_OUTPUT_BYTES = 1024 * 1024;
export const MAX_STREAM_CHUNK_BYTES = 16 * 1024;
export const STREAM_RETENTION_COUNT = 1000;
export const STREAM_TTL_SECONDS = 60 * 60;
