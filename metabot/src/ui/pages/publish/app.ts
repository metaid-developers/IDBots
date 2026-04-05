import type { LocalUiPageDefinition } from '../types';

export function buildPublishPageDefinition(): LocalUiPageDefinition {
  return {
    page: 'publish',
    title: 'Publish Service',
    eyebrow: 'Provider Console',
    heading: 'Publish a local capability to MetaWeb',
    description: 'This page exists for human setup only. The daemon and CLI stay responsible for the actual publish call and result envelope.',
    panels: [
      {
        title: 'Reuse validated publish semantics',
        body: 'Carry forward IDBots pricing, provider identity, output type, and icon rules without changing the chain contract.',
      },
      {
        title: 'Minimal human inputs',
        body: 'The page should help a human inspect and confirm a publish payload, not replace the machine-first CLI.',
        actionLabel: 'Inspect daemon status',
        actionHref: '/api/daemon/status',
      },
      {
        title: 'One service at a time',
        body: 'V1 optimizes for a stable publish flow instead of a bulk marketplace workflow.',
      },
    ],
    script: `(() => {
  document.body.dataset.metabotPage = 'publish';
})();`,
  };
}
