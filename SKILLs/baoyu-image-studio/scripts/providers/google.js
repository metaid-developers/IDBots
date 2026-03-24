const { getFetch, normalizeString, readSourceBytes } = require('../lib/providerCommon');

function getGoogleApiKey(env = process.env) {
  return normalizeString(env.GOOGLE_API_KEY || env.GEMINI_API_KEY);
}

function resolveGoogleImageSize(options = {}) {
  const explicit = normalizeString(options.imageSize);
  if (explicit) {
    return explicit;
  }
  return options.quality === 'normal' ? '1K' : '2K';
}

function isImagenModel(model) {
  return /\bimagen\b/i.test(normalizeString(model));
}

async function generateGeminiImage({ prompt, model, options, env, fetchImpl }) {
  const apiKey = getGoogleApiKey(env);
  const fetchFn = getFetch(fetchImpl);
  const baseUrl = normalizeString(env.GOOGLE_BASE_URL) || 'https://generativelanguage.googleapis.com/v1beta';
  const parts = [{ text: prompt }];

  for (const imageSource of options.referenceImages || []) {
    const { buffer, mimeType } = await readSourceBytes(imageSource, fetchImpl);
    parts.push({
      inlineData: {
        mimeType,
        data: Buffer.from(buffer).toString('base64'),
      },
    });
  }

  const body = {
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        imageSize: resolveGoogleImageSize(options),
      },
    },
  };

  const aspectRatio = normalizeString(options.aspectRatio);
  if (aspectRatio) {
    body.generationConfig.imageConfig.aspectRatio = aspectRatio;
  }

  const response = await fetchFn(
    `${baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Google image request failed (${response.status})${json?.error?.message ? `: ${json.error.message}` : ''}`,
    );
  }

  const candidate = Array.isArray(json?.candidates) ? json.candidates[0] : null;
  const partsList = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const inlineData = partsList.find((part) => part?.inlineData?.data)?.inlineData;
  if (!inlineData?.data) {
    throw new Error('Google response did not include image bytes.');
  }

  return {
    bytes: Buffer.from(inlineData.data, 'base64'),
    mimeType: inlineData.mimeType || 'image/png',
    extension: '.png',
  };
}

async function generateImagenImage({ prompt, model, options, env, fetchImpl }) {
  const apiKey = getGoogleApiKey(env);
  const fetchFn = getFetch(fetchImpl);
  const baseUrl = normalizeString(env.GOOGLE_BASE_URL) || 'https://generativelanguage.googleapis.com/v1beta';
  const parameters = {
    sampleCount: options.n || 1,
    addWatermark: false,
    outputMimeType: 'image/png',
  };

  const aspectRatio = normalizeString(options.aspectRatio);
  if (aspectRatio) {
    parameters.aspectRatio = aspectRatio;
  }

  const response = await fetchFn(
    `${baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:predict?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters,
      }),
    },
  );

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Google Imagen request failed (${response.status})${json?.error?.message ? `: ${json.error.message}` : ''}`,
    );
  }

  const predictions = Array.isArray(json?.predictions) ? json.predictions : [];
  const first = predictions[0] || {};
  const base64Data = first?.bytesBase64Encoded || first?.image?.imageBytes;
  if (!base64Data) {
    throw new Error('Google Imagen response did not include image bytes.');
  }

  return {
    bytes: Buffer.from(base64Data, 'base64'),
    mimeType: 'image/png',
    extension: '.png',
  };
}

async function generateImage({ prompt, model, options = {}, env = process.env, fetchImpl }) {
  const apiKey = getGoogleApiKey(env);
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY is required for the Google image provider.');
  }

  if (isImagenModel(model)) {
    return generateImagenImage({ prompt, model, options, env, fetchImpl });
  }
  return generateGeminiImage({ prompt, model, options, env, fetchImpl });
}

module.exports = {
  generateImage,
};
