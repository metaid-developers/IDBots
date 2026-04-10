import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildHubPageDefinition } from '../../ui/pages/hub/app';
import { buildMyServicesPageDefinition } from '../../ui/pages/my-services/app';
import { buildPublishPageDefinition } from '../../ui/pages/publish/app';
import { buildRefundPageDefinition } from '../../ui/pages/refund/app';
import { buildTracePageDefinition } from '../../ui/pages/trace/app';
import type { LocalUiPageDefinition } from '../../ui/pages/types';
import type { MetabotUiPageName, RouteHandler } from './types';

const UI_ROUTE_PREFIX = '/ui/';

const PAGE_BUILDERS: Record<MetabotUiPageName, () => LocalUiPageDefinition> = {
  'hub': buildHubPageDefinition,
  'publish': buildPublishPageDefinition,
  'my-services': buildMyServicesPageDefinition,
  'trace': buildTracePageDefinition,
  'refund': buildRefundPageDefinition,
};

const NAV_ITEMS: Array<{ page: MetabotUiPageName; label: string }> = [
  { page: 'hub', label: 'Hub' },
  { page: 'publish', label: 'Publish' },
  { page: 'my-services', label: 'My Services' },
  { page: 'trace', label: 'Trace' },
  { page: 'refund', label: 'Refund' },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPanels(definition: LocalUiPageDefinition): string {
  return definition.panels.map((panel) => {
    const items = Array.isArray(panel.items) && panel.items.length > 0
      ? `<ul>${panel.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '';
    const action = panel.actionLabel && panel.actionHref
      ? `<a href="${escapeHtml(panel.actionHref)}">${escapeHtml(panel.actionLabel)}</a>`
      : '';
    return `<article class="panel"><h2>${escapeHtml(panel.title)}</h2><p>${escapeHtml(panel.body)}</p>${items}${action}</article>`;
  }).join('');
}

function renderNav(currentPage: MetabotUiPageName): string {
  return NAV_ITEMS.map((item) => {
    const label = item.page === currentPage ? `${item.label} *` : item.label;
    return `<a href="/ui/${item.page}">${escapeHtml(label)}</a>`;
  }).join('');
}

function resolveTemplatePath(page: MetabotUiPageName): string {
  const copiedAssetPath = path.resolve(__dirname, `../../ui/pages/${page}/index.html`);
  const sourceAssetPath = path.resolve(__dirname, `../../../src/ui/pages/${page}/index.html`);
  return fs.access(copiedAssetPath).then(() => copiedAssetPath).catch(() => sourceAssetPath) as unknown as string;
}

async function loadTemplate(page: MetabotUiPageName): Promise<string> {
  const copiedAssetPath = path.resolve(__dirname, `../../ui/pages/${page}/index.html`);
  try {
    return await fs.readFile(copiedAssetPath, 'utf8');
  } catch {
    const sourceAssetPath = path.resolve(__dirname, `../../../src/ui/pages/${page}/index.html`);
    return fs.readFile(sourceAssetPath, 'utf8');
  }
}

async function renderBuiltInPage(page: MetabotUiPageName): Promise<string> {
  const definition = PAGE_BUILDERS[page]();
  const template = await loadTemplate(page);
  const content = `
    <main class="page">
      <section class="hero">
        <div class="eyebrow">${escapeHtml(definition.eyebrow)}</div>
        <h1>${escapeHtml(definition.heading)}</h1>
        <p class="hero-copy">${escapeHtml(definition.description)}</p>
        <div class="hero-meta">
          <div class="hero-chip">
            <strong data-online-count>0</strong>
            <span>Online services detected</span>
          </div>
          <div class="hero-chip">
            <strong data-trace-id>trace-ready</strong>
            <span>Latest visible trace</span>
          </div>
          <div class="hero-chip">
            <strong data-order-id>order-ready</strong>
            <span>Manual refund focus</span>
          </div>
        </div>
        <nav class="nav">${renderNav(definition.page)}</nav>
      </section>
      <section class="panels">${renderPanels(definition)}</section>
    </main>
  `.trim();
  return template
    .replace(/__PAGE_TITLE__/g, escapeHtml(definition.title))
    .replace(/__PAGE_EYEBROW__/g, escapeHtml(definition.eyebrow))
    .replace(/__PAGE_HEADING__/g, escapeHtml(definition.heading))
    .replace(/__PAGE_DESCRIPTION__/g, escapeHtml(definition.description))
    .replace(/__PAGE_NAV__/g, renderNav(definition.page))
    .replace(/__PAGE_PANELS__/g, renderPanels(definition))
    .replace(/__PAGE_CONTENT__/g, content)
    .replace(/__PAGE_SCRIPT__/g, definition.script);
}

export const handleUiRoutes: RouteHandler = async (context) => {
  const { req, url, handlers } = context;

  if (!url.pathname.startsWith(UI_ROUTE_PREFIX)) {
    return false;
  }

  if (req.method !== 'GET') {
    context.sendMethodNotAllowed(['GET']);
    return true;
  }

  const page = url.pathname.slice(UI_ROUTE_PREFIX.length).trim() as MetabotUiPageName;
  if (!(page in PAGE_BUILDERS)) {
    context.sendJson(404, {
      ok: false,
      state: 'failed',
      code: 'not_found',
      message: `No UI page matched ${url.pathname}.`,
    });
    return true;
  }

  const html = handlers.ui?.renderPage
    ? await handlers.ui.renderPage(page)
    : await renderBuiltInPage(page);
  context.sendHtml(200, html);
  return true;
};
