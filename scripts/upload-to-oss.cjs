#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const OSS = require('ali-oss');

const localFilePath = process.argv[2];
const explicitObjectKey = process.argv[3];

if (!localFilePath) {
  console.error('Usage: node scripts/upload-to-oss.cjs <localFilePath> [objectKey]');
  process.exit(1);
}

if (!fs.existsSync(localFilePath)) {
  console.error(`[OSS] Local file not found: ${localFilePath}`);
  process.exit(1);
}

const accessKeyId = (process.env.OSS_ACCESS_KEY_ID || '').trim();
const accessKeySecret = (process.env.OSS_ACCESS_KEY_SECRET || '').trim();
const bucket = (process.env.OSS_BUCKET || '').trim();
const endpointRaw = (process.env.OSS_ENDPOINT || '').trim();

if (!accessKeyId || !accessKeySecret || !bucket || !endpointRaw) {
  console.error('[OSS] Missing required env: OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET / OSS_ENDPOINT');
  process.exit(1);
}

const endpointHost = endpointRaw.replace(/^https?:\/\//i, '').replace(/\/+$/g, '');
let apiEndpointHost = endpointHost;
const bucketPrefix = `${bucket.toLowerCase()}.`;
if (apiEndpointHost.toLowerCase().startsWith(bucketPrefix)) {
  apiEndpointHost = apiEndpointHost.slice(bucketPrefix.length);
}
if (!apiEndpointHost) {
  console.error(`[OSS] Invalid endpoint host: ${endpointRaw}`);
  process.exit(1);
}

const refName = (process.env.GITHUB_REF_NAME || '').trim();
const version = refName.replace(/^v/i, '') || 'latest';
const objectKey = explicitObjectKey || `IDBots.Setup.${version}.exe`;

const client = new OSS({
  accessKeyId,
  accessKeySecret,
  bucket,
  endpoint: `https://${apiEndpointHost}`,
  secure: true,
});

(async () => {
  const normalizedLocalPath = path.resolve(localFilePath);
  await client.put(objectKey, normalizedLocalPath);
  const publicUrl = `https://${endpointHost}/${objectKey}`;
  console.log(`[OSS] Uploaded to ${publicUrl}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `windows_oss_url=${publicUrl}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `windows_oss_object_key=${objectKey}\n`);
  }
})().catch((error) => {
  console.error('[OSS] Upload failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
