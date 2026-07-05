import type { JobHistoryEntry } from '../hooks/useJobHistory';

interface Props {
  entries: JobHistoryEntry[];
  onSelect: (jobId: string) => void;
}

export function JobHistory({ entries, onSelect }: Props) {
  if (entries.length === 0) {
    return <p className="job-history-empty">No jobs submitted yet in this browser.</p>;
  }

  return (
    <ul className="job-history">
      {entries.map((entry) => (
        <li key={entry.jobId} className="job-history-item">
          <button type="button" className="job-history-button" onClick={() => onSelect(entry.jobId)}>
            <span className="job-history-language">{entry.language}</span>
            <span className={`job-history-status job-history-status-${String(entry.status).toLowerCase()}`}>
              {entry.status}
            </span>
            <span className="job-history-time">{new Date(entry.submittedAt).toLocaleTimeString()}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
