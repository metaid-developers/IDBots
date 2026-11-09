/**
 * escrowOrderStateMachine — S3 generalized escrow order state machine
 * (design docs bots/1/2026-11-02/S3-fiat-escrow-design 03 + 04, v1.0 code slice).
 *
 * One machine runs all three goods kinds (NFT MRC721/MetaContract, digital
 * deliverables, service orders — doc 03 §2). Fiat rail: money moves
 * point-to-point OUTSIDE the system; "money arrived" is replaced by buyer
 * evidence + seller confirmation, so the table has NO funds action and no
 * "platform received money" state — zero-funds-flow is the red line (03 §5.1).
 *
 * Serialization contract (03 MVP + 04 write-up): an order is a plain JSON
 * object; deadlines are never stored as timers — they derive from order
 * fields + `now`, so a restarted escrow bot re-derives T1–T4 by scanning
 * (04 "setTimeout 不落库"). Storage-agnostic: callers persist `EscrowOrder`
 * as a document row.
 *
 * DOM-free, dependency-free; unit tests run this source directly under tsx.
 */

// ---------------------------------------------------------------------------
// States / actors / actions (doc 03 §3 state table)
// ---------------------------------------------------------------------------

export const ESCROW_STATES = [
  'CREATED',
  'ITEM_ESCROWED',
  'PAID_EVIDENCE_UPLOADED',
  'SELLER_CONFIRMED',
  'RELEASED',
  'DISPUTED',
  'REFUND_ROLLED_BACK',
  'CANCELLED',
] as const;
export type EscrowState = (typeof ESCROW_STATES)[number];

const TERMINAL_STATES = new Set<EscrowState>(['RELEASED', 'REFUND_ROLLED_BACK', 'CANCELLED']);
export const isEscrowTerminalState = (state: EscrowState): boolean => TERMINAL_STATES.has(state);

/** Doc 03 §2: Seller / Buyer / EscrowAgent (whitelist bot) / system Timer. */
export const ESCROW_ACTORS = ['seller', 'buyer', 'escrow_agent', 'system'] as const;
export type EscrowActor = (typeof ESCROW_ACTORS)[number];

export type EscrowGoodsKind = 'mrc721' | 'metacontract' | 'digital' | 'service';

export const ESCROW_ACTIONS = [
  'escrow_goods', // 卖方托管货（转押 PIN/token / 密文+密钥承诺 / 条款哈希）【人工:卖方】
  'upload_payment_evidence', // 买方（系统外）付款后上传凭证【人工:买方】
  'confirm_received', // 卖方核对到账：金额精确到分 + 备注含订单号【人工:卖方·关键确认点】
  'release_goods', // 担保人双查（货在押 + 凭证/确认齐备）后放货【人工:担保人】
  'cancel_mutual', // 双方合意取消（一方发起→另一方确认，两次人工确认）
  'cancel_request', // 单方取消请求：只生成不执行，12h 无响应且无付款证据视同合意
  'cancel_unilateral_timeout', // 系统计时：单方请求挂 12h 无响应 → 作废取消
  'timeout_t1_cancel', // T1 到期：卖方未托管 → 取消，无善后
  'timeout_t2_return_goods', // T2 到期：买方未付款 → 货退卖方 → 取消
  'timeout_t3_dispute', // T3 到期：卖方未确认 → DISPUTED（不自动放款不自动退款）
  'timeout_t4_escalate', // T4 到期：担保人未放行（失职位）→ DISPUTED 升级 owner
  'dispute_open', // 任一方在 PAID_EVIDENCE_UPLOADED / SELLER_CONFIRMED 申诉（人工）
  'ruling_release', // 一级裁决=放行（担保人；owner 复核改判走同动作，basis 加 owner: 前缀）
  'ruling_rollback', // 裁决=回退：货退卖方自动执行 + 退款指令（法币由卖方手动退）
  'refund_confirmed', // 终验：买方收妥退款，订单在 REFUND_ROLLED_BACK 内归档关闭
  'record_note', // 调证/举证等不改状态的动作，只进 append-only 订单日志
] as const;
export type EscrowAction = (typeof ESCROW_ACTIONS)[number];

/**
 * Doc 03 §2 托管形态 per kind: 托管物 / 在押证明 / 放行动作 / 退回物。
 * The system touches only the goods leg; fiat never moves through it.
 */
export const ESCROW_CUSTODY: Record<
  EscrowGoodsKind,
  { custody: string; escrowProof: string; release: string; returnName: string }
> = {
  mrc721: {
    custody: 'item PIN 转移到担保人地址',
    escrowProof: '链上转移 txid + 索引确认',
    release: '转移 PIN 给买方',
    returnName: 'PIN 转回卖方',
  },
  metacontract: {
    custody: 'token 转移到担保人地址（场景 B 已实证）',
    escrowProof: '链上转移 txid + 索引确认',
    release: 'wallet 转回买方',
    returnName: 'token 转回卖方',
  },
  digital: {
    custody: '密文（内容加密）+ sha256 明文承诺，解密密钥交担保人保管',
    escrowProof: '密文哈希 + 密钥分片承诺',
    release: '密钥交付买方（先给密文、后放密钥）',
    returnName: '密钥归还卖方',
  },
  service: {
    custody: '条款即托管物（范围/时限/验收标准写死在订单）',
    escrowProof: '订单快照哈希',
    release: '无实物放行；确认完成即终态',
    returnName: '条款作废',
  },
};

// ---------------------------------------------------------------------------
// Transition table: (from, action) → allowed actors + target + payload gates
// ---------------------------------------------------------------------------

export interface EscrowTransitionSpec {
  from: EscrowState;
  action: EscrowAction;
  actors: readonly EscrowActor[];
}

/** Table source of truth: (from, action) → allowed actors. Doc 03 ⚠ marks. */
export const ESCROW_TRANSITIONS: readonly EscrowTransitionSpec[] = [
  { from: 'CREATED', action: 'escrow_goods', actors: ['seller'] },
  { from: 'ITEM_ESCROWED', action: 'upload_payment_evidence', actors: ['buyer'] },
  { from: 'PAID_EVIDENCE_UPLOADED', action: 'confirm_received', actors: ['seller'] },
  { from: 'SELLER_CONFIRMED', action: 'release_goods', actors: ['escrow_agent'] },
  { from: 'CREATED', action: 'cancel_mutual', actors: ['seller', 'buyer', 'escrow_agent', 'system'] },
  { from: 'ITEM_ESCROWED', action: 'cancel_mutual', actors: ['seller', 'buyer', 'escrow_agent', 'system'] },
  { from: 'CREATED', action: 'cancel_request', actors: ['seller', 'buyer'] },
  { from: 'ITEM_ESCROWED', action: 'cancel_request', actors: ['seller', 'buyer'] },
  { from: 'CREATED', action: 'cancel_unilateral_timeout', actors: ['system'] },
  { from: 'ITEM_ESCROWED', action: 'cancel_unilateral_timeout', actors: ['system'] },
  { from: 'CREATED', action: 'timeout_t1_cancel', actors: ['system'] },
  { from: 'ITEM_ESCROWED', action: 'timeout_t2_return_goods', actors: ['system'] },
  { from: 'PAID_EVIDENCE_UPLOADED', action: 'timeout_t3_dispute', actors: ['system'] },
  { from: 'SELLER_CONFIRMED', action: 'timeout_t4_escalate', actors: ['system'] },
  { from: 'PAID_EVIDENCE_UPLOADED', action: 'dispute_open', actors: ['seller', 'buyer'] },
  { from: 'SELLER_CONFIRMED', action: 'dispute_open', actors: ['seller', 'buyer'] },
  // 04 二级：任一方对一级裁决申诉复核（owner 复核，MVP 只记录）。
  { from: 'DISPUTED', action: 'dispute_open', actors: ['seller', 'buyer'] },
  { from: 'DISPUTED', action: 'ruling_release', actors: ['escrow_agent'] },
  { from: 'DISPUTED', action: 'ruling_rollback', actors: ['escrow_agent'] },
  { from: 'REFUND_ROLLED_BACK', action: 'refund_confirmed', actors: ['seller', 'buyer', 'escrow_agent'] },
  { from: 'CREATED', action: 'record_note', actors: ['seller', 'buyer', 'escrow_agent'] },
  { from: 'ITEM_ESCROWED', action: 'record_note', actors: ['seller', 'buyer', 'escrow_agent'] },
  { from: 'PAID_EVIDENCE_UPLOADED', action: 'record_note', actors: ['seller', 'buyer', 'escrow_agent'] },
  { from: 'SELLER_CONFIRMED', action: 'record_note', actors: ['seller', 'buyer', 'escrow_agent'] },
  { from: 'DISPUTED', action: 'record_note', actors: ['seller', 'buyer', 'escrow_agent'] },
];

export type EscrowProofKind = 'txid' | 'hash' | 'ref';
const TXID_RE = /^[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-fA-F]{64}$/;

export interface EscrowTransitionTarget {
  to: EscrowState;
  /** Doc 03 §5.3: state moves must carry txid / content hash / evidence ref. */
  proofKind?: EscrowProofKind;
  gates?: {
    /** Invariant 5: amount matched exactly ( seller confirm / evidence check ). */
    amountCentsExact?: boolean;
    /** Invariant 5: memo embeds the order id（scheme 备注=订单号，01 §2.2）. */
    memoOrderNumber?: boolean;
    /** Two human confirmations required for mutual cancel (doc 04 branch 2). */
    mutualConfirmed?: boolean;
    /** Ruling needs a written basis（04 分支三：依据伴随裁决）. */
    rulingBasis?: boolean;
  };
}

/** proof kind by goods kind for escrow_goods / release_goods（03 §2 表）. */
function goodsProofKind(kind: EscrowGoodsKind): EscrowProofKind {
  switch (kind) {
    case 'mrc721':
    case 'metacontract':
      return 'txid'; // 链上转移 txid
    case 'digital':
      return 'hash'; // 密文哈希 / 密钥承诺
    case 'service':
      return 'hash'; // 订单快照哈希 / 确认完成记录哈希
  }
}

const ESCROW_TARGETS = new Map<string, EscrowTransitionTarget>();
const transitionKey = (from: EscrowState, action: EscrowAction): string => `${from}:${action}`;

for (const spec of ESCROW_TRANSITIONS) {
  let to: EscrowState;
  switch (spec.action) {
    case 'escrow_goods': to = 'ITEM_ESCROWED'; break;
    case 'upload_payment_evidence': to = 'PAID_EVIDENCE_UPLOADED'; break;
    case 'confirm_received': to = 'SELLER_CONFIRMED'; break;
    case 'release_goods': to = 'RELEASED'; break;
    case 'cancel_mutual':
    case 'cancel_unilateral_timeout':
    case 'timeout_t1_cancel':
    case 'timeout_t2_return_goods':
      to = 'CANCELLED';
      break;
    case 'cancel_request': to = spec.from; break; // 只挂请求、不执行状态迁移（04 分支二）
    case 'timeout_t3_dispute':
    case 'timeout_t4_escalate':
    case 'dispute_open':
      to = 'DISPUTED';
      break;
    case 'ruling_release': to = 'RELEASED'; break;
    case 'ruling_rollback': to = 'REFUND_ROLLED_BACK'; break;
    case 'refund_confirmed': to = 'REFUND_ROLLED_BACK'; break;
    case 'record_note': to = spec.from; break;
    default: {
      const exhaustive: never = spec.action;
      throw new Error(`unmapped escrow action ${String(exhaustive)}`);
    }
  }
  const target: EscrowTransitionTarget = { to };
  // goods moves: proof kind resolved per live order's goodsKind at apply time;
  // the table records nothing so the static view stays kind-agnostic.
  if (spec.action === 'upload_payment_evidence') {
    target.proofKind = 'ref'; // 凭证（截图+金额+订单号）落档引用
    target.gates = { memoOrderNumber: true };
  }
  if (spec.action === 'confirm_received') {
    target.proofKind = 'ref'; // 卖方核对记录引用
    target.gates = { amountCentsExact: true, memoOrderNumber: true };
  }
  if (spec.action === 'cancel_mutual') target.gates = { mutualConfirmed: true };
  // 货腿动作（托管/放行/退回）：提交时必须附真实世界凭证，种类随标的托管形态。
  if (spec.action === 'timeout_t2_return_goods' || spec.action === 'ruling_rollback') {
    target.proofKind = 'txid'; // 表级默认；apply 时按 goodsKind 重解（数字交付物=哈希）
  }
  if (spec.action === 'dispute_open' || spec.action === 'ruling_release' || spec.action === 'ruling_rollback') {
    target.gates = { ...(target.gates ?? {}), rulingBasis: true };
  }
  ESCROW_TARGETS.set(transitionKey(spec.from, spec.action), target);
}

// ---------------------------------------------------------------------------
// Order shape（plain JSON 落库即可序列化）
// ---------------------------------------------------------------------------

export interface EscrowTimelineEntry {
  from: EscrowState;
  to: EscrowState;
  actor: EscrowActor;
  action: EscrowAction;
  /** 状态迁移必填（txid / 哈希 / 凭证引用三选一）；record_note / reminder 可不带。 */
  proof?: string;
  /** 裁决依据 / 申诉理由。 */
  basis?: string;
  note?: string;
  at: number;
  /** reminder 条目不改状态（分支一）。 */
  reminder?: boolean;
}

export interface EscrowTimers {
  /** Doc 03 §4 defaults (hours); per-order overridable. */
  t1Hours: number;
  t2Hours: number;
  t3Hours: number;
  t4Hours: number;
}

export const ESCROW_DEFAULT_TIMERS: EscrowTimers = { t1Hours: 24, t2Hours: 24, t3Hours: 48, t4Hours: 24 };

/** Anti-spam ledger: each timer may fire `50%` and `-2h` once (04 branch 1). */
export interface EscrowRemindersFired {
  [timer: string]: string[];
}

export interface EscrowOrder {
  orderId: string;
  goodsKind: EscrowGoodsKind;
  /** Fiat consideration, exact to the cent (分). */
  amountCents: number;
  roles: { seller: string; buyer: string; escrowAgent: string };
  title?: string;
  state: EscrowState;
  /** 当前态进入时间（计时器锚，重启后重推 deadline 用）。 */
  stateEnteredAt: number;
  createdAt: number;
  timers: EscrowTimers;
  timeline: EscrowTimelineEntry[];
  reminders: EscrowRemindersFired;
  /** 每方申诉次数（04 防滥用：每方每单 ≤2 次，第二次须附新证据）。 */
  disputesByParty: { seller: number; buyer: number };
  /** 负面记录 (subject, kind, note)：只记录不惩罚（04 MVP 清单 5）。 */
  negativeRecords: { subject: string; kind: string; note: string; at: number }[];
  /** 单方取消请求在途（04 分支二：只生成不执行）。 */
  pendingCancelRequest?: { by: 'seller' | 'buyer'; at: number };
  /** Owner-level review pending flag (T4 escalation, or an in-dispute appeal
   *  against a first-level ruling). Surfaced on escrow_order_info / escrow_tick;
   *  resolved by a second ruling whose basis carries the `owner:` prefix. */
  ownerReview?: { reason: string; at: number };
}

export const createEscrowOrder = (opts: {
  orderId: string;
  goodsKind: EscrowGoodsKind;
  amountCents: number;
  roles: { seller: string; buyer: string; escrowAgent: string };
  title?: string;
  now?: number;
  timers?: Partial<EscrowTimers>;
}): EscrowOrder => {
  const now = opts.now ?? Date.now();
  if (!opts.orderId?.trim()) throw new Error('orderId required');
  if (!opts.roles?.seller?.trim() || !opts.roles?.buyer?.trim() || !opts.roles?.escrowAgent?.trim()) {
    throw new Error('roles: seller / buyer / escrowAgent are all required');
  }
  if (!Number.isInteger(opts.amountCents) || opts.amountCents < 0) {
    throw new Error('amountCents must be a non-negative integer（分）');
  }
  return {
    orderId: opts.orderId,
    goodsKind: opts.goodsKind,
    amountCents: opts.amountCents,
    roles: opts.roles,
    title: opts.title,
    state: 'CREATED',
    stateEnteredAt: now,
    createdAt: now,
    timers: { ...ESCROW_DEFAULT_TIMERS, ...opts.timers },
    timeline: [],
    reminders: {},
    disputesByParty: { seller: 0, buyer: 0 },
    negativeRecords: [],
  };
};

// ---------------------------------------------------------------------------
// Applying transitions
// ---------------------------------------------------------------------------

export interface EscrowTransitionEvent {
  actor: EscrowActor;
  action: EscrowAction;
  proof?: string;
  /** 金额核对值（must equal order.amountCents where required）。 */
  basisAmountCents?: number;
  /** 付款备注原文（must embed orderId where required）。 */
  basisMemo?: string;
  /** 双方合意取消：两次人工确认齐备。 */
  mutualConfirmed?: boolean;
  /** 裁决依据 / 申诉理由（owner 复核改判用 `owner:` 前缀）。 */
  basis?: string;
  note?: string;
  at?: number;
}

export type EscrowApplyResult =
  | { ok: true; order: EscrowOrder }
  | { ok: false; reason: string };

const transitionMeta = (from: EscrowState, action: EscrowAction): EscrowTransitionSpec | undefined =>
  ESCROW_TRANSITIONS.find((t) => t.from === from && t.action === action);

/** proofKind for live orders: goods moves AND goods returns follow the order's goods kind. */
const isGoodsLegAction = (action: EscrowAction): boolean =>
  action === 'escrow_goods' || action === 'release_goods' ||
  action === 'timeout_t2_return_goods' || action === 'ruling_rollback';
const resolveProofKind = (order: EscrowOrder, target: EscrowTransitionTarget, action: EscrowAction): EscrowProofKind | undefined => {
  if (isGoodsLegAction(action)) return goodsProofKind(order.goodsKind);
  return target.proofKind;
};

/** Apply one transition. Pure: returns a NEW order object (never mutates). */
export const applyEscrowTransition = (order: EscrowOrder, event: EscrowTransitionEvent): EscrowApplyResult => {
  const at = event.at ?? Date.now();

  // Invariant 4: 终态幂等。唯一例外 refund_confirmed 在 REFUND_ROLLED_BACK 内归档。
  if (isEscrowTerminalState(order.state) && !(order.state === 'REFUND_ROLLED_BACK' && event.action === 'refund_confirmed')) {
    return { ok: false, reason: `terminal state ${order.state}: action ${event.action} rejected (invariant 4)` };
  }

  const meta = transitionMeta(order.state, event.action);
  if (!meta) {
    const legal = ESCROW_TRANSITIONS.filter((t) => t.from === order.state).map((t) => t.action);
    return {
      ok: false,
      reason: `illegal transition: ${order.state} has no action ${event.action}（legal here: ${legal.join(', ') || 'none'}）`,
    };
  }
  if (!meta.actors.includes(event.actor)) {
    return { ok: false, reason: `actor ${event.actor} may not perform ${event.action} from ${order.state}（legal: ${meta.actors.join('/')}）` };
  }

  const target = ESCROW_TARGETS.get(transitionKey(order.state, event.action))!;
  const gates = target.gates ?? {};
  if (gates.amountCentsExact && event.basisAmountCents !== order.amountCents) {
    return { ok: false, reason: `amount mismatch: evidence ${event.basisAmountCents ?? 'none'} ≠ order ${order.amountCents}（核对到分）` };
  }
  if (gates.memoOrderNumber && !(event.basisMemo ?? '').includes(order.orderId)) {
    return { ok: false, reason: `memo must embed orderId ${order.orderId}（凭证核对锚）` };
  }
  if (gates.mutualConfirmed && event.mutualConfirmed !== true) {
    return { ok: false, reason: '双方合意取消需要两次人工确认都满足' };
  }
  if (gates.rulingBasis && !(event.basis ?? '').trim()) {
    return { ok: false, reason: `${event.action} 需要书面依据（裁决依据/申诉理由）` };
  }
  if (event.action === 'dispute_open') {
    if (event.actor !== 'seller' && event.actor !== 'buyer') {
      return { ok: false, reason: '申诉是买方/卖方的人工动作' };
    }
    const party = event.actor;
    const used = order.disputesByParty[party];
    // 04 防滥用：每方每单 ≤2 次；第 2 次起必须附新证据（与上一条申诉理由不同）。
    if (used >= 2) {
      return { ok: false, reason: '每方每单申诉上限 2 次（04 防滥用）' };
    }
    if (used === 1) {
      const lastNote = [...order.timeline].reverse().find((e) => e.action === 'dispute_open' && e.actor === party)?.note ?? '';
      const newEvidence = (event.note ?? '').trim().length > 0 && (event.note ?? '').trim() !== lastNote;
      if (!newEvidence) return { ok: false, reason: '第二次申诉必须附新证据（04 防滥用）' };
    }
  }

  const stateMoves = target.to !== order.state;
  if (stateMoves) {
    // Invariant 3: 证据链完备。
    if (!event.proof?.trim()) {
      return { ok: false, reason: `state move ${order.state} → ${target.to} requires proof (invariant 3)` };
    }
    const kind = resolveProofKind(order, target, event.action);
    if (kind === 'txid' && !TXID_RE.test(event.proof.trim())) {
      return { ok: false, reason: `${event.action} 的 proof 必须是 64-hex 链上 txid` };
    }
    if (kind === 'hash' && !HASH_RE.test(event.proof.trim())) {
      return { ok: false, reason: `${event.action} 的 proof 必须是 64-hex 内容哈希` };
    }
    if (event.proof.trim().length > 256) return { ok: false, reason: 'proof too long (≤256 chars)' };
  }
  if ((event.note?.length ?? 0) > 512 || (event.basis?.length ?? 0) > 512) {
    return { ok: false, reason: 'note/basis too long (≤512 chars)' };
  }

  // Invariant 2 的防御性再断言（表已在 CREATED 禁掉该动作，这里防回退）。
  if (event.action === 'upload_payment_evidence' && order.state !== 'ITEM_ESCROWED') {
    return { ok: false, reason: '先押后款被违反：付款凭证只能在 ITEM_ESCROWED 后上传（invariant 2）' };
  }

  const entry: EscrowTimelineEntry = { from: order.state, to: target.to, actor: event.actor, action: event.action, at };
  if (event.proof?.trim()) entry.proof = event.proof.trim();
  if (event.basis?.trim()) entry.basis = event.basis.trim();
  if (event.note?.trim()) entry.note = event.note.trim();

  const next: EscrowOrder = {
    ...order,
    state: target.to,
    stateEnteredAt: stateMoves ? at : order.stateEnteredAt,
    timeline: [...order.timeline, entry],
    disputesByParty: { ...order.disputesByParty },
    reminders: { ...order.reminders },
    negativeRecords: [...order.negativeRecords],
  };

  if (event.action === 'cancel_request') {
    // 只挂请求（04 分支二）：不改状态，12h 静默由 escrowDueTimeoutAt 判。
    next.pendingCancelRequest = { by: event.actor === 'buyer' ? 'buyer' : 'seller', at };
  }
  if (event.action === 'upload_payment_evidence') {
    // 钱可能已经动了——离开安全区（04 分支二硬边界：此后不存在自动回滚）。
    delete next.pendingCancelRequest;
  }
  if (stateMoves && order.pendingCancelRequest) {
    delete next.pendingCancelRequest;
  }
  if (event.action === 'timeout_t2_return_goods') {
    next.negativeRecords.push({ subject: 'order', kind: 'timeout_cancel', note: 'T2 到期：买方未付款，货自动退卖方', at });
  }
  if (event.action === 'timeout_t1_cancel') {
    next.negativeRecords.push({ subject: 'order', kind: 'timeout_cancel', note: 'T1 到期：卖方未托管，订单取消无善后', at });
  }
  if (event.action === 'timeout_t4_escalate') {
    next.ownerReview = { reason: 'T4 expiry: agent failed to release after confirmation', at };
    next.negativeRecords.push({ subject: 'escrowAgent', kind: 'failure-marker', note: 'T4 到期：担保人未放行，升级 owner（放行仍人工）', at });
  }
  if (event.action === 'ruling_release' || event.action === 'ruling_rollback') {
    const level = (event.basis ?? '').startsWith('owner:') ? 'owner' : 'first';
    next.negativeRecords.push({ subject: `ruling:${level}`, kind: event.action, note: event.basis ?? '', at });
  }
  if (event.action === 'dispute_open') {
    if (event.actor === 'seller' || event.actor === 'buyer') next.disputesByParty[event.actor] += 1;
    if (order.state === 'DISPUTED') {
      // DISPUTED 内的再次申诉 = 对一级裁决的复核请求（04 二级 owner）。
      next.ownerReview = { reason: 'appeal against first-level ruling (owner review)', at };
    }
  }
  return { ok: true, order: next };
};

/**
 * Record a reminder (branch 1: pressure without state move). Deduped by the
 * anti-spam ledger — a repeat of the same stage is a no-op.
 */
export const applyEscrowReminder = (order: EscrowOrder, timer: 't1' | 't2' | 't3' | 't4', stage: '50%' | '-2h', at = Date.now()): EscrowOrder => {
  const fired = new Set(order.reminders[timer] ?? []);
  if (fired.has(stage)) return order;
  fired.add(stage);
  return {
    ...order,
    timeline: [
      ...order.timeline,
      { from: order.state, to: order.state, actor: 'system', action: 'record_note', at, reminder: true, note: `reminder:${timer}:${stage}` },
    ],
    reminders: { ...order.reminders, [timer]: [...fired] },
  };
};

// ---------------------------------------------------------------------------
// Invariants（03 §5 五条 —— 纯函数断言器，供测试与监管扫描复用）
// ---------------------------------------------------------------------------

/** Invariant 1: 零资金流 —— 时间线内不允许任何资金过手型动作/记录。 */
const ZERO_FUNDS_FORBIDDEN_RE = /(move[_-]?funds|platform[_-]?(receive|transfer|hold|pays|payout)|agent[_-]?(recv|received|held|pays?)[_-]?(funds|money|cny|space|me\b)|auto[_-]?(release|refund)[_-]?(funds|money))/i;
export const assertZeroFundsFlow = (order: EscrowOrder): true | string => {
  for (const entry of order.timeline) {
    if (ZERO_FUNDS_FORBIDDEN_RE.test(entry.action)) {
      return `invariant 1 violated: action ${entry.action} moves money through the platform`;
    }
    if (ZERO_FUNDS_FORBIDDEN_RE.test(entry.basis ?? '')) {
      return `invariant 1 violated: basis at t=${entry.at} records a platform funds transfer`;
    }
  }
  return true;
};

/** Invariant 2: 先押后款 —— 付款凭证上传的合法前置只有 ITEM_ESCROWED。 */
export const assertNoPaymentBeforeEscrow = (order: EscrowOrder): true | string => {
  for (const entry of order.timeline) {
    if (entry.action === 'upload_payment_evidence' && entry.to !== 'PAID_EVIDENCE_UPLOADED') {
      return `invariant 2 violated: payment evidence fired from ${entry.from}`;
    }
  }
  return true;
};

/** Invariant 3: 证据链完备 —— 每次状态迁移都带 txid / 哈希 / 凭证引用。 */
export const assertProofChainComplete = (order: EscrowOrder): true | string => {
  for (const entry of order.timeline) {
    if (entry.to !== entry.from && !entry.reminder && !entry.proof?.trim()) {
      return `invariant 3 violated: state move ${entry.from}→${entry.to} lacks proof`;
    }
  }
  return true;
};

/** Invariant 4: 终态幂等 —— 终态之后不允许再出现状态迁移。 */
export const assertTerminalIdempotent = (order: EscrowOrder): true | string => {
  let terminalSeen: EscrowState | null = null;
  for (const entry of order.timeline) {
    if (terminalSeen) {
      if (entry.to !== entry.from) return `invariant 4 violated: move after terminal ${terminalSeen}`;
      continue;
    }
    if (isEscrowTerminalState(entry.to)) terminalSeen = entry.to;
  }
  return true;
};

/** Invariant 5: 凭证核对锚 —— 卖方确认记录必须带 amount=<精确分> 依据。 */
export const assertEvidenceAnchor = (order: EscrowOrder): true | string => {
  for (const entry of order.timeline) {
    if (entry.action === 'confirm_received' && !entry.basis?.includes('amount=')) {
      return `invariant 5 violated: seller confirm without amount anchor at t=${entry.at}`;
    }
  }
  return true;
};

/** Run all five invariants; returns the first violated reason or true. */
export const assertEscrowInvariants = (order: EscrowOrder): true | string => {
  const checks: Array<((o: EscrowOrder) => true | string)> = [
    assertZeroFundsFlow,
    assertNoPaymentBeforeEscrow,
    assertProofChainComplete,
    assertTerminalIdempotent,
    assertEvidenceAnchor,
  ];
  for (const check of checks) {
    const verdict = check(order);
    if (verdict !== true) return verdict;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Clock: reminders (50% / −2h) + timeout branches (doc 04 / 03 §4)
// ---------------------------------------------------------------------------

export interface EscrowClockSideEffect {
  kind: 'reminder' | 'timeout';
  timer: 't1' | 't2' | 't3' | 't4';
  /** 50% 一档、−2h 一档（每档 ≤1 条）；timeout 时为 'expired'. */
  stage: '50%' | '-2h' | 'expired';
  /** Rendered reminder text: @responsible party + remaining time + what to do
   *  next + the timeout consequence (composed by reminderMessageOf). */
  message: string;
  /** timeout 时调用方要 apply 的系统动作。 */
  dueAction?: EscrowAction;
  /** T2 到期需要担保 bot 执行的货退动作（03 §2 退货物名）。 */
  goodsReturn?: string;
}

const TIMER_OF_STATE: Partial<Record<EscrowState, 't1' | 't2' | 't3' | 't4'>> = {
  CREATED: 't1',
  ITEM_ESCROWED: 't2',
  PAID_EVIDENCE_UPLOADED: 't3',
  SELLER_CONFIRMED: 't4',
};

const RESPONSIBLE_OF_TIMER: Record<'t1' | 't2' | 't3' | 't4', string> = {
  t1: '卖方：请尽快托管货（NFT 转押 / 密文+密钥承诺 / 条款哈希）',
  t2: '买方：请付款并在支付卡内点「我已支付」上传凭证',
  t3: '卖方：请核收到账并确认（金额核对到分，备注含订单号）',
  t4: '担保人：请完成双查并放货',
};

/** Active timer of the CURRENT state, deadline derived from state entered-at. */
export const escrowActiveTimerOf = (
  order: EscrowOrder,
): { timer: 't1' | 't2' | 't3' | 't4'; deadlineAt: number; hours: number; responsible: string } | null => {
  const timer = TIMER_OF_STATE[order.state];
  if (!timer) return null;
  const hours = order.timers[`${timer}Hours` as keyof EscrowTimers];
  return {
    timer,
    hours,
    deadlineAt: order.stateEnteredAt + hours * 3_600_000,
    responsible: RESPONSIBLE_OF_TIMER[timer],
  };
};

const REMINDER_CONSEQUENCE: Record<'t1' | 't2' | 't3' | 't4', string> = {
  t1: '超时订单自动取消（无善后）',
  t2: '超时担保 bot 自动退货并取消订单',
  t3: '超时转担保人仲裁（不自动放款不自动退款）',
  t4: '超时升级 owner（担保人失职记录）',
};

const reminderMessageOf = (order: EscrowOrder, timer: 't1' | 't2' | 't3' | 't4', remainingMs: number): string =>
  `T${timer.slice(1)} 提醒 @${order.roles[TIMER_ROLE_OF[timer]]}：${RESPONSIBLE_OF_TIMER[timer]}；剩余 ${Math.max(1, Math.ceil(remainingMs / 3_600_000))}h；${REMINDER_CONSEQUENCE[timer]}`;

const TIMER_ROLE_OF: Record<'t1' | 't2' | 't3' | 't4', 'seller' | 'buyer' | 'escrowAgent'> = {
  t1: 'seller',
  t2: 'buyer',
  t3: 'seller',
  t4: 'escrowAgent',
};

/**
 * 分支一 · 自动提醒：扫描当前状态计时器在 `now` 应触发的提醒档位。
 * 不改状态；调用方拿 events 走消息模板，并用 applyEscrowReminder 落档。
 */
export const escrowClockScan = (order: EscrowOrder, now: number): EscrowClockSideEffect[] => {
  const active = escrowActiveTimerOf(order);
  if (!active) return [];
  const elapsed = now - order.stateEnteredAt;
  const total = active.hours * 3_600_000;
  const remainingMs = active.deadlineAt - now;
  const fired = new Set(order.reminders[active.timer] ?? []);

  const events: EscrowClockSideEffect[] = [];
  if (elapsed >= total / 2 && !fired.has('50%')) {
    events.push({ kind: 'reminder', timer: active.timer, stage: '50%', message: reminderMessageOf(order, active.timer, remainingMs) });
  }
  if (remainingMs > 0 && remainingMs <= 2 * 3_600_000 && !fired.has('-2h')) {
    events.push({ kind: 'reminder', timer: active.timer, stage: '-2h', message: reminderMessageOf(order, active.timer, remainingMs) });
  }
  return events;
};

/**
 * Due-timeout map（03 §4 / 04 分支二·三）。T1/T2 ∈ 全自动安全区；T3/T4 是升级
 * DISPUTED —— **铁律：既不自动放款、也不自动退款**（钱是否到账住在外部世界，
 * 系统内没有可信副本，唯一安全去向是转人工仲裁，03 §3 论证）。
 */
export const ESCROW_TIMEOUT_ACTIONS: Record<'t1' | 't2' | 't3' | 't4', { action: EscrowAction }> = {
  t1: { action: 'timeout_t1_cancel' },
  t2: { action: 'timeout_t2_return_goods' },
  t3: { action: 'timeout_t3_dispute' },
  t4: { action: 'timeout_t4_escalate' },
};

// 仲裁入口（04 分支三）已落位：一级=担保人调证+裁决（escrow_order_act 的
// ruling_release / ruling_rollback，放行/回退二选一，basis 必填）；二级=owner
// 复核（维持/改判）——owner 改判复用 ruling_* 动作，basis 加 `owner:` 前缀落
// 档；当事人申诉入口在渲染侧 escrow-card 的「申诉 / 复核」展开面板。失职处置
// （白名单除名）仍只记录，不自动除名。
export const ESCROW_RULING_LEVELS = ['first', 'owner'] as const;

/** 单方取消请求 12h 静默阈值（04 分支二）。 */
const CANCEL_REQUEST_GRACE_MS = 12 * 3_600_000;

/** 判断在 `now` 该单是否命中某个超时动作（重启安全：全部由订单字段重推）。 */
export const escrowDueTimeoutAt = (order: EscrowOrder, now: number): EscrowClockSideEffect | null => {
  const active = escrowActiveTimerOf(order);
  if (active && now >= active.deadlineAt) {
    const meta = ESCROW_TIMEOUT_ACTIONS[active.timer];
    return {
      kind: 'timeout',
      timer: active.timer,
      stage: 'expired',
      message: `${active.timer.toUpperCase()} 到期：${meta.action === 'timeout_t2_return_goods' ? goodsReturnOf(order) + '，' : ''}${ROLLBACK_OR_ESCALATE_TEXT[active.timer]}`,
      dueAction: meta.action,
      goodsReturn: meta.action === 'timeout_t2_return_goods' ? goodsReturnOf(order) : undefined,
    };
  }
  // 单方取消请求的 12h 静默视同合意取消（仅安全区需要，状态落在 CREATED/ITEM_ESCROWED 时才存在该请求）。
  if (order.pendingCancelRequest && now - order.pendingCancelRequest.at >= CANCEL_REQUEST_GRACE_MS) {
    return {
      kind: 'timeout',
      timer: 't1',
      stage: 'expired',
      message: `单方取消请求 12h 无响应且无付款证据 → 请求发起方为 ${order.roles[order.pendingCancelRequest.by]}`,
      dueAction: 'cancel_unilateral_timeout',
    };
  }
  return null;
};

const ROLLBACK_OR_ESCALATE_TEXT: Record<'t1' | 't2' | 't3' | 't4', string> = {
  t1: '取消订单（无善后）',
  t2: '自动退货并取消',
  t3: '转担保人仲裁（人工裁决，不自动放款不自动退款）',
  t4: '升级 owner 复核（担保人失职记录，放行仍人工）',
};

/** goods-return descriptor per live order's kind（T2 到期的自动退货动作说明）。 */
const goodsReturnOf = (order: EscrowOrder): string => `担保 bot 自动执行货退卖方：${ESCROW_CUSTODY[order.goodsKind].returnName}`;

/**
 * 会话消息/渲染骨架的下一步文案：当前状态 → 谁该做什么（03 状态表「允许动作」）。
 */
export const escrowNextStep = (order: EscrowOrder): { actor: string; text: string } | null => {
  switch (order.state) {
    case 'CREATED': return { actor: '卖方', text: '请托管货（买方付款按钮在此前不激活）' };
    case 'ITEM_ESCROWED': return { actor: '买方', text: '请点对点付款并上传凭证' };
    case 'PAID_EVIDENCE_UPLOADED': return { actor: '卖方', text: '请核收到账并确认（金额核对到分）' };
    case 'SELLER_CONFIRMED': return { actor: '担保人', text: '请双查后放货' };
    case 'DISPUTED': return { actor: '担保人', text: '请调证并裁决：放行或回退（回退=货自动退卖方+退款指令由卖方手动执行）' };
    default: return null;
  }
};
