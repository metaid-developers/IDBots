const { getFetch, normalizeString, readSourceAsDataUrl } = require('../lib/providerCommon');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAspectRatio(options = {}) {
  const ratio = normalizeString(options.aspectRatio);
  return ratio || '1:1';
}

async function pollPrediction(predictionUrl, env, fetchImpl) {
  const fetchFn = getFetch(fetchImpl);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetchFn(predictionUrl, {
      headers: {
        Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`,
      },
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Replicate polling failed (${response.status}).`);
    }
    if (json?.status === 'succeeded') {
      return json;
    }
    if (json?.status === 'failed' || json?.status === 'canceled') {
      throw new Error(`Replicate image generation failed: ${json?.error || json?.status}`);
    }
    await sleep(3000);
  }
  throw new Error('Replicate image generation timed out.');
}

function extractReplicateResult(json) {
  const output = json?.output;
  if (typeof output === 'string' && output.trim()) {
    return { url: output.trim(), extension: '.png' };
  }
  if (Array.isArray(output) && typeof output[0] === 'string' && output[0].trim()) {
    return { url: output[0].trim(), extension: '.png' };
  }
  if (json?.urls?.get) {
    throw new Error('Replicate prediction did not return output after completion.');
  }
  throw new Error('Replicate response did not include an output URL.');
}

async function generateImage({ prompt, model, options = {}, env = process.env, fetchImpl }) {
  const apiToken = normalizeString(env.REPLICATE_API_TOKEN);
  if (!apiToken) {
    throw new Error('REPLICATE_API_TOKEN is required for the Replicate image provider.');
  }

  const fetchFn = getFetch(fetchImpl);
  const baseUrl = normalizeString(env.REPLICATE_BASE_URL) || 'https://api.replicate.com/v1';
  const input = {
    prompt,
    aspect_ratio: resolveAspectRatio(options),
    output_format: 'png',
    output_quality: 90,
  };

  if (options.n && options.n > 1) {
    input.number_of_images = options.n;
  }
  if (Array.isArray(options.referenceImages) && options.referenceImages.length > 0) {
    input.image_input = [];
    for (const imageSource of options.referenceImages) {
      input.image_input.push(await readSourceAsDataUrl(imageSource, fetchImpl));
    }
  }

  const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=60',
    },
    body: JSON.stringify({
      model,
      input,
    }),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Replicate image request failed (${response.status})${json?.detail ? `: ${json.detail}` : ''}`,
    );
  }

  if (json?.status === 'succeeded') {
    return extractReplicateResult(json);
  }

  const pollUrl = json?.urls?.get;
  if (!pollUrl) {
    throw new Error('Replicate response did not include a polling URL.');
  }
  const completed = await pollPrediction(pollUrl, env, fetchImpl);
  return extractReplicateResult(completed);
}

module.exports = {
  generateImage,
};
