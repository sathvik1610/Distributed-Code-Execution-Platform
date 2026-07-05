import Editor from '@monaco-editor/react';
import type { Language } from '../api/client';

interface Props {
  language: Language;
  value: string;
  onChange: (value: string) => void;
}

// Monaco's built-in language IDs already match the contract's literal union
// ('python', 'javascript'), so no translation table is needed here.
export function CodeEditor({ language, value, onChange }: Props) {
  return (
    <Editor
      height="60vh"
      language={language}
      theme="vs-dark"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        automaticLayout: true,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
