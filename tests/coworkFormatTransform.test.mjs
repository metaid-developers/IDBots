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

function parseSSEEvents(raw) {
  return raw
    .split('\n\n')
    .map((packet) => packet.trim())
    .filter(Boolean)
    .map((packet) => {
      const lines = packet.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length) || '';
      const data = lines
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n');
      return { event, data: JSON.parse(data) };
    });
}

function createWritableRecorder() {
  const chunks = [];
  return {
    chunks,
    res: {
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
    },
  };
}

test('DeepSeek stream tool calls carry reasoning_content for future request hydration', async () => {
  const { __openAICompatProxyTestUtils } = await import('../dist-electron/libs/coworkOpenAICompatProxy.js');
  const {
    createStreamState,
    processOpenAIChunk,
    hydrateDeepSeekReasoningForRequest,
    resetDeepSeekReasoningCache,
  } = __openAICompatProxyTestUtils;
  resetDeepSeekReasoningCache();

  const state = createStreamState({ preserveDeepSeekReasoning: true });
  const recorder = createWritableRecorder();

  processOpenAIChunk(recorder.res, state, {
    id: 'chatcmpl_reasoning_tool',
    model: 'deepseek-v4-pro',
    choices: [{ delta: { reasoning_content: 'need to inspect the file first' } }],
  });
  processOpenAIChunk(recorder.res, state, {
    id: 'chatcmpl_reasoning_tool',
    model: 'deepseek-v4-pro',
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_read_file',
          type: 'function',
          function: { name: 'Read', arguments: '{"file_path":"src/main.ts"}' },
        }],
      },
    }],
  });

  const toolUseStart = parseSSEEvents(recorder.chunks.join('')).find((item) => (
    item.event === 'content_block_start'
    && item.data.content_block?.type === 'tool_use'
  ));

  assert.equal(
    toolUseStart.data.content_block.extra_content.deepseek.reasoning_content,
    'need to inspect the file first',
  );

  const request = {
    model: 'deepseek-v4-pro',
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_read_file',
        type: 'function',
        function: { name: 'Read', arguments: '{"file_path":"src/main.ts"}' },
      }],
    }],
  };

  const hydrateResult = hydrateDeepSeekReasoningForRequest(request, 'deepseek', 'https://api.deepseek.com');

  assert.deepEqual(hydrateResult, { ok: true, hydratedCount: 1, missingCount: 0 });
  assert.equal(request.messages[0].reasoning_content, 'need to inspect the file first');
});

test('non-DeepSeek stream tool calls do not receive DeepSeek reasoning metadata', async () => {
  const { __openAICompatProxyTestUtils } = await import('../dist-electron/libs/coworkOpenAICompatProxy.js');
  const {
    createStreamState,
    processOpenAIChunk,
    resetDeepSeekReasoningCache,
  } = __openAICompatProxyTestUtils;
  resetDeepSeekReasoningCache();

  const state = createStreamState();
  const recorder = createWritableRecorder();

  processOpenAIChunk(recorder.res, state, {
    id: 'chatcmpl_reasoning_tool',
    model: 'o3',
    choices: [{ delta: { reasoning_content: 'provider-specific reasoning' } }],
  });
  processOpenAIChunk(recorder.res, state, {
    id: 'chatcmpl_reasoning_tool',
    model: 'o3',
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_other_provider',
          type: 'function',
          function: { name: 'Read', arguments: '{"file_path":"src/main.ts"}' },
        }],
      },
    }],
  });

  const toolUseStart = parseSSEEvents(recorder.chunks.join('')).find((item) => (
    item.event === 'content_block_start'
    && item.data.content_block?.type === 'tool_use'
  ));

  assert.equal(toolUseStart.data.content_block.extra_content, undefined);
});

test('DeepSeek request validation rejects assistant tool calls when reasoning_content cannot be restored', async () => {
  const { __openAICompatProxyTestUtils } = await import('../dist-electron/libs/coworkOpenAICompatProxy.js');
  const {
    hydrateDeepSeekReasoningForRequest,
    resetDeepSeekReasoningCache,
  } = __openAICompatProxyTestUtils;
  resetDeepSeekReasoningCache();

  const request = {
    model: 'deepseek-v4-pro',
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_without_reasoning',
        type: 'function',
        function: { name: 'Read', arguments: '{"file_path":"src/main.ts"}' },
      }],
    }],
  };

  const hydrateResult = hydrateDeepSeekReasoningForRequest(request, 'deepseek', 'https://api.deepseek.com');

  assert.equal(hydrateResult.ok, false);
  assert.equal(hydrateResult.hydratedCount, 0);
  assert.equal(hydrateResult.missingCount, 1);
  assert.match(hydrateResult.error, /missing reasoning_content/i);
});
