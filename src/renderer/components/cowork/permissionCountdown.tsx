import React, { useEffect, useState } from 'react';

/** Whole seconds left until a permission's default button fires. Null when the request does not time out. */
export function usePermissionCountdown(expiresAt: number | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt == null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  if (expiresAt == null) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function PermissionCountdownLabel({
  label,
  seconds,
}: {
  label: string;
  seconds: number | null;
}): React.ReactElement {
  if (seconds == null) return <>{label}</>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <span className="tabular-nums">{seconds}s</span>
    </span>
  );
}
