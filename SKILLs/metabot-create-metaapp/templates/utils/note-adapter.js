import { normalizeNoteAttachments } from './note-attachments.js';

export const NOTE_CONTENT_TYPE = 'text/markdown';

export function createEmptyNoteForm() {
  return {
    title: '',
    subtitle: '',
    content: '',
    contentType: NOTE_CONTENT_TYPE,
    encryption: '0',
    coverImg: '',
    createTime: 0,
    tags: [],
    attachments: [],
  };
}

export const createEmptyNoteData = createEmptyNoteForm;

function parseJsonLike(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  var text = value.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return value.reduce(function collect(result, item) {
    var text = String(item || '').trim();
    if (!text) return result;
    result.push(text);
    return result;
  }, []);
}

function normalizeCreateTime(value, fallback) {
  var numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;

  var next = Number(fallback);
  return Number.isFinite(next) && next > 0 ? next : 0;
}

export function normalizeNoteData(raw, fallback = {}) {
  var parsed = parseJsonLike(raw);
  var source = parsed && typeof parsed === 'object'
    ? parsed
    : raw && typeof raw === 'object'
      ? raw
      : {};
  var base = createEmptyNoteForm();

  return {
    title: String(source.title || fallback.title || base.title),
    subtitle: String(source.subtitle || fallback.subtitle || base.subtitle),
    content: String(source.content || fallback.content || base.content),
    contentType: String(source.contentType || fallback.contentType || base.contentType),
    encryption: String(source.encryption || fallback.encryption || base.encryption),
    coverImg: String(source.coverImg || fallback.coverImg || base.coverImg),
    createTime: normalizeCreateTime(source.createTime, fallback.createTime),
    tags: normalizeTags(source.tags || fallback.tags),
    attachments: normalizeNoteAttachments(source.attachments || fallback.attachments),
  };
}

export function parseNoteSummary(rawPin) {
  var pin = rawPin && typeof rawPin === 'object' ? rawPin : {};
  var parsed = null;
  if (pin.contentSummary !== undefined) {
    parsed = parseJsonLike(pin.contentSummary);
  }
  if (!parsed && pin.noteData !== undefined) {
    parsed = parseJsonLike(pin.noteData);
  }
  if (!parsed) {
    parsed = parseJsonLike(rawPin);
  }
  return normalizeNoteData(parsed, {
    createTime: pin.createTime || pin.timestamp || pin.date || 0,
  });
}

export function adaptNoteSummary(rawPin) {
  var pin = rawPin && typeof rawPin === 'object' ? rawPin : {};
  var noteData = parseNoteSummary(pin);
  return {
    ...pin,
    noteData: noteData,
    title: noteData.title,
    subtitle: noteData.subtitle,
    content: noteData.content,
    contentType: noteData.contentType,
    encryption: noteData.encryption,
    coverImg: noteData.coverImg,
    createTime: noteData.createTime,
    tags: noteData.tags,
    attachments: noteData.attachments,
  };
}
