import { useEffect, useState } from 'react';
import { isTerminalStatus, type SubmissionStatus } from '@code-execution/contracts';
import { LanguageSelector } from './components/LanguageSelector';
import { CodeEditor } from './components/CodeEditor';
import { SnippetPicker } from './components/SnippetPicker';
import { RunButton } from './components/RunButton';
import { StatusBadge } from './components/StatusBadge';
import { OutputPanel } from './components/OutputPanel';
import { CopyOutputButton } from './components/CopyOutputButton';
import { ResultsPanel } from './components/ResultsPanel';
import { JobHistory } from './components/JobHistory';
import { useSubmission, type OutputLine } from './hooks/useSubmission';
import { useJobHistory } from './hooks/useJobHistory';
import { getSubmission, type SubmissionDetail } from './api/client';
import { DEFAULT_LANGUAGE, SNIPPETS } from './snippets';

export default function App() {
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);
  const [code, setCode] = useState(SNIPPETS[0].code[DEFAULT_LANGUAGE]);

  // Set when the user clicks a past job in history — displays that job's
  // frozen result instead of the live submission state below.
  const [historicalView, setHistoricalView] = useState<SubmissionDetail | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const { entries, addEntry, updateStatus } = useJobHistory();
  const submission = useSubmission(addEntry);

  // Keep the history list's snapshot status in sync with the live job's
  // final state once it reaches a terminal outcome.
  useEffect(() => {
    if (!submission.jobId) return;
    if (submission.status === 'submit_error' || isTerminalStatus(submission.status as SubmissionStatus)) {
      updateStatus(submission.jobId, submission.status);
    }
  }, [submission.jobId, submission.status, updateStatus]);

  const handleRun = () => {
    setHistoricalView(null);
    setHistoryError(null);
    void submission.run(code, language);
  };

  const handleSelectHistory = async (jobId: string) => {
    setHistoryError(null);
    try {
      const detail = await getSubmission(jobId);
      setHistoricalView(detail);
      setLanguage(detail.language);
      setCode(detail.sourceCode);
    } catch {
      setHistoryError('Could not load that job — it may have been removed.');
    }
  };

  const viewingHistory = historicalView !== null;
  const displayOutput: OutputLine[] = viewingHistory
    ? [
        ...(historicalView.stdout ? [{ type: 'stdout' as const, data: historicalView.stdout }] : []),
        ...(historicalView.stderr ? [{ type: 'stderr' as const, data: historicalView.stderr }] : []),
      ]
    : submission.output;
  const displayResult = viewingHistory ? historicalView : submission.result;
  const displayStatus = viewingHistory ? historicalView.status : submission.status;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Code Execution Platform</h1>
      </header>

      <main className="app-main">
        <section className="editor-section">
          <div className="editor-toolbar">
            <LanguageSelector value={language} onChange={setLanguage} disabled={submission.isBusy} />
            <SnippetPicker language={language} onSelect={setCode} disabled={submission.isBusy} />
            <RunButton onClick={handleRun} disabled={submission.isBusy} busy={submission.isBusy} />
          </div>
          <CodeEditor language={language} value={code} onChange={setCode} />
        </section>

        <section className="result-section">
          <div className="result-header">
            <StatusBadge status={displayStatus} />
            <CopyOutputButton lines={displayOutput} />
          </div>
          {submission.submitError && !viewingHistory && (
            <p className="submit-error">{submission.submitError}</p>
          )}
          <OutputPanel lines={displayOutput} />
          <ResultsPanel result={displayResult} />
        </section>

        <aside className="history-section">
          <h2>Recent Jobs</h2>
          {historyError && <p className="submit-error">{historyError}</p>}
          <JobHistory entries={entries} onSelect={handleSelectHistory} />
        </aside>
      </main>
    </div>
  );
}
