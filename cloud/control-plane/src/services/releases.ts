import type Database from 'better-sqlite3';
import { sha256Hex } from '../crypto.js';

export interface ReleaseManifest {
  schemaVersion: 1;
  sourceSha: string;
  appVersion: string;
  contractVersion: string;
  rollbackSafeTo: string | null;
  databaseSchemaVersion: number;
  tenant: { image: string; digest: string };
  controlPlane: { image: string; digest: string };
  createdAt: string;
  createdBy: string;
}

export interface ReleaseRecord extends ReleaseManifest {
  id: string;
  status: 'candidate' | 'canary' | 'stable' | 'retired';
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`release manifest field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function digest(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!/^sha256:[a-f0-9]{64}$/.test(parsed)) {
    throw new Error(`release manifest field "${field}" must be a sha256 digest`);
  }
  return parsed;
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const input = (value ?? {}) as Record<string, unknown>;
  if (input.schemaVersion !== 1) throw new Error('release manifest schemaVersion must be 1');
  const sourceSha = requiredString(input.sourceSha, 'sourceSha');
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('sourceSha must be a full lowercase Git SHA');
  if (!Number.isInteger(input.databaseSchemaVersion) || (input.databaseSchemaVersion as number) < 1) {
    throw new Error('databaseSchemaVersion must be a positive integer');
  }
  const tenant = (input.tenant ?? {}) as Record<string, unknown>;
  const controlPlane = (input.controlPlane ?? {}) as Record<string, unknown>;
  const createdAt = requiredString(input.createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('createdAt must be an ISO date');
  return {
    schemaVersion: 1,
    sourceSha,
    appVersion: requiredString(input.appVersion, 'appVersion'),
    contractVersion: requiredString(input.contractVersion, 'contractVersion'),
    rollbackSafeTo: input.rollbackSafeTo === null || input.rollbackSafeTo === ''
      ? null
      : requiredString(input.rollbackSafeTo, 'rollbackSafeTo'),
    databaseSchemaVersion: input.databaseSchemaVersion as number,
    tenant: {
      image: requiredString(tenant.image, 'tenant.image'),
      digest: digest(tenant.digest, 'tenant.digest'),
    },
    controlPlane: {
      image: requiredString(controlPlane.image, 'controlPlane.image'),
      digest: digest(controlPlane.digest, 'controlPlane.digest'),
    },
    createdAt,
    createdBy: requiredString(input.createdBy, 'createdBy'),
  };
}

function audit(
  db: Database.Database,
  operator: string,
  action: string,
  target: string,
  detail: Record<string, unknown>,
): void {
  db.prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), `admin:${operator}`, action, target, JSON.stringify(detail));
}

function rowToRelease(row: Record<string, unknown>): ReleaseRecord {
  const manifest = parseReleaseManifest(JSON.parse(String(row.manifest_json)));
  return {
    ...manifest,
    id: String(row.id),
    status: String(row.status) as ReleaseRecord['status'],
  };
}

export function registerRelease(
  db: Database.Database,
  value: unknown,
  operator: string,
): { release: ReleaseRecord; duplicate: boolean } {
  const manifest = parseReleaseManifest(value);
  const id = `rel_${sha256Hex(`${manifest.tenant.image}@${manifest.tenant.digest}`).slice(0, 20)}`;
  const core = {
    tenant_image: manifest.tenant.image,
    tenant_image_digest: manifest.tenant.digest,
    control_plane_image: manifest.controlPlane.image,
    control_plane_image_digest: manifest.controlPlane.digest,
    source_sha: manifest.sourceSha,
    app_version: manifest.appVersion,
    contract_version: manifest.contractVersion,
    rollback_safe_to: manifest.rollbackSafeTo,
    database_schema_version: manifest.databaseSchemaVersion,
  };
  const existing = db.prepare('SELECT * FROM releases WHERE id = ? OR tenant_image = ?')
    .get(id, manifest.tenant.image) as Record<string, unknown> | undefined;
  if (existing) {
    for (const [key, value] of Object.entries(core)) {
      if (existing[key] !== value) {
        throw new Error(`release identity conflict in ${key}; immutable releases cannot be overwritten`);
      }
    }
    return { release: rowToRelease(existing), duplicate: true };
  }
  db.transaction(() => {
    db.prepare(`INSERT INTO releases (
      id, tenant_image, tenant_image_digest, control_plane_image, control_plane_image_digest,
      source_sha, app_version, contract_version, rollback_safe_to, database_schema_version,
      status, manifest_json, created_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`)
      .run(
        id,
        core.tenant_image,
        core.tenant_image_digest,
        core.control_plane_image,
        core.control_plane_image_digest,
        core.source_sha,
        core.app_version,
        core.contract_version,
        core.rollback_safe_to,
        core.database_schema_version,
        JSON.stringify(manifest),
        Date.parse(manifest.createdAt),
        operator,
      );
    audit(db, operator, 'release.register', id, { image: manifest.tenant.image, digest: manifest.tenant.digest });
  })();
  const created = db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as Record<string, unknown>;
  return { release: rowToRelease(created), duplicate: false };
}

export function listReleases(db: Database.Database): ReleaseRecord[] {
  return (db.prepare('SELECT * FROM releases ORDER BY created_at DESC, id').all() as Array<Record<string, unknown>>)
    .map(rowToRelease);
}

export function setReleaseStatus(
  db: Database.Database,
  id: string,
  status: ReleaseRecord['status'],
  operator: string,
): ReleaseRecord {
  if (!['candidate', 'canary', 'stable', 'retired'].includes(status)) {
    throw new Error('release status must be candidate, canary, stable, or retired');
  }
  const existing = db.prepare('SELECT status FROM releases WHERE id = ?').get(id) as { status: string } | undefined;
  if (!existing) throw new Error(`release ${id} not found`);
  db.transaction(() => {
    db.prepare('UPDATE releases SET status = ? WHERE id = ?').run(status, id);
    audit(db, operator, 'release.status', id, { from: existing.status, to: status });
  })();
  return rowToRelease(db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as Record<string, unknown>);
}
