/**
 * escrowCardCore — pure DOM-free / i18n-free parser, serializer, and types for
 * `escrow-card` fenced blocks. Safe to import from Electron main-process
 * modules (e.g. `tokenCardSyntax` -> `tokenCardService`) as well as renderer
 * and Cloud Mobile without pulling in `window.electron` ambient types.
 */

export const ESCROW_CARD_FENCE_TAG = 'escrow-card';

/** Mirrors main-side ESCROW_STATES (doc 03 §3). */
export const ESCROW_CARD_STATES = [
  'CREATED',
  'ITEM_ESCROWED',
  'PAID_EVIDENCE_UPLOADED',
  'SELLER_CONFIRMED',
  'RELEASED',
  'DISPUTED',
  'REFUND_ROLLED_BACK',
  'CANCELLED',
] as const;
export type EscrowCardState = (typeof ESCROW_CARD_STATES)[number];

/** Terminal states (mirrors main-side TERMINAL_STATES): no appeal entry. */
export const ESCROW_CARD_TERMINAL_STATES: readonly EscrowCardState[] = ['RELEASED', 'REFUND_ROLLED_BACK', 'CANCELLED'];

export const buildEscrowAppealTemplate = (orderId: string): string =>
  `escrow_order_act order_id=${orderId} action=dispute_open basis=<你的申诉理由>`;

export type EscrowCardGoodsKind = 'mrc721' | 'metacontract' | 'digital' | 'service';
const GOODS_KIND_RE = /^(mrc721|metacontract|digital|service)$/;

/** Required fence: `escrow-card`. */
export const isEscrowCardFenceLanguage = (language: string): boolean =>
  language.trim().toLowerCase() === ESCROW_CARD_FENCE_TAG;

const MAX_TEXT = 120;
const LABEL_RE = /^[0-9A-Za-z_\-·.\u4e00-\u9fff]{1,40}$/;

const cleanLabel = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ').slice(0, 40);
  return LABEL_RE.test(trimmed) ? trimmed : undefined;
};

const cleanText = (value: unknown, max = 160): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
};

const cleanEpochMs = (value: unknown): number | undefined => {
  const num = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(num) || num < 0 || num > 4_102_444_800_000) return undefined;
  return num;
};

const cleanCents = (value: unknown): number | undefined => {
  const num = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(num) || num < 0 || num > 9_999_999_999) return undefined;
  return num;
};

const cleanProofRef = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || /\s/.test(trimmed)) return undefined;
  return trimmed;
};

export interface EscrowCardParties {
  seller: string;
  buyer: string;
  agent: string;
}

export interface EscrowCardData {
  orderId: string;
  title?: string;
  kind: EscrowCardGoodsKind;
  amountCents: number;
  state: EscrowCardState;
  stateEnteredAt: number;
  timerHours: number;
  next?: { actor: string; text: string };
  parties: EscrowCardParties;
  custodyProof?: string;
  disputeOpen?: boolean;
}

const ORDER_ID_CLEAN_RE = /^[A-Za-z0-9_\-: ]{1,64}$/;

export const parseEscrowCardFence = (codeText: string): EscrowCardData | null => {
  const text = String(codeText ?? '').trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  const orderId = typeof raw.orderId === 'string' ? raw.orderId.trim().slice(0, 64) : '';
  if (!orderId || !ORDER_ID_CLEAN_RE.test(orderId)) return null;

  const kind = typeof raw.kind === 'string' && GOODS_KIND_RE.test(raw.kind) ? (raw.kind as EscrowCardGoodsKind) : null;
  if (!kind) return null;

  const amountCents = cleanCents(raw.amountCents);
  if (amountCents === undefined) return null;

  const state = typeof raw.state === 'string' && (ESCROW_CARD_STATES as readonly string[]).includes(raw.state)
    ? (raw.state as EscrowCardState)
    : null;
  if (!state) return null;

  const seller = cleanLabel(raw.parties && (raw.parties as Record<string, unknown>).seller) ?? '';
  const buyer = cleanLabel(raw.parties && (raw.parties as Record<string, unknown>).buyer) ?? '';
  const agent = cleanLabel(raw.parties && (raw.parties as Record<string, unknown>).agent) ?? '';
  if (!seller || !buyer || !agent) return null;

  const stateEnteredAt = cleanEpochMs(raw.stateEnteredAt);
  if (stateEnteredAt === undefined) return null;
  const timerHours = raw.timerHours === undefined ? 0 : cleanCents(raw.timerHours);
  if (timerHours === undefined || timerHours > 24 * 60) return null;

  const nextRaw = raw.next as Record<string, unknown> | undefined;
  const next = nextRaw
    ? { actor: cleanLabel(nextRaw.actor), text: cleanText(nextRaw.text, 200) }
    : null;
  if (nextRaw && (!next?.actor || !next?.text)) return null;

  const data: EscrowCardData = {
    orderId,
    kind,
    amountCents,
    state,
    stateEnteredAt,
    timerHours,
    parties: { seller, buyer, agent },
    disputeOpen: raw.disputeOpen === true,
  };
  if (typeof raw.title === 'string' && raw.title.trim()) data.title = raw.title.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT);
  if (next) data.next = next;
  const custodyProof = cleanProofRef(raw.custodyProof);
  if (custodyProof) data.custodyProof = custodyProof;
  return data;
};

/** Serialize the payload for a bot that composes the fence (chat 消息流双轨用). */
export const serializeEscrowCardFence = (data: EscrowCardData): string => {
  const body = {
    orderId: data.orderId,
    ...(data.title ? { title: data.title } : {}),
    kind: data.kind,
    amountCents: data.amountCents,
    state: data.state,
    stateEnteredAt: data.stateEnteredAt,
    timerHours: data.timerHours,
    ...(data.next ? { next: data.next } : {}),
    parties: data.parties,
    ...(data.custodyProof ? { custodyProof: data.custodyProof } : {}),
    ...(data.disputeOpen ? { disputeOpen: true } : {}),
  };
  return `\`\`\`${ESCROW_CARD_FENCE_TAG}\n${JSON.stringify(body)}\n\`\`\``;
};

/** 分 × 100 → ￥x.xx（一分口径，法币点对点显示用）。 */
export const formatEscrowYuan = (cents: number): string => {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const yuanInteger = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}￥${yuanInteger}.${frac}`;
};
