'use strict';

function computeReleaseAssetLabel({ refName }) {
  const raw = String(refName || '').trim();
  const withoutLeadingV = raw.replace(/^v(?=\d)/, '');
  const sanitized = withoutLeadingV
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return sanitized || 'dev';
}

if (require.main === module) {
  process.stdout.write(`${computeReleaseAssetLabel({ refName: process.env.GITHUB_REF_NAME })}\n`);
}

module.exports = {
  computeReleaseAssetLabel,
};
