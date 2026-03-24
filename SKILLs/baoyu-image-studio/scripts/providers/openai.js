const {
  getFetch,
  normalizeString,
  readSourceBytes,
  sourceBasename,
} = require('../lib/providerCommon');

const SIZE_BY_ASPECT_RATIO = {
  '1:1': '1024x1024',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
};

function resolveOpenAiSize(options = {}) {
  const explicit = normalizeString(options.size);
  if (explicit) {
    return explicit.replace(/\*/g, 'x');
  }
  return SIZE_BY_ASPECT_RATIO[normalizeString(options.aspectRatio)] || '1024x1024';
}

function resolveOpenAiQuality(options = {}) {
  return options.quality === 'normal' ? 'medium' : 'high';
}

function extractImageFromOpenAiResponse(responseJson) {
  const first = Array.isArray(responseJson?.data) ? responseJson.data[0] : null;
  if (!first) {
    throw new Error('OpenAI response did not contain image data.');
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

  throw new Error('OpenAI response did not include an image URL or base64 image payload.');
}

async function generateImage({ prompt, model, options = {}, env = process.env, fetchImpl }) {
  const apiKey = normalizeString(env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for the OpenAI image provider.');
  }

  const fetchFn = getFetch(fetchImpl);
  const baseUrl = normalizeString(env.OPENAI_BASE_URL) || 'https://api.openai.com/v1';
  const referenceImages = Array.isArray(options.referenceImages) ? options.referenceImages : [];
  const headers = {
    Authorization: `Bearer ${apiKey}`,
  };

  let response;

  if (referenceImages.length > 0) {
    const formData = new FormData();
    formData.append('model', model);
    formData.append('prompt', prompt);
    formData.append('size', resolveOpenAiSize(options));
    formData.append('quality', resolveOpenAiQuality(options));
    formData.append('n', String(options.n || 1));

    for (const imageSource of referenceImages) {
      const { buffer, mimeType } = await readSourceBytes(imageSource, fetchImpl);
      formData.append(
        'image[]',
        new Blob([buffer], { type: mimeType }),
        sourceBasename(imageSource),
      );
    }

    response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/images/edits`, {
      method: 'POST',
      headers,
      body: formData,
    });
  } else {
    response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/images/generations`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt,
        size: resolveOpenAiSize(options),
        quality: resolveOpenAiQuality(options),
        n: options.n || 1,
      }),
    });
  }

  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = null;
  }

  if (!response.ok) {
    throw new Error(
      `OpenAI image request failed (${response.status})${responseJson?.error?.message ? `: ${responseJson.error.message}` : responseText ? `: ${responseText}` : ''}`,
    );
  }

  return extractImageFromOpenAiResponse(responseJson);
}

module.exports = {
  generateImage,
};
