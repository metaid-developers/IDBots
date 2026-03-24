const {
  getFetch,
  normalizeString,
  readSourceAsDataUrl,
} = require('../lib/providerCommon');

function buildUserContent(prompt, options, fetchImpl) {
  return Promise.all(
    [
      Promise.resolve({ type: 'text', text: prompt }),
      ...((options.referenceImages || []).map(async (imageSource) => ({
        type: 'image_url',
        image_url: {
          url: await readSourceAsDataUrl(imageSource, fetchImpl),
        },
      }))),
    ],
  );
}

function extractOpenRouterImage(json) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  const images = Array.isArray(choice?.message?.images) ? choice.message.images : [];
  const firstImage = images[0];
  const possibleUrl = firstImage?.image_url?.url || firstImage?.url || firstImage?.image_url;
  if (typeof possibleUrl === 'string' && possibleUrl.trim()) {
    if (possibleUrl.startsWith('data:')) {
      return {
        dataUrl: possibleUrl,
        extension: '.png',
      };
    }
    return {
      url: possibleUrl.trim(),
      extension: '.png',
    };
  }

  const contentParts = Array.isArray(choice?.message?.content) ? choice.message.content : [];
  for (const part of contentParts) {
    const partUrl = part?.image_url?.url || part?.url;
    if (typeof partUrl === 'string' && partUrl.trim()) {
      if (partUrl.startsWith('data:')) {
        return { dataUrl: partUrl, extension: '.png' };
      }
      return { url: partUrl.trim(), extension: '.png' };
    }
  }

  throw new Error('OpenRouter response did not include an image URL or data URL.');
}

async function generateImage({ prompt, model, options = {}, env = process.env, fetchImpl }) {
  const apiKey = normalizeString(env.OPENROUTER_API_KEY);
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required for the OpenRouter image provider.');
  }

  const fetchFn = getFetch(fetchImpl);
  const baseUrl = normalizeString(env.OPENROUTER_BASE_URL) || 'https://openrouter.ai/api/v1';
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: await buildUserContent(prompt, options, fetchImpl),
      },
    ],
    modalities: ['image', 'text'],
    stream: false,
  };

  const imageConfig = {};
  const aspectRatio = normalizeString(options.aspectRatio);
  const imageSize = normalizeString(options.imageSize);
  if (aspectRatio) {
    imageConfig.aspect_ratio = aspectRatio;
  }
  if (imageSize) {
    imageConfig.image_size = imageSize;
  }
  if (Object.keys(imageConfig).length > 0) {
    body.image_config = imageConfig;
  }

  const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `OpenRouter image request failed (${response.status})${json?.error?.message ? `: ${json.error.message}` : ''}`,
    );
  }

  return extractOpenRouterImage(json);
}

module.exports = {
  generateImage,
};
