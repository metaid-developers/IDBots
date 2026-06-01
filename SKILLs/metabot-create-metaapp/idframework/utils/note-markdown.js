import { resolveAttachmentUrl } from './note-attachments.js';

const METAFILE_URI_PATTERN = /metafile:\/\/[A-Za-z0-9._/-]+/g;

function normalizeInputs(attachmentsOrOptions, maybeOptions) {
  if (Array.isArray(attachmentsOrOptions)) {
    return {
      attachments: attachmentsOrOptions,
      options: maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {},
    };
  }

  var options = attachmentsOrOptions && typeof attachmentsOrOptions === 'object'
    ? attachmentsOrOptions
    : {};
  return {
    attachments: Array.isArray(options.attachments) ? options.attachments : [],
    options: options,
  };
}

function getAttachmentResolver(options = {}) {
  if (typeof options.resolveAttachmentUrl === 'function') {
    return options.resolveAttachmentUrl;
  }
  return function resolveWithDefaults(value) {
    return resolveAttachmentUrl(value, options);
  };
}

export function replaceMarkdownAttachmentPlaceholders(content, attachmentsOrOptions, maybeOptions = {}) {
  var text = String(content || '');
  var normalized = normalizeInputs(attachmentsOrOptions, maybeOptions);
  if (!text || !normalized.attachments.length) return text;
  var resolve = getAttachmentResolver(normalized.options);

  return normalized.attachments.reduce(function replaceValue(result, attachment, index) {
    var url = resolve(attachment, normalized.options);
    if (!url) return result;
    return result.replaceAll('{{attachment-' + index + '}}', url);
  }, text);
}

export function replaceMarkdownMetafileUris(content, options = {}) {
  var text = String(content || '');
  if (!text) return text;
  var resolve = getAttachmentResolver(options);

  return text.replace(METAFILE_URI_PATTERN, function replaceUri(match) {
    return resolve(match, options);
  });
}

export function replaceNoteAttachmentPlaceholders(content, options = {}) {
  return replaceMarkdownMetafileUris(
    replaceMarkdownAttachmentPlaceholders(content, options),
    options,
  );
}

export function normalizeNoteMarkdown(content, attachmentsOrOptions, maybeOptions = {}) {
  var normalized = normalizeInputs(attachmentsOrOptions, maybeOptions);
  return replaceMarkdownMetafileUris(
    replaceMarkdownAttachmentPlaceholders(content, normalized.attachments, normalized.options),
    normalized.options,
  );
}
