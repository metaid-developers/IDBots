import type { LocalUiPageDefinition } from '../types';

export function buildRefundPageDefinition(): LocalUiPageDefinition {
  return {
    page: 'refund',
    title: 'Manual Refund Confirmation',
    eyebrow: 'Human Action',
    heading: 'Confirm a provider-side refund when automation must pause',
    description: 'This is the main human interruption surface in V1: a precise local page for refund confirmation when the daemon cannot finish autonomously.',
    panels: [
      {
        title: 'Manual action only',
        body: 'Reserve this page for seller-side refund confirmation. Do not widen it into a general operations dashboard.',
      },
      {
        title: 'Exact identifiers',
        body: 'Display order id, refund request pin id, and session linkage so the human knows what they are confirming.',
      },
      {
        title: 'Back to machine-first flow',
        body: 'Once confirmed, the next state should be observable by the daemon, CLI, and trace route without bespoke UI logic.',
      },
    ],
    script: `(() => {
  const params = new URL(window.location.href).searchParams;
  const orderId = params.get('orderId') || 'unknown-order';
  const target = document.querySelector('[data-order-id]');
  if (target) {
    target.textContent = orderId;
  }
})();`,
  };
}
