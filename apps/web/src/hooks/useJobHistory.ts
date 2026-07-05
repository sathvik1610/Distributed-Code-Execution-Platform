import { useCallback, useEffect, useState } from 'react';
import type { SubmissionStatus } from '@code-execution/contracts';
import type { Language } from '../api/client';

const STORAGE_KEY = 'code-execution-job-history';
const MAX_ENTRIES = 10;

export interface JobHistoryEntry {
  jobId: string;
  language: Language;
  status: SubmissionStatus | string;
  submittedAt: string;
}

function load(): JobHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(entries: JobHistoryEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage full or unavailable (private browsing) — history just won't persist.
  }
}

export function useJobHistory() {
  const [entries, setEntries] = useState<JobHistoryEntry[]>(() => load());

  useEffect(() => {
    save(entries);
  }, [entries]);

  const addEntry = useCallback((jobId: string, language: Language) => {
    setEntries((prev) => [
      { jobId, language, status: 'PENDING', submittedAt: new Date().toISOString() },
      ...prev,
    ].slice(0, MAX_ENTRIES));
  }, []);

  const updateStatus = useCallback((jobId: string, status: SubmissionStatus | string) => {
    setEntries((prev) => prev.map((e) => (e.jobId === jobId ? { ...e, status } : e)));
  }, []);

  return { entries, addEntry, updateStatus };
}
