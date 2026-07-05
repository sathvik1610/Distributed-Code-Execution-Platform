import { ErrorCategory } from '@code-execution/contracts';
import type { SubmissionDetail } from '../api/client';

interface Props {
  result: SubmissionDetail | null;
}

const ERROR_LABELS: Record<ErrorCategory, string> = {
  [ErrorCategory.SYNTAX_ERROR]: 'Syntax Error',
  [ErrorCategory.RUNTIME_ERROR]: 'Runtime Error',
  [ErrorCategory.OOM]: 'Out of Memory',
  [ErrorCategory.TIMEOUT]: 'Timeout',
  [ErrorCategory.WORKER_CRASH]: 'Worker Crash',
  [ErrorCategory.UNKNOWN]: 'Unknown Error',
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ResultsPanel({ result }: Props) {
  if (!result) return null;

  return (
    <div className="results-panel">
      <div className="results-grid">
        <div className="results-field">
          <span className="results-label">Exit Code</span>
          <span className="results-value">{result.exitCode ?? '—'}</span>
        </div>
        <div className="results-field">
          <span className="results-label">Execution Time</span>
          <span className="results-value">{result.executionTimeMs !== null ? `${result.executionTimeMs} ms` : '—'}</span>
        </div>
        <div className="results-field">
          <span className="results-label">Memory Used</span>
          <span className="results-value">{formatBytes(result.memoryUsedBytes)}</span>
        </div>
      </div>

      {result.errorCategory && (
        <div className="results-error">
          <span className="results-error-category">{ERROR_LABELS[result.errorCategory]}</span>
          {result.errorMessage && <p className="results-error-message">{result.errorMessage}</p>}
        </div>
      )}

      {(result.outputTruncated || result.streamOutputLimitExceeded) && (
        <div className="results-warning">Output was truncated (exceeded the platform's output size limit).</div>
      )}
    </div>
  );
}
