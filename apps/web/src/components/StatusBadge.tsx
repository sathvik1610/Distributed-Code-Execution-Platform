import { SubmissionStatus, isTerminalStatus } from '@code-execution/contracts';
import type { UiStatus } from '../hooks/useSubmission';

const LABELS: Record<string, string> = {
  idle: 'Idle',
  submitting: 'Submitting…',
  submit_error: 'Submit Failed',
  [SubmissionStatus.PENDING]: 'Pending',
  [SubmissionStatus.RUNNING]: 'Running',
  [SubmissionStatus.COMPLETED]: 'Completed',
  [SubmissionStatus.FAILED]: 'Failed',
  [SubmissionStatus.TIMEOUT]: 'Timed Out',
};

const COLOR_CLASS: Record<string, string> = {
  idle: 'status-idle',
  submitting: 'status-pending',
  submit_error: 'status-failed',
  [SubmissionStatus.PENDING]: 'status-pending',
  [SubmissionStatus.RUNNING]: 'status-running',
  [SubmissionStatus.COMPLETED]: 'status-completed',
  [SubmissionStatus.FAILED]: 'status-failed',
  [SubmissionStatus.TIMEOUT]: 'status-failed',
};

interface Props {
  status: UiStatus;
}

export function StatusBadge({ status }: Props) {
  const label = LABELS[status] ?? status;
  const colorClass = COLOR_CLASS[status] ?? 'status-idle';
  const isNonTerminal = status === 'submitting' || (status !== 'idle' && status !== 'submit_error' && !isTerminalStatus(status as SubmissionStatus));

  return (
    <span className={`status-badge ${colorClass}`}>
      {isNonTerminal && <span className="status-dot" aria-hidden="true" />}
      {label}
    </span>
  );
}
