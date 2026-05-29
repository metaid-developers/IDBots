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

test('GigSquareServiceCard shows SPACE when service currency is MVC', () => {
  const markup = renderToStaticMarkup(
    <GigSquareServiceCard
      service={{
        id: 'svc-2',
        displayName: 'Legacy MVC Service',
        serviceName: 'legacy-mvc-service',
        description: 'Legacy service record',
        price: '1.25',
        currency: 'MVC',
        providerMetaId: 'meta-2',
        providerGlobalMetaId: 'global-2',
        providerAddress: 'addr-2',
      }}
      providerName="Legacy Bot"
      providerAvatarSrc="https://example.com/provider.png"
      providerLookupId="global-2"
      isOnline={true}
      onOpen={() => {}}
    />
  );

  assert.match(markup, /1\.25[\s\S]*SPACE/);
  assert.doesNotMatch(markup, /1\.25[\s\S]*MVC/);
});

test('GigSquareServiceCard renders free services without a zero currency price', () => {
  const markup = renderToStaticMarkup(
    <GigSquareServiceCard
      service={{
        id: 'svc-free',
        displayName: 'Free Weather',
        serviceName: 'free-weather-service',
        description: 'Free forecast',
        price: '0',
        currency: 'SPACE',
        paymentTiming: 'free',
        providerMetaId: 'meta-free',
        providerGlobalMetaId: 'global-free',
        providerAddress: 'addr-free',
      }}
      providerName="Forecast Bot"
      providerAvatarSrc="https://example.com/provider.png"
      providerLookupId="global-free"
      isOnline={true}
      onOpen={() => {}}
    />
  );

  assert.match(markup, /data-slot="gig-square-card-price"[\s\S]*Free/);
  assert.doesNotMatch(markup, /0[\s\S]*SPACE/);
});

test('GigSquareServiceCard renders provider skill allow-list chips', () => {
  const markup = renderToStaticMarkup(
    <GigSquareServiceCard
      service={{
        id: 'svc-skills',
        displayName: 'Multi Skill',
        serviceName: 'multi-skill-service',
        description: 'Uses allowed skills',
        price: '0.25',
        currency: 'SPACE',
        providerSkill: 'legacy',
        providerSkills: ['weather', 'reporter'],
        providerMetaId: 'meta-skills',
        providerGlobalMetaId: 'global-skills',
        providerAddress: 'addr-skills',
      }}
      providerName="Forecast Bot"
      providerAvatarSrc="https://example.com/provider.png"
      providerLookupId="global-skills"
      isOnline={true}
      onOpen={() => {}}
    />
  );

  assert.match(markup, /data-slot="gig-square-provider-skill-chips"[\s\S]*weather[\s\S]*reporter/);
  assert.doesNotMatch(markup, /data-slot="gig-square-provider-skill-chips"[\s\S]*legacy/);
});

test('GigSquareServiceCard does not render publisher execution reminder', () => {
  const markup = renderToStaticMarkup(
    <GigSquareServiceCard
      service={{
        id: 'svc-3',
        displayName: 'Weather Reminder Service',
        serviceName: 'weather-reminder-service',
        description: 'Public weather service description',
        executionReminder: '如果用户没指定城市就用北京。',
        price: '0',
        currency: 'SPACE',
        providerMetaId: 'meta-3',
        providerGlobalMetaId: 'global-3',
        providerAddress: 'addr-3',
      }}
      providerName="Forecast Bot"
      providerAvatarSrc={null}
      providerLookupId="global-3"
      isOnline={true}
      onOpen={() => {}}
    />
  );

  assert.match(markup, /Public weather service description/);
  assert.doesNotMatch(markup, /如果用户没指定城市就用北京/);
});
