import type { QueuePayload, SubmissionStatus, ErrorCategory } from '@code-execution/contracts';

export type Language = QueuePayload['language'];

export interface SubmitRequest {
  code: string;
  language: Language;
}

export interface SubmitResponse {
  jobId: string;
  status: SubmissionStatus;
}

// Shape returned by GET /submissions/:id — a superset of SubmissionResult
// (adds language/sourceCode/retryCount/timestamps that only exist once a
// submission row has been created, not while it's still in flight).
export interface SubmissionDetail {
  jobId: string;
  userId: string | null;
  language: Language;
  sourceCode: string;
  status: SubmissionStatus;
  retryCount: number;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  errorMessage: string | null;
  errorCategory: ErrorCategory | null;
  executionTimeMs: number | null;
  memoryUsedBytes: number | null;
  outputTruncated: boolean;
  streamOutputLimitExceeded: boolean;
  createdAt: string;
  updatedAt: string;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.message || body.error || `Request failed with status ${res.status}`;
  } catch {
    return `Request failed with status ${res.status}`;
  }
}

export async function submitJob(req: SubmitRequest): Promise<SubmitResponse> {
  const res = await fetch('/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorMessage(res));
  return res.json();
}

export async function getSubmission(jobId: string): Promise<SubmissionDetail> {
  const res = await fetch(`/submissions/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new ApiError(res.status, await parseErrorMessage(res));
  return res.json();
}
