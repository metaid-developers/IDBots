const path = require('node:path');
const { normalizeString } = require('./providerCommon');

function slugify(value, fallback = 'image') {
  const normalized = normalizeString(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return normalized || fallback;
}

function normalizeExtension(extension) {
  const normalized = normalizeString(extension);
  if (!normalized) {
    return '.png';
  }
  return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

function buildOutputPath({ cwd, mode, title, extension = '.png', now = Date.now, outputPath }) {
  const baseCwd = path.resolve(cwd || process.cwd());
  const explicitOutput = normalizeString(outputPath);
  const normalizedExtension = normalizeExtension(extension);

  if (explicitOutput) {
    const resolved = path.isAbsolute(explicitOutput)
      ? explicitOutput
      : path.resolve(baseCwd, explicitOutput);
    return path.extname(resolved) ? resolved : `${resolved}${normalizedExtension}`;
  }

  const timestamp = typeof now === 'function' ? now() : now;
  const root = path.resolve(baseCwd, 'outputs', 'baoyu-image-studio', normalizeString(mode) || 'generate');
  const fileName = `${slugify(title, normalizeString(mode) || 'image')}-${timestamp}${normalizedExtension}`;
  return path.join(root, fileName);
}

module.exports = {
  buildOutputPath,
  normalizeExtension,
  slugify,
};
