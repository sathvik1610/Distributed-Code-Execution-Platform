import { useCallback, useRef, useState } from 'react';
import { SubmissionStatus, isTerminalStatus, type StreamChunk } from '@code-execution/contracts';
import { getSubmission, submitJob, type Language, type SubmissionDetail } from '../api/client';
import { openJobStream } from '../api/stream';

export type UiStatus = 'idle' | 'submitting' | 'submit_error' | SubmissionStatus;

export interface OutputLine {
  type: StreamChunk['type'];
  data: string;
}

const FALLBACK_POLL_DELAY_MS = 3000;
const FALLBACK_POLL_INTERVAL_MS = 1500;

export function useSubmission(onSubmitted?: (jobId: string, language: Language) => void) {
  const [status, setStatus] = useState<UiStatus>('idle');
  const [jobId, setJobId] = useState<string | null>(null);
  const [output, setOutput] = useState<OutputLine[]>([]);
  const [result, setResult] = useState<SubmissionDetail | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Mutable bookkeeping that doesn't need to trigger re-renders.
  const closeStreamRef = useRef<(() => void) | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    fallbackTimerRef.current = null;
    pollIntervalRef.current = null;
  }, []);

  const finalize = useCallback(async (id: string) => {
    clearTimers();
    try {
      const detail = await getSubmission(id);
      setResult(detail);
      setStatus(detail.status);
    } catch {
      // The submission genuinely can't be read back — surface as failed
      // rather than leaving the UI stuck on a non-terminal status forever.
      setStatus(SubmissionStatus.FAILED);
    }
  }, [clearTimers]);

  const startFallbackPoll = useCallback((id: string) => {
    if (pollIntervalRef.current) return; // already polling
    pollIntervalRef.current = setInterval(async () => {
      try {
        const detail = await getSubmission(id);
        if (isTerminalStatus(detail.status)) {
          clearTimers();
          setResult(detail);
          setStatus(detail.status);
        } else {
          setStatus(detail.status);
        }
      } catch {
        // Transient network blip — keep polling, don't fail the job over one miss.
      }
    }, FALLBACK_POLL_INTERVAL_MS);
  }, [clearTimers]);

  const run = useCallback(async (code: string, language: Language) => {
    // Tear down any previous job's stream/timers before starting a new one.
    closeStreamRef.current?.();
    clearTimers();

    setStatus('submitting');
    setOutput([]);
    setResult(null);
    setSubmitError(null);

    let newJobId: string;
    try {
      const res = await submitJob({ code, language });
      newJobId = res.jobId;
    } catch (err) {
      setStatus('submit_error');
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit job');
      return;
    }

    setJobId(newJobId);
    setStatus(SubmissionStatus.PENDING);
    onSubmitted?.(newJobId, language);

    let sawFirstMessage = false;

    fallbackTimerRef.current = setTimeout(() => {
      if (!sawFirstMessage) startFallbackPoll(newJobId);
    }, FALLBACK_POLL_DELAY_MS);

    closeStreamRef.current = openJobStream(newJobId, {
      onChunk: (chunk) => {
        sawFirstMessage = true;
        if (fallbackTimerRef.current) {
          clearTimeout(fallbackTimerRef.current);
          fallbackTimerRef.current = null;
        }
        if (chunk.type === 'stdout' || chunk.type === 'stderr') {
          setOutput((prev) => [...prev, { type: chunk.type, data: chunk.data }]);
          setStatus((prev) => (prev === SubmissionStatus.PENDING ? SubmissionStatus.RUNNING : prev));
        }
      },
      onClose: () => {
        void finalize(newJobId);
      },
      onUnavailable: () => {
        if (!sawFirstMessage) startFallbackPoll(newJobId);
      },
    });
  }, [clearTimers, finalize, onSubmitted, startFallbackPoll]);

  const isBusy = status === 'submitting' || status === SubmissionStatus.PENDING || status === SubmissionStatus.RUNNING;

  return { status, jobId, output, result, submitError, isBusy, run };
}
