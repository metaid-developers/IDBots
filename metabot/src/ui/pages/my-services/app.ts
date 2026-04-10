import type { LocalUiPageDefinition } from '../types';

export function buildMyServicesPageDefinition(): LocalUiPageDefinition {
  return {
    page: 'my-services',
    title: 'My Services',
    eyebrow: 'Provider Ledger',
    heading: 'Inspect your published services and recent orders',
    description: 'A compact local console for service mutation history, order status, and human-readable context around provider-side activity.',
    panels: [
      {
        title: 'Service inventory',
        body: 'List current services, last mutation state, and whether the service is currently available to remote MetaBots.',
      },
      {
        title: 'Recent order activity',
        body: 'Expose the order and refund state transitions that matter to a human operator.',
      },
      {
        title: 'Safe mutation actions',
        body: 'Modify or revoke only after reflecting the same semantics already validated in IDBots.',
      },
    ],
    script: `(() => {
  document.body.dataset.metabotPage = 'my-services';
})();`,
  };
}
