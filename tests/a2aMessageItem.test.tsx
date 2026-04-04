import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import A2AMessageItem from '../src/renderer/components/cowork/A2AMessageItem';

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
