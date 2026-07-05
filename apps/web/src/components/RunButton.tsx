interface Props {
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
}

export function RunButton({ onClick, disabled, busy }: Props) {
  return (
    <button type="button" className="run-button" onClick={onClick} disabled={disabled}>
      {busy ? 'Running…' : 'Run'}
    </button>
  );
}
