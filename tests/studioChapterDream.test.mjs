// Studio chapter cards feed the nightly dream (Phase 2 slice 4): the dream
// ledger must render closed chapter cards as a dedicated section and direct
// the continuity crystal to distill decisions → standing_rulings and open
// loops → active_workstreams. The store query is covered indirectly (the
// chapter store CRUD has its own suite); these pins check the prompt wiring.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const promptSource = readFileSync(join(here, '../src/main/libs/dreamPrompt.ts'), 'utf8');
const storeSource = readFileSync(join(here, '../src/main/dreamStore.ts'), 'utf8');

test('the dream activity carries studio chapter cards with a defensive schema guard', () => {
  assert.ok(
    storeSource.includes('studioChapterCards?: DreamStudioChapterCardActivity[]'),
    'dreamStore: the activity interface declares the chapter-card field',
  );
  assert.ok(
    storeSource.includes("this.hasTable('cowork_session_chapters')"),
    'dreamStore: the query is guarded on table existence (older installs)',
  );
  assert.ok(
    storeSource.includes("this.hasTableColumn('cowork_sessions', 'assistant_mode')"),
    'dreamStore: the assistant_mode filter is schema-guarded like the activity scan',
  );
  assert.ok(
    storeSource.includes("AND s.session_type = 'browser'"),
    'dreamStore: only Studio owner sessions feed chapter cards',
  );
  assert.ok(
    storeSource.includes('AND c.ended_at IS NOT NULL'),
    'dreamStore: only CLOSED chapters are dreamable',
  );
});

test('the dream prompt renders a chapter-card ledger and routes it into the continuity crystal', () => {
  assert.ok(
    promptSource.includes('### 当日收拢的 Studio 章节卡'),
    'dreamPrompt: a dedicated chapter-card ledger section renders',
  );
  assert.ok(
    promptSource.includes('card.closeReason === \'task_boundary\''),
    'dreamPrompt: close reasons render in owner language (task_boundary → 任务交付)',
  );
  assert.ok(
    promptSource.includes('并入 standing_rulings') && promptSource.includes('并入 active_workstreams'),
    'dreamPrompt: cards route decisions → standing_rulings and open loops → active_workstreams',
  );
  assert.ok(
    promptSource.includes('优先级高于对话原文的粗摘要'),
    'dreamPrompt: cards outrank the raw transcript digest in the crystal synthesis',
  );
  // A day with ONLY chapter closes (no delegations/decisions) must still
  // render the ledger block.
  assert.ok(
    promptSource.includes('studioChapterCards.length > 0) {'),
    'dreamPrompt: the ledger gate includes chapter cards',
  );
});
