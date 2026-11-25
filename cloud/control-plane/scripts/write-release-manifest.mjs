import fs from 'node:fs';
import path from 'node:path';

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function validDigest(name) {
  const value = required(name);
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a sha256 digest`);
  return value;
}

const repoRoot = path.resolve(process.env.REPO_ROOT ?? process.cwd());
const sourceSha = required('SOURCE_SHA', process.env.GITHUB_SHA).toLowerCase();
if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('SOURCE_SHA must be a full Git SHA');
const labels = JSON.parse(required('TENANT_LABELS'));
const appVersion = required('APP_VERSION', labels['org.idbots.version']);
if (labels['org.idbots.commit'] && labels['org.idbots.commit'] !== sourceSha) {
  throw new Error('tenant image commit label does not match SOURCE_SHA');
}
const migrationsSource = fs.readFileSync(path.join(repoRoot, 'cloud/control-plane/src/db/migrations.ts'), 'utf8');
const databaseSchemaVersion = Math.max(
  ...[...migrationsSource.matchAll(/\{ version: (\d+), name:/g)].map((match) => Number(match[1])),
);
if (!Number.isInteger(databaseSchemaVersion) || databaseSchemaVersion < 1) {
  throw new Error('could not determine database schema version');
}
const manifest = {
  schemaVersion: 1,
  sourceSha,
  appVersion,
  contractVersion: required('CONTRACT_VERSION', labels['org.idbots.contract']),
  rollbackSafeTo: labels['org.idbots.rollback-safe-to'] || null,
  databaseSchemaVersion,
  tenant: {
    image: required('TENANT_IMAGE'),
    digest: validDigest('TENANT_IMAGE_DIGEST'),
  },
  controlPlane: {
    image: required('CONTROL_PLANE_IMAGE'),
    digest: validDigest('CONTROL_PLANE_IMAGE_DIGEST'),
  },
  createdAt: new Date().toISOString(),
  createdBy: required('CREATED_BY', process.env.GITHUB_ACTOR ?? 'local-operator'),
};
const output = path.resolve(required('OUTPUT_FILE', 'release/cloud-release-manifest.json'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
console.log(output);
