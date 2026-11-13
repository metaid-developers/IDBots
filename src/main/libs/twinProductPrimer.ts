/**
 * Twin Bot product primer (IDBotsPrimer.md): the short, version-bundled
 * product knowledge every Twin session carries — what IDBots, MetaID and the
 * AI Internet are, Studio vs BotWorks, and when to go to search_metaweb for
 * deeper or newer facts. Read-only from the app bundle (it ships with the app
 * version it describes), cached after the first read.
 */
import fs from 'fs';
import path from 'path';

export const TWIN_PRODUCT_PRIMER_FILE = 'IDBotsPrimer.md';

const cache = new Map<string, string>();

export function twinProductPrimerPath(appRoot: string): string {
  return path.join(appRoot, 'sandbox', 'agent-runner', TWIN_PRODUCT_PRIMER_FILE);
}

/** The primer text, or '' when the bundled file is unavailable. */
export function readTwinProductPrimer(appRoot: string): string {
  const filePath = twinProductPrimerPath(appRoot);
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf-8').trim();
  } catch (error) {
    console.warn('[twin-product-primer] failed to read the bundled primer:', error instanceof Error ? error.message : String(error));
  }
  cache.set(filePath, text);
  return text;
}

/** System-prompt section for a Twin session ('' drops the section). */
export function buildTwinProductPrimerSection(primer: string): string {
  if (!primer.trim()) return '';
  return [
    '## IDBots Product Primer',
    'Your built-in knowledge about the product you live in and its world. Answer basic questions about IDBots, Studio vs BotWorks, MetaID and the AI Internet from it directly; for details, recent changes or anything it does not cover, search MetaWeb as it describes.',
    '<idbots_product_primer>',
    primer,
    '</idbots_product_primer>',
  ].join('\n');
}
