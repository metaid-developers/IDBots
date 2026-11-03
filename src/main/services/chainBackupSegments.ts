import { gzipSync } from 'node:zlib';
import { canonicalJson, chainBackupObjectId, encryptBytes, objectId } from './chainBackupCrypto';
import {
  CHAIN_BACKUP_CIPHER,
  CHAIN_BACKUP_ENCODING_GZIP,
  CHAIN_BACKUP_KDF,
  CHAIN_BACKUP_SEGMENT_PLAINTEXT_LIMIT,
  CHAIN_BACKUP_VERSION,
} from './chainBackupProtocol';
import type { ChainBackupObject, ChainBackupSegmentRef } from './chainBackupData';

const OVERSIZED_CHUNK_PAYLOAD_BYTES = 96 * 1024;

export interface PackedBackupSegment {
  plaintext: Record<string, unknown>;
  objects: ChainBackupObject[];
  segmentKey: string;
  journalObjectIds: string[];
}

export function chainBackupSegmentKey(botGlobalMetaId: string, objectIds: string[]): string {
  return objectId({ version: CHAIN_BACKUP_VERSION, bot: botGlobalMetaId, objectIds });
}

export function chainBackupSegmentRefKey(botGlobalMetaId: string, ref: ChainBackupSegmentRef): string {
  return ref.segmentKey?.trim() || chainBackupSegmentKey(botGlobalMetaId, ref.objectIds);
}

function makeChunkObject(kind: 'object_chunk', data: Record<string, unknown>): ChainBackupObject {
  return { id: chainBackupObjectId(kind, data), kind, data };
}

function expandOversizedObject(obj: ChainBackupObject): ChainBackupObject[] {
  const serialized = canonicalJson({ kind: obj.kind, data: obj.data });
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length <= CHAIN_BACKUP_SEGMENT_PLAINTEXT_LIMIT - 64) return [obj];
  const total = Math.ceil(bytes.length / OVERSIZED_CHUNK_PAYLOAD_BYTES);
  const chunks: ChainBackupObject[] = [];
  for (let index = 0; index < total; index += 1) {
    const payload = bytes.subarray(
      index * OVERSIZED_CHUNK_PAYLOAD_BYTES,
      Math.min(bytes.length, (index + 1) * OVERSIZED_CHUNK_PAYLOAD_BYTES),
    );
    chunks.push(makeChunkObject('object_chunk', {
      of: obj.id,
      index,
      total,
      encoding: 'base64',
      payload: payload.toString('base64'),
    }));
  }
  return chunks;
}

function buildSegment(
  botGlobalMetaId: string,
  objects: ChainBackupObject[],
  createdAt: number,
): PackedBackupSegment {
  const journalObjectIds = new Set<string>();
  for (const obj of objects) {
    journalObjectIds.add(obj.id);
    if (obj.kind === 'object_chunk' && typeof obj.data.of === 'string') {
      journalObjectIds.add(obj.data.of);
    }
  }
  return {
    plaintext: {
      version: CHAIN_BACKUP_VERSION,
      bot: botGlobalMetaId,
      createdAt,
      objects: objects.map((obj) => ({ id: obj.id, kind: obj.kind, data: obj.data })),
    },
    objects,
    segmentKey: chainBackupSegmentKey(botGlobalMetaId, objects.map((obj) => obj.id)),
    journalObjectIds: [...journalObjectIds],
  };
}

export function packSegments(
  botGlobalMetaId: string,
  objects: ChainBackupObject[],
  createdAt = Math.floor(Date.now() / 1000),
): PackedBackupSegment[] {
  const segments: PackedBackupSegment[] = [];
  let current: ChainBackupObject[] = [];
  let currentSize = 64;
  for (const original of objects) {
    for (const obj of expandOversizedObject(original)) {
      const size = Buffer.byteLength(canonicalJson(obj), 'utf8');
      if (current.length > 0 && currentSize + size > CHAIN_BACKUP_SEGMENT_PLAINTEXT_LIMIT) {
        segments.push(buildSegment(botGlobalMetaId, current, createdAt));
        current = [];
        currentSize = 64;
      }
      current.push(obj);
      currentSize += size;
    }
  }
  if (current.length > 0) segments.push(buildSegment(botGlobalMetaId, current, createdAt));
  return segments;
}

export function buildObjectPinContent(
  backupKey: Buffer,
  botGlobalMetaId: string,
  segmentPlaintext: Record<string, unknown>,
  segmentKey?: string,
): string {
  const encrypted = encryptBytes(backupKey, gzipSync(Buffer.from(canonicalJson(segmentPlaintext), 'utf8')));
  return canonicalJson({
    version: CHAIN_BACKUP_VERSION,
    bot: botGlobalMetaId,
    segment: objectId(segmentPlaintext),
    ...(segmentKey ? { segmentKey } : {}),
    cipher: CHAIN_BACKUP_CIPHER,
    kdf: CHAIN_BACKUP_KDF,
    encoding: CHAIN_BACKUP_ENCODING_GZIP,
    payload: encrypted.toString('base64'),
  });
}

export function buildManifestContent(input: {
  botGlobalMetaId: string;
  botName: string;
  segments: ChainBackupSegmentRef[];
  updatedAt?: number;
}): string {
  const totalObjects = input.segments.reduce((sum, segment) => sum + segment.objectIds.length, 0);
  const totalBytes = input.segments.reduce((sum, segment) => sum + segment.bytes, 0);
  return canonicalJson({
    version: CHAIN_BACKUP_VERSION,
    bot: input.botGlobalMetaId,
    botName: input.botName,
    keyCustody: 'envelope',
    updatedAt: input.updatedAt ?? Math.floor(Date.now() / 1000),
    segments: input.segments,
    stats: { objects: totalObjects, bytes: totalBytes },
  });
}

export function materializeBackupObjects(objects: ChainBackupObject[]): ChainBackupObject[] {
  const chunks = new Map<string, ChainBackupObject[]>();
  for (const obj of objects) {
    if (obj.kind !== 'object_chunk') continue;
    const originalId = typeof obj.data.of === 'string' ? obj.data.of : '';
    if (!originalId) throw new Error('INVALID_OBJECT_CHUNK');
    const group = chunks.get(originalId) ?? [];
    group.push(obj);
    chunks.set(originalId, group);
  }
  if (chunks.size === 0) return objects;

  const materializedGroups = new Map<string, ChainBackupObject>();
  for (const [originalId, group] of chunks) {
    const first = group[0];
    const total = Number(first.data.total);
    if (!Number.isInteger(total) || total <= 0 || group.length !== total) {
      throw new Error(`INCOMPLETE_OBJECT_CHUNK:${originalId}`);
    }
    const ordered = [...group].sort((a, b) => Number(a.data.index) - Number(b.data.index));
    const buffers: Buffer[] = [];
    for (let index = 0; index < total; index += 1) {
      const chunk = ordered[index];
      if (Number(chunk.data.index) !== index || chunk.data.encoding !== 'base64') {
        throw new Error(`INCOMPLETE_OBJECT_CHUNK:${originalId}`);
      }
      buffers.push(Buffer.from(String(chunk.data.payload ?? ''), 'base64'));
    }
    const parsed = JSON.parse(Buffer.concat(buffers).toString('utf8')) as {
      kind: ChainBackupObject['kind'];
      data: Record<string, unknown>;
    };
    if (
      originalId !== chainBackupObjectId(parsed.kind, parsed.data)
      && originalId !== objectId({ kind: parsed.kind, data: parsed.data })
    ) {
      throw new Error(`OBJECT_CHUNK_HASH_MISMATCH:${originalId}`);
    }
    materializedGroups.set(originalId, { id: originalId, kind: parsed.kind, data: parsed.data });
  }

  const emitted = new Set<string>();
  const result: ChainBackupObject[] = [];
  for (const obj of objects) {
    if (obj.kind !== 'object_chunk') {
      result.push(obj);
      continue;
    }
    const originalId = String(obj.data.of);
    if (emitted.has(originalId)) continue;
    emitted.add(originalId);
    result.push(materializedGroups.get(originalId) as ChainBackupObject);
  }
  return result;
}
