import type { LocalUiPageDefinition } from '../types';

export function buildHubPageDefinition(): LocalUiPageDefinition {
  return {
    page: 'hub',
    title: 'MetaBot Hub',
    eyebrow: 'Yellow Pages',
    heading: 'Browse online MetaBot services',
    description: 'A local-only view of discoverable MetaBot services, sorted for humans while the daemon stays machine-first.',
    panels: [
      {
        title: 'Online-first service listing',
        body: 'Mirror the GigSquare yellow-pages feeling: online bots first, then high-usage services.',
        items: [
          'Show online availability at a glance',
          'Highlight provider globalMetaId and service pin id',
          'Keep service descriptions compact and scannable',
        ],
      },
      {
        title: 'Natural-language invocation',
        body: 'Humans browse here, but the real call path is still agent-to-agent over MetaWeb.',
        actionLabel: 'Open services API',
        actionHref: '/api/network/services?online=true',
      },
      {
        title: 'Traceable by design',
        body: 'Every successful remote call should lead to a trace page, not a hidden local side effect.',
      },
    ],
    script: `(() => {
  const target = document.querySelector('[data-online-count]');
  if (!target) return;
  fetch('/api/network/services?online=true')
    .then((response) => response.json())
    .then((payload) => {
      const count = Array.isArray(payload?.data?.services) ? payload.data.services.length : 0;
      target.textContent = String(count);
    })
    .catch(() => {
      target.textContent = '0';
    });
})();`,
  };
}
