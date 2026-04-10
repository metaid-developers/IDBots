import type { LocalUiPageDefinition } from '../types';

export function buildTracePageDefinition(): LocalUiPageDefinition {
  return {
    page: 'trace',
    title: 'Trace Inspector',
    eyebrow: 'Session Trace',
    heading: 'Inspect an agent-to-agent execution trace',
    description: 'Make chain-backed task flow visible to humans without changing the machine-first trace export format.',
    panels: [
      {
        title: 'Trace id focus',
        body: 'Show the trace id, external conversation id, and export path as the primary anchors.',
      },
      {
        title: 'Transcript export',
        body: 'Keep the transcript path obvious so humans can inspect the same evidence that agents generated.',
      },
      {
        title: 'Chain-aware debugging',
        body: 'Summaries should point back to the relevant MetaWeb interactions instead of inventing a separate app-only history.',
      },
    ],
    script: `(() => {
  const traceId = new URL(window.location.href).searchParams.get('traceId') || 'unknown-trace';
  const target = document.querySelector('[data-trace-id]');
  if (target) {
    target.textContent = traceId;
  }
})();`,
  };
}
