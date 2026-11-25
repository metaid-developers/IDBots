import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { freshDb } from './helpers.js';
import { listReleases, registerRelease, setReleaseStatus } from '../src/services/releases.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
const SOURCE_SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const CP_DIGEST = `sha256:${'c'.repeat(64)}`;

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    appVersion: '1.2.0',
    contractVersion: '1.0.0',
    rollbackSafeTo: '1.1.0',
    databaseSchemaVersion: 8,
    tenant: { image: 'registry.test/idbots/tenant:1.2.0-aaaaaaa', digest: DIGEST },
    controlPlane: { image: 'registry.test/idbots/control-plane:0.1.0-aaaaaaa', digest: CP_DIGEST },
    createdAt: '2026-11-26T00:00:00.000Z',
    createdBy: 'test',
  };
}

let db: Database.Database;
before(() => {
  db = freshDb();
});
after(() => {
  db.close();
});

describe('immutable cloud releases', () => {
  test('register is idempotent but rejects conflicting content for the same image', () => {
    const first = registerRelease(db, manifest(), 'operator');
    assert.equal(first.duplicate, false);
    assert.equal(first.release.status, 'candidate');
    const second = registerRelease(db, { ...manifest(), createdAt: '2026-11-26T01:00:00.000Z' }, 'operator');
    assert.equal(second.duplicate, true);
    assert.equal(second.release.id, first.release.id);
    assert.throws(
      () => registerRelease(db, { ...manifest(), sourceSha: 'd'.repeat(40) }, 'operator'),
      /immutable releases cannot be overwritten/,
    );
    const promoted = setReleaseStatus(db, first.release.id, 'canary', 'operator');
    assert.equal(promoted.status, 'canary');
    assert.equal(listReleases(db).length, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'release.%'").get() as { n: number }).n,
      2,
    );
  });

  test('CI writer captures labels, pushed digests, and the current database schema', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cp-release-manifest-'));
    try {
      const output = path.join(dir, 'cloud-release-manifest.json');
      execFileSync(process.execPath, [path.join(PKG_ROOT, 'scripts/write-release-manifest.mjs')], {
        env: {
          ...process.env,
          REPO_ROOT,
          SOURCE_SHA,
          TENANT_IMAGE: 'registry.test/idbots/tenant:1.2.0-aaaaaaa',
          TENANT_IMAGE_DIGEST: DIGEST,
          CONTROL_PLANE_IMAGE: 'registry.test/idbots/control-plane:0.1.0-aaaaaaa',
          CONTROL_PLANE_IMAGE_DIGEST: CP_DIGEST,
          TENANT_LABELS: JSON.stringify({
            'org.idbots.version': '1.2.0',
            'org.idbots.commit': SOURCE_SHA,
            'org.idbots.contract': '1.0.0',
            'org.idbots.rollback-safe-to': '1.1.0',
          }),
          CREATED_BY: 'test-ci',
          OUTPUT_FILE: output,
        },
      });
      const written = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
      assert.equal(written.schemaVersion, 1);
      assert.equal(written.appVersion, '1.2.0');
      assert.equal(written.contractVersion, '1.0.0');
      assert.equal(written.createdBy, 'test-ci');
      assert.ok((written.databaseSchemaVersion as number) >= 8);
      const imported = {
        ...written,
        tenant: { image: 'registry.test/idbots/tenant:1.2.0-bbbbbbb', digest: `sha256:${'d'.repeat(64)}` },
      };
      assert.equal(registerRelease(db, imported, 'operator').duplicate, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
