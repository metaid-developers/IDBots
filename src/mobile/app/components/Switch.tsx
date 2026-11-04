/** Touch-friendly toggle (44 px hit area) for task/skill enabled states. */
export function Switch(props: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={`twin-switch ${props.checked ? 'twin-switch-on' : ''}`}
    >
      <span className="twin-switch-thumb" />
    </button>
  );
}
