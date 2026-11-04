import { t } from '../../i18n';

/**
 * Shown when neither the mock bridge nor the real gateway shim (T3) is
 * installed. A built bundle must render this instead of white-screening:
 * the tenant image serves dist-mobile/ at /app/ as-is.
 */
export function BridgeUnavailable(): JSX.Element {
  return (
    <div className="twin-page min-h-dvh items-center justify-center gap-3 px-8 text-center">
      <h1 className="twin-title">{t('mobile.bridge.unavailableTitle')}</h1>
      <p className="text-sm text-[var(--text-secondary)]">{t('mobile.bridge.unavailableBody')}</p>
    </div>
  );
}
