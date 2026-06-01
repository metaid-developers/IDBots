const METAFILE_PREFIX = 'metafile://';
const DEFAULT_METAFS_BASE = 'https://file.metaid.io/metafile-indexer/api/v1';

function stripQueryAndHash(value) {
  return String(value || '').trim().split('?')[0].split('#')[0].trim();
}

function getConfiguredMetafsBase(options = {}) {
  var explicit = String(options.metafsBaseUrl || options.gatewayBase || '').trim();
  if (explicit) return explicit;

  var serviceLocator = typeof window !== 'undefined' && window && window.ServiceLocator
    ? window.ServiceLocator
    : {};
  if (serviceLocator.metafs) return String(serviceLocator.metafs).trim();

  var config = typeof window !== 'undefined' && window && window.IDConfig
    ? window.IDConfig
    : {};
  return String(config.METAFS_BASE_URL || '').trim();
}

function normalizeMetafsBase(value) {
  var text = String(value || '').trim() || DEFAULT_METAFS_BASE;
  text = text.replace(/\/+$/, '');
  if (/\/v1$/i.test(text)) return text;
  return text + '/v1';
}

function pickAttachmentValue(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';

  if (typeof value.uploadedUri === 'string') return value.uploadedUri.trim();
  if (typeof value.uri === 'string') return value.uri.trim();
  if (typeof value.url === 'string') return value.url.trim();
  if (typeof value.value === 'string') return value.value.trim();
  if (typeof value.pinId === 'string' && value.pinId.trim()) {
    return METAFILE_PREFIX + value.pinId.trim();
  }
  return '';
}

function canonicalAttachmentKey(value) {
  var text = pickAttachmentValue(value);
  if (!text) return '';
  if (text.indexOf(METAFILE_PREFIX) === 0) {
    var pinId = extractMetafileId(text);
    return pinId ? METAFILE_PREFIX + pinId : text;
  }
  return text;
}

export function isMetafileUri(value) {
  return pickAttachmentValue(value).indexOf(METAFILE_PREFIX) === 0;
}

export function extractMetafileId(value) {
  var text = stripQueryAndHash(pickAttachmentValue(value));
  if (!text || text.indexOf(METAFILE_PREFIX) !== 0) return '';
  var raw = text.slice(METAFILE_PREFIX.length).trim();
  if (!raw) return '';

  var tail = raw.split('/').pop() || raw;
  var pinMatch = tail.match(/[A-Fa-f0-9]{64}i\d+/);
  if (pinMatch && pinMatch[0]) return pinMatch[0];
  return tail.replace(/\.[A-Za-z0-9]{1,10}$/i, '');
}

export function resolveAttachmentUrl(value, options = {}) {
  var text = pickAttachmentValue(value);
  if (!text) return '';
  if (text.indexOf(METAFILE_PREFIX) !== 0) return text;
  var pinId = extractMetafileId(text);
  if (!pinId) return '';
  return normalizeMetafsBase(getConfiguredMetafsBase(options)) + '/files/content/' + encodeURIComponent(pinId);
}

export function normalizeNoteAttachments(values) {
  if (!Array.isArray(values)) return [];
  var seen = new Set();

  return values.reduce(function collect(result, item) {
    if (item && typeof item === 'object' && item.keep === false) return result;

    var value = pickAttachmentValue(item);
    if (!value) return result;
    var key = canonicalAttachmentKey(value);
    if (!key || seen.has(key)) return result;
    seen.add(key);
    result.push(value);
    return result;
  }, []);
}

export function mergeNoteAttachments(existing, incoming) {
  var merged = normalizeNoteAttachments(existing);
  var instructions = Array.isArray(incoming) ? incoming : [];

  instructions.forEach(function apply(item) {
    var value = pickAttachmentValue(item);
    if (!value) return;
    var key = canonicalAttachmentKey(value);
    if (!key) return;

    if (item && typeof item === 'object' && item.keep === false) {
      merged = merged.filter(function keep(current) {
        return canonicalAttachmentKey(current) !== key;
      });
      return;
    }

    var exists = merged.some(function hasCurrent(current) {
      return canonicalAttachmentKey(current) === key;
    });
    if (!exists) merged.push(value);
  });

  return normalizeNoteAttachments(merged);
}

export function resolveNoteCoverUrl(value, options = {}) {
  return resolveAttachmentUrl(value, options);
}
