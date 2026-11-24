/**
 * escrow-card fence syntax — chat escrow card contract (S3 slice, doc 03 §2 /
 * §3 状态表). Pure parser/serializer primitives live in `./escrowCardCore` so
 * main-process modules (`tokenCardService`) can share `tokenCardSyntax`
 * without pulling in renderer `i18nService` / `window.electron`.
 */

import { i18nService } from '../../services/i18n';
import type {
  EscrowCardData,
  EscrowCardGoodsKind,
  EscrowCardState,
} from './escrowCardCore';

export * from './escrowCardCore';

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
