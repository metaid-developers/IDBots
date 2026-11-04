import { MeCoinIcon } from './MeCoin';
import { formatMe, meFromMilli, type MobileMeBalance } from '../me/mePointsStore';

/**
 * Compact ME balance chip for the Me topbar (S9 §3 global balance badge). One number:
 * the merged weekly + persistent balance. Tapping opens the usage & credits
 * page; the full four-row breakdown lives in the hero card below it.
 */
export function MeBalanceChip(props: {
  balance: MobileMeBalance | null;
  loading: boolean;
  onOpen: () => void;
}): JSX.Element {
  const total = props.balance ? meFromMilli(props.balance.totalAvailable) : null;
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
