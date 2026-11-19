import { app } from 'electron';

export function getAutoLaunchEnabled(): boolean {
  try {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  } catch (error) {
    console.error('Failed to get auto-launch settings:', error);
    return false;
  }
}

export function setAutoLaunchEnabled(enabled: boolean): void {
  const isMac = process.platform === 'darwin';

  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // macOS: 自启后窗口不显示，M芯片和Intel均兼容
      openAsHidden: isMac ? enabled : false,
      // Windows: 通过命令行参数标记自启动
      args: enabled ? ['--auto-launched'] : [],
    });
  } catch (error) {
    console.error('Failed to set auto-launch settings:', error);
    throw error;
  }
}

export function isAutoLaunched(): boolean {
  try {
    if (process.platform === 'darwin') {
      const settings = app.getLoginItemSettings();
      return settings.wasOpenedAtLogin || false;
    }
    // Windows: 检查命令行参数
    return process.argv.includes('--auto-launched');
  } catch (error) {
    console.error('Failed to check auto-launch status:', error);
    return false;
  }
}

/**
 * Decide whether the login item must be re-registered after an upgrade.
 *
 * An installer that lands the app in a NEW directory leaves the OS login-item
 * entry pointing at the old exe (on Windows the Run key is never touched by
 * the NSIS uninstaller): auto-launch would silently fail — or boot the stale
 * old version out of the leftover directory. Re-register only when
 * auto-launch is actually ON and the exe path moved since the last
 * registration; a first run has no previous path and registers separately.
 */
export function shouldRetargetAutoLaunch(input: {
  lastRegisteredExePath?: string | null;
  currentExePath: string;
  autoLaunchEnabled: boolean;
}): boolean {
  if (!input.lastRegisteredExePath) return false;
  if (!input.autoLaunchEnabled) return false;
  return input.lastRegisteredExePath !== input.currentExePath;
}
