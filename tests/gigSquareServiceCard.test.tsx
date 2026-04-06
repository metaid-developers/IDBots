import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GigSquareServiceCard from '../src/renderer/components/gigSquare/GigSquareServiceCard';

test('GigSquareServiceCard renders title on its own row and keeps service name with price in the meta row', () => {
  const markup = renderToStaticMarkup(
    <GigSquareServiceCard
      service={{
        id: 'svc-1',
        displayName: 'Weather Oracle Ultra Long Title',
        serviceName: 'weather-oracle-service',
        description: 'Detailed forecasts',
        price: '0.25',
        currency: 'SPACE',
        providerMetaId: 'meta-1',
        providerGlobalMetaId: 'global-1',
        providerAddress: 'addr-1',
      }}
      providerName="Forecast Bot"
      providerAvatarSrc="https://example.com/provider.png"
      providerLookupId="global-1"
      isOnline={true}
      onOpen={() => {}}
    />
  );

  assert.match(
    markup,
    /data-slot="gig-square-card-title"[^>]*>Weather Oracle Ultra Long Title<\/div>/,
  );
  assert.match(
    markup,
    /data-slot="gig-square-card-meta-row"[\s\S]*weather-oracle-service[\s\S]*data-slot="gig-square-card-price"[\s\S]*0\.25[\s\S]*SPACE/,
  );
});
