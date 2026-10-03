import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CapabilityDraftsPanel, {
  type CapabilityDraftItem,
} from '../src/renderer/components/settings/CapabilityDraftsPanel';
import { i18nService } from '../src/renderer/services/i18n';

const baseDraft = (id: number, overrides: Partial<CapabilityDraftItem> = {}): CapabilityDraftItem => ({
  id,
  dreamDate: '2026-09-30',
  title: `技巧 ${id}`,
  status: 'draft',
  validationScore: null,
  timesInjected: 0,
  promotedAt: null,
  promotedProcedureId: null,
  validatedAt: null,
  ...overrides,
});

const fixture: CapabilityDraftItem[] = [
  baseDraft(1, { status: 'validated', validationScore: 0.92, timesInjected: 7, validatedAt: Date.UTC(2026, 8, 30) }),
  baseDraft(2, { status: 'validated', validationScore: 0.88, timesInjected: 3, promotedAt: 1, promotedProcedureId: 'proc-2', validatedAt: Date.UTC(2026, 8, 29) }),
  baseDraft(3, { status: 'draft' }),
  baseDraft(4, { status: 'rejected', validationScore: 0.31 }),
];

test('capability drafts panel groups by status in validated → pending → rejected order with counts', () => {
  i18nService.setLanguage('en', { persist: false });
  const markup = renderToStaticMarkup(<CapabilityDraftsPanel drafts={fixture} />);

  const validatedHeader = `Validated (2)`;
  const draftHeader = `Pending (1)`;
  const rejectedHeader = `Rejected (1)`;
  assert.ok(markup.includes(validatedHeader), 'validated group header with count');
  assert.ok(markup.includes(draftHeader), 'pending group header with count');
  assert.ok(markup.includes(rejectedHeader), 'rejected group header with count');
  assert.ok(
    markup.indexOf(validatedHeader) < markup.indexOf(draftHeader)
      && markup.indexOf(draftHeader) < markup.indexOf(rejectedHeader),
    'groups render in validated → pending → rejected order',
  );

  // Score / injections / validated-at rows ride the entries.
  assert.ok(markup.includes('Score: 0.92'), 'validation score rendered');
  assert.ok(markup.includes('Injections: 7'), 'injection count rendered');
  assert.ok(markup.includes('Validated at:'), 'first-validation date rendered');
});

test('capability drafts panel marks promoted drafts only', () => {
  i18nService.setLanguage('en', { persist: false });
  const markup = renderToStaticMarkup(<CapabilityDraftsPanel drafts={fixture} />);
  assert.equal(
    (markup.match(/Procedure/g) || []).length,
    1,
    'only the promoted draft carries the procedure badge',
  );
});

test('capability drafts panel renders the empty state and the loading state', () => {
  i18nService.setLanguage('en', { persist: false });
  const empty = renderToStaticMarkup(<CapabilityDraftsPanel drafts={[]} />);
  assert.ok(empty.includes('No capability drafts yet'), 'empty hint rendered');
  const loading = renderToStaticMarkup(<CapabilityDraftsPanel drafts={[]} loading />);
  assert.ok(!loading.includes('No capability drafts yet'), 'loading replaces the empty hint');
});

test('capability drafts i18n keys exist in both languages', () => {
  i18nService.setLanguage('zh', { persist: false });
  const zh = renderToStaticMarkup(<CapabilityDraftsPanel drafts={fixture} />);
  assert.ok(zh.includes('能力草案 (4)'), 'zh title with count');
  assert.ok(zh.includes('已验证 (2)'), 'zh validated group');
  assert.ok(zh.includes('待验证 (1)'), 'zh pending group');
  assert.ok(zh.includes('已否决 (1)'), 'zh rejected group');
  assert.ok(zh.includes('已固化'), 'zh promoted badge');
  assert.ok(zh.includes('注入次数: 7'), 'zh injection count');

  i18nService.setLanguage('en', { persist: false });
  const en = renderToStaticMarkup(<CapabilityDraftsPanel drafts={fixture} />);
  assert.ok(en.includes('Capability drafts (4)'), 'en title with count');
  // The key set is complete in both languages (t() falls back to the raw key
  // when missing, and a raw camelCase key would fail these literal asserts).
  for (const key of ['capabilityDraftsTitle', 'capabilityDraftsHint', 'capabilityDraftsEmpty', 'capabilityDraftsStatusValidated', 'capabilityDraftsStatusDraft', 'capabilityDraftsStatusRejected', 'capabilityDraftsPromoted', 'capabilityDraftsScore', 'capabilityDraftsInjections', 'capabilityDraftsValidatedAt']) {
    assert.notEqual(i18nService.t(key), key, `${key} has an English translation`);
  }
  i18nService.setLanguage('zh', { persist: false });
  for (const key of ['capabilityDraftsTitle', 'capabilityDraftsHint', 'capabilityDraftsEmpty', 'capabilityDraftsStatusValidated', 'capabilityDraftsStatusDraft', 'capabilityDraftsStatusRejected', 'capabilityDraftsPromoted', 'capabilityDraftsScore', 'capabilityDraftsInjections', 'capabilityDraftsValidatedAt']) {
    assert.notEqual(i18nService.t(key), key, `${key} has a Chinese translation`);
  }
});
