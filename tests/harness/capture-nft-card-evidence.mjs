/**
 * Captures the S3 evidence screenshots (playwright):
 *   01 — all three real surfaces rendering the card (+ plain-image contrast
 *        bubble in the CoWork section)
 *   02 — the detail overlay opened by clicking the card
 *
 * Usage (vite dev must be up, serving the worktree root):
 *   EVIDENCE_BASE_URL=http://localhost:5199 \
 *   EVIDENCE_OUT_DIR=/abs/path/to/dir \
 *   node tests/harness/capture-nft-card-evidence.mjs
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.EVIDENCE_BASE_URL || 'http://localhost:5199';
const outDir = process.env.EVIDENCE_OUT_DIR;
if (!outDir || !path.isAbsolute(outDir)) {
  console.error('EVIDENCE_OUT_DIR must be an absolute path');
  process.exit(1);
}

const url = `${baseUrl}/tests/harness/nft-card-evidence.html`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 980, height: 1400 }, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => console.error('[pageerror]', error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // All three surfaces must show a card before anything is captured.
  // (First hit pays vite's dependency optimization; generous timeout.)
  await page.waitForSelector('#cowork [data-nft-card="true"]', { timeout: 60000 });
  await page.waitForSelector('#a2a [data-nft-card="true"]', { timeout: 15000 });
  await page.waitForSelector('#group [data-nft-card="true"]', { timeout: 15000 });
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll('[data-nft-card="true"] img'));
    return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, { timeout: 30000 }).catch(() => console.warn('[warn] artwork images did not all settle; capturing anyway'));

  await mkdir(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, '01-three-surfaces.png'), fullPage: true });
  console.log('captured 01-three-surfaces.png');

  // Click the CoWork card -> detail overlay must open with the full fields.
  await page.click('#cowork [data-nft-card="true"]');
  await page.waitForSelector('[data-nft-card-detail="true"]', { timeout: 10000 });
  await page.waitForFunction(() => {
    const overlay = document.querySelector('[data-nft-card-detail="true"]');
    if (!overlay) return false;
    const images = Array.from(overlay.querySelectorAll('img'));
    return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, { timeout: 30000 }).catch(() => console.warn('[warn] overlay artwork did not settle; capturing anyway'));
  await page.screenshot({ path: path.join(outDir, '02-detail-overlay.png') });
  console.log('captured 02-detail-overlay.png');

  // Esc closes the overlay (keyboard path evidence in the console log).
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-nft-card-detail="true"]', { state: 'detached', timeout: 5000 });
  console.log('overlay closed via Escape — ok');
} finally {
  await browser.close();
}
