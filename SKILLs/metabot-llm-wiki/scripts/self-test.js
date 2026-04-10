#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const scriptPath = path.resolve(__dirname, 'index.js');

function runSkill(payload) {
  const result = spawnSync(process.execPath, [scriptPath, '--payload', JSON.stringify(payload)], {
    encoding: 'utf8',
  });

  let parsed = null;
  try {
    parsed = JSON.parse((result.stdout || '').trim());
  } catch {
    parsed = null;
  }

  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    json: parsed,
  };
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-llm-wiki-'));
  const kbRoot = path.join(tempRoot, 'legal-cn');
  const rawDir = path.join(kbRoot, 'raw', 'cases');
  fs.mkdirSync(rawDir, { recursive: true });

  fs.writeFileSync(
    path.join(rawDir, 'case-001.md'),
    '# 合同违约责任案例\n\n当事人约定了违约金条款，违约发生后应承担约定责任。\n',
    'utf8'
  );

  const base = {
    kbId: 'legal-cn',
    payload: {
      rootDir: kbRoot,
    },
  };

  const initRes = runSkill({ ...base, action: 'init', payload: { ...base.payload, config: { language: 'zh-CN' } } });
  assert.equal(initRes.code, 0, initRes.stdout || initRes.stderr);
  assert.equal(initRes.json?.success, true);

  const ingestRes = runSkill({ ...base, action: 'ingest', payload: { ...base.payload, mode: 'incremental' } });
  assert.equal(ingestRes.code, 0, ingestRes.stdout || ingestRes.stderr);
  assert.equal(ingestRes.json?.success, true);
  assert.equal(ingestRes.json?.data?.docsTotal, 1);

  const indexRes = runSkill({ ...base, action: 'index', payload: { ...base.payload, mode: 'incremental' } });
  assert.equal(indexRes.code, 0, indexRes.stdout || indexRes.stderr);
  assert.equal(indexRes.json?.success, true);
  assert.ok(indexRes.json?.data?.chunkCount >= 1);

  const queryRes = runSkill({
    ...base,
    action: 'query',
    payload: {
      ...base.payload,
      question: '合同违约责任如何承担？',
      minScore: 0.01,
    },
  });
  assert.equal(queryRes.code, 0, queryRes.stdout || queryRes.stderr);
  assert.equal(queryRes.json?.success, true);
  assert.equal(queryRes.json?.data?.insufficient, false);
  assert.ok(Array.isArray(queryRes.json?.data?.citations));
  assert.ok(queryRes.json?.data?.citations?.length > 0);

  const wikiRes = runSkill({ ...base, action: 'wiki_build', payload: { ...base.payload, siteTitle: 'Legal Wiki' } });
  assert.equal(wikiRes.code, 0, wikiRes.stdout || wikiRes.stderr);
  assert.equal(wikiRes.json?.success, true);
  assert.ok(fs.existsSync(path.join(kbRoot, 'wiki', 'site', 'index.html')));

  const bundleRes = runSkill({ ...base, action: 'bundle_zip', payload: { ...base.payload } });
  assert.equal(bundleRes.code, 0, bundleRes.stdout || bundleRes.stderr);
  assert.equal(bundleRes.json?.success, true);
  assert.ok(fs.existsSync(bundleRes.json?.data?.zipPath));

  const publishAllLocalRes = runSkill({
    ...base,
    action: 'publish_all',
    payload: {
      ...base.payload,
      uploadZip: false,
      snapshotOnChain: false,
    },
  });
  assert.equal(publishAllLocalRes.code, 0, publishAllLocalRes.stdout || publishAllLocalRes.stderr);
  assert.equal(publishAllLocalRes.json?.success, true);
  assert.equal(publishAllLocalRes.json?.data?.steps?.publish_zip?.skipped, true);
  assert.ok(String(publishAllLocalRes.json?.data?.steps?.publish_snapshot?.snapshot?.zipUri || '').startsWith('file://'));

  const publishAllReuseUriRes = runSkill({
    ...base,
    action: 'publish_all',
    payload: {
      ...base.payload,
      uploadZip: false,
      zipUri: 'metafile://selftest-zip-pin',
      snapshotOnChain: false,
    },
  });
  assert.equal(publishAllReuseUriRes.code, 0, publishAllReuseUriRes.stdout || publishAllReuseUriRes.stderr);
  assert.equal(publishAllReuseUriRes.json?.success, true);
  assert.equal(publishAllReuseUriRes.json?.data?.steps?.publish_zip?.zipUri, 'metafile://selftest-zip-pin');
  assert.ok(publishAllReuseUriRes.json?.data?.steps?.publish_snapshot?.snapshotPath);

  const publishZipInvalidRes = runSkill({
    ...base,
    action: 'publish_zip',
    payload: {
      ...base.payload,
      zipPath: bundleRes.json?.data?.zipPath,
      uploadZip: false,
    },
  });
  assert.equal(publishZipInvalidRes.code, 1, publishZipInvalidRes.stdout || publishZipInvalidRes.stderr);
  assert.equal(publishZipInvalidRes.json?.success, false);
  assert.equal(publishZipInvalidRes.json?.error?.code, 'invalid_payload');

  process.stdout.write('metabot-llm-wiki self-test passed\n');
}

main();
