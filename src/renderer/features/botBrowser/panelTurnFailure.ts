/**
 * Panel turn-failure card helpers.
 *
 * The transcript filter keeps ONLY turn-level failure system rows — the
 * final turn error (`metadata.error`) and the three localized turn-death
 * flags (`dshTurnStalled` / `dshTurnInterrupted` / `emptyTerminalTurn`) —
 * so a dead turn stays visible in the Studio panel instead of ending in
 * silence after the ack bubble (session 4b78a0fd: five hours of nothing
 * while the stored system message carried the real compaction error).
 *
 * The compaction checkpoint notice (`compaction: true`) is bookkeeping that
 * PRECEDES the real error and stays hidden with every other system row.
 */

import { i18nService, type LanguageType } from '../../services/i18n';
import { describeStudioTurnError } from '../../../main/shared/studioTurnErrorCopy';
import type { CoworkMessage } from '../../types/cowork';

export type PanelTurnFailureKind = 'error' | 'stalled' | 'interrupted' | 'emptyTerminal';

/**
 * The failure kind a system message represents, or null for every other
 * system row (compaction checkpoints, SDK notices, fallbacks, …).
 */
export function panelTurnFailureKind(message: CoworkMessage): PanelTurnFailureKind | null {
  if (message.type !== 'system') return null;
  const meta = message.metadata as Record<string, unknown> | undefined;
  if (!meta || meta.compaction === true) return null;
  if (typeof meta.error === 'string') return 'error';
  if (meta.dshTurnStalled === true) return 'stalled';
  if (meta.dshTurnInterrupted === true) return 'interrupted';
  if (meta.emptyTerminalTurn === true) return 'emptyTerminal';
  return null;
}

export function isPanelTurnFailureMessage(message: CoworkMessage): boolean {
  return panelTurnFailureKind(message) !== null;
}

const FLAG_REASON_KEYS: Record<Exclude<PanelTurnFailureKind, 'error'>, string> = {
  stalled: 'coworkDshTurnStalled',
  interrupted: 'coworkDshTurnInterrupted',
  emptyTerminal: 'coworkEmptyTerminalTurn',
};

export interface PanelTurnFailureCopy {
  /** Card title — always the localized "this run didn't finish". */
  title: string;
  /** Reason + generic continue hint, already joined for the language. */
  body: string;
  /** Raw error text behind the Details disclosure; '' hides it. */
  details: string;
}

/**
 * Card copy for a turn-failure system message. `metadata.error` goes through
 * the shared studioTurnErrorCopy classifier (quota / rate-limit / context /
 * network / auth get their own plain-language reason); the three flag kinds
 * reuse the main transcript's existing i18n explanations as the reason.
 */
export function describePanelTurnFailure(
  message: CoworkMessage,
  language: LanguageType,
): PanelTurnFailureCopy {
  const kind = panelTurnFailureKind(message);
  const title = i18nService.tIn(language, 'panelTurnFailureTitle');
  const meta = message.metadata as Record<string, unknown> | undefined;
  if (kind === 'error') {
    const raw = typeof meta?.error === 'string' ? meta.error : '';
    const { reason, hint } = describeStudioTurnError(raw, language);
    return {
      title,
      body: language === 'zh' ? `${reason}。${hint}` : `${reason}. ${hint}`,
      details: raw,
    };
  }
  const reasonKey = kind ? FLAG_REASON_KEYS[kind] : null;
  const reason = reasonKey ? i18nService.tIn(language, reasonKey) : '';
  const hint = i18nService.tIn(language, 'panelTurnFailureHint');
  return {
    title,
    // The flag i18n texts already end with sentence punctuation.
    body: reason
      ? (language === 'zh' ? `${reason}${hint}` : `${reason} ${hint}`)
      : hint,
    details: '',
  };
}
