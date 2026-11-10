/**
 * escrow-card fence syntax — chat escrow card contract (S3 slice, doc 03 §2 /
 * §3 状态表). A bot (the escrow agent) embeds the card as a fenced code block
 * tagged `escrow-card` whose body is one JSON object:
 *
 * ```escrow-card
 * {"orderId":"esc-42","title":"星球系列 #3","kind":"mrc721","amountCents":9900,
 *  "state":"ITEM_ESCROWED","stateEnteredAt":1793640000000,"timerHours":24,
 *  "next":{"actor":"买方","text":"请点对点付款并上传凭证"},
 *  "parties":{"seller":"0xAlice","buyer":"0xBob","agent":"担保bot"},
 *  "custodyProof":"3f2a…i0","disputeOpen":false}
 * ```
 *
 * This module is DOM-free so server-rendered tests drive it directly. It is
 * deliberately self-contained (no src/main imports): the state list here
 * mirrors the main-side escrowOrderStateMachine and the escrow bot fills the
 * payload from its live order row. Design rule this slice must not violate:
 * zero funds flow — the card only ever shows状态/下一步/剩余时间/证据；它没有
 * 「去付款放款」类资金按钮。
 *
 * 与 S3 支付卡不冲突：独立 fence 标签（`escrow-card` vs `pay-card`）、独立组
 * 件文件、独立 data 标记；分享的只有样式词汇（与 main 上的 NftCard 同语法）。
 * feat/s3-paycard 未合并；若未来需要复用其工具函数，只按工单规则复制小函数
 * 并注明来源。
 */

import { i18nService } from '../../services/i18n';

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

/**
 * 申诉/复核动作模板（04 分支三入口形态）：复制进对应会话，由当事 bot 用
 * escrow_order_act 执行。机器侧语义不变：dispute_open 需书面依据，每方每单
 * ≤2 次；DISPUTED 内再次申诉=对一级裁决的复核请求（owner 复核）。
 */
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
  if (!Number.isInteger(num) || num < 0 || num > 9_999_999_999) return undefined; // ≤ ~1 亿分
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
  /** 当前计时器启动时点（状态进入时间），渲染端算剩余时间。 */
  stateEnteredAt: number;
  /** 当前状态计时器时长 h（对应 T1–T4 之一；无计时器态传 0）。 */
  timerHours: number;
  /** 下一步该谁做什么（由担保 bot 从订单行算好塞进来）。 */
  next?: { actor: string; text: string };
  parties: EscrowCardParties;
  /** 在押证明引用（txid / 密文哈希 / 订单快照哈希），展示用截断。 */
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

const STATE_LABEL_KEYS: Record<EscrowCardState, string> = {
  CREATED: 'escrowStateCreated',
  ITEM_ESCROWED: 'escrowStateItemEscrowed',
  PAID_EVIDENCE_UPLOADED: 'escrowStatePaidEvidence',
  SELLER_CONFIRMED: 'escrowStateSellerConfirmed',
  RELEASED: 'escrowStateReleased',
  DISPUTED: 'escrowStateDisputed',
  REFUND_ROLLED_BACK: 'escrowStateRefundRolledBack',
  CANCELLED: 'escrowStateCancelled',
};
export const escrowCardStateLabel = (state: EscrowCardState): string =>
  i18nService.t(STATE_LABEL_KEYS[state]);

const STATE_TONE: Record<EscrowCardState, string> = {
  CREATED: 'text-slate-300 bg-slate-700/60',
  ITEM_ESCROWED: 'text-amber-300 bg-amber-700/30',
  PAID_EVIDENCE_UPLOADED: 'text-yellow-300 bg-yellow-700/30',
  SELLER_CONFIRMED: 'text-sky-300 bg-sky-700/30',
  RELEASED: 'text-emerald-300 bg-emerald-700/30',
  DISPUTED: 'text-orange-300 bg-orange-700/40',
  REFUND_ROLLED_BACK: 'text-rose-300 bg-rose-700/30',
  CANCELLED: 'text-slate-400 bg-slate-700/40',
};
export const escrowCardStateTone = (state: EscrowCardState): string => STATE_TONE[state];

export const ESCROW_GOODS_KIND_LABELS: Record<EscrowCardGoodsKind, string> = {
  mrc721: 'MRC-721',
  metacontract: 'MetaContract',
  digital: 'Digital deliverable',
  service: 'Service order',
};

/** Goods-kind display label: protocol names stay verbatim, the rest via i18n. */
export const escrowGoodsKindLabel = (kind: EscrowCardGoodsKind): string => {
  if (kind === 'digital') return i18nService.t('escrowGoodsDigital');
  if (kind === 'service') return i18nService.t('escrowGoodsService');
  return ESCROW_GOODS_KIND_LABELS[kind];
};

/** 剩余时间文案；无计时器态（终态/DISPUTED）返回 null。 */
export const escrowRemainingTimeText = (data: EscrowCardData, now: number): string | null => {
  if (!data.timerHours) return null;
  const deadlineAt = data.stateEnteredAt + data.timerHours * 3_600_000;
  const remainingMs = deadlineAt - now;
  if (remainingMs <= 0) return null;
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  if (hours >= 48) {
    return i18nService.t('escrowRemainingDays').replace('{days}', String(Math.floor(hours / 24)));
  }
  if (hours >= 1) {
    return i18nService.t('escrowRemainingHours')
      .replace('{hours}', String(hours))
      .replace('{minutes}', String(minutes));
  }
  return i18nService.t('escrowRemainingMinutes').replace('{minutes}', String(minutes));
};

