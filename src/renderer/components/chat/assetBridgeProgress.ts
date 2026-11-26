import type { AssetBridgeStage, AssetBridgeState } from './assetBridgeCardSyntax';

const BLOCK_MS = 10 * 60 * 1000;
const PAYOUT_MS = 60 * 1000;

export interface AssetBridgeProgressInput {
  state: AssetBridgeState;
  stage: AssetBridgeStage;
  requiredConfirmations: number | null;
  confirmations: number | null;
  lastConfirmationAt: number | null;
  broadcastAt: number | null;
  now: number;
}

export interface AssetBridgeProgress {
  percent: number;
  blocksDone: number;
  currentBlockIndex: number;
  currentFraction: number;
  pinned: boolean;
  remainingMinutes: number | null;
  payoutActive: boolean;
}

function finiteNonNegative(value: number | null | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Pure projection of the approved Direction-A bridge progress model.
 *
 * The arc treats every required source-chain block as one unit and reserves
 * half a unit for the bridge payout. The current block never visually completes
 * on elapsed time alone: it caps at 90% until main-process confirmation data
 * advances. Elapsed time is clamped rather than trusted, so a clock regression
 * or missing timestamp can stall the display but never rewind it.
 */
export function computeAssetBridgeProgress(input: AssetBridgeProgressInput): AssetBridgeProgress {
  const required = Math.max(1, Math.floor(finiteNonNegative(input.requiredConfirmations, 1)));
  if (input.state === 'completed') {
    return {
      percent: 100,
      blocksDone: required,
      currentBlockIndex: required,
      currentFraction: 1,
      pinned: false,
      remainingMinutes: 0,
      payoutActive: false,
    };
  }
  if (input.state !== 'bridging') {
    return {
      percent: 0,
      blocksDone: 0,
      currentBlockIndex: 1,
      currentFraction: 0,
      pinned: false,
      remainingMinutes: null,
      payoutActive: false,
    };
  }

  const blocksDone = Math.max(0, Math.min(required, Math.floor(finiteNonNegative(input.confirmations, 0))));
  const anchor = finiteNonNegative(input.lastConfirmationAt, finiteNonNegative(input.broadcastAt, 0));
  const now = finiteNonNegative(input.now, anchor);
  const elapsedSinceAnchor = anchor > 0 && now > anchor ? now - anchor : 0;
  const payoutActive = input.stage === 'paying_out' || blocksDone >= required;

  if (payoutActive) {
    const payoutFraction = Math.min(0.95, elapsedSinceAnchor / PAYOUT_MS);
    const unitPercent = (required + payoutFraction * 0.5) / (required + 0.5);
    return {
      percent: Math.min(99.5, Math.max(0, unitPercent * 100)),
      blocksDone: required,
      currentBlockIndex: required,
      currentFraction: payoutFraction,
      pinned: false,
      remainingMinutes: 1,
      payoutActive: true,
    };
  }

  const rawFraction = elapsedSinceAnchor / BLOCK_MS;
  const fraction = Math.min(0.9, Math.max(0, rawFraction));
  const pinned = rawFraction > 0.9;
  const percent = ((blocksDone + fraction) / (required + 0.5)) * 100;
  const remainingUnits = required - blocksDone - fraction;
  return {
    percent: Math.min(99.5, Math.max(0, percent)),
    blocksDone,
    currentBlockIndex: Math.min(required, blocksDone + 1),
    currentFraction: clamp01(fraction),
    pinned,
    remainingMinutes: pinned ? null : Math.max(1, Math.ceil(remainingUnits * 10 + 1)),
    payoutActive: false,
  };
}
