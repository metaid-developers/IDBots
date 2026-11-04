import MePurchaseScreen from './MePurchaseScreen';

/**
 * Recharge screen (S9 §5 top-up path) - the ME topup face of the shared purchase
 * flow. It carries no traffic/token bundles anymore: a paid subscriber picks
 * package A/B (both read from /v1/me/topup/packages) and submits a voucher;
 * a free-tier account that reaches this screen directly sees the
 * the "plan required" gate, and the backend's SUBSCRIPTION_REQUIRED answer is
 * surfaced verbatim by MePurchaseScreen.
 */
export default function RechargeScreen(props: {
  canPurchase: boolean;
  onClose: () => void;
  onOpenSubscribe: (planId?: string) => void;
  onOpenUsage: () => void;
  onSubmitted?: () => void;
}): JSX.Element {
  return (
    <MePurchaseScreen
      section="topup"
      canPurchase={props.canPurchase}
      onClose={props.onClose}
      onSwitchSection={() => props.onOpenSubscribe()}
      onOpenUsage={props.onOpenUsage}
      onSubmitted={props.onSubmitted}
    />
  );
}
