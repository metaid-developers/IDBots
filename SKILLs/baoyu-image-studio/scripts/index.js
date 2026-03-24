#!/usr/bin/env node

const { buildPrompt, detectMode, summarizeTitle } = require('./lib/promptBuilder');
const { buildOutputPath, normalizeExtension } = require('./lib/outputPaths');
const { loadProviderAdapter, resolveProviderConfig } = require('./lib/providerResolver');
const { materializeImageResult, normalizeOptions, normalizeString } = require('./lib/providerCommon');

function parsePayloadArg(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv : [];
  const payloadIndex = args.findIndex((arg) => arg === '--payload');
  if (payloadIndex < 0) {
    return {};
  }
  const payloadRaw = args[payloadIndex + 1];
  if (!payloadRaw) {
    throw new Error('Missing value for --payload.');
  }
  try {
    return JSON.parse(payloadRaw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON payload: ${message}`);
  }
}

function resolveRequestedExtension(payload, providerId) {
  const outputPath = normalizeString(payload.output || payload.outputPath);
  if (outputPath) {
    const existingExtension = require('node:path').extname(outputPath);
    if (existingExtension) {
      return existingExtension;
    }
  }

  const requested = normalizeString(payload.extension || payload.format);
  if (requested) {
    return normalizeExtension(requested);
  }

  return providerId === 'seedream' ? '.png' : '.png';
}

async function runWithPayload(payload, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const now = options.now || Date.now;
  const providerConfig = resolveProviderConfig({ env });

  if (!providerConfig) {
    throw new Error(
      'No supported image provider is available. Configure openai/gemini/openrouter/qwen in IDBots Settings, or export REPLICATE_API_TOKEN / JIMENG_ACCESS_KEY_ID+JIMENG_SECRET_ACCESS_KEY / ARK_API_KEY.',
    );
  }

  const mode = detectMode(payload);
  const title = summarizeTitle(payload, mode);
  const prompt = buildPrompt({ ...payload, mode });
  const generationOptions = normalizeOptions(payload);
  const requestedExtension = resolveRequestedExtension(payload, providerConfig.provider);
  const outputPath = buildOutputPath({
    cwd,
    mode,
    title,
    extension: requestedExtension,
    now,
    outputPath: payload.output || payload.outputPath,
  });

  const adapter = loadProviderAdapter(providerConfig.provider, options.adapters);
  if (!adapter || typeof adapter.generateImage !== 'function') {
    throw new Error(`Provider adapter is unavailable for ${providerConfig.provider}.`);
  }

  const imageResult = await adapter.generateImage({
    prompt,
    model: providerConfig.model,
    options: generationOptions,
    env,
    fetchImpl: options.fetchImpl,
  });

  const saved = await materializeImageResult(imageResult, outputPath, options.fetchImpl);
  const message = `Generated ${mode} image "${title}" via ${providerConfig.provider} at ${saved.outputPath}`;

  return {
    message,
    mode,
    model: providerConfig.model,
    outputPath: saved.outputPath,
    mimeType: saved.mimeType,
    provider: providerConfig.provider,
    prompt,
    title,
  };
}

async function main(argv = process.argv.slice(2), options = {}) {
  const payload = options.payload || parsePayloadArg(argv);
  const result = await runWithPayload(payload, options);
  console.log(
    JSON.stringify({
      message: result.message,
      mode: result.mode,
      provider: result.provider,
      model: result.model,
      outputPath: result.outputPath,
    }),
  );
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parsePayloadArg,
  runWithPayload,
};
