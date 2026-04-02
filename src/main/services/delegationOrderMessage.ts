export interface BuildDelegationOrderPayloadInput {
  taskContext?: string | null;
  userTask?: string | null;
  serviceName?: string | null;
  providerSkill?: string | null;
  servicePinId?: string | null;
  paymentTxid: string;
  price: string;
  currency: string;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const ORDER_PREFIX_RE = /^\s*\[ORDER\]\s*/i;
const STRUCTURED_ORDER_METADATA_LINE_RE = /^\s*(?:支付金额|payment(?: amount)?|txid|transaction id|service(?:\s+pin)?\s+id|service(?:\s+id)?|serviceid|skill(?:\s+name)?|provider\s*skill|service\s+skill|服务(?:\s*pin)?\s*id|服务(?:编号|标识|ID)|技能(?:名称?)?|服务技能|服务名称)\s*[:：=]?/i;
const TRANSPORT_CHATTER_FRAGMENT_PATTERNS = [
  /(?:^|[，,。；;])\s*已确认同意使用远程MetaBot服务[^，,。；;\n]*/gi,
  /(?:^|[，,。；;])\s*已支付\s*[0-9]+(?:\.[0-9]+)?\s*(?:SPACE|BTC|DOGE)[^，,。；;\n]*/gi,
  /(?:^|[，,。；;])\s*支付\s*[0-9]+(?:\.[0-9]+)?\s*(?:SPACE|BTC|DOGE)(?:费用|服务费|订单金额)?[^，,。；;\n]*/gi,
  /(?:^|[，,。；;])\s*txid\s*[:：=]?\s*[0-9a-fA-F]{6,64}[^，,。；;\n]*/gi,
  /(?:^|[，,。；;])\s*你收到一笔[^，,。；;\n]*/gi,
  /(?:^|[，,。；;])\s*已收到你[^，,。；;\n]*/gi,
  /(?:^|[，,。；;])\s*(?:马上处理|正在处理|开始处理)[^，,。；;\n]*/gi,
];

function sanitizeDelegationOrderNaturalText(value: unknown): string {
  const source = String(value || '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '';

  const keptLines: string[] = [];
  source.split('\n').forEach((line, index) => {
    const withoutPrefix = index === 0 ? line.replace(ORDER_PREFIX_RE, '') : line;
    const trimmed = withoutPrefix.trim();
    if (!trimmed) return;
    if (STRUCTURED_ORDER_METADATA_LINE_RE.test(trimmed)) return;
    keptLines.push(trimmed);
  });

  let cleaned = keptLines.join(' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  TRANSPORT_CHATTER_FRAGMENT_PATTERNS.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, '');
  });

  return cleaned
    .replace(/\s+/g, ' ')
    .replace(/^[，,。；;:：\s]+/, '')
    .replace(/[，,。；;:：\s]+$/, '')
    .trim();
}

function buildDelegationOrderNaturalText(input: BuildDelegationOrderPayloadInput): string {
  return (
    sanitizeDelegationOrderNaturalText(input.taskContext)
    || sanitizeDelegationOrderNaturalText(input.userTask)
    || normalizeText(input.serviceName)
    || resolveDelegationOrderSkillName(input)
  );
}

export function resolveDelegationOrderSkillName(input: {
  providerSkill?: string | null;
  serviceName?: string | null;
}): string {
  return normalizeText(input.providerSkill) || normalizeText(input.serviceName) || 'Service Order';
}

export function buildDelegationOrderPayload(
  input: BuildDelegationOrderPayloadInput
): string {
  const naturalText = buildDelegationOrderNaturalText(input);
  const skillName = resolveDelegationOrderSkillName(input);
  const structuredFields = [
    `支付金额 ${normalizeText(input.price)} ${normalizeText(input.currency)}`,
    `txid: ${normalizeText(input.paymentTxid)}`,
    `service id: ${normalizeText(input.servicePinId)}`,
    `skill name: ${skillName}`,
  ].join('\n');

  return `[ORDER] ${naturalText}\n${structuredFields}`;
}
