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
