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

export function findNearestExistingFile(startDir: string, relativeFilePath: string): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, relativeFilePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * Resolve the best Electron executable path for child process spawning.
 * Prefer app.getPath('exe') because process.execPath can be incorrect on some Windows builds.
 */
export function resolveElectronExecutablePath(): string {
  try {
    const electronExe = app?.getPath?.('exe');
    if (electronExe && fs.existsSync(electronExe) && fs.statSync(electronExe).isFile()) {
      return electronExe;
    }
  } catch {
    // Fall through to process.execPath.
  }
  return process.execPath;
}

/**
 * Background skill processes must not register as another Dock application on
 * macOS. Use Electron's bundled LSUIElement helper when it is available; DSH
 * and desktop-automation workers keep resolveElectronExecutablePath so their
 * existing permission responsibility stays unchanged.
 */
export function resolveElectronSkillExecutablePath(): string {
  const electronExe = resolveElectronExecutablePath();
  if (process.platform !== 'darwin') return electronExe;
  try {
    const executableName = path.basename(electronExe);
    const helperName = `${executableName} Helper`;
    const helperPath = path.resolve(
      path.dirname(electronExe),
      '..',
      'Frameworks',
      `${helperName}.app`,
      'Contents',
      'MacOS',
      helperName,
    );
    if (fs.existsSync(helperPath) && fs.statSync(helperPath).isFile()) {
      return helperPath;
    }
  } catch {
    // Fall back to the main executable if the helper is unavailable.
  }
  return electronExe;
}

export function resolveMetabotDistModulePath(
  relativePath: string,
  input?: {
    startDir?: string;
    appPath?: string;
  },
): string {
  const baseDir = input?.startDir ?? input?.appPath ?? app?.getAppPath?.() ?? process.cwd();
  const metabotRelativePath = path.join('metabot', 'dist', relativePath);
  const resolvedFromAncestors = findNearestExistingFile(baseDir, metabotRelativePath);
  if (resolvedFromAncestors) {
    return resolvedFromAncestors;
  }
  return path.join(path.resolve(baseDir), metabotRelativePath);
}
