export const CHAIN_BACKUP_OBJECT_PATH = '/protocols/metabot-backup/object';
export const CHAIN_BACKUP_MANIFEST_PATH = '/protocols/metabot-backup/manifest';
export const CHAIN_BACKUP_VERSION = 1;
export const CHAIN_BACKUP_CIPHER = 'aes-256-gcm';
export const CHAIN_BACKUP_KDF = 'hkdf-sha256:user-globalmetaid';
export const CHAIN_BACKUP_SEGMENT_PLAINTEXT_LIMIT = 256 * 1024;
/**
 * Payload encoding marker on segment envelopes. Segments written before
 * compression landed carry no `encoding` field and hold raw canonical-JSON
 * ciphertext; `gzip` means the decrypted payload is gzip-compressed JSON.
 */
export const CHAIN_BACKUP_ENCODING_GZIP = 'gzip';
/**
 * Segment storage marker on manifest refs. Refs written before the metafile
 * switch carry no `storage` field and point at legacy inline-JSON pins under
 * CHAIN_BACKUP_OBJECT_PATH; `metafile` means the pinId is a `/file` metafile
 * whose content is the raw encrypted segment (gzip inside AES-256-GCM).
 */
export const CHAIN_BACKUP_SEGMENT_STORAGE_METAFILE = 'metafile';
export const CHAIN_BACKUP_METAFILE_CONTENT_TYPE = 'application/octet-stream';
