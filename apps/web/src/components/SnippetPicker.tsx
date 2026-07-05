import { SNIPPETS } from '../snippets';
import type { Language } from '../api/client';

interface Props {
  language: Language;
  onSelect: (code: string) => void;
  disabled?: boolean;
}

export function SnippetPicker({ language, onSelect, disabled }: Props) {
  return (
    <div className="snippet-picker">
      <span className="snippet-picker-label">Examples:</span>
      {SNIPPETS.map((snippet) => (
        <button
          key={snippet.id}
          type="button"
          className="snippet-button"
          data-testid={`snippet-${snippet.id}`}
          disabled={disabled}
          onClick={() => onSelect(snippet.code[language])}
        >
          {snippet.label}
        </button>
      ))}
    </div>
  );
}
