import type { Language } from './api/client';

export interface Snippet {
  id: string;
  label: string;
  code: Record<Language, string>;
}

// Three deliberately chosen scenarios that exercise distinct backend paths:
// a clean run, a SYNTAX_ERROR categorization, and the 5s sandbox timeout.
export const SNIPPETS: Snippet[] = [
  {
    id: 'hello-world',
    label: 'Hello World',
    code: {
      python: 'print("Hello, World!")',
      javascript: 'console.log("Hello, World!");',
    },
  },
  {
    id: 'syntax-error',
    label: 'Syntax Error',
    code: {
      python: 'def broken(:\n    pass',
      javascript: 'function broken( {\n  return 1;\n}',
    },
  },
  {
    id: 'infinite-loop',
    label: 'Infinite Loop',
    code: {
      python: 'while True:\n    pass',
      javascript: 'while (true) {}',
    },
  },
];

export const DEFAULT_LANGUAGE: Language = 'python';
