import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBotBrowserHostService } from '../src/main/services/botBrowserHostService.ts';

const CANONICAL_GLOBAL_META_ID = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';

function createMetaApp(overrides = {}) {
  return {
    id: 'demo-app',
    sourcePinId: 'pin123i0',
    name: 'Local Demo',
    creatorMetaId: 'idq1publisher',
    description: 'Demo app',
    version: '1.0.0',
    entry: 'index.html',
    codePinId: 'code123i0',
    updatedAt: 1_700_000_000_000,
    sourceType: 'chain-community',
    prompt: '',
    icon: '',
    cover: '',
    ...overrides,
  };
}

function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    async json() {
      return payload;
    },
  };
}

function createHostService(overrides = {}) {
  return createBotBrowserHostService({
    listMetaApps: async () => [],
    resolveMetaAppPin: async () => ({
      ok: false,
      code: 'browser_resource_not_found',
      message: 'Resource not found.',
    }),
    installCommunityMetaApp: async () => ({
      success: false,
      error: 'Resource not found.',
    }),
    resolveMetaAppUrl: async () => 'http://127.0.0.1:17878/metaapps/demo-app',
    ...overrides,
  });
}

function createEnsProviderFactory(input) {
  return {
    id: 'ens',
    supportsName(name) {
      return String(name ?? '').trim().toLowerCase().endsWith('.eth');
    },
    async resolveNameAlias(request) {
      return {
        ok: true,
        data: {
          provider: 'ens',
          normalizedName: String(request.name ?? '').trim().toLowerCase(),
          textKey: input.textKey,
          canonicalUri: `metaid://${CANONICAL_GLOBAL_META_ID}`,
          resolvedAt: 1_720_000_000_000,
          verificationState: 'verified',
          raw: {
            rpcUrls: [...input.rpcUrls],
          },
        },
      };
    },
  };
}

test('resolveResource keeps local MetaApp resolution working through the host service', async () => {
  const service = createHostService({
    listMetaApps: async () => [
      createMetaApp({ sourcePinId: ' pin123i0 ' }),
    ],
    resolveMetaAppUrl: async () => 'http://127.0.0.1:17878/metaapps/local-demo',
  });

  const result = await service.resolveResource({ uri: 'metaapp://PIN123I0' });

  assert.equal(result.ok, true);
  assert.equal(result.data.resourceType, 'metaapp');
  assert.equal(result.data.normalizedUri, 'metaapp://PIN123I0');
  assert.equal(result.data.renderer.url, 'http://127.0.0.1:17878/metaapps/local-demo');
});

test('resolveResource enriches pin owners through ABC profile fetching with host-default fetch', async () => {
  const pinId = '941c5cfe188a01f50c925c0dfab640b3e1a0638a22979c801e8b8c1f45dbda2di0';
  const ownerGlobalMetaId = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).includes(`/pin/${pinId}`)) {
      return createJsonResponse({
        code: 0,
        data: {
          pin: {
            pinId,
            ownerGlobalMetaId,
            contentType: 'application/json',
            contentBody: JSON.stringify({ title: 'Demo Pin' }),
          },
        },
      });
    }
    if (String(url).includes(`/api/info/globalmetaid/${ownerGlobalMetaId}`)) {
      return createJsonResponse({
        code: 0,
        data: {
          globalMetaId: ownerGlobalMetaId,
          name: 'Owner Bot',
          avatarId: 'avatar123i0',
        },
      });
    }
    return createJsonResponse({}, 404);
  };

  try {
    const service = createHostService();
    const result = await service.resolveResource({ uri: `pin://${pinId}` });

    assert.equal(result.ok, true);
    assert.equal(result.data.owner.globalMetaId, ownerGlobalMetaId);
    assert.equal(result.data.owner.name, 'Owner Bot');
    assert.equal(result.data.owner.avatar, 'https://file.metaid.io/metafile-indexer/content/avatar123i0');
    assert.deepEqual(fetchCalls, [
      `https://manapi.metaid.io/pin/${pinId}`,
      `https://so.metaid.io/api/info/globalmetaid/${ownerGlobalMetaId}`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getProfile reuses ABC fetchBotProfileInfo for Browser info hydration', async () => {
  const globalMetaId = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';
  const fetchCalls = [];
  const service = createHostService({
    fetch: async (url) => {
      fetchCalls.push(String(url));
      return createJsonResponse({
        code: 0,
        data: {
          globalMetaId,
          name: 'Related Bot',
          avatarId: 'relatedavatar123i0',
        },
      });
    },
  });

  const result = await service.getProfile({ globalMetaId });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, {
    globalMetaId,
    name: 'Related Bot',
    avatar: 'https://file.metaid.io/metafile-indexer/content/relatedavatar123i0',
  });
  assert.deepEqual(fetchCalls, [
    `https://so.metaid.io/api/info/globalmetaid/${globalMetaId}`,
  ]);
});

test('resolveResource resolves a bare ENS alias from host settings and preserves alias semantics', async () => {
  const fetchCalls = [];
  const providerFactoryCalls = [];
  const service = createHostService({
    fetch: async (url) => {
      fetchCalls.push(String(url));
      return createJsonResponse({
        code: 0,
        data: {
          schemaVersion: 'botHomepage.v3',
          identity: { globalMetaId: CANONICAL_GLOBAL_META_ID },
          profile: { name: 'Sunny Bot' },
        },
      });
    },
    ensNameAliasProviderFactory: (config) => {
      providerFactoryCalls.push(config);
      return createEnsProviderFactory(config);
    },
  });

  const updated = await service.updateSettings({
    browser: {
      nameResolution: {
        enabled: true,
        ens: {
          enabled: true,
          rpcUrls: ['https://rpc.example'],
          textKey: 'org.example.agent-browser.uri',
        },
      },
    },
  });
  assert.equal(updated.ok, true);

  const result = await service.resolveResource({ uri: 'sunnyfung.eth' });

  assert.equal(result.ok, true);
  assert.equal(result.data.uri, 'metaid://sunnyfung.eth');
  assert.equal(result.data.normalizedUri, 'metaid://sunnyfung.eth');
  assert.equal(result.data.owner.globalMetaId, CANONICAL_GLOBAL_META_ID);
  assert.deepEqual(providerFactoryCalls, [
    {
      chainId: 1,
      rpcUrls: ['https://rpc.example'],
      textKey: 'org.example.agent-browser.uri',
    },
  ]);
  assert.deepEqual(fetchCalls, [
    `https://so.metaid.io/api/bot-homepage/globalmetaid/${CANONICAL_GLOBAL_META_ID}?version=v3`,
  ]);
});

test('resolveResource resolves metaid:// ENS aliases and keeps the alias in the visible URI', async () => {
  const service = createHostService({
    fetch: async () => createJsonResponse({
      code: 0,
      data: {
        schemaVersion: 'botHomepage.v3',
        identity: { globalMetaId: CANONICAL_GLOBAL_META_ID },
        profile: { name: 'Sunny Bot' },
      },
    }),
    ensNameAliasProviderFactory: (config) => createEnsProviderFactory(config),
  });

  const result = await service.resolveResource({ uri: 'metaid://sunnyfung.eth' });

  assert.equal(result.ok, true);
  assert.equal(result.data.uri, 'metaid://sunnyfung.eth');
  assert.equal(result.data.normalizedUri, 'metaid://sunnyfung.eth');
  assert.equal(result.data.owner.globalMetaId, CANONICAL_GLOBAL_META_ID);
});

test('resolveResource returns name_resolution_unavailable when ENS is disabled in host settings', async () => {
  const providerFactoryCalls = [];
  const service = createHostService({
    ensNameAliasProviderFactory: (config) => {
      providerFactoryCalls.push(config);
      return createEnsProviderFactory(config);
    },
  });

  const updated = await service.updateSettings({
    browser: {
      nameResolution: {
        enabled: false,
        ens: {
          enabled: true,
          rpcUrls: ['https://rpc.example'],
          textKey: 'org.example.agent-browser.uri',
        },
      },
    },
  });
  assert.equal(updated.ok, true);

  const result = await service.resolveResource({ uri: 'sunnyfung.eth' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'name_resolution_unavailable');
  assert.deepEqual(providerFactoryCalls, []);
});

test('resolveResource returns name_resolution_unavailable when ENS rpcUrls are explicitly emptied', async () => {
  const providerFactoryCalls = [];
  const service = createHostService({
    ensNameAliasProviderFactory: (config) => {
      providerFactoryCalls.push(config);
      return createEnsProviderFactory(config);
    },
  });

  const updated = await service.updateSettings({
    browser: {
      nameResolution: {
        enabled: true,
        ens: {
          enabled: true,
          rpcUrls: [],
          textKey: 'org.example.agent-browser.uri',
        },
      },
    },
  });
  assert.equal(updated.ok, true);

  const settings = await service.getSettings();
  assert.equal(settings.ok, true);
  assert.deepEqual(settings.data.effectiveBrowser.nameResolution, {
    enabled: true,
    ens: {
      enabled: false,
      chainId: 1,
      rpcUrls: [],
      textKey: 'org.example.agent-browser.uri',
    },
  });

  const result = await service.resolveResource({ uri: 'sunnyfung.eth' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'name_resolution_unavailable');
  assert.deepEqual(providerFactoryCalls, []);
});

// ---------------------------------------------------------------------------
// On-chain Q&A question routing (feat/metaweb-qa phase 3)
// ---------------------------------------------------------------------------

const QA_QUESTION_PIN = '3afb11cc22dd44ee55ff66778899aabbccddeeff00112233445566778899aabbcc i0'.replace(' ', '');
const QA_DETAIL = () => ({
  question: {
    pinId: QA_QUESTION_PIN,
    currentPinId: QA_QUESTION_PIN,
    chainName: 'mvc',
    title: 'How to recover a wallet when the mnemonic is lost?',
    summary: 'User reinstalled and lost the mnemonic…',
    tags: ['wallet'],
    contentType: 'text/markdown',
    publisher: { globalMetaId: 'idq1asker', metaId: 'metaid-1', name: 'Asker Bot', avatar: '' },
    createdAt: 1755000000,
    isMempool: false,
    likeCount: 3,
    dislikeCount: 0,
    commentCount: 1,
    answerCount: 2,
    topAnswer: null,
  },
  answers: [],
  nextCursor: null,
  hasMore: false,
});

function createQaHarness(overrides = {}) {
  const calls = { question: [], appUrl: [] };
  const service = createHostService({
    resolveQaQuestion: async (pinId) => {
      calls.question.push(pinId);
      if (overrides.questionError) throw overrides.questionError;
      return overrides.questionResult !== undefined ? overrides.questionResult : QA_DETAIL();
    },
    resolveQaAppUrl: async (questionPinId) => {
      calls.appUrl.push(questionPinId);
      return `http://127.0.0.1:17878/qanda/app/index.html#q/${questionPinId}`;
    },
  });
  return { calls, service };
}

test('pin:// question pins open the bundled qanda app as an html-iframe resource', async () => {
  const { calls, service } = createQaHarness();
  const result = await service.resolveResource({ uri: `pin://${QA_QUESTION_PIN}` });
  assert.equal(result.ok, true);
  const resource = result.data;
  assert.equal(resource.renderer.type, 'html-iframe');
  assert.match(resource.renderer.url, /\/qanda\/app\/index\.html#q\//);
  assert.match(resource.renderer.url, new RegExp(QA_QUESTION_PIN));
  assert.equal(resource.title, 'How to recover a wallet when the mnemonic is lost?');
  assert.equal(resource.proof.protocolPath, '/protocols/simplequestion');
  assert.equal(resource.proof.pinId, QA_QUESTION_PIN);
  assert.equal(resource.status.state, 'resolved');
  assert.deepEqual(calls.question, [QA_QUESTION_PIN]);
  // Question pins re-probe on every open on purpose — the question page should
  // show fresh counts/answers. Only NON-question pins are negative-cached.
  await service.resolveResource({ uri: `pin://${QA_QUESTION_PIN}` });
  assert.deepEqual(calls.question, [QA_QUESTION_PIN, QA_QUESTION_PIN]);
});

test('non-question pins fall through to the generic resolver and are negative-cached', async () => {
  const { calls, service } = createQaHarness({ questionResult: null });
  const uri = 'pin://4b1c9e2a8b3d7f6e0a5c2d9b8e7f4a3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7abi0';
  const first = await service.resolveResource({ uri });
  // Fell through: the generic resolver runs (fails here because no fetch is
  // wired in this harness — the point is it was NOT short-circuited).
  assert.equal(first.ok, false);
  assert.equal(calls.question.length, 1);
  // Second open of the same pin: negative cache, no probe.
  await service.resolveResource({ uri });
  assert.equal(calls.question.length, 1);
});

test('an indeterminate probe (API failure) falls through WITHOUT negative caching', async () => {
  const { calls, service } = createQaHarness({ questionError: new Error('network down') });
  const uri = 'pin://5c2d9b8e7f4a3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7ab4b1c9e2a8b3d7f6ei0';
  const first = await service.resolveResource({ uri });
  assert.equal(first.ok, false, 'falls through to the generic resolver');
  await service.resolveResource({ uri });
  assert.equal(calls.question.length, 2, 'indeterminate answers are re-probed next time');
});

test('metaapp:// URIs bypass the Q&A probe entirely', async () => {
  const { calls, service } = createQaHarness();
  await service.resolveResource({ uri: 'metaapp://pin123i0' });
  assert.deepEqual(calls.question, []);
});

function createLocalPreviewHarness(files) {
  const sessions = [];
  return {
    sessions,
    createLocalPreviewSession: async (input) => {
      sessions.push(input);
      const previewId = `local-preview-test-${sessions.length}`;
      return {
        previewId,
        localPreviewUrl: `http://127.0.0.1:49999/browser-cache/metaapp-preview/${previewId}/${input.indexFile}`,
      };
    },
  };
}

test('resolveResource previews a markdown file via preview-file with a viewer session', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bot-browser-preview-file-'));
  try {
    const filePath = path.join(dir, 'note.md');
    await writeFile(filePath, '# hello', 'utf8');
    const harness = createLocalPreviewHarness();
    const service = createHostService(harness);

    const result = await service.resolveResource({ uri: `preview-file://localhost${filePath}` });

    assert.equal(result.ok, true);
    assert.equal(result.data.renderer.type, 'file-viewer');
    assert.equal(result.data.renderer.contentType, 'text/markdown; charset=utf-8');
    assert.match(result.data.renderer.url, /\?abc-viewer=1$/);
    assert.equal(result.data.resourceType, 'document');
    assert.equal(result.data.title, 'note.md');
    assert.equal(harness.sessions.length, 1);
    assert.equal(harness.sessions[0].viewer, true);
    assert.equal(harness.sessions[0].indexFile, 'note.md');
    assert.equal(harness.sessions[0].artifactDir, dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('resolveResource previews a pdf via preview-file without a viewer flag', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bot-browser-preview-file-'));
  try {
    const filePath = path.join(dir, 'paper.pdf');
    await writeFile(filePath, '%PDF-1.4', 'utf8');
    const harness = createLocalPreviewHarness();
    const service = createHostService(harness);

    const result = await service.resolveResource({ uri: `preview-file://localhost${filePath}` });

    assert.equal(result.ok, true);
    assert.equal(result.data.renderer.type, 'pdf');
    assert.equal(result.data.renderer.contentType, 'application/pdf');
    assert.equal(result.data.resourceType, 'pdf');
    assert.doesNotMatch(result.data.renderer.url, /abc-viewer/);
    assert.equal(harness.sessions.length, 1);
    assert.equal(harness.sessions[0].viewer, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('resolveResource rejects a preview-file directory and an unsupported extension', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bot-browser-preview-file-'));
  try {
    const docxPath = path.join(dir, 'report.docx');
    await writeFile(docxPath, 'x', 'utf8');
    const harness = createLocalPreviewHarness();
    const service = createHostService(harness);

    const dirResult = await service.resolveResource({ uri: `preview-file://localhost${dir}` });
    assert.equal(dirResult.ok, false);
    assert.match(dirResult.message, /preview-metaapp:\/\/ for directories/);

    const docxResult = await service.resolveResource({ uri: `preview-file://localhost${docxPath}` });
    assert.equal(docxResult.ok, true);
    assert.equal(docxResult.data.renderer.type, 'unsupported');
    assert.equal(docxResult.data.status.state, 'error');
    assert.equal(docxResult.data.renderer.url, undefined);
    // Unsupported kinds never reach the filesystem callback.
    assert.equal(harness.sessions.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('resolveResource serves a single-file preview-metaapp with its classified MIME', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bot-browser-preview-file-'));
  try {
    const filePath = path.join(dir, 'paper.pdf');
    await writeFile(filePath, '%PDF-1.4', 'utf8');
    const harness = createLocalPreviewHarness();
    const service = createHostService(harness);

    const result = await service.resolveResource({ uri: `preview-metaapp://localhost${filePath}` });

    assert.equal(result.ok, true);
    assert.equal(result.data.renderer.contentType, 'application/pdf');
    assert.equal(harness.sessions.length, 1);
    assert.equal(harness.sessions[0].viewer, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
