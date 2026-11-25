import type Database from 'better-sqlite3';

export interface FleetUpgradeSelection {
  targetImage: string;
  targetDigest?: string | null;
  kind?: 'customer' | 'internal' | 'synthetic' | 'demo';
  cohort?: 'canary' | 'early' | 'stable';
  environment?: 'staging' | 'production';
}

/** Fleet upgrades only select serving tenants that actually need the target. */
export function selectFleetUpgradeTenantIds(
  db: Database.Database,
  selection: FleetUpgradeSelection,
): string[] {
  const conditions = [
    "tenants.status IN ('ready', 'degraded')",
    'tenants.image <> ?',
  ];
  const params: Array<string> = [selection.targetImage];
  if (selection.targetDigest) {
    conditions.push('(tenants.image_digest IS NULL OR tenants.image_digest <> ?)');
    params.push(selection.targetDigest);
  }
  if (selection.kind) {
    conditions.push('tenants.kind = ?');
    params.push(selection.kind);
  }
  if (selection.cohort) {
    conditions.push('tenants.cohort = ?');
    params.push(selection.cohort);
  }
  if (selection.environment) {
    conditions.push('hosts.environment = ?');
    params.push(selection.environment);
  }
  return (db.prepare(
    `SELECT tenants.id FROM tenants
     LEFT JOIN hosts ON hosts.id = tenants.host_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY tenants.created_at, tenants.id`,
  ).all(...params) as Array<{ id: string }>).map((row) => row.id);
}
