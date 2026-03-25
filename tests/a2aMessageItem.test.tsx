import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import A2AMessageItem from '../src/renderer/components/cowork/A2AMessageItem';

test('A2A delivery messages render the delivery result text instead of the raw envelope', () => {
  const payload = {
    paymentTxid: 'abc123',
    servicePinId: null,
    serviceName: 'Weather Query',
    result: '## 香港当前天气\n- 晴朗\n- 25°C',
    deliveredAt: 1774440568,
  };

  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'delivery-1',
        type: 'assistant',
        content: `[DELIVERY] ${JSON.stringify(payload)}`,
        timestamp: 1774440568000,
        metadata: {
          direction: 'incoming',
          senderName: 'AI_Sunny',
        },
      }}
      peerName="AI_Sunny"
      metabotName="AI_Ligong"
    />,
  );

  assert.match(markup, /## 香港当前天气/);
  assert.match(markup, /- 晴朗/);
  assert.doesNotMatch(markup, /\[DELIVERY\]/);
  assert.doesNotMatch(markup, /&quot;paymentTxid&quot;/);
  assert.doesNotMatch(markup, /<h2[^>]*>/);
});
