const { getFetch, normalizeString } = require('../lib/providerCommon');

const DASHSCOPE_SIZE_BY_RATIO = {
  '1:1': '1328*1328',
  '4:3': '1664*1248',
  '3:4': '1248*1664',
  '16:9': '2048*1152',
  '9:16': '1152*2048',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDashscopeSize(options = {}) {
  const explicit = normalizeString(options.size);
  if (explicit) {
    return explicit.replace(/[xX]/g, '*');
  }
  return DASHSCOPE_SIZE_BY_RATIO[normalizeString(options.aspectRatio)] || '1328*1328';
}

function extractDashscopeResult(payload) {
  const directUrl = payload?.output?.result_url
    || payload?.output?.results?.[0]?.url
    || payload?.output?.choices?.[0]?.message?.content?.find?.((item) => item.image)?.image
    || payload?.output?.choices?.[0]?.message?.content?.find?.((item) => item.image_url)?.image_url;

  if (typeof directUrl === 'string' && directUrl.trim()) {
    return {
      url: directUrl.trim(),
      extension: '.png',
    };
  }

  const base64Data = payload?.output?.result_image || payload?.output?.results?.[0]?.b64_image;
  if (typeof base64Data === 'string' && base64Data.trim()) {
    return {
      bytes: Buffer.from(base64Data.trim(), 'base64'),
      mimeType: 'image/png',
      extension: '.png',
    };
  }

  return null;
}

async function pollTask(taskId, env, fetchImpl) {
  const fetchFn = getFetch(fetchImpl);
  const baseUrl = normalizeString(env.DASHSCOPE_BASE_URL) || 'https://dashscope.aliyuncs.com';

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: {
        Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
      },
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`DashScope task polling failed (${response.status}).`);
    }

    const taskStatus = normalizeString(json?.output?.task_status || json?.output?.taskStatus).toUpperCase();
    if (taskStatus === 'SUCCEEDED') {
      const extracted = extractDashscopeResult(json);
      if (extracted) {
        return extracted;
      }
      throw new Error('DashScope task completed without an image result.');
    }
    if (taskStatus === 'FAILED') {
      throw new Error(`DashScope task failed: ${json?.output?.message || json?.message || 'unknown error'}`);
    }

    await sleep(3000);
  }

  throw new Error('DashScope image generation timed out while polling task status.');
}

async function generateImage({ prompt, model, options = {}, env = process.env, fetchImpl }) {
  const apiKey = normalizeString(env.DASHSCOPE_API_KEY);
  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY is required for the DashScope image provider.');
  }
  if (Array.isArray(options.referenceImages) && options.referenceImages.length > 0) {
    throw new Error('DashScope image generation does not support reference images in this IDBots skill yet.');
  }

  const fetchFn = getFetch(fetchImpl);
  const baseUrl = normalizeString(env.DASHSCOPE_BASE_URL) || 'https://dashscope.aliyuncs.com';
  const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model,
      input: {
        messages: [
          {
            role: 'user',
            content: [{ text: prompt }],
          },
        ],
      },
      parameters: {
        size: resolveDashscopeSize(options),
        watermark: false,
        prompt_extend: false,
        negative_prompt: 'blurry, low quality, distorted text, extra fingers',
      },
    }),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `DashScope image request failed (${response.status})${json?.message ? `: ${json.message}` : ''}`,
    );
  }

  const directResult = extractDashscopeResult(json);
  if (directResult) {
    return directResult;
  }

  const taskId = normalizeString(json?.output?.task_id || json?.output?.taskId);
  if (!taskId) {
    throw new Error('DashScope response did not include an image result or task id.');
  }

  return pollTask(taskId, env, fetchImpl);
}

module.exports = {
  generateImage,
};
