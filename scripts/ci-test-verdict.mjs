#!/usr/bin/env node
/**
 * Single verdict for the workflow's test steps.
 *
 * The failure class this closes: with fail-fast steps a red job reports its
 * FIRST failing suite only, and every further failure costs another full
 * Windows round on the single signing runner (50–100 min each). v1.1.3
 * (2026-11-25) peeled the commerce block that way — CRLF, then a Windows-path
 * bug hidden behind it — and three more rounds died at agent-game (step 20)
 * without ever reaching the suites behind it. The release SOP already calls
 * one-shot enumeration "far better than one pit per 30–50 minute round"
 * (§11.22); this makes it the workflow's default.
 *
 * The test steps run with `continue-on-error: true`, so a failing suite no
 * longer stops the job: every suite runs, and this step — placed right before
 * packaging — fails the job if any of them did. Packaging never starts on a
 * red tree.
 *
 * Wiring: every test step has an id starting with `test_`, and this step's
 * env carries one `TEST_*_OUTCOME: ${{ steps.<id>.outcome }}` entry per test
 * step. Exit codes: 0 = every test step succeeded or was skipped, 1 = at
 * least one did not.
 */
import { pathToFileURL } from 'node:url';

/** Test-step env entries that did not succeed (failed, cancelled, ...). */
export function collectFailures(env = process.env) {
  const failures = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('TEST_') || !key.endsWith('_OUTCOME')) continue;
    if (value !== 'success' && value !== 'skipped') failures.push({ name: key, outcome: value || '(unset)' });
  }
  return failures.sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  const failures = collectFailures();
  if (failures.length === 0) {
    console.log('[ci-test-verdict] every test step passed');
    return;
  }
  for (const failure of failures) {
    console.error(`✗ ${failure.outcome}: ${failure.name.replace(/^TEST_/, '').replace(/_OUTCOME$/, '').toLowerCase()}`);
  }
  console.error(
    `\n[ci-test-verdict] ${failures.length} test step(s) failed. Every suite above ran, so this list `
      + 'is complete for this commit — fix all of it before pushing again (release SOP §11.22).',
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
