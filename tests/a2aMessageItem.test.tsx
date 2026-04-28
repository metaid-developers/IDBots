import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import A2AMessageItem, {
  parseMetafileUri,
  prepareMetafilePreview,
  triggerMetafileDownload,
} from '../src/renderer/components/cowork/A2AMessageItem';

const METAID_CONTENT_API_RE = /https:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/content\//;

test('A2A normal message bubble renders markdown content', () => {
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-1',
        type: 'assistant',
        content: 'Hello **world**',
        timestamp: 1_744_444_444_000,
        metadata: { direction: 'outgoing' },
      }}
      metabotName="Local Bot"
    />
  );

  assert.match(markup, /<strong[^>]*>world<\/strong>/);
  assert.doesNotMatch(markup, /\*\*world\*\*/);
});

test('A2A delivery result renders markdown content inside the bubble', () => {
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-2',
        type: 'user',
        content: '[DELIVERY] {"result":"## Done\\n\\n- item one\\n- item two"}',
        timestamp: 1_744_444_445_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot' },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /<h2[^>]*>Done<\/h2>/);
  assert.match(markup, /<li[^>]*>item one<\/li>/);
  assert.match(markup, /<li[^>]*>item two<\/li>/);
  assert.doesNotMatch(markup, />## Done</);
});

test('A2A delivery image keeps metafile text and renders image preview for .jpg', () => {
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-3',
        type: 'user',
        content: '[DELIVERY] {"result":"这是给你处理好的图片： metafile://aabbccddeeff00112233445566778899i0.jpg"}',
        timestamp: 1_744_444_446_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot' },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /metafile:\/\/aabbccddeeff00112233445566778899i0\.jpg/);
  assert.match(markup, /<img[^>]*src="https:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/content\/aabbccddeeff00112233445566778899i0"/);
  assert.match(markup, /PINID/);
  assert.match(markup, /aabbccddeeff00112233445566778899i0/);
  assert.match(markup, /下载文件/);
  assert.match(markup, METAID_CONTENT_API_RE);
  assert.doesNotMatch(markup, /metafile-indexer\/content\/aabbccddeeff00112233445566778899i0/);
});

test('A2A delivery renders embedded player for .mp4 metafile', () => {
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-4',
        type: 'user',
        content: '[DELIVERY] {"result":"视频交付： metafile://ffeeddccbbaa99887766554433221100i0.mp4"}',
        timestamp: 1_744_444_447_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot' },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /<video[^>]*controls/);
  assert.match(markup, /src="https:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/content\/ffeeddccbbaa99887766554433221100i0"/);
  assert.match(markup, /PINID/);
  assert.match(markup, /下载文件/);
});

test('A2A delivery previews modern image and video metafile extensions', () => {
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-modern-media',
        type: 'user',
        content: '[DELIVERY] {"result":"交付： metafile://imagepin001i0.webp\\n视频： metafile://videopin001i0.webm"}',
        timestamp: 1_744_444_447_500,
        metadata: { direction: 'incoming', senderName: 'Peer Bot' },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /<img[^>]*src="https:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/content\/imagepin001i0"/);
  assert.match(markup, /<video[^>]*src="https:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/content\/videopin001i0"/);
  assert.match(markup, /PINID:\s*imagepin001i0/);
  assert.match(markup, /PINID:\s*videopin001i0/);
});

test('A2A delivery renders embedded player for .mp3 metafile', () => {
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-5',
        type: 'user',
        content: '[DELIVERY] {"result":"音频交付： metafile://11223344556677889900aabbccddeeffi0.mp3"}',
        timestamp: 1_744_444_448_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot' },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /<audio[^>]*controls/);
  assert.match(markup, /src="https:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/content\/11223344556677889900aabbccddeeffi0"/);
  assert.match(markup, /PINID/);
  assert.match(markup, /下载文件/);
});

test('A2A metafile download uses native save dialog API when available', async () => {
  const item = parseMetafileUri('metafile://cafebabefeed00112233445566778899i0.pdf');
  assert.ok(item);
  const calls: unknown[] = [];
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    electron: {
      cowork: {
        downloadMetafile: async (input: unknown) => {
          calls.push(input);
          return { success: true, path: '/tmp/cafebabefeed00112233445566778899i0.pdf' };
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
    url: 'https://file.metaid.io/metafile-indexer/api/v1/files/content/cafebabefeed00112233445566778899i0',
    fileName: 'cafebabefeed00112233445566778899i0.pdf',
  }]);
});

test('A2A video preview asks Electron to prepare a local playable preview file', async () => {
  const item = parseMetafileUri('metafile://3b94a321a496a5a92e765acae78101d35ad42728b00b30d2ce085034eadcc1b0i0.mp4');
  assert.ok(item);
  const calls: unknown[] = [];
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    electron: {
      cowork: {
        prepareMetafilePreview: async (input: unknown) => {
          calls.push(input);
          return {
            success: true,
            fileUrl: 'file:///tmp/idbots-preview/3b94a321a496a5a92e765acae78101d35ad42728b00b30d2ce085034eadcc1b0i0.mp4',
          };
        },
      },
    },
  };

  try {
    const previewUrl = await prepareMetafilePreview(item);
    assert.equal(
      previewUrl,
      'file:///tmp/idbots-preview/3b94a321a496a5a92e765acae78101d35ad42728b00b30d2ce085034eadcc1b0i0.mp4',
    );
  } finally {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  }

  assert.deepEqual(calls, [{
    url: 'https://file.metaid.io/metafile-indexer/api/v1/files/content/3b94a321a496a5a92e765acae78101d35ad42728b00b30d2ce085034eadcc1b0i0',
    fileName: '3b94a321a496a5a92e765acae78101d35ad42728b00b30d2ce085034eadcc1b0i0.mp4',
  }]);
});

test('A2A delivery renders pin id and download button for unsupported metafile extension', () => {
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-6',
        type: 'user',
        content: '[DELIVERY] {"result":"文档交付： metafile://cafebabefeed00112233445566778899i0.pdf"}',
        timestamp: 1_744_444_449_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot' },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /PINID/);
  assert.match(markup, /下载文件/);
  assert.match(markup, /metafile:\/\/cafebabefeed00112233445566778899i0\.pdf/);
});

test('A2A delivery renders pin id and download button for metafile without extension', () => {
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-7',
        type: 'user',
        content: '[DELIVERY] {"result":"原始交付： metafile://8899aabbccddeeff0011223344556677i0"}',
        timestamp: 1_744_444_450_000,
        metadata: { direction: 'incoming', senderName: 'Peer Bot' },
      }}
      peerName="Peer Bot"
    />
  );

  assert.match(markup, /PINID/);
  assert.match(markup, /下载文件/);
  assert.match(markup, /metafile:\/\/8899aabbccddeeff0011223344556677i0/);
});
