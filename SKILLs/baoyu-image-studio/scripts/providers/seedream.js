const { getFetch, normalizeString, readSourceAsDataUrl } = require('../lib/providerCommon');

function resolveSeedreamSize(options = {}) {
  const explicit = normalizeString(options.size || options.imageSize);
  if (explicit) {
    return explicit;
  }
  return options.quality === 'normal' ? '1K' : '2K';
}

function extractSeedreamResult(json) {
  const first = Array.isArray(json?.data) ? json.data[0] : null;
  if (!first) {
    throw new Error('Seedream response did not include image data.');
  }
  if (typeof first.b64_json === 'string' && first.b64_json.trim()) {
    return {
      bytes: Buffer.from(first.b64_json.trim(), 'base64'),
      mimeType: 'image/png',
      extension: '.png',
    };
  }
  if (typeof first.url === 'string' && first.url.trim()) {
    return {
      url: first.url.trim(),
      extension: '.png',
    };
  }
  throw new Error('Seedream response did not include an image URL or base64 payload.');
}

async function generateImage({ prompt, model, options = {}, env = process.env, fetchImpl }) {
  const apiKey = normalizeString(env.ARK_API_KEY);
  if (!apiKey) {
    throw new Error('ARK_API_KEY is required for the Seedream image provider.');
  }

  const fetchFn = getFetch(fetchImpl);
  const baseUrl = normalizeString(env.SEEDREAM_BASE_URL) || 'https://ark.cn-beijing.volces.com/api/v3';
  const requestBody = {
    model,
    prompt,
    size: resolveSeedreamSize(options),
    response_format: 'url',
    watermark: false,
  };

  if (/seedream-5/i.test(model)) {
    requestBody.output_format = 'png';
  }

  const referenceImages = Array.isArray(options.referenceImages) ? options.referenceImages : [];
  if (referenceImages.length === 1) {
    requestBody.image = await readSourceAsDataUrl(referenceImages[0], fetchImpl);
  } else if (referenceImages.length > 1) {
    requestBody.images = [];
    for (const imageSource of referenceImages) {
      requestBody.images.push(await readSourceAsDataUrl(imageSource, fetchImpl));
    }
  }

  const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Seedream image request failed (${response.status})${json?.error?.message ? `: ${json.error.message}` : ''}`,
    );
  }

  return extractSeedreamResult(json);
}

module.exports = {
  generateImage,
};
