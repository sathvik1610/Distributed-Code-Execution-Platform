import { useEffect, useRef } from 'react';
import type { OutputLine } from '../hooks/useSubmission';

interface Props {
  lines: OutputLine[];
}

export function OutputPanel({ lines }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);

  return (
    <pre className="output-panel">
      {lines.length === 0 && <span className="output-placeholder">Output will appear here…</span>}
      {lines.map((line, i) => (
        <span key={i} className={line.type === 'stderr' ? 'output-stderr' : 'output-stdout'}>
          {line.data}
        </span>
      ))}
      <div ref={bottomRef} />
    </pre>
  );
}
