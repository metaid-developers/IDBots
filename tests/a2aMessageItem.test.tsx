import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import A2AMessageItem, {
  createMetafileMediaObjectUrl,
  extractMetafileItems,
  formatA2ATxidPreview,
  getA2AMessageOrderTxid,
  isStrictMetafilePinId,
  parseMetafileUri,
  resetMetafileMetadataCacheForTests,
  resolveA2AMessageTxid,
  resolveMetafileMetadata,
  shouldShowA2AResendDigitalDeliveryAction,
  triggerMetafileDownload,
} from '../src/renderer/components/cowork/A2AMessageItem';

const METAID_ACCELERATE_CONTENT_API_RE = /https:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/accelerate\/content\//;
const METAID_CONTENT_API_RE = /https:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/content\//;

test('A2A normal message bubble renders markdown content', () => {
  const txid = '1'.repeat(64);
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-1',
        type: 'assistant',
        content: 'Hello **world**',
        timestamp: 1_744_444_444_000,
        metadata: { direction: 'outgoing', txid },
      }}
      metabotName="Local Bot"
    />
  );

  assert.match(markup, /<strong[^>]*>world<\/strong>/);
  assert.doesNotMatch(markup, /\*\*world\*\*/);
  assert.match(markup, /txid:/);
  assert.match(markup, /Local Bot/);
});

test('A2A incoming message does not render raw MetaID content avatar paths directly', () => {
  const txid = '1'.repeat(64);
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-raw-avatar',
        type: 'user',
        content: 'Hello',
        timestamp: 1_744_444_444_000,
        metadata: {
          direction: 'incoming',
          senderName: 'Eric',
          senderAvatar: '/content/92fcff9ceada16c20d26322748e877b2d48dee54cf09770768bb8b27998b90f9i0',
          txid,
        },
      }}
      peerName="Eric"
    />
  );

  assert.doesNotMatch(markup, /src="\/content\//);
});

test('A2A message avatars expose Bot Browser targets for both local and peer Bots', () => {
  const txid = '1'.repeat(64);
  const outgoingMarkup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-local-avatar-browser',
        type: 'assistant',
        content: 'Hello from local',
        timestamp: 1_744_444_444_000,
        metadata: { direction: 'outgoing', txid },
      }}
      metabotName="Local Bot"
      metabotAvatar="https://example.com/local.png"
      localGlobalMetaId="idq1localbot"
      peerGlobalMetaId="idq1peerbot"
      onOpenBotInBrowser={() => {}}
    />
  );

  assert.match(outgoingMarkup, /<button[^>]*data-browser-global-metaid="idq1localbot"[^>]*aria-label="Open Local Bot in Bot Browser"/);
  assert.doesNotMatch(outgoingMarkup, /data-browser-global-metaid="idq1peerbot"/);

  const incomingMarkup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-peer-avatar-browser',
        type: 'user',
        content: 'Hello from peer',
        timestamp: 1_744_444_444_000,
        metadata: {
          direction: 'incoming',
          senderName: 'Peer Bot',
          senderGlobalMetaId: 'idq1senderpeer',
          senderAvatar: 'https://example.com/peer.png',
          txid,
        },
      }}
      peerName="Fallback Peer"
      peerAvatar="https://example.com/fallback-peer.png"
      localGlobalMetaId="idq1localbot"
      peerGlobalMetaId="idq1fallbackpeer"
      onOpenBotInBrowser={() => {}}
    />
  );

  assert.match(incomingMarkup, /<button[^>]*data-browser-global-metaid="idq1senderpeer"[^>]*aria-label="Open Fallback Peer in Bot Browser"/);
  assert.doesNotMatch(incomingMarkup, /data-browser-global-metaid="idq1fallbackpeer"/);
});

test('A2A incoming message prefers the session-level peerName over the stale message snapshot', () => {
  const txid = 'a'.repeat(64);
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-stale-peer-name',
        type: 'user',
        content: 'Hello after the peer renamed itself',
        timestamp: 1_744_444_451_000,
        metadata: { direction: 'incoming', senderName: 'Twin Bot', txid },
      }}
      peerName="小峰"
    />
  );

  assert.match(markup, /小峰/);
  assert.doesNotMatch(markup, /Twin Bot/);
});

test('A2A incoming message falls back to the message-level senderName when peerName is missing', () => {
  const txid = 'b'.repeat(64);
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-sender-name-fallback',
        type: 'user',
        content: 'Hello from a snapshot-only peer',
        timestamp: 1_744_444_452_000,
        metadata: { direction: 'incoming', senderName: 'Snapshot Peer', txid },
      }}
    />
  );

  assert.match(markup, /Snapshot Peer/);
});

test('A2A non-chain assistant messages render as plain notices without an internal-status header', () => {
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-local-only',
        type: 'assistant',
        content: '本地执行结果，还没有发到链上。',
        timestamp: 1_744_444_444_000,
        metadata: { direction: 'outgoing', isFinal: true },
      }}
      metabotName="Local Bot"
    />
  );

  assert.match(markup, /本地执行结果，还没有发到链上。/);
  assert.doesNotMatch(markup, /内部状态|Internal status/);
  assert.doesNotMatch(markup, /Local Bot/);
  assert.doesNotMatch(markup, /rounded-2xl/);
});

test('A2A message bubble renders subtle txid label from message metadata', () => {
  const txid = '56ddbdab' + 'c'.repeat(56);
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-txid',
        type: 'assistant',
        content: 'Hello with txid',
        timestamp: 1_744_444_444_000,
        metadata: { direction: 'outgoing', txid },
      }}
      metabotName="Local Bot"
    />
  );

  assert.equal(formatA2ATxidPreview(txid), '56ddbdab....');
  assert.match(markup, /txid:/);
  assert.match(markup, /56ddbdab\.\.\.\./);
  assert.match(markup, /title="[^"]*copy/i);
  assert.match(markup, /class="[^"]*text-\[10px\][^"]*text-claude-textSecondary/);
});

test('A2A message txid resolver accepts message-chain metadata but ignores order payment txid fallback', () => {
  const pinTxid = 'a'.repeat(64);
  assert.equal(
    resolveA2AMessageTxid({
      id: 'msg-pin',
      type: 'user',
      content: 'plain',
      timestamp: 1,
      metadata: { direction: 'incoming', pinId: `${pinTxid}i0` },
    }),
    pinTxid,
  );

  const paymentTxid = 'b'.repeat(64);
  assert.equal(
    resolveA2AMessageTxid({
      id: 'msg-order',
      type: 'user',
      content: `[ORDER] test\n支付金额 0.1 SPACE\ntxid: ${paymentTxid}`,
      timestamp: 1,
      metadata: { direction: 'incoming' },
    }),
    '',
  );

  const deliveryTxid = 'c'.repeat(64);
  assert.equal(
    resolveA2AMessageTxid({
      id: 'msg-delivery',
      type: 'assistant',
      content: `[DELIVERY] {"paymentTxid":"${deliveryTxid}","result":"done"}`,
      timestamp: 1,
      metadata: { direction: 'outgoing' },
    }),
    '',
  );

  const messageTxid = 'd'.repeat(64);
  assert.equal(
    resolveA2AMessageTxid({
      id: 'msg-metadata',
      type: 'assistant',
      content: `[DELIVERY] {"paymentTxid":"${deliveryTxid}","result":"done"}`,
      timestamp: 1,
      metadata: { direction: 'outgoing', txid: messageTxid, paymentTxid },
    }),
    messageTxid,
  );
});

test('A2A delivery result renders markdown content inside the bubble', () => {
  const txid = '2'.repeat(64);
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-2',
        type: 'user',
        content: '[DELIVERY] {"result":"## Done\\n\\n- item one\\n- item two"}',
        timestamp: 1_744_444_445_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot', txid },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /<h2[^>]*>Done<\/h2>/);
  assert.match(markup, /<li[^>]*>item one<\/li>/);
  assert.match(markup, /<li[^>]*>item two<\/li>/);
  assert.doesNotMatch(markup, />## Done</);
});

test('A2A delivery result supports order-scoped DELIVERY tags', () => {
  const txid = '2'.repeat(64);
  const orderTxid = 'a'.repeat(64);
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-2-scoped',
        type: 'user',
        content: `[DELIVERY:${orderTxid}] {"result":"## Done\\n\\n- item one"}`,
        timestamp: 1_744_444_445_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot', txid },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /<h2[^>]*>Done<\/h2>/);
  assert.match(markup, /<li[^>]*>item one<\/li>/);
  assert.doesNotMatch(markup, /\[DELIVERY:/);
});

test('A2A order protocol messages hide routing tags in chat bubbles', () => {
  const txid = '6'.repeat(64);
  const orderTxid = 'a'.repeat(64);
  const cases = [
    {
      content: `[ORDER_STATUS:${orderTxid}] 正在上传链上交付。`,
      visible: '正在上传链上交付。',
      hidden: '[ORDER_STATUS:',
    },
    {
      content: `[NeedsRating:${orderTxid}] 请评价本次服务。`,
      visible: '请评价本次服务。',
      hidden: '[NeedsRating:',
    },
    {
      content: `[ORDER_END:${orderTxid} rated] 评分：5分。`,
      visible: '评分：5分。',
      hidden: '[ORDER_END:',
    },
    {
      content: '[ORDER_END rating_timeout] 等待评价超时，订单已结束。',
      visible: '等待评价超时，订单已结束。',
      hidden: '[ORDER_END rating_timeout]',
    },
  ];

  cases.forEach((item, i) => {
    const markup = renderToStaticMarkup(
      <A2AMessageItem
        message={{
          // Neutral fixture id: embedding the tag in the id would leak it into
          // the data-message-id anchor attribute and defeat the full-markup
          // doesNotMatch assertion below (false positive, seen on 90da59fb).
          id: `msg-order-protocol-${i}`,
          type: 'assistant',
          content: item.content,
          timestamp: 1_744_444_445_500,
          metadata: { direction: 'outgoing', txid },
        }}
        metabotName="Local Bot"
      />
    );

    assert.match(markup, new RegExp(item.visible.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(markup, new RegExp(item.hidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('A2A upload notice renders an order-scoped resend digital delivery action', () => {
  const orderTxid = 'a'.repeat(64);
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-upload-notice',
        type: 'assistant',
        content: `[ORDER_STATUS:${orderTxid}] 技能执行完毕，数字成果已生成，正在将数字成果上传链上交付，请耐心等待。`,
        timestamp: 1_744_444_445_500,
        metadata: {
          direction: 'outgoing',
          orderRole: 'seller',
          orderDeliveryUploadNotice: true,
          orderTxid,
        },
      }}
      metabotName="Local Bot"
      canResendDigitalDelivery
      isResendingDigitalDelivery={false}
      onResendDigitalDelivery={() => {}}
    />
  );

  assert.equal(
    getA2AMessageOrderTxid({
      id: 'msg-upload-notice',
      type: 'assistant',
      content: `[ORDER_STATUS:${orderTxid}] upload`,
      timestamp: 1,
      metadata: { orderTxid },
    }),
    orderTxid
  );
  assert.equal(
    shouldShowA2AResendDigitalDeliveryAction({
      id: 'msg-upload-notice',
      type: 'assistant',
      content: `[ORDER_STATUS:${orderTxid}] upload`,
      timestamp: 1,
      metadata: { direction: 'outgoing', orderRole: 'seller', orderDeliveryUploadNotice: true },
    }, true),
    true
  );
  assert.match(markup, /再次发送数字成果|Resend digital delivery/);
  assert.match(markup, new RegExp(`data-order-txid="${orderTxid}"`));
  assert.doesNotMatch(markup, /\[ORDER_STATUS:/);
  assert.doesNotMatch(markup, /内部状态|Internal status/);
});

test('A2A upload notice hides resend action when it is not tied to a seller order', () => {
  const orderTxid = 'b'.repeat(64);
  assert.equal(
    shouldShowA2AResendDigitalDeliveryAction({
      id: 'msg-notice-without-flag',
      type: 'assistant',
      content: `[ORDER_STATUS:${orderTxid}] upload`,
      timestamp: 1,
      metadata: { direction: 'outgoing', orderRole: 'seller' },
    }, true),
    false
  );
  assert.equal(
    shouldShowA2AResendDigitalDeliveryAction({
      id: 'msg-notice-without-order',
      type: 'assistant',
      content: 'upload',
      timestamp: 1,
      metadata: { direction: 'outgoing', orderRole: 'seller', orderDeliveryUploadNotice: true },
    }, true),
    false
  );
  assert.equal(
    shouldShowA2AResendDigitalDeliveryAction({
      id: 'msg-buyer-notice',
      type: 'assistant',
      content: `[ORDER_STATUS:${orderTxid}] upload`,
      timestamp: 1,
      metadata: { direction: 'incoming', orderRole: 'buyer', orderDeliveryUploadNotice: true },
    }, true),
    false
  );
});

test('A2A delivery image keeps metafile text and renders image preview for .jpg', () => {
  const txid = '3'.repeat(64);
  const pinId = `${'aabbccdd'.repeat(8)}i0`;
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-3',
        type: 'user',
        content: `[DELIVERY] {"result":"这是给你处理好的图片： metafile://${pinId}.jpg"}`,
        timestamp: 1_744_444_446_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot', txid },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, new RegExp(`metafile://${pinId}\\.jpg`));
  assert.match(markup, new RegExp(`<img[^>]*src="https://file\\.metaid\\.io/metafile-indexer/api/v1/files/accelerate/content/${pinId}"`));
  assert.match(markup, /data-metafile-zoom="image"/);
  assert.match(markup, /PINID/);
  assert.match(markup, new RegExp(pinId));
  assert.match(markup, /下载文件|Download file/);
  assert.match(markup, METAID_ACCELERATE_CONTENT_API_RE);
  assert.doesNotMatch(markup, METAID_CONTENT_API_RE);
  assert.doesNotMatch(markup, new RegExp(`metafile-indexer/content/${pinId}`));
});

test('A2A delivery renders embedded player for .mp4 metafile', () => {
  const txid = '4'.repeat(64);
  const pinId = `${'ffeeddcc'.repeat(8)}i0`;
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-4',
        type: 'user',
        content: `[DELIVERY] {"result":"视频交付： metafile://${pinId}.mp4"}`,
        timestamp: 1_744_444_447_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot', txid },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /<video[^>]*controls/);
  assert.match(markup, /<video[^>]*preload="auto"/);
  assert.match(markup, /<video[^>]*playsinline/);
  assert.match(markup, /data-metafile-zoom="video"/);
  assert.match(markup, new RegExp(`<source[^>]*src="https://file\\.metaid\\.io/metafile-indexer/api/v1/files/accelerate/content/${pinId}"`));
  assert.doesNotMatch(markup, new RegExp(`<source[^>]*src="https://file\\.metaid\\.io/metafile-indexer/api/v1/files/content/${pinId}"`));
  assert.match(markup, /PINID/);
  assert.match(markup, /下载文件|Download file/);
});

test('A2A delivery previews modern image and video metafile extensions', () => {
  const txid = '5'.repeat(64);
  const imgPinId = `${'11223344'.repeat(8)}i0`;
  const vidPinId = `${'55667788'.repeat(8)}i0`;
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-modern-media',
        type: 'user',
        content: `[DELIVERY] {"result":"交付： metafile://${imgPinId}.webp\\n视频： metafile://${vidPinId}.webm"}`,
        timestamp: 1_744_444_447_500,
        metadata: { direction: 'incoming', senderName: 'Peer Bot', txid },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, new RegExp(`<img[^>]*src="https://file\\.metaid\\.io/metafile-indexer/api/v1/files/accelerate/content/${imgPinId}"`));
  assert.match(markup, /<video[^>]*controls/);
  assert.match(markup, new RegExp(`<source[^>]*src="https://file\\.metaid\\.io/metafile-indexer/api/v1/files/accelerate/content/${vidPinId}"`));
  assert.doesNotMatch(markup, new RegExp(`<source[^>]*src="https://file\\.metaid\\.io/metafile-indexer/api/v1/files/content/${vidPinId}"`));
  assert.match(markup, new RegExp(`PINID:\\s*${imgPinId}`));
  assert.match(markup, new RegExp(`PINID:\\s*${vidPinId}`));
});

test('A2A delivery renders embedded player for .mp3 metafile', () => {
  const txid = '6'.repeat(64);
  const pinId = `${'9900aabb'.repeat(8)}i0`;
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-5',
        type: 'user',
        content: `[DELIVERY] {"result":"音频交付： metafile://${pinId}.mp3"}`,
        timestamp: 1_744_444_448_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot', txid },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /<audio[^>]*controls/);
  assert.match(markup, new RegExp(`<source[^>]*src="https://file\\.metaid\\.io/metafile-indexer/api/v1/files/accelerate/content/${pinId}"`));
  assert.doesNotMatch(markup, new RegExp(`src="https://file\\.metaid\\.io/metafile-indexer/api/v1/files/content/${pinId}"`));
  assert.match(markup, /PINID/);
  assert.match(markup, /下载文件|Download file/);
});

test('A2A metafile parser keeps accelerate URL primary and content URL fallback', () => {
  const pinId = `${'aabbccdd'.repeat(8)}i0`;
  const item = parseMetafileUri(`metafile://${pinId}.png`);
  assert.ok(item);
  assert.equal(
    item.sourceUrl,
    `https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/${pinId}`,
  );
  assert.equal(
    item.fallbackUrl,
    `https://file.metaid.io/metafile-indexer/api/v1/files/content/${pinId}`,
  );
});

test('A2A metafile download uses native save dialog API when available', async () => {
  const pinId = `${'cafebabe'.repeat(8)}i0`;
  const item = parseMetafileUri(`metafile://${pinId}.pdf`);
  assert.ok(item);
  const calls: unknown[] = [];
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    electron: {
      cowork: {
        downloadMetafile: async (input: unknown) => {
          calls.push(input);
          return { success: true, path: `/tmp/${pinId}.pdf` };
        },
      },
    },
  };

  try {
    await triggerMetafileDownload(item);
  } finally {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  }

  assert.deepEqual(calls, [{
    url: `https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/${pinId}`,
    fallbackUrl: `https://file.metaid.io/metafile-indexer/api/v1/files/content/${pinId}`,
    fileName: `${pinId}.pdf`,
  }]);
});

test('A2A media preview does not download a local preview before playback', () => {
  const txid = '9'.repeat(64);
  const calls: unknown[] = [];
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    electron: {
      cowork: {
        prepareMetafilePreview: async (input: unknown) => {
          calls.push(input);
          return { success: false, error: 'should not be called' };
        },
      },
    },
  };

  try {
    renderToStaticMarkup(
      <A2AMessageItem
        message={{
          id: 'msg-online-video',
          type: 'user',
          content: '[DELIVERY] {"result":"视频交付： metafile://3b94a321a496a5a92e765acae78101d35ad42728b00b30d2ce085034eadcc1b0i0.mp4"}',
          timestamp: 1_744_444_447_000,
          metadata: { direction: 'incoming', senderName: 'Peer Bot', txid },
        }}
        peerName="Peer Bot"
      />
    );
  } finally {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  }

  assert.deepEqual(calls, []);
});

test('A2A media preview fallback loads original content URL into a blob URL', async () => {
  const item = parseMetafileUri('metafile://3b94a321a496a5a92e765acae78101d35ad42728b00b30d2ce085034eadcc1b0i0.mp4');
  assert.ok(item);
  const originalFetch = globalThis.fetch;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const fetchCalls: string[] = [];
  const blobCalls: Array<{ type: string; size: number }> = [];
  let progressBytes = 0;

  globalThis.fetch = (async (url: RequestInfo | URL) => {
    fetchCalls.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'video/mp4;binary' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    } as Response;
  }) as typeof fetch;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      blobCalls.push({ type: blob.type, size: blob.size });
      return 'blob:idbots-preview';
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: () => undefined,
  });

  try {
    const previewUrl = await createMetafileMediaObjectUrl(item, (bytes) => {
      progressBytes = bytes;
    });
    assert.equal(previewUrl, 'blob:idbots-preview');
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectUrl,
    });
  }

  assert.deepEqual(fetchCalls, [
    'https://file.metaid.io/metafile-indexer/api/v1/files/content/3b94a321a496a5a92e765acae78101d35ad42728b00b30d2ce085034eadcc1b0i0',
  ]);
  assert.deepEqual(blobCalls, [{ type: 'video/mp4', size: 4 }]);
  assert.equal(progressBytes, 4);
});

test('A2A delivery renders pin id and download button for unsupported metafile extension', () => {
  const txid = '7'.repeat(64);
  const pinId = `${'cafebabe'.repeat(8)}i0`;
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-6',
        type: 'user',
        content: `[DELIVERY] {"result":"文档交付： metafile://${pinId}.pdf"}`,
        timestamp: 1_744_444_449_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot', txid },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /PINID/);
  assert.match(markup, /下载文件|Download file/);
  assert.match(markup, new RegExp(`metafile://${pinId}\\.pdf`));
});

test('A2A delivery renders pin id and download button for metafile without extension', () => {
  const txid = '8'.repeat(64);
  const pinId = `${'8899aabb'.repeat(8)}i0`;
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-7',
        type: 'user',
        content: `[DELIVERY] {"result":"原始交付： metafile://${pinId}"}`,
        timestamp: 1_744_444_450_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot', txid },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /PINID/);
  assert.match(markup, /下载文件|Download file/);
  assert.match(markup, new RegExp(`metafile://${pinId}`));
});

test('strict 64hex+i0 metafile extraction ignores bare scheme mentions, strips adjacent Chinese/Markdown punctuation, and extracts all items', () => {
  assert.equal(isStrictMetafilePinId('67619dbb61bdd9ba7f5d8051b797846c1467e63a2d43f7acd8a1e7f3193f5e1ei0'), true);
  assert.equal(isStrictMetafilePinId('67619dbb61bdd9ba7f5d8051b797846c1467e63a2d43f7acd8a1e7f3193f5e1e'), false);
  assert.equal(isStrictMetafilePinId('short123i0'), false);

  // Real regression cases from session 0adc754f-5df0-42db-a466-22e2eeeba415:
  // 1) bf7d18c3...: prose mention of "metafile://" followed by Chinese punctuation
  assert.deepEqual(
    extractMetafileItems('二进制/图片走 upload_file（拿 metafile://）——用什么协议你自报即可，重点是之后你报给我的指针必须与链一致；'),
    [],
  );
  // 2) bdb38656...: "（pin:// 或 metafile://）三账自洽，④事件件"
  assert.deepEqual(
    extractMetafileItems('落盘路径+sha256+链上指针（pin:// 或 metafile://）三账自洽，④事件件 payload 里 pairWith 留空。'),
    [],
  );
  // 3) fedac99b...: valid 64hex+i0 immediately followed by full-width Chinese "（66 全形）"
  const fedaItems = extractMetafileItems(
    'artifactSelfRef=选向 A 定稿 metafile://67619dbb61bdd9ba7f5d8051b797846c1467e63a2d43f7acd8a1e7f3193f5e1ei0（66 全形）✓',
  );
  assert.equal(fedaItems.length, 1);
  assert.equal(fedaItems[0]?.pinId, '67619dbb61bdd9ba7f5d8051b797846c1467e63a2d43f7acd8a1e7f3193f5e1ei0');

  // 4) 6793182f9...: Markdown table with 3 [metafile://...](metafile://...) links
  const tableItems = extractMetafileItems([
    '| **A 素笺提笔** | [metafile://67619dbb61bdd9ba7f5d8051b797846c1467e63a2d43f7acd8a1e7f3193f5e1ei0](metafile://67619dbb61bdd9ba7f5d8051b797846c1467e63a2d43f7acd8a1e7f3193f5e1ei0) |',
    '| B 流水工单 | [metafile://72d907fc19e8ad34821aeafbd6af6e11c9e4e790c49e9b82926a1d5c089cc540i0](metafile://72d907fc19e8ad34821aeafbd6af6e11c9e4e790c49e9b82926a1d5c089cc540i0) |',
    '| C 夜读暗场 | [metafile://75f18c82fd9161c0ff8b801d57ff409be07de2291a45fa12963ab59ff32133b5i0](metafile://75f18c82fd9161c0ff8b801d57ff409be07de2291a45fa12963ab59ff32133b5i0) |',
  ].join('\n'));
  assert.deepEqual(
    tableItems.map((item) => item.pinId),
    [
      '67619dbb61bdd9ba7f5d8051b797846c1467e63a2d43f7acd8a1e7f3193f5e1ei0',
      '72d907fc19e8ad34821aeafbd6af6e11c9e4e790c49e9b82926a1d5c089cc540i0',
      '75f18c82fd9161c0ff8b801d57ff409be07de2291a45fa12963ab59ff32133b5i0',
    ],
  );
});

test('A2A gallery extracts and renders 4 mixed metafiles (2 images, 1 video, 1 zip) with zoom and download controls', () => {
  const txid = 'a'.repeat(64);
  const img1 = `${'11'.repeat(32)}i0`;
  const img2 = `${'22'.repeat(32)}i0`;
  const vid1 = `${'33'.repeat(32)}i0`;
  const zip1 = `${'44'.repeat(32)}i0`;
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-mixed-4',
        type: 'assistant',
        content: [
          `图一：metafile://${img1}.png`,
          `图二：**metafile://${img2}.jpg**（样张）`,
          `视频：[演示](metafile://${vid1}.mp4)`,
          `源码包：\`metafile://${zip1}.zip\``,
        ].join('\n'),
        timestamp: 1_744_444_455_000,
        metadata: { direction: 'outgoing', txid },
      }}
      metabotName="Local Bot"
    />
  );

  assert.match(markup, /data-metafile-gallery="true"/);
  assert.match(markup, new RegExp(`data-metafile-card="${img1}"[^>]*data-metafile-kind="image"`));
  assert.match(markup, new RegExp(`data-metafile-card="${img2}"[^>]*data-metafile-kind="image"`));
  assert.match(markup, new RegExp(`data-metafile-card="${vid1}"[^>]*data-metafile-kind="video"`));
  assert.match(markup, new RegExp(`data-metafile-card="${zip1}"[^>]*data-metafile-kind="download"`));
  assert.equal((markup.match(/data-metafile-zoom="image"/g) || []).length, 2);
  assert.equal((markup.match(/data-metafile-zoom="video"/g) || []).length, 1);
  assert.equal((markup.match(/下载文件|Download file/g) || []).length, 4);
});

test('resolveMetafileMetadata detects image/video MIME and extension for extensionless 64hex+i0 metafiles and caches for rendering', async () => {
  resetMetafileMetadataCacheForTests();
  const pinA = '67619dbb61bdd9ba7f5d8051b797846c1467e63a2d43f7acd8a1e7f3193f5e1ei0';
  const pinB = '72d907fc19e8ad34821aeafbd6af6e11c9e4e790c49e9b82926a1d5c089cc540i0';
  const itemA = parseMetafileUri(`metafile://${pinA}`, { strictPinId: true });
  const itemB = parseMetafileUri(`metafile://${pinB}`, { strictPinId: true });
  assert.ok(itemA);
  assert.ok(itemB);
  assert.equal(itemA.kind, 'download');

  // 1) Info JSON endpoint path
  const resolvedA = await resolveMetafileMetadata(itemA, (async (url: RequestInfo | URL) => {
    assert.match(String(url), new RegExp(`/api/v1/files/${pinA}$`));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        data: {
          content_type: 'image/png;binary',
          file_type: 'image',
          file_extension: '.png',
          file_name: '',
          file_size: 135574,
        },
      }),
    } as Response;
  }) as typeof fetch);
  assert.equal(resolvedA.kind, 'image');
  assert.equal(resolvedA.extension, '.png');
  assert.equal(resolvedA.fileName, `${pinA}.png`);
  assert.equal(resolvedA.fileSize, 135574);

  // 2) HEAD fallback path when info endpoint fails
  const resolvedB = await resolveMetafileMetadata(itemB, (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method) {
      return { ok: false, status: 404 } as Response;
    }
    assert.equal(init.method, 'HEAD');
    assert.match(String(url), /accelerate\/content/);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/webp', 'content-length': '42000' }),
    } as Response;
  }) as typeof fetch);
  assert.equal(resolvedB.kind, 'image');
  assert.equal(resolvedB.extension, '.webp');
  assert.equal(resolvedB.fileName, `${pinB}.webp`);

  // Once cached, A2AMessageItem renders the extensionless URIs directly as image cards!
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-resolved-images',
        type: 'user',
        content: `[metafile://${pinA}](metafile://${pinA}) and [metafile://${pinB}](metafile://${pinB})`,
        timestamp: 1_744_444_456_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot', txid: 'c'.repeat(64) },
      }}
      peerName="Peer Bot"
    />
  );
  assert.match(markup, new RegExp(`data-metafile-card="${pinA}"[^>]*data-metafile-kind="image"`));
  assert.match(markup, new RegExp(`data-metafile-card="${pinB}"[^>]*data-metafile-kind="image"`));
  resetMetafileMetadataCacheForTests();
});

test('A2A bubble hides leaked Local Time Context blocks from historical chain messages', () => {
  const txid = 'e'.repeat(64);
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-leaked-ltc',
        type: 'user',
        content: [
          '④ 补发回来了，回报告示——挂账已清。',
          '',
          '## Local Time Context',
          '- Treat this section as the authoritative current local time for this machine.',
          '- Current local datetime: 2026-11-09 04:10:09 (timezone: Asia/Shanghai, UTC+08:00)',
          '- 当前 CoWork 会话 ID: 05a159e1-936f-494f-9d9c-5f345b74c64f',
          '- 创建一次性定时任务 (`schedule.type = "at"`) 时，请使用本地时钟日期时间格式。',
        ].join('\n'),
        timestamp: 1_744_444_457_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot', txid },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /④ 补发回来了，回报告示——挂账已清。/);
  assert.doesNotMatch(markup, /Local Time Context/);
  assert.doesNotMatch(markup, /05a159e1-936f-494f-9d9c-5f345b74c64f/);
});

test('A2A incoming message renders the friend badge beside the peer name when confirmed friends', () => {
  const txid = '9'.repeat(64);
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-friend-1',
        type: 'user',
        content: '合作愉快！',
        timestamp: 1_744_444_460_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot', txid },
      }}
      peerName="Peer Bot"
      peerIsFriend
    />
  );

  assert.match(markup, /data-friend-badge="true"/);
  assert.match(markup, /好友|Friend/);
});

test('A2A message without a confirmed friendship renders no friend badge', () => {
  const txid = '9'.repeat(64);
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-friend-2',
        type: 'user',
        content: '初次见面。',
        timestamp: 1_744_444_461_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot', txid },
      }}
      peerName="Peer Bot"
    />
  );

  assert.doesNotMatch(markup, /data-friend-badge/);
});

test('A2A friend badge never renders on the local bot side', () => {
  const txid = '9'.repeat(64);
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-friend-3',
        type: 'assistant',
        content: '本地回复',
        timestamp: 1_744_444_462_000,
        metadata: { direction: 'outgoing', txid },
      }}
      metabotName="Local Bot"
      peerIsFriend
    />
  );

  assert.doesNotMatch(markup, /data-friend-badge/);
});
