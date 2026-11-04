import type { ReactNode } from 'react';

/** Titled section card shared by the Me and Tasks screens. */
export function Section(props: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="twin-panel twin-section">
      <h2 className="mb-3 text-base font-semibold text-[var(--text-primary)]">{props.title}</h2>
      {props.children}
    </section>
  );
}
