export enum SubmissionStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  TIMEOUT = 'TIMEOUT'
}

// Map of allowed status transitions
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
    throw new Error(`Invalid status transition: ${from} -> ${to}`);
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
  executionTimeMs?: number;
  memoryUsedBytes?: number;
}

// Dead Letter Queue payload — carries full failure history
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

// Queue key constants — single source of truth across all services
export const QUEUE_KEYS = {
  PENDING: 'jobs:queue:pending',
  PROCESSING: (workerId: string) => `jobs:queue:processing:${workerId}`,
  DEAD_LETTER: 'jobs:queue:dead-letter',
  HEARTBEAT: (workerId: string) => `worker:heartbeat:${workerId}`,
  STREAM: (jobId: string) => `jobs:streams:${jobId}`,
} as const;

export const MAX_RETRY_COUNT = 3;
export const HEARTBEAT_TTL_SECONDS = 15;
export const HEARTBEAT_INTERVAL_MS = 5_000;
