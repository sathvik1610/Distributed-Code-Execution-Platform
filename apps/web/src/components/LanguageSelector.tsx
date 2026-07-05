import type { Language } from '../api/client';

interface Props {
  value: Language;
  onChange: (language: Language) => void;
  disabled?: boolean;
}

const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'python', label: 'Python' },
  { value: 'javascript', label: 'JavaScript' },
];

export function LanguageSelector({ value, onChange, disabled }: Props) {
  return (
    <select
      className="language-selector"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Language)}
    >
      {LANGUAGES.map((lang) => (
        <option key={lang.value} value={lang.value}>
          {lang.label}
        </option>
      ))}
    </select>
  );
}
