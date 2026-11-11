import { MeCoinIcon } from './MeCoin';
import { formatMe, meFromMilli, meSpendableMilli, type MobileMeBalance } from '../me/mePointsStore';

/**
 * Compact ME balance chip for the Me topbar. The number is what a new official
 * ME spend can draw now; the ledger-pool breakdown lives in the hero card.
 */
export function MeBalanceChip(props: {
  balance: MobileMeBalance | null;
  loading: boolean;
  onOpen: () => void;
}): JSX.Element {
  const total = props.balance ? meFromMilli(meSpendableMilli(props.balance)) : null;
  return (
    <button
      type="button"
      data-testid="me-balance-chip"
      onClick={props.onOpen}
      className="me-chip"
      aria-label="ME"
    >
      <MeCoinIcon className="h-3.5 w-3.5" />
      <span className="me-chip-value">
        {total === null ? (props.loading ? '…' : '—') : formatMe(total)}
      </span>
      <span className="me-chip-unit">ME</span>
    </button>
  );
}
