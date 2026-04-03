function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const DEFAULT_BUYER_ORDER_CHAT_TIMEOUT_MS = 8000;

const ORDER_PREFIX_RE = /^\s*\[ORDER\]\s*/i;
const STRUCTURED_ORDER_METADATA_LINE_RE = /^\s*(?:支付金额|payment(?: amount)?|txid|transaction id|order(?:\s+id|\s+ref(?:erence)?)?|service(?:\s+pin)?\s+id|service(?:\s+id)?|serviceid|skill(?:\s+name)?|provider\s*skill|service\s+skill|服务(?:\s*pin)?\s*id|服务(?:编号|标识|ID)|订单(?:编号|标识|ID)|技能(?:名称?)?|服务技能|服务名称)\s*[:：=]?/i;
const FORBIDDEN_ORDER_CHATTER_PATTERNS = [
  /已收到你.*付款/i,
  /收到你.*付款/i,
  /你收到一笔.*订单/i,
  /收到一笔.*订单/i,
  /收到.*订单啦/i,
  /我需要调用.*技能/i,
  /请求技能/i,
  /支付金额/i,
  /\btxid\b/i,
  /\border\s+(?:id|ref(?:erence)?)\b/i,
  /transaction id/i,
  /交易id/i,
  /service id/i,
  /skill name/i,
  /马上处理/i,
  /正在处理/i,
  /开始处理/i,
];

function buildPersonaLine(buyerPersona) {
  if (!buyerPersona || typeof buyerPersona !== 'object') return '';
  return [
    normalizeText(buyerPersona.name) ? `Your name is ${normalizeText(buyerPersona.name)}.` : '',
    normalizeText(buyerPersona.role) ? `Your role: ${normalizeText(buyerPersona.role)}.` : '',
    normalizeText(buyerPersona.soul) ? `Your personality: ${normalizeText(buyerPersona.soul)}.` : '',
    normalizeText(buyerPersona.background) ? `Background: ${normalizeText(buyerPersona.background)}.` : '',
  ].filter(Boolean).join(' ');
}

export function buildBuyerOrderNaturalFallback(requestText) {
  const request = normalizeText(requestText);
  return request
    ? `想请你帮我处理这个需求：${request}`
    : '想请你帮我处理一个需求。';
}

function normalizeTimeoutMs(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Number(timeoutMs)
    : DEFAULT_BUYER_ORDER_CHAT_TIMEOUT_MS;
}

function resolveBuyerOrderFallback(requestText) {
  return buildBuyerOrderNaturalFallback(requestText);
}

export function normalizeBuyerOrderNaturalText(text, requestText) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  const lines = [];

  source.split('\n').forEach((line, index) => {
    const withoutPrefix = index === 0 ? line.replace(ORDER_PREFIX_RE, '') : line;
    const trimmed = withoutPrefix.trim();
    if (!trimmed) return;
    if (STRUCTURED_ORDER_METADATA_LINE_RE.test(trimmed)) return;
    lines.push(trimmed);
  });

  const compact = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (!compact) {
    return buildBuyerOrderNaturalFallback(requestText);
  }
  if (FORBIDDEN_ORDER_CHATTER_PATTERNS.some((pattern) => pattern.test(compact))) {
    return buildBuyerOrderNaturalFallback(requestText);
  }
  return compact;
}

async function waitForBuyerOrderChatResult(chatPromise, timeoutMs, cancel) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        cancel?.();
      } catch {}
      reject(new Error('buyer_order_chat_timeout'));
    }, normalizeTimeoutMs(timeoutMs));

    Promise.resolve(chatPromise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function generateBuyerOrderNaturalText(input, deps = {}) {
  const requestText = normalizeText(input?.requestText);
  const fallback = resolveBuyerOrderFallback(requestText);
  if (typeof deps.chat !== 'function') {
    return fallback;
  }

  try {
    const systemMsg = buildBuyerOrderMessageSystemPrompt(input);
    const result = await waitForBuyerOrderChatResult(
      deps.chat(
        'Write the natural-language request now.',
        undefined,
        [{ role: 'system', content: systemMsg }]
      ),
      deps.timeoutMs,
      deps.cancel
    );
    return normalizeBuyerOrderNaturalText(result?.content, requestText);
  } catch {
    return fallback;
  }
}

export function buildBuyerOrderMessageSystemPrompt(input) {
  const personaLine = buildPersonaLine(input?.buyerPersona);
  const requestText = normalizeText(input?.requestText);
  const skillName = normalizeText(input?.skillName) || 'the requested skill';
  const price = normalizeText(input?.price) || 'the agreed price';
  const currency = normalizeText(input?.currency) || '';
  const numericPrice = Number(normalizeText(input?.price));
  const isFreeOrder = Number.isFinite(numericPrice) && numericPrice === 0;
  const txid = normalizeText(input?.txid) || 'the payment txid';
  const orderReference = normalizeText(input?.orderReference) || 'the order id';
  const serviceId = normalizeText(input?.serviceId) || 'the service id';
  const structuredMetadataSummary = isFreeOrder
    ? `Structured metadata will be appended separately after your sentence: payment amount ${price} ${currency}, order id ${orderReference}, service id ${serviceId}, required skill ${skillName}. Do not restate any of those metadata fields.`
    : `Structured metadata will be appended separately after your sentence: payment amount ${price} ${currency}, txid ${txid}, service id ${serviceId}, required skill ${skillName}. Do not restate any of those metadata fields.`;

  return [
    personaLine,
    'You are the buyer MetaBot sending a service order to another MetaBot seller.',
    'Write only the natural-language request that should appear before the structured order metadata.',
    'Stay strictly in the buyer role and speak in your own voice.',
    requestText ? `Actual user request: "${requestText}"` : '',
    structuredMetadataSummary,
    'Do not say that you received payment, that the seller received an order, or that you are starting to process the task.',
    'Do not use phrases like "已收到你xx的付款", "你收到一笔订单", "马上处理", or "正在处理".',
    'Focus only on the task the seller should perform.',
    'Prefer 1 sentence, maximum 2 short sentences.',
    'Do not use markdown, brackets, JSON, bullet points, or transport metadata.',
  ].filter(Boolean).join('\n');
}
