import { app } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * Cross-platform path containment check.
 * Uses path.relative to avoid false positives like /foo matching /foobar.
 */
export function isPathWithin(basePath: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve the best Electron executable path for child process spawning.
 * Prefer app.getPath('exe') because process.execPath can be incorrect on some Windows builds.
 */
export function resolveElectronExecutablePath(): string {
  try {
    const electronExe = app.getPath('exe');
    if (electronExe && fs.existsSync(electronExe)) {
      return electronExe;
    }
  } catch {
    // Fall through to process.execPath.
  }
  return process.execPath;
}
