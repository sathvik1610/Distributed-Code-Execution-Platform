import { useState } from 'react';
import type { OutputLine } from '../hooks/useSubmission';

interface Props {
  lines: OutputLine[];
}

export function CopyOutputButton({ lines }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = lines.map((l) => l.data).join('');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — fail quietly.
    }
  };

  return (
    <button type="button" className="copy-output-button" onClick={handleCopy} disabled={lines.length === 0}>
      {copied ? 'Copied!' : 'Copy Output'}
    </button>
  );
}
