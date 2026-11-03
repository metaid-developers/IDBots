import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { SqliteStore } from '../sqliteStore';
import { EscrowOrderStore } from '../services/escrowOrderStore';
import {
  applyEscrowReminder,
  applyEscrowTransition,
  createEscrowOrder,
  ESCROW_ACTIONS,
  escrowActiveTimerOf,
  escrowClockScan,
  escrowDueTimeoutAt,
  escrowNextStep,
  isEscrowTerminalState,
  type EscrowAction,
  type EscrowActor,
  type EscrowGoodsKind,
  type EscrowOrder,
  type EscrowState,
  type EscrowTimelineEntry,
} from './escrowOrderStateMachine';
import { buildNftCardFence, NFT_CARD_RESULT_HINT, type NftCardEmitFields } from './nftCardMarkdown';
import { nftCardStampIdentity, withNftCardHostStamp, type NftCardStampFields } from './tradeActivityStamp';

/**
 * escrow_* agent tools — first-round runtime slice wiring the PURE
 * escrowOrderStateMachine (the tested contract; its semantics are not
 * modified here) into cowork sessions.
 *
 * Zero-funds-flow red line: these tools NEVER move money or goods. Fiat moves
 * point-to-point outside the system; the goods custody legs (MRC-721 /
 * MetaContract transfers) are executed by the party bots themselves through
 * mrc721_transfer / wallet transfer tools, and the escrow tools only RECORD
 * the resulting txid as the transition proof the state machine demands. There
 * is no wallet import, no transfer call, and no chain-write budget here.
 *
 * Persistence: the full EscrowOrder JSON document lives in the escrow_orders
 * table (EscrowOrderStore); state machine functions stay the only writers of
 * order semantics. The document may carry TOOL extension fields (parties,
 * creatorMetabotId, itemPinId, terms) — the machine functions spread unknown
 * fields through untouched, so round-tripping through
 * applyEscrowTransition / applyEscrowReminder is lossless.
 *
 * Card emission mirrors the renderer contract
 * (src/renderer/components/chat/escrowCardSyntax.ts): an ```escrow-card
 * fenced block whose body carries ONLY the renderer-validated fields, key
 * order matching serializeEscrowCardFence. Because the session trade-badge
 * scanner reads ```nft-card fences only (reserved action 'escrow'), orders
 * carrying an NFT identity also get the stamped ```nft-card announcement
 * appended (hostStamp from tradeActivityStamp) so the emitting session earns
 * the escrow trade badge.
 */

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => Promise<unknown> | unknown;

/** Host control surface, wired in main.ts next to the mrc721Tools control. */
export type EscrowAgentToolsControl = {
  resolveMetabotIdByName(name: string): number | null;
  getMetabotMvcAddress(metabotId: number): string | null;
  /** Display name for party rendering (optional — tests may omit). */
  getMetabotDisplayName?(metabotId: number): string | null;
};

/** One resolved escrow party: canonical identity = MVC address. */
export interface EscrowPartyRef {
  /** Local MetaBot when the party is a local bot; null for external addresses. */
  metabotId: number | null;
  /** MVC address — the exact string written into the machine's roles. */
  address: string;
  /** Local bot display name when known. */
  name?: string;
}

/**
 * The persisted order document: the machine's EscrowOrder plus the tool-side
 * extension fields. The machine functions only read their own fields and
 * spread the rest, so these survive every transition untouched.
 */
export interface EscrowOrderDocument extends EscrowOrder {
  creatorMetabotId: number;
  parties: { seller: EscrowPartyRef; buyer: EscrowPartyRef; escrowAgent: EscrowPartyRef };
  /** MRC-721 goods reference (item pinId) — also feeds the badge stamp. */
  itemPinId?: string;
  /** Free-text terms / goods description (service & digital orders). */
  terms?: string;
}

const ROLE_ACTOR: Record<'seller' | 'buyer' | 'escrowAgent', EscrowActor> = {
  seller: 'seller',
  buyer: 'buyer',
  escrowAgent: 'escrow_agent',
};

// --- small pure helpers (local copies, source-attributed) -------------------

/** Same base58 check as mrc721Service.isMvcAddress (kept local: no service import). */
const isMvcAddressLocal = (value: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{20,}$/.test(value);

/** Same pin shape as mrc721Service.isMrc721PinId: `<64-hex txid>i<index>`. */
const isMrc721PinIdLocal = (value: string): boolean => /^[0-9a-f]{64}i\d+$/.test(value);

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const iso = (ms: number): string => new Date(ms).toISOString();

const formatShortAddress = (address: string | undefined): string => {
  const text = String(address || '');
  if (text.length <= 18) return text || '(unknown)';
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
};

/** Cents → ￥x.xx (same cent-exact convention as the renderer contract). */
const formatYuan = (cents: number): string => {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}￥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

const partyDisplay = (ref: EscrowPartyRef | undefined): string => {
  if (!ref) return '(unknown)';
  if (ref.name) return `${ref.name} (${formatShortAddress(ref.address)})`;
  return formatShortAddress(ref.address);
};

// --- escrow-card fence (renderer contract mirror) ---------------------------

export const ESCROW_CARD_FENCE_TAG = 'escrow-card';

export const ESCROW_CARD_RESULT_HINT =
  'Chat escrow card — include this fenced block verbatim in your reply so every chat client (CoWork, private chat, group chat) renders the escrow state card:';

export interface EscrowCardFenceFields {
  orderId: string;
  title?: string;
  kind: EscrowGoodsKind;
  amountCents: number;
  state: EscrowState;
  stateEnteredAt: number;
  timerHours: number;
  next?: { actor: string; text: string };
  parties: { seller: string; buyer: string; agent: string };
  custodyProof?: string;
  disputeOpen?: boolean;
}

/**
 * Mirror of the renderer's party cleanLabel (escrowCardSyntax.ts): trim,
 * collapse whitespace, ≤40 chars, label charset only. Falls back through
 * address → display name → 'unknown' so a party value can never drop the
 * whole card by failing the renderer's validation.
 */
const labelSafeParty = (ref: EscrowPartyRef | undefined): string => {
  const candidates = [ref?.address, ref?.name, 'unknown'];
  for (const candidate of candidates) {
    const trimmed = String(candidate ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (trimmed && /^[0-9A-Za-z_\-·.\u4e00-\u9fff]{1,40}$/.test(trimmed)) return trimmed;
  }
  return 'unknown';
};

/**
 * Serialize the escrow-card fence with EXACTLY the renderer-validated field
 * set, in serializeEscrowCardFence's key order (orderId, title?, kind,
 * amountCents, state, stateEnteredAt, timerHours, next?, parties,
 * custodyProof?, disputeOpen?). No extra keys: the payload stays within the
 * renderer's validated fields so the card can never be dropped.
 */
export const buildEscrowCardFence = (fields: EscrowCardFenceFields): string => {
  const body: Record<string, unknown> = {
    orderId: fields.orderId,
    ...(fields.title ? { title: fields.title } : {}),
    kind: fields.kind,
    amountCents: fields.amountCents,
    state: fields.state,
    stateEnteredAt: fields.stateEnteredAt,
    timerHours: fields.timerHours,
    ...(fields.next ? { next: fields.next } : {}),
    parties: fields.parties,
    ...(fields.custodyProof ? { custodyProof: fields.custodyProof } : {}),
    ...(fields.disputeOpen ? { disputeOpen: true } : {}),
  };
  return `\`\`\`${ESCROW_CARD_FENCE_TAG}\n${JSON.stringify(body)}\n\`\`\``;
};

/** Most recent goods-leg proof on the timeline (custody → return override). */
const latestCustodyProof = (doc: EscrowOrder): string | undefined => {
  const goodsLegs: EscrowAction[] = ['escrow_goods', 'release_goods', 'timeout_t2_return_goods', 'ruling_rollback'];
  for (let i = doc.timeline.length - 1; i >= 0; i -= 1) {
    const entry = doc.timeline[i];
    if (goodsLegs.includes(entry.action) && entry.proof?.trim()) return entry.proof.trim();
  }
  return undefined;
};

const buildEscrowCardFields = (doc: EscrowOrderDocument): EscrowCardFenceFields => {
  const active = escrowActiveTimerOf(doc);
  const next = escrowNextStep(doc) ?? undefined;
  return {
    orderId: doc.orderId,
    ...(doc.title ? { title: doc.title } : {}),
    kind: doc.goodsKind,
    amountCents: doc.amountCents,
    state: doc.state,
    stateEnteredAt: doc.stateEnteredAt,
    timerHours: active?.hours ?? 0,
    ...(next ? { next } : {}),
    parties: {
      seller: labelSafeParty(doc.parties?.seller),
      buyer: labelSafeParty(doc.parties?.buyer),
      agent: labelSafeParty(doc.parties?.escrowAgent),
    },
    ...(latestCustodyProof(doc) ? { custodyProof: latestCustodyProof(doc) } : {}),
    ...(doc.state === 'DISPUTED' ? { disputeOpen: true } : {}),
  };
};

/**
 * Stamp input for a stateful emit: only orders carrying an MRC-721 item
 * pinId have an NFT identity the host stamp can bind to (nftCardStampIdentity
 * needs a genesis triple or a pinId). Other kinds emit the escrow card
 * unsigned — fail-open exactly like the other emit sites.
 */
const stampInputFor = (doc: EscrowOrderDocument, sessionId: string): { sessionId: string; fields: NftCardStampFields } | undefined => {
  const pinId = asString(doc.itemPinId);
  if (!sessionId || !isMrc721PinIdLocal(pinId)) return undefined;
  return { sessionId, fields: { pinId, action: 'escrow' } };
};

/**
 * Result text + blank line + hint + ```escrow-card fence; when the order
 * carries an NFT identity, ALSO append the host-stamped ```nft-card
 * announcement (action 'escrow' — the reserved syntax-layer value the session
 * trade-badge scanner classifies as escrow activity). The escrow-card payload
 * itself stays exactly within the renderer's validated fields; the stamp
 * binds to the item pinId, the emitting session id, and the issue time.
 */
export const appendEscrowCardBlock = (
  resultText: string,
  fence: EscrowCardFenceFields,
  stamp?: { sessionId: string; fields: NftCardStampFields },
): string => {
  let out = `${resultText}\n\n${ESCROW_CARD_RESULT_HINT}\n${buildEscrowCardFence(fence)}`;
  if (stamp && nftCardStampIdentity(stamp.fields)) {
    const badgeFields: NftCardEmitFields = {
      ...(isMrc721PinIdLocal(asString(stamp.fields.pinId))
        ? { format: 'mrc721' as const, pinId: asString(stamp.fields.pinId) }
        : {}),
      action: 'escrow',
    };
    out += `\n\n${NFT_CARD_RESULT_HINT}\n${buildNftCardFence(withNftCardHostStamp(badgeFields, stamp.sessionId))}`;
  }
  return out;
};

// --- shared tool-side helpers ------------------------------------------------

const ACTIVE_NON_TERMINAL_STATES: EscrowState[] = ['CREATED', 'ITEM_ESCROWED', 'PAID_EVIDENCE_UPLOADED', 'SELLER_CONFIRMED', 'DISPUTED'];

const MRC721_CUSTODY_TEACHING = [
  'For kind mrc721 the custody legs run through mrc721_transfer and this tool NEVER moves the item:',
  'the SELLER first runs mrc721_transfer to the agent bot\'s own MVC address, then records that on-chain txid here as the escrow_goods proof;',
  'on release the AGENT runs mrc721_transfer from its address to the buyer\'s address and records that txid as the release_goods proof.',
].join(' ');

export function buildEscrowAgentTools(deps: {
  tool: SdkToolFactory;
  control: EscrowAgentToolsControl;
  orders: EscrowOrderStore;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | null | undefined;
}): unknown[] {
  const { tool, control, orders, sessionId, resolveMetabotId } = deps;

  const sessionBot = (): { metabotId: number; address: string | null } | null => {
    const id = resolveMetabotId(sessionId);
    if (id == null) return null;
    return { metabotId: id, address: control.getMetabotMvcAddress(id) };
  };

  const requireSessionBot = (toolLabel: string): { metabotId: number; address: string | null } | string => {
    const bot = sessionBot();
    if (!bot) {
      return `${toolLabel} could not determine which MetaBot owns this session; escrow orders are always created and acted by a session MetaBot party.`;
    }
    return bot;
  };

  const sessionIdentityStrings = (bot: { metabotId: number; address: string | null }): string[] =>
    [String(bot.metabotId), bot.address ?? ''].map((identity) => identity.trim()).filter(Boolean);

  /** Resolve one party input: metabot id | local bot name | raw MVC address. */
  const resolvePartyInput = (raw: string): { ref: EscrowPartyRef } | { error: string } => {
    const value = asString(raw);
    if (!value) return { error: 'party is empty (accepts a metabot id, a local bot name, or an MVC address)' };
    if (/^\d+$/.test(value)) {
      const id = Number(value);
      const address = control.getMetabotMvcAddress(id);
      if (!address) return { error: `local MetaBot ${value} not found or has no MVC address` };
      const name = control.getMetabotDisplayName?.(id) ?? undefined;
      return { ref: { metabotId: id, address, ...(name ? { name } : {}) } };
    }
    if (isMvcAddressLocal(value)) {
      return { ref: { metabotId: null, address: value } };
    }
    const id = control.resolveMetabotIdByName(value);
    if (id == null) {
      return { error: `"${value}" is neither a local MetaBot id/name nor an MVC address. For an external party pass the full MVC address.` };
    }
    const address = control.getMetabotMvcAddress(id);
    if (!address) return { error: `MetaBot "${value}" has no MVC address` };
    const name = control.getMetabotDisplayName?.(id) ?? value;
    return { ref: { metabotId: id, address, name } };
  };

  const resolveParties = (input: { seller: string; buyer: string; agent: string }):
    { parties: { seller: EscrowPartyRef; buyer: EscrowPartyRef; escrowAgent: EscrowPartyRef } } | { error: string } => {
    const seller = resolvePartyInput(input.seller);
    if ('error' in seller) return { error: `seller: ${seller.error}` };
    const buyer = resolvePartyInput(input.buyer);
    if ('error' in buyer) return { error: `buyer: ${buyer.error}` };
    const agent = resolvePartyInput(input.agent);
    if ('error' in agent) return { error: `agent (escrow guarantor): ${agent.error}` };
    return { parties: { seller: seller.ref, buyer: buyer.ref, escrowAgent: agent.ref } };
  };

  /** Which machine actor the session bot is on THIS order (party match by local id or address). */
  const resolveSessionActor = (doc: EscrowOrderDocument, bot: { metabotId: number; address: string | null }): EscrowActor | null => {
    const parties = doc.parties;
    if (!parties) return null;
    for (const role of ['seller', 'buyer', 'escrowAgent'] as const) {
      const party = parties[role];
      if (!party) continue;
      if (party.metabotId != null && party.metabotId === bot.metabotId) return ROLE_ACTOR[role];
      if (bot.address && party.address === bot.address) return ROLE_ACTOR[role];
    }
    return null;
  };

  const genOrderId = (): string =>
    `esc-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;

  const loadOrderDocument = (orderId: string): EscrowOrderDocument | null => {
    const row = orders.get(asString(orderId));
    return row ? (row.payload as EscrowOrderDocument) : null;
  };

  const persist = (doc: EscrowOrder): EscrowOrderDocument => {
    const row = orders.update(doc);
    return row.payload as EscrowOrderDocument;
  };

  const statefulReply = (doc: EscrowOrderDocument, headerLines: string[]): string => {
    const lines = [...headerLines];
    const active = escrowActiveTimerOf(doc);
    if (active) {
      lines.push(`- active timer T${active.timer.slice(1)}: ${active.hours}h from state entry, deadline ${iso(active.deadlineAt)}`);
    }
    const due = escrowDueTimeoutAt(doc, Date.now());
    if (due) {
      lines.push(`- DUE NOW: ${due.message} — run escrow_tick to apply the due timeout action (${due.dueAction ?? 'none'}).`);
    }
    const next = escrowNextStep(doc);
    if (next) {
      lines.push(`- next: [${next.actor}] ${next.text}`);
    }
    return appendEscrowCardBlock(lines.join('\n'), buildEscrowCardFields(doc), stampInputFor(doc, sessionId));
  };

  const timerLine = (doc: EscrowOrder): string => {
    const active = escrowActiveTimerOf(doc);
    if (!active) return `${doc.state} has no running timer (terminal or arbitration state)`;
    const remainingMs = active.deadlineAt - Date.now();
    return remainingMs > 0
      ? `T${active.timer.slice(1)} running: ${active.hours}h total, ~${Math.ceil(remainingMs / 3_600_000)}h remaining, deadline ${iso(active.deadlineAt)}`
      : `T${active.timer.slice(1)} EXPIRED at ${iso(active.deadlineAt)}`;
  };

  // -------------------------------------------------------------------------
  // escrow_order_create
  // -------------------------------------------------------------------------
  const escrowOrderCreate = tool(
    'escrow_order_create',
    [
      'Create a three-party escrow order (S3 generalized escrow: mrc721 / metacontract / digital / service goods, fiat paid point-to-point OUTSIDE the system — this tool never moves money or goods).',
      'The session bot MUST be one of the three parties (seller, buyer, or agent/guarantor); its role is auto-detected and refused otherwise. seller/buyer/agent each accept a local metabot id, a local bot name, or a raw MVC address.',
      'The order starts in state CREATED with a 24h T1 timer on the seller to escrow the goods. amount_cents is the fiat consideration exact to the cent (分); the buyer memo must embed the order id, and the seller confirms the arrival amount to the exact cent.',
      MRC721_CUSTODY_TEACHING,
      'Returns the escrow-card fence — include it verbatim in your announcement so all chat clients render the escrow state card.',
    ].join(' '),
    {
      kind: z.enum(['mrc721', 'metacontract', 'digital', 'service']).describe('Goods kind: mrc721 (pin-based NFT), metacontract (token), digital (encrypted deliverable), service (terms as custody).'),
      title: z.string().optional().describe('Short order title shown on the escrow card.'),
      amount_cents: z.number().int().min(0).describe('Fiat consideration exact to the cent (分), e.g. 9900 = ￥99.00.'),
      seller: z.string().min(1).describe('Seller: local metabot id, local bot name, or MVC address.'),
      buyer: z.string().min(1).describe('Buyer: local metabot id, local bot name, or MVC address.'),
      agent: z.string().min(1).describe('Escrow agent / guarantor: local metabot id, local bot name, or MVC address. Holds the goods custody, never the money.'),
      item_pin_id: z.string().optional().describe('For kind mrc721: the item pinId (64-hex txid + "i" + index) being escrowed.'),
      terms: z.string().optional().describe('Order terms / goods description (scope, deadline, acceptance criteria for service orders; content commitment notes for digital deliverables).'),
    },
    async (args: {
      kind: EscrowGoodsKind;
      title?: string;
      amount_cents: number;
      seller: string;
      buyer: string;
      agent: string;
      item_pin_id?: string;
      terms?: string;
    }) => {
      const bot = requireSessionBot('escrow_order_create');
      if (typeof bot === 'string') return textResult(bot, true);
      const parties = resolveParties({ seller: args.seller, buyer: args.buyer, agent: args.agent });
      if ('error' in parties) return textResult(`escrow_order_create: ${parties.error}`, true);

      // Creator role auto-detection: the session bot must be one of the parties.
      const creatorRole = (['seller', 'buyer', 'escrowAgent'] as const).find((role) => {
        const party = parties.parties[role];
        return (party.metabotId != null && party.metabotId === bot.metabotId)
          || (bot.address != null && party.address === bot.address);
      });
      if (!creatorRole) {
        return textResult(
          'escrow_order_create refused: the session bot is not a party of this order. '
          + 'An escrow order is always created BY one of seller / buyer / agent — pass the session bot as one of the three parties.',
          true,
        );
      }

      const itemPinId = asString(args.item_pin_id);
      if (itemPinId && !isMrc721PinIdLocal(itemPinId)) {
        return textResult(`escrow_order_create: item_pin_id "${itemPinId}" is not a valid MRC-721 item pinId (64-hex txid + "i" + output index).`, true);
      }

      let orderId = genOrderId();
      for (let attempt = 0; attempt < 3 && orders.get(orderId); attempt += 1) {
        orderId = genOrderId();
      }
      if (orders.get(orderId)) {
        return textResult('escrow_order_create failed: could not allocate a unique order id (retry).', true);
      }

      let doc: EscrowOrderDocument;
      try {
        const base = createEscrowOrder({
          orderId,
          goodsKind: args.kind,
          amountCents: args.amount_cents,
          roles: {
            seller: parties.parties.seller.address,
            buyer: parties.parties.buyer.address,
            escrowAgent: parties.parties.escrowAgent.address,
          },
          title: asString(args.title) || undefined,
        });
        doc = {
          ...base,
          creatorMetabotId: bot.metabotId,
          parties: parties.parties,
          ...(itemPinId ? { itemPinId } : {}),
          ...(asString(args.terms) ? { terms: asString(args.terms) } : {}),
        };
      } catch (error) {
        return textResult(`escrow_order_create: ${errorMessage(error)}`, true);
      }

      const row = orders.create(doc, bot.metabotId);
      const stored = row.payload as EscrowOrderDocument;
      const lines = [
        `Escrow order ${stored.orderId} created (you are the ${ROLE_ACTOR[creatorRole]}).`,
        `- goods: ${stored.goodsKind}${stored.itemPinId ? ` · item pinId ${stored.itemPinId}` : ''}${stored.title ? ` · "${stored.title}"` : ''}`,
        `- amount: ${formatYuan(stored.amountCents)} (${stored.amountCents} cents) — fiat moves point-to-point outside the system; the buyer payment memo MUST embed the order id.`,
        `- seller: ${partyDisplay(stored.parties.seller)} | buyer: ${partyDisplay(stored.parties.buyer)} | agent: ${partyDisplay(stored.parties.escrowAgent)}`,
        stored.terms ? `- terms: ${stored.terms}` : '',
        `- ${timerLine(stored)}`,
      ].filter(Boolean);
      return textResult(statefulReply(stored, lines));
    }
  );

  // -------------------------------------------------------------------------
  // escrow_order_act
  // -------------------------------------------------------------------------
  const escrowOrderAct = tool(
    'escrow_order_act',
    [
      'Perform ONE escrow state-machine action on an order the session bot is a party of. The machine validates actor permission, proof requirements, and amount/memo gates — a refused action returns the machine\'s own reason and changes nothing.',
      'The session bot\'s actor role (seller / buyer / escrow_agent) is resolved from the order parties; system-only actions (timeouts) belong to escrow_tick, not this tool.',
      'Proof rules: escrow_goods and release_goods need a 64-hex on-chain transfer txid for mrc721/metacontract orders (SELLER transfers to the agent address first, then records the escrow txid; AGENT transfers to the buyer address and records the release txid) — this tool never moves the item itself. upload_payment_evidence needs the payment evidence reference; confirm_received needs basis_amount_cents (exact to the cent) and basis_memo embedding the order id. dispute_open and rulings need a written basis.',
      'cancel_request only HANGS a cancel request (no state move); cancel_mutual requires mutual_confirmed=true from the confirming side.',
    ].join(' '),
    {
      order_id: z.string().min(1).describe('The escrow order id (esc-…).'),
      action: z.enum([...ESCROW_ACTIONS] as [EscrowAction, ...EscrowAction[]]).describe('One of the 16 state-machine actions.'),
      proof: z.string().optional().describe('Transition proof: 64-hex txid for chain goods legs, content hash for digital, evidence reference otherwise. Required for every state move.'),
      note: z.string().optional().describe('Free-text note recorded on the order timeline (≤512 chars).'),
      basis: z.string().optional().describe('Written basis / appeal reason for dispute_open and ruling actions (≤512 chars).'),
      basis_amount_cents: z.number().int().optional().describe('confirm_received: the received amount in cents — must equal the order amount exactly.'),
      basis_memo: z.string().optional().describe('confirm_received / upload_payment_evidence: the payment memo verbatim — must embed the order id.'),
      mutual_confirmed: z.boolean().optional().describe('cancel_mutual: pass true only when BOTH sides have agreed (the responding side confirms the other side\'s pending cancel request).'),
    },
    async (args: {
      order_id: string;
      action: EscrowAction;
      proof?: string;
      note?: string;
      basis?: string;
      basis_amount_cents?: number;
      basis_memo?: string;
      mutual_confirmed?: boolean;
    }) => {
      const bot = requireSessionBot('escrow_order_act');
      if (typeof bot === 'string') return textResult(bot, true);
      const doc = loadOrderDocument(args.order_id);
      if (!doc) return textResult(`escrow_order_act: escrow order "${asString(args.order_id)}" not found.`, true);
      const actor = resolveSessionActor(doc, bot);
      if (!actor) {
        return textResult(
          `escrow_order_act refused: the session bot is not a party of order ${doc.orderId} `
          + `(parties: seller ${partyDisplay(doc.parties?.seller)}, buyer ${partyDisplay(doc.parties?.buyer)}, agent ${partyDisplay(doc.parties?.escrowAgent)}).`,
          true,
        );
      }

      // confirm_received composes the written basis with the amount anchor the
      // machine's invariant 5 requires on the recorded timeline entry.
      let basis = asString(args.basis);
      if (args.action === 'confirm_received') {
        const anchor = `amount=${args.basis_amount_cents ?? 'none'} cents | memo: ${asString(args.basis_memo) || '(none)'}`;
        basis = basis ? `${anchor} | ${basis}` : anchor;
      }

      const result = applyEscrowTransition(doc, {
        actor,
        action: args.action,
        ...(asString(args.proof) ? { proof: asString(args.proof) } : {}),
        ...(args.basis_amount_cents != null ? { basisAmountCents: args.basis_amount_cents } : {}),
        ...(asString(args.basis_memo) ? { basisMemo: asString(args.basis_memo) } : {}),
        ...(args.mutual_confirmed === true ? { mutualConfirmed: true } : {}),
        ...(basis ? { basis } : {}),
        ...(asString(args.note) ? { note: asString(args.note) } : {}),
      });
      // NOTE: this project compiles without strictNullChecks, so the machine
      // result union must be narrowed by the literal discriminant (`===`),
      // not by truthiness — `!result.ok` does not narrow the failure branch.
      if (result.ok === false) {
        return textResult(`escrow_order_act refused by the state machine: ${result.reason}`, true);
      }

      const stored = persist(result.order);
      const entry = stored.timeline[stored.timeline.length - 1];
      const moved = entry && entry.from !== entry.to;
      const lines = [
        `Escrow order ${stored.orderId}: ${args.action} ${moved ? `applied — state ${entry.from} → ${entry.to}` : 'recorded (no state move)'}.`,
        `- actor: ${actor}${entry?.proof ? ` | proof: ${entry.proof}` : ''}${entry?.basis ? ` | basis: ${entry.basis}` : ''}`,
        `- ${timerLine(stored)}`,
      ];
      return textResult(statefulReply(stored, lines));
    }
  );

  // -------------------------------------------------------------------------
  // escrow_order_list
  // -------------------------------------------------------------------------
  const escrowOrderList = tool(
    'escrow_order_list',
    [
      'List escrow orders the session bot is a PARTY of (seller, buyer, or agent) — optionally filtered to active (non-terminal) or terminal orders, or to orders this bot created.',
      'Each line: order id, kind, state, amount, parties, and last update time. Use escrow_order_info for one order\'s full timeline and timers. Read-only.',
    ].join(' '),
    {
      state: z.enum(['active', 'terminal', 'all']).optional().describe('"active" = non-terminal states (waiting on someone); "terminal" = RELEASED / REFUND_ROLLED_BACK / CANCELLED; default all.'),
      scope: z.enum(['party', 'created']).optional().describe('"party" (default) = orders where this bot is seller/buyer/agent; "created" = orders this bot created.'),
    },
    async (args: { state?: 'active' | 'terminal' | 'all'; scope?: 'party' | 'created' }) => {
      const bot = requireSessionBot('escrow_order_list');
      if (typeof bot === 'string') return textResult(bot, true);
      const rows = args.scope === 'created'
        ? orders.listByCreator(bot.metabotId)
        : orders.listByParticipant(sessionIdentityStrings(bot));
      const wantActive = args.state === 'active';
      const wantTerminal = args.state === 'terminal';
      const filtered = rows.filter((row) => {
        const terminal = isEscrowTerminalState(row.payload.state);
        return wantActive ? !terminal : wantTerminal ? terminal : true;
      });
      if (!filtered.length) {
        return textResult(`No escrow orders ${args.state && args.state !== 'all' ? `in ${args.state} state ` : ''}for this bot${args.scope === 'created' ? ' as creator' : ' as a party'}.`);
      }
      const lines = [`${filtered.length} escrow order(s):`];
      for (const row of filtered) {
        const doc = row.payload as EscrowOrderDocument;
        lines.push(
          `- ${doc.orderId} [${doc.goodsKind}] ${doc.state} · ${formatYuan(doc.amountCents)}`
          + ` · seller ${partyDisplay(doc.parties?.seller)} / buyer ${partyDisplay(doc.parties?.buyer)} / agent ${partyDisplay(doc.parties?.escrowAgent)}`
          + ` · updated ${iso(row.updatedAt)}`,
        );
      }
      return textResult(lines.join('\n'));
    }
  );

  // -------------------------------------------------------------------------
  // escrow_order_info
  // -------------------------------------------------------------------------
  const escrowOrderInfo = tool(
    'escrow_order_info',
    [
      'Full detail sheet for ONE escrow order: parties, current state with its active T-timer and deadline, custody proof, the complete state-machine timeline (every action, actor, proof, basis), dispute counters, negative records, and any pending cancel request or owner-review flag.',
      'The session bot must be a party (or the creator) of the order. Read-only.',
    ].join(' '),
    {
      order_id: z.string().min(1).describe('The escrow order id (esc-…).'),
    },
    async (args: { order_id: string }) => {
      const bot = requireSessionBot('escrow_order_info');
      if (typeof bot === 'string') return textResult(bot, true);
      const doc = loadOrderDocument(args.order_id);
      if (!doc) return textResult(`escrow_order_info: escrow order "${asString(args.order_id)}" not found.`, true);
      const actor = resolveSessionActor(doc, bot);
      const isCreator = doc.creatorMetabotId === bot.metabotId;
      if (!actor && !isCreator) {
        return textResult(`escrow_order_info refused: the session bot is neither a party nor the creator of order ${doc.orderId}.`, true);
      }

      const lines: string[] = [
        `Escrow order ${doc.orderId}`,
        `- goods: ${doc.goodsKind}${doc.itemPinId ? ` · item pinId ${doc.itemPinId}` : ''}${doc.title ? ` · "${doc.title}"` : ''}`,
        `- amount: ${formatYuan(doc.amountCents)} (${doc.amountCents} cents), fiat point-to-point outside the system`,
        `- state: ${doc.state} (entered ${iso(doc.stateEnteredAt)})${isEscrowTerminalState(doc.state) ? ' — TERMINAL' : ''}`,
        `- timer: ${timerLine(doc)}`,
        `- parties: seller ${partyDisplay(doc.parties?.seller)} | buyer ${partyDisplay(doc.parties?.buyer)} | agent ${partyDisplay(doc.parties?.escrowAgent)}`,
        doc.terms ? `- terms: ${doc.terms}` : '',
        `- custody proof: ${latestCustodyProof(doc) ?? '(none recorded yet)'}`,
        `- disputes: seller ${doc.disputesByParty?.seller ?? 0}/2, buyer ${doc.disputesByParty?.buyer ?? 0}/2`,
        doc.pendingCancelRequest ? `- pending cancel request by ${doc.pendingCancelRequest.by} at ${iso(doc.pendingCancelRequest.at)} (12h silence without payment evidence counts as mutual cancel)` : '',
        doc.ownerReview ? `- OWNER REVIEW flagged: ${doc.ownerReview.reason} (${iso(doc.ownerReview.at)})` : '',
        doc.negativeRecords?.length
          ? `- negative records (${doc.negativeRecords.length}):\n${doc.negativeRecords.map((record) => `  - [${record.kind}] ${record.subject}: ${record.note} (${iso(record.at)})`).join('\n')}`
          : '',
      ].filter(Boolean);

      const timeline: EscrowTimelineEntry[] = doc.timeline ?? [];
      lines.push(`- timeline (${timeline.length} entr${timeline.length === 1 ? 'y' : 'ies'}):`);
      for (const [index, entry] of timeline.entries()) {
        const bits = [
          `${index + 1}. ${entry.from} → ${entry.to}`,
          `by ${entry.actor}`,
          entry.action,
          entry.proof ? `proof=${entry.proof}` : '',
          entry.basis ? `basis="${entry.basis}"` : '',
          entry.note ? `note="${entry.note}"` : '',
          entry.reminder ? '[reminder]' : '',
          iso(entry.at),
        ].filter(Boolean);
        lines.push(`  ${bits.join(' | ')}`);
      }

      const active = escrowActiveTimerOf(doc);
      if (active) {
        const responsible = active.responsible ? ` responsible party hint: ${active.responsible}` : '';
        lines.push(`- active timer detail: T${active.timer.slice(1)}, ${active.hours}h, deadline ${iso(active.deadlineAt)}.${responsible}`);
      }
      return textResult(statefulReply(doc, lines));
    }
  );

  // -------------------------------------------------------------------------
  // escrow_tick (the explicit clock driver — no background daemon this round)
  // -------------------------------------------------------------------------
  const escrowTick = tool(
    'escrow_tick',
    [
      'Run the escrow clock ONCE over the active escrow orders the session bot is a party of: applies due T1–T4 timeout actions and records due reminders (50% elapsed / 2h left) through the state machine, then reports per-order outcomes.',
      'System-actor timeouts apply automatically EXCEPT goods-return timeouts on chain goods (mrc721/metacontract T2): the machine demands a real return-transfer txid, so the tick reports the instruction instead — the agent bot runs mrc721_transfer back to the seller and records the txid via escrow_order_act timeout_t2_return_goods. This tool never moves goods or money.',
      'Call this periodically during long escrow conversations; there is no background daemon.',
    ].join(' '),
    {},
    async () => {
      const bot = requireSessionBot('escrow_tick');
      if (typeof bot === 'string') return textResult(bot, true);
      const now = Date.now();
      const rows = orders.listByParticipant(sessionIdentityStrings(bot), ACTIVE_NON_TERMINAL_STATES);
      if (!rows.length) return textResult('escrow_tick: no active escrow orders for this bot — nothing to scan.');

      const lines: string[] = [`escrow_tick scanned ${rows.length} active order(s):`];
      for (const row of rows) {
        const doc = row.payload as EscrowOrderDocument;
        lines.push(`# ${doc.orderId} [${doc.goodsKind}] ${doc.state}`);
        const due = escrowDueTimeoutAt(doc, now);
        if (due?.dueAction) {
          const goodsReturnNeedsTxid = due.dueAction === 'timeout_t2_return_goods'
            && (doc.goodsKind === 'mrc721' || doc.goodsKind === 'metacontract');
          if (goodsReturnNeedsTxid) {
            lines.push(`  - DUE: ${due.message}`);
            lines.push('  - NOT auto-applied: the goods return is an on-chain move and the machine requires its txid. '
              + `Run mrc721_transfer (or the wallet transfer for metacontract) returning the goods to the seller ${partyDisplay(doc.parties?.seller)}, `
              + `then escrow_order_act order_id=${doc.orderId} action=timeout_t2_return_goods proof=<return txid>.`);
            continue;
          }
          // All timeout actions allow the system actor; proof = a system ref
          // (state move gate satisfied; no format gate on these actions).
          const applied = applyEscrowTransition(doc, {
            actor: 'system',
            action: due.dueAction,
            proof: `system:timeout:${due.timer}:${doc.orderId}`,
            note: due.message.slice(0, 512),
            at: now,
          });
          if (applied.ok === false) {
            lines.push(`  - DUE but refused by the machine: ${applied.reason}`);
          } else {
            const stored = persist(applied.order);
            const entry = stored.timeline[stored.timeline.length - 1];
            lines.push(`  - TIMEOUT APPLIED: ${due.dueAction} — state ${entry.from} → ${entry.to} (system actor).`);
            lines.push(`  - ${timerLine(stored)}`);
          }
          continue;
        }

        // No timeout due — record due reminders (branch 1: pressure, no state move).
        const reminders = escrowClockScan(doc, now).filter(
          (reminder): reminder is typeof reminder & { stage: '50%' | '-2h' } => reminder.stage !== 'expired',
        );
        if (reminders.length) {
          let current = doc;
          for (const reminder of reminders) {
            current = applyEscrowReminder(current, reminder.timer, reminder.stage, now) as EscrowOrderDocument;
            lines.push(`  - reminder [T${reminder.timer.slice(1)} ${reminder.stage}]: ${reminder.message}`);
          }
          persist(current);
        } else {
          const active = escrowActiveTimerOf(doc);
          lines.push(active
            ? `  - on schedule: ${timerLine(doc)}`
            : '  - no running timer (arbitration/terminal state)');
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  return [
    escrowOrderCreate,
    escrowOrderAct,
    escrowOrderList,
    escrowOrderInfo,
    escrowTick,
  ];
}

/**
 * Construct the escrow order store over the shared SqliteStore (same pattern
 * as the other SqliteStore-backed stores; the escrow_orders table itself is
 * created idempotently by SqliteStore.initializeTables).
 */
export const escrowOrderStoreFromSqlite = (store: SqliteStore): EscrowOrderStore =>
  new EscrowOrderStore(store.getDatabase(), store.getSaveFunction());
