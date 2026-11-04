/** ME coin glyph — shared by the chip, hero card and empty states. */
export function MeCoinIcon(props: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={props.className}>
      <circle cx="10" cy="10" r="7.6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M6.6 13.4V6.6h2.6c1.55 0 2.5.92 2.5 2.35 0 1.44-.95 2.35-2.5 2.35H8v2.1H6.6Zm1.4-3.3h1.05c.72 0 1.12-.42 1.12-1.05 0-.64-.4-1.05-1.12-1.05H8v2.1Z"
        fill="currentColor"
      />
    </svg>
  );
}
