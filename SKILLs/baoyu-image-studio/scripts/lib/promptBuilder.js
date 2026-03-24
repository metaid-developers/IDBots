const fs = require('node:fs');
const path = require('node:path');
const { normalizeString } = require('./providerCommon');

const SUPPORTED_MODES = ['generate', 'cover', 'infographic', 'comic'];
const MODE_ALIASES = {
  image: 'generate',
  illustration: 'generate',
  poster: 'cover',
  head: 'cover',
  header: 'cover',
  info: 'infographic',
  card: 'infographic',
  manga: 'comic',
  storyboard: 'comic',
};

const TEMPLATE_CACHE = new Map();

function normalizeMode(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return '';
  }
  if (SUPPORTED_MODES.includes(normalized)) {
    return normalized;
  }
  return MODE_ALIASES[normalized] || '';
}

function containsModeKeyword(value, keywords) {
  const text = normalizeString(value).toLowerCase();
  if (!text) {
    return false;
  }
  return keywords.some((keyword) => text.includes(keyword));
}

function detectMode(payload = {}) {
  const explicit = normalizeMode(payload.mode);
  if (explicit) {
    return explicit;
  }

  if (Array.isArray(payload.bullets) && payload.bullets.length > 0) {
    return 'infographic';
  }

  if (
    (Array.isArray(payload.panels) && payload.panels.length > 0)
    || containsModeKeyword(payload.style, ['comic', '漫画', 'manga'])
    || containsModeKeyword(payload.intent, ['comic', '漫画', '分镜'])
  ) {
    return 'comic';
  }

  if (
    normalizeString(payload.title)
    || containsModeKeyword(payload.intent, ['cover', '封面', '海报', 'header'])
    || containsModeKeyword(payload.prompt, ['cover', '封面', '海报'])
  ) {
    return 'cover';
  }

  return 'generate';
}

function loadTemplate(mode) {
  const normalizedMode = normalizeMode(mode);
  if (!normalizedMode || normalizedMode === 'generate') {
    return '';
  }
  if (TEMPLATE_CACHE.has(normalizedMode)) {
    return TEMPLATE_CACHE.get(normalizedMode);
  }

  const filePath = path.resolve(__dirname, '..', '..', 'templates', `${normalizedMode}.md`);
  const template = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trim() : '';
  TEMPLATE_CACHE.set(normalizedMode, template);
  return template;
}

function summarizeTitle(payload = {}, mode = detectMode(payload)) {
  const candidates = [
    payload.title,
    payload.topic,
    payload.subject,
    payload.prompt,
  ];

  for (const candidate of candidates) {
    const value = normalizeString(candidate);
    if (value) {
      return value;
    }
  }

  return `${mode} image`;
}

function asList(label, values) {
  if (!Array.isArray(values) || values.length === 0) {
    return '';
  }
  const lines = values
    .map((value) => normalizeString(value))
    .filter(Boolean)
    .map((value) => `- ${value}`);
  if (lines.length === 0) {
    return '';
  }
  return `${label}\n${lines.join('\n')}`;
}

function buildPrompt(payload = {}) {
  const mode = normalizeMode(payload.mode) || detectMode(payload);
  const title = summarizeTitle(payload, mode);
  const subject = normalizeString(payload.prompt || payload.subject || payload.topic || payload.title);
  const style = normalizeString(payload.style);
  const extra = normalizeString(payload.notes || payload.instructions);
  const template = loadTemplate(mode);

  const sections = [
    `Mode: ${mode}`,
    template ? `Template\n${template}` : '',
    `Goal\nCreate a ${mode} image about: ${title}`,
    subject ? `Primary Brief\n${subject}` : '',
    style ? `Style\n${style}` : '',
    asList('Infographic Points', payload.bullets),
    asList('Comic Panels', payload.panels),
    extra ? `Extra Instructions\n${extra}` : '',
    'Output Requirements\nProduce one polished local image file unless the user explicitly requests multiple variants.',
  ].filter(Boolean);

  return sections.join('\n\n');
}

module.exports = {
  SUPPORTED_MODES,
  buildPrompt,
  detectMode,
  normalizeMode,
  summarizeTitle,
};
