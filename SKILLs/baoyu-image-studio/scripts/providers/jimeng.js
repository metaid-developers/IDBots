const crypto = require('node:crypto');
const { getFetch, normalizeString } = require('../lib/providerCommon');

const JIMENG_REGION = 'cn-north-1';
const JIMENG_SERVICE = 'cv';
const JIMENG_VERSION = '2022-08-31';

const JIMENG_SIZE_PRESETS = {
  normal: {
    '1:1': { width: 1024, height: 1024 },
    '4:3': { width: 1152, height: 864 },
    '3:4': { width: 864, height: 1152 },
    '16:9': { width: 1280, height: 720 },
    '9:16': { width: 720, height: 1280 },
  },
  '2k': {
    '1:1': { width: 1536, height: 1536 },
    '4:3': { width: 1536, height: 1152 },
    '3:4': { width: 1152, height: 1536 },
    '16:9': { width: 2048, height: 1152 },
    '9:16': { width: 1152, height: 2048 },
  },
  '4k': {
    '1:1': { width: 2048, height: 2048 },
    '4:3': { width: 2304, height: 1728 },
    '3:4': { width: 1728, height: 2304 },
    '16:9': { width: 4096, height: 2304 },
    '9:16': { width: 2304, height: 4096 },
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data).digest(encoding);
}

function toAmzDate(now = new Date()) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function buildSignatureKey(secretAccessKey, dateStamp) {
  const kDate = hmac(`HMAC${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, JIMENG_REGION);
  const kService = hmac(kRegion, JIMENG_SERVICE);
  return hmac(kService, 'request');
}

function buildCanonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
}

function signRequest({ accessKeyId, secretAccessKey, method, host, pathname, queryParams, body, now }) {
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const canonicalQuery = buildCanonicalQuery(queryParams);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-date';
  const payloadHash = sha256Hex(body);
  const canonicalRequest = [method, pathname || '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${JIMENG_REGION}/${JIMENG_SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(buildSignatureKey(secretAccessKey, dateStamp), stringToSign, 'hex');

  return {
    Authorization: `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': 'application/json',
    Host: host,
    'X-Date': amzDate,
  };
}

function resolveJimengSize(options = {}) {
  const explicit = normalizeString(options.size);
  if (explicit) {
    const match = explicit.match(/^(\d+)[xX*](\d+)$/);
    if (match) {
      return { width: Number(match[1]), height: Number(match[2]) };
    }
  }

  const quality = options.quality === 'normal' ? 'normal' : '2k';
  const ratio = normalizeString(options.aspectRatio) || '1:1';
  return JIMENG_SIZE_PRESETS[quality][ratio] || JIMENG_SIZE_PRESETS[quality]['1:1'];
}

async function callJimengAction(action, bodyObject, env, fetchImpl) {
  const accessKeyId = normalizeString(env.JIMENG_ACCESS_KEY_ID);
  const secretAccessKey = normalizeString(env.JIMENG_SECRET_ACCESS_KEY);
  const fetchFn = getFetch(fetchImpl);
  const body = JSON.stringify(bodyObject);
  const queryParams = {
    Action: action,
    Version: JIMENG_VERSION,
  };
  const baseUrl = new URL(normalizeString(env.JIMENG_BASE_URL) || 'https://visual.volcengineapi.com');
  const headers = signRequest({
    accessKeyId,
    secretAccessKey,
    method: 'POST',
    host: baseUrl.host,
    pathname: baseUrl.pathname || '/',
    queryParams,
    body,
    now: new Date(),
  });

  const url = new URL(baseUrl.toString());
  url.search = buildCanonicalQuery(queryParams);
  const response = await fetchFn(url.toString(), {
    method: 'POST',
    headers,
    body,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Jimeng request failed (${response.status})${json?.message ? `: ${json.message}` : ''}`);
  }
  return json;
}

function extractJimengResult(json) {
  const data = json?.data || {};
  if (Array.isArray(data.binary_data_base64) && typeof data.binary_data_base64[0] === 'string') {
    return {
      bytes: Buffer.from(data.binary_data_base64[0], 'base64'),
      mimeType: 'image/png',
      extension: '.png',
    };
  }
  if (Array.isArray(data.image_urls) && typeof data.image_urls[0] === 'string') {
    return {
      url: data.image_urls[0],
      extension: '.png',
    };
  }
  return null;
}

async function pollJimengTask(taskId, model, env, fetchImpl) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const json = await callJimengAction(
      'CVSync2AsyncGetResult',
      {
        req_key: model,
        task_id: taskId,
      },
      env,
      fetchImpl,
    );
    const status = normalizeString(json?.data?.status).toLowerCase();
    if (status === 'done' || status === 'success') {
      const extracted = extractJimengResult(json);
      if (extracted) {
        return extracted;
      }
      throw new Error('Jimeng task completed without an image result.');
    }
    if (status === 'failed') {
      throw new Error(`Jimeng image generation failed: ${json?.message || 'unknown error'}`);
    }
    await sleep(3000);
  }
  throw new Error('Jimeng image generation timed out.');
}

async function generateImage({ prompt, model, options = {}, env = process.env, fetchImpl }) {
  if (!normalizeString(env.JIMENG_ACCESS_KEY_ID) || !normalizeString(env.JIMENG_SECRET_ACCESS_KEY)) {
    throw new Error('JIMENG_ACCESS_KEY_ID and JIMENG_SECRET_ACCESS_KEY are required for the Jimeng provider.');
  }
  if (Array.isArray(options.referenceImages) && options.referenceImages.length > 0) {
    throw new Error('Jimeng image generation does not support reference images in this IDBots skill yet.');
  }

  const { width, height } = resolveJimengSize(options);
  const responseJson = await callJimengAction(
    'CVProcess',
    {
      req_key: model,
      prompt_text: prompt,
      seed: -1,
      width,
      height,
      use_sr: true,
      return_url: true,
      logo_info: { add_logo: false },
    },
    env,
    fetchImpl,
  );

  const direct = extractJimengResult(responseJson);
  if (direct) {
    return direct;
  }

  const taskId = normalizeString(responseJson?.data?.task_id || responseJson?.data?.taskId);
  if (!taskId) {
    throw new Error('Jimeng response did not include an image result or task id.');
  }
  return pollJimengTask(taskId, model, env, fetchImpl);
}

module.exports = {
  generateImage,
};
