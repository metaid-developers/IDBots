import test from 'node:test';
import assert from 'node:assert/strict';

test('anthropicToOpenAI gives empty SDK web tool schemas valid OpenAI function parameters', async () => {
  const { anthropicToOpenAI } = await import('../dist-electron/libs/coworkFormatTransform.js');

  const converted = anthropicToOpenAI({
    model: 'test-model',
    messages: [{ role: 'user', content: 'search the web' }],
    tools: [
      {
        name: 'web_search',
        description: 'Search the web',
        input_schema: null,
      },
      {
        name: 'web_fetch',
        description: 'Fetch a URL',
      },
    ],
  });

  assert.deepEqual(converted.tools[0].function.parameters, {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to use',
      },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include search results from these domains',
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Never include search results from these domains',
      },
    },
    required: ['query'],
  });
  assert.deepEqual(converted.tools[1].function.parameters, {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from',
      },
      prompt: {
        type: 'string',
        description: 'The prompt to run on the fetched content',
      },
    },
    required: ['url', 'prompt'],
  });
});

test('anthropicToOpenAI preserves valid explicit function tool schemas', async () => {
  const { anthropicToOpenAI } = await import('../dist-electron/libs/coworkFormatTransform.js');

  const converted = anthropicToOpenAI({
    model: 'test-model',
    messages: [{ role: 'user', content: 'read a file' }],
    tools: [
      {
        name: 'Read',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
          required: ['file_path'],
        },
      },
    ],
  });

  assert.deepEqual(converted.tools[0].function.parameters, {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
    },
    required: ['file_path'],
  });
});
