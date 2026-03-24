const path = require('node:path');
const { normalizeString } = require('./providerCommon');

const DEFAULT_MODELS = {
  openai: 'gpt-image-1.5',
  google: 'gemini-3-pro-image-preview',
  openrouter: 'google/gemini-3.1-flash-image-preview',
  dashscope: 'qwen-image-2.0-pro',
  replicate: 'google/nano-banana-pro',
  jimeng: 'jimeng_t2i_v40',
  seedream: 'doubao-seedream-5-0-260128',
};

const PROVIDER_DEFS = {
  openai: {
    credentialEnvNames: ['OPENAI_API_KEY'],
    modelEnvNames: ['OPENAI_IMAGE_MODEL'],
  },
  google: {
    credentialEnvNames: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    modelEnvNames: ['GOOGLE_IMAGE_MODEL', 'GEMINI_IMAGE_MODEL'],
  },
  openrouter: {
    credentialEnvNames: ['OPENROUTER_API_KEY'],
    modelEnvNames: ['OPENROUTER_IMAGE_MODEL'],
  },
  dashscope: {
    credentialEnvNames: ['DASHSCOPE_API_KEY'],
    modelEnvNames: ['DASHSCOPE_IMAGE_MODEL'],
  },
  replicate: {
    credentialEnvNames: ['REPLICATE_API_TOKEN'],
    modelEnvNames: ['REPLICATE_IMAGE_MODEL'],
  },
  jimeng: {
    credentialEnvNames: ['JIMENG_ACCESS_KEY_ID', 'JIMENG_SECRET_ACCESS_KEY'],
    modelEnvNames: ['JIMENG_IMAGE_MODEL'],
    requiresAllCredentials: true,
  },
  seedream: {
    credentialEnvNames: ['ARK_API_KEY'],
    modelEnvNames: ['SEEDREAM_IMAGE_MODEL'],
  },
};

const PROVIDER_ORDER = [
  'openai',
  'google',
  'openrouter',
  'dashscope',
  'replicate',
  'jimeng',
  'seedream',
];

function normalizeProviderId(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'gemini') return 'google';
  if (normalized === 'qwen') return 'dashscope';
  return normalized;
}

function getCredentialValue(env, providerDef) {
  if (providerDef.requiresAllCredentials) {
    const values = {};
    for (const envName of providerDef.credentialEnvNames) {
      const value = normalizeString(env[envName]);
      if (!value) {
        return null;
      }
      values[envName] = value;
    }
    return values;
  }

  const resolved = providerDef.credentialEnvNames
    .map((envName) => normalizeString(env[envName]))
    .find(Boolean);
  if (!resolved) {
    return null;
  }

  return Object.fromEntries(providerDef.credentialEnvNames.map((envName) => [envName, resolved]));
}

function getModel(env, providerId) {
  const providerDef = PROVIDER_DEFS[providerId];
  if (!providerDef) {
    return '';
  }

  for (const envName of providerDef.modelEnvNames) {
    const value = normalizeString(env[envName]);
    if (value) {
      return value;
    }
  }

  return DEFAULT_MODELS[providerId];
}

function resolveProviderConfig({ env = process.env } = {}) {
  const explicitProvider = normalizeProviderId(env.BAOYU_IMAGE_PROVIDER);
  const orderedCandidates = explicitProvider && PROVIDER_DEFS[explicitProvider]
    ? [explicitProvider, ...PROVIDER_ORDER.filter((providerId) => providerId !== explicitProvider)]
    : PROVIDER_ORDER;

  for (const providerId of orderedCandidates) {
    const def = PROVIDER_DEFS[providerId];
    const credentials = getCredentialValue(env, def);
    if (!credentials) {
      continue;
    }

    return {
      provider: providerId,
      model: getModel(env, providerId),
      credentials,
      adapterPath: path.resolve(__dirname, '..', 'providers', `${providerId}.js`),
    };
  }

  return null;
}

function loadProviderAdapter(providerId, overrides) {
  if (overrides && overrides[providerId]) {
    return overrides[providerId];
  }
  return require(path.resolve(__dirname, '..', 'providers', `${providerId}.js`));
}

module.exports = {
  DEFAULT_MODELS,
  PROVIDER_DEFS,
  PROVIDER_ORDER,
  loadProviderAdapter,
  normalizeProviderId,
  resolveProviderConfig,
};
