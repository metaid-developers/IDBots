import { app, session } from 'electron';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { delimiter, dirname, join, resolve } from 'path';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadClaudeSdk } from './claudeSdk';
import { buildEnvForConfig, getClaudeCodePath, getCurrentApiConfig } from './claudeSettings';
import type { OpenAICompatProxyTarget } from './coworkOpenAICompatProxy';
import { getInternalApiBaseURL } from './coworkOpenAICompatProxy';
import { coworkLog } from './coworkLogger';
import { resolveElectronExecutablePath } from './runtimePaths';

function appendEnvPath(current: string | undefined, additions: string[]): string | undefined {
  const items = new Set<string>();

  for (const entry of additions) {
    if (entry) {
      items.add(entry);
    }
  }

  if (current) {
    for (const entry of current.split(delimiter)) {
      if (entry) {
        items.add(entry);
      }
    }
  }

  return items.size > 0 ? Array.from(items).join(delimiter) : current;
}

/**
 * Cached user shell PATH. Resolved once and reused across calls.
 */
let cachedUserShellPath: string | null | undefined;

/**
 * Resolve the user's login shell PATH on macOS/Linux.
 * Packaged Electron apps on macOS don't inherit the user's shell profile,
 * so node/npm and other tools won't be in PATH unless we resolve it.
 */
function resolveUserShellPath(): string | null {
  if (cachedUserShellPath !== undefined) return cachedUserShellPath;

  if (process.platform === 'win32') {
    cachedUserShellPath = null;
    return null;
  }

  try {
    const shell = process.env.SHELL || '/bin/bash';
    const result = execSync(`${shell} -ilc 'echo __PATH__=$PATH'`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env },
    });
    const match = result.match(/__PATH__=(.+)/);
    cachedUserShellPath = match ? match[1].trim() : null;
  } catch (error) {
    console.warn('[coworkUtil] Failed to resolve user shell PATH:', error);
    cachedUserShellPath = null;
  }

  return cachedUserShellPath;
}

/**
 * Cached git-bash path on Windows. Resolved once and reused.
 */
let cachedGitBashPath: string | null | undefined;
const LOCAL_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1', '10.0.2.2'];

function normalizeWindowsPath(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().replace(/\r/g, '');
  if (!trimmed) return null;

  const unquoted = trimmed.replace(/^["']+|["']+$/g, '');
  if (!unquoted) return null;

  return unquoted.replace(/\//g, '\\');
}

function mergeNoProxyList(
  current: string | undefined,
  additions: string[]
): string {
  const merged: string[] = [];
  const seen = new Set<string>();

  const pushValue = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(trimmed);
  };

  if (current) {
    current
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach(pushValue);
  }

  additions.forEach(pushValue);
  return merged.join(',');
}

function listWindowsCommandPaths(command: string): string[] {
  try {
    const output = execSync(command, { encoding: 'utf-8', timeout: 5000 });
    const parsed = output
      .split(/\r?\n/)
      .map((line) => normalizeWindowsPath(line))
      .filter((line): line is string => Boolean(line && existsSync(line)));
    return Array.from(new Set(parsed));
  } catch {
    return [];
  }
}

function listGitInstallPathsFromRegistry(): string[] {
  const registryKeys = [
    'HKCU\\Software\\GitForWindows',
    'HKLM\\Software\\GitForWindows',
    'HKLM\\Software\\WOW6432Node\\GitForWindows',
  ];

  const installRoots: string[] = [];

  for (const key of registryKeys) {
    try {
      const output = execSync(`reg query "${key}" /v InstallPath`, { encoding: 'utf-8', timeout: 5000 });
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/InstallPath\s+REG_\w+\s+(.+)$/i);
        const root = normalizeWindowsPath(match?.[1]);
        if (root) {
          installRoots.push(root);
        }
      }
    } catch {
      // registry key might not exist
    }
  }

  return Array.from(new Set(installRoots));
}

function getWindowsGitToolDirs(bashPath: string): string[] {
  const normalized = bashPath.replace(/\//g, '\\');
  const lower = normalized.toLowerCase();
  let gitRoot: string | null = null;

  if (lower.endsWith('\\usr\\bin\\bash.exe')) {
    gitRoot = normalized.slice(0, -'\\usr\\bin\\bash.exe'.length);
  } else if (lower.endsWith('\\bin\\bash.exe')) {
    gitRoot = normalized.slice(0, -'\\bin\\bash.exe'.length);
  }

  if (!gitRoot) {
    const bashDir = dirname(normalized);
    return [bashDir].filter((dir) => existsSync(dir));
  }

  const candidates = [
    join(gitRoot, 'cmd'),
    join(gitRoot, 'mingw64', 'bin'),
    join(gitRoot, 'usr', 'bin'),
    join(gitRoot, 'bin'),
  ];

  return candidates.filter((dir) => existsSync(dir));
}

type WindowsNodeShimInfo = {
  shimDir: string;
  shimScriptPath: string;
};

function ensureWindowsElectronNodeShim(): WindowsNodeShimInfo | null {
  if (process.platform !== 'win32') {
    return null;
  }

  try {
    const shimDir = join(app.getPath('userData'), 'cowork', 'bin');
    mkdirSync(shimDir, { recursive: true });

    const shimScriptPath = join(shimDir, 'idbots-node-shim.js');

    const nodeSh = join(shimDir, 'node');
    const nodeCmd = join(shimDir, 'node.cmd');
    const npxSh = join(shimDir, 'npx');
    const npxCmd = join(shimDir, 'npx.cmd');
    const tsNodeSh = join(shimDir, 'ts-node');
    const tsNodeCmd = join(shimDir, 'ts-node.cmd');

    const shimScriptContent = [
      '#!/usr/bin/env node',
      '\'use strict\';',
      '',
      'const fs = require(\'fs\');',
      'const path = require(\'path\');',
      'const { spawnSync } = require(\'child_process\');',
      '',
      'const modeArg = process.argv[2] || \'\';',
      'const mode = modeArg.startsWith(\'--mode=\') ? modeArg.slice(\'--mode=\'.length) : \'node\';',
      'const args = modeArg.startsWith(\'--mode=\') ? process.argv.slice(3) : process.argv.slice(2);',
      '',
      'const electronPath = process.env.IDBOTS_ELECTRON_PATH || \'\';',
      'if (!electronPath) {',
      '  console.error(\'IDBOTS_ELECTRON_PATH is not set\');',
      '  process.exit(127);',
      '}',
      '',
      'const shimDir = process.env.IDBOTS_NODE_SHIM_DIR',
      '  ? path.resolve(process.env.IDBOTS_NODE_SHIM_DIR)',
      '  : path.dirname(__filename);',
      'const normalizedShimDir = path.resolve(shimDir).toLowerCase();',
      '',
      'function exists(filePath) {',
      '  try {',
      '    return fs.existsSync(filePath);',
      '  } catch {',
      '    return false;',
      '  }',
      '}',
      '',
      'function runCommand(command, commandArgs, env) {',
      '  const result = spawnSync(command, commandArgs, {',
      '    stdio: \'inherit\',',
      '    env,',
      '    cwd: process.cwd(),',
      '    windowsHide: true,',
      '  });',
      '  if (typeof result.status === \'number\') {',
      '    process.exit(result.status);',
      '  }',
      '  if (result.error) {',
      '    const code = result.error.code === \'ENOENT\' ? 127 : 1;',
      '    console.error(result.error.message || String(result.error));',
      '    process.exit(code);',
      '  }',
      '  process.exit(1);',
      '}',
      '',
      'function runAsNode(nodeArgs) {',
      '  const env = { ...process.env, ELECTRON_RUN_AS_NODE: \'1\' };',
      '  runCommand(electronPath, nodeArgs, env);',
      '}',
      '',
      'function toAbsoluteMaybe(value) {',
      '  if (!value) return null;',
      '  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);',
      '}',
      '',
      'function findScriptFallback(scriptArg) {',
      '  const absolute = toAbsoluteMaybe(scriptArg);',
      '  if (!absolute) return null;',
      '  if (exists(absolute)) return absolute;',
      '',
      '  const ext = path.extname(absolute).toLowerCase();',
      '  const dir = path.dirname(absolute);',
      '  const baseName = ext ? path.basename(absolute, ext) : path.basename(absolute);',
      '  const candidates = [];',
      '',
      '  if (ext === \'.ts\') {',
      '    candidates.push(path.join(dir, `${baseName}.js`));',
      '    candidates.push(path.join(dir, \'dist\', `${baseName}.js`));',
      '  } else if (ext === \'.js\') {',
      '    candidates.push(path.join(dir, \'dist\', `${baseName}.js`));',
      '  } else {',
      '    candidates.push(`${absolute}.js`);',
      '    candidates.push(path.join(dir, \'dist\', `${path.basename(absolute)}.js`));',
      '  }',
      '',
      '  for (const candidate of candidates) {',
      '    if (exists(candidate)) return candidate;',
      '  }',
      '  return null;',
      '}',
      '',
      'function resolveNodeArgs(rawArgs) {',
      '  if (!Array.isArray(rawArgs) || rawArgs.length === 0) {',
      '    return rawArgs;',
      '  }',
      '',
      '  const first = rawArgs[0];',
      '  if (!first || first.startsWith(\'-\')) {',
      '    return rawArgs;',
      '  }',
      '',
      '  const resolved = findScriptFallback(first);',
      '  if (!resolved) {',
      '    return rawArgs;',
      '  }',
      '',
      '  return [resolved, ...rawArgs.slice(1)];',
      '}',
      '',
      'function findExecutableOnPath(names) {',
      '  const envPath = process.env.PATH || \'\';',
      '  const pathEntries = envPath',
      '    .split(path.delimiter)',
      '    .map((entry) => entry.trim().replace(/^["\']+|["\']+$/g, \'\'))',
      '    .filter(Boolean);',
      '',
      '  for (const entry of pathEntries) {',
      '    const resolvedEntry = path.resolve(entry);',
      '    if (resolvedEntry.toLowerCase() === normalizedShimDir) continue;',
      '',
      '    for (const name of names) {',
      '      const full = path.join(resolvedEntry, name);',
      '      if (exists(full)) {',
      '        return full;',
      '      }',
      '    }',
      '  }',
      '',
      '  return null;',
      '}',
      '',
      'function parseTsNodeInvocation(rawArgs) {',
      '  const optionsWithValue = new Set([',
      '    \'-P\', \'--project\',',
      '    \'-r\', \'--require\',',
      '    \'-O\', \'--compiler-options\',',
      '    \'--compiler\', \'--cwd\',',
      '    \'--scopeDir\', \'--transpiler\',',
      '  ]);',
      '',
      '  for (let i = 0; i < rawArgs.length; i += 1) {',
      '    const arg = rawArgs[i];',
      '    if (arg === \'--\') {',
      '      const scriptIndex = i + 1;',
      '      if (scriptIndex < rawArgs.length) {',
      '        return { scriptIndex, trailingArgs: rawArgs.slice(scriptIndex + 1) };',
      '      }',
      '      return null;',
      '    }',
      '    if (!arg.startsWith(\'-\')) {',
      '      return { scriptIndex: i, trailingArgs: rawArgs.slice(i + 1) };',
      '    }',
      '    if (optionsWithValue.has(arg)) {',
      '      i += 1;',
      '    }',
      '  }',
      '',
      '  return null;',
      '}',
      '',
      'function runTsNode(rawArgs) {',
      '  const parsed = parseTsNodeInvocation(rawArgs);',
      '  if (!parsed) {',
      '    const realTsNode = findExecutableOnPath([\'ts-node.cmd\', \'ts-node.exe\', \'ts-node\']);',
      '    if (realTsNode) {',
      '      runCommand(realTsNode, rawArgs, process.env);',
      '      return;',
      '    }',
      '    console.error(\'Unable to parse ts-node arguments and ts-node runtime was not found\');',
      '    process.exit(127);',
      '  }',
      '',
      '  const scriptArg = rawArgs[parsed.scriptIndex];',
      '  const resolvedScript = findScriptFallback(scriptArg);',
      '  if (resolvedScript && resolvedScript.toLowerCase().endsWith(\'.js\')) {',
      '    runAsNode([resolvedScript, ...parsed.trailingArgs]);',
      '    return;',
      '  }',
      '',
      '  const realTsNode = findExecutableOnPath([\'ts-node.cmd\', \'ts-node.exe\', \'ts-node\']);',
      '  if (realTsNode) {',
      '    runCommand(realTsNode, rawArgs, process.env);',
      '    return;',
      '  }',
      '',
      '  console.error(`ts-node is unavailable and no compiled JavaScript fallback was found for: ${scriptArg}`);',
      '  process.exit(127);',
      '}',
      '',
      'function parseNpxInvocation(rawArgs) {',
      '  const optionsWithValue = new Set([',
      '    \'-p\', \'--package\',',
      '    \'-c\', \'--call\',',
      '    \'--cache\', \'--userconfig\',',
      '    \'--registry\', \'--node-arg\',',
      '    \'--node-args\',',
      '  ]);',
      '',
      '  let index = 0;',
      '  while (index < rawArgs.length) {',
      '    const arg = rawArgs[index];',
      '    if (arg === \'--\') {',
      '      index += 1;',
      '      break;',
      '    }',
      '    if (!arg.startsWith(\'-\')) {',
      '      break;',
      '    }',
      '    if (optionsWithValue.has(arg)) {',
      '      index += 2;',
      '      continue;',
      '    }',
      '    index += 1;',
      '  }',
      '',
      '  if (index >= rawArgs.length) {',
      '    return null;',
      '  }',
      '',
      '  return {',
      '    command: rawArgs[index],',
      '    commandArgs: rawArgs.slice(index + 1),',
      '  };',
      '}',
      '',
      'function runNpx(rawArgs) {',
      '  const parsed = parseNpxInvocation(rawArgs);',
      '  if (parsed && parsed.command === \'ts-node\') {',
      '    runTsNode(parsed.commandArgs);',
      '    return;',
      '  }',
      '',
      '  const realNpx = findExecutableOnPath([\'npx.cmd\', \'npx.exe\', \'npx\']);',
      '  if (realNpx) {',
      '    runCommand(realNpx, rawArgs, process.env);',
      '    return;',
      '  }',
      '',
      '  if (parsed) {',
      '    console.error(`npx runtime was not found and cannot execute: ${parsed.command}`);',
      '  } else {',
      '    console.error(\'npx runtime was not found\');',
      '  }',
      '  process.exit(127);',
      '}',
      '',
      'if (mode === \'npx\') {',
      '  runNpx(args);',
      '} else if (mode === \'ts-node\') {',
      '  runTsNode(args);',
      '} else {',
      '  runAsNode(resolveNodeArgs(args));',
      '}',
      '',
    ].join('\n');

    const nodeShContent = [
      '#!/usr/bin/env bash',
      'if [ -z "${IDBOTS_ELECTRON_PATH:-}" ]; then',
      '  echo "IDBOTS_ELECTRON_PATH is not set" >&2',
      '  exit 127',
      'fi',
      'if [ -z "${IDBOTS_NODE_SHIM_SCRIPT:-}" ]; then',
      '  echo "IDBOTS_NODE_SHIM_SCRIPT is not set" >&2',
      '  exit 127',
      'fi',
      'exec env ELECTRON_RUN_AS_NODE=1 "${IDBOTS_ELECTRON_PATH}" "${IDBOTS_NODE_SHIM_SCRIPT}" --mode=node "$@"',
      '',
    ].join('\n');

    const npxShContent = [
      '#!/usr/bin/env bash',
      'if [ -z "${IDBOTS_ELECTRON_PATH:-}" ]; then',
      '  echo "IDBOTS_ELECTRON_PATH is not set" >&2',
      '  exit 127',
      'fi',
      'if [ -z "${IDBOTS_NODE_SHIM_SCRIPT:-}" ]; then',
      '  echo "IDBOTS_NODE_SHIM_SCRIPT is not set" >&2',
      '  exit 127',
      'fi',
      'exec env ELECTRON_RUN_AS_NODE=1 "${IDBOTS_ELECTRON_PATH}" "${IDBOTS_NODE_SHIM_SCRIPT}" --mode=npx "$@"',
      '',
    ].join('\n');

    const tsNodeShContent = [
      '#!/usr/bin/env bash',
      'if [ -z "${IDBOTS_ELECTRON_PATH:-}" ]; then',
      '  echo "IDBOTS_ELECTRON_PATH is not set" >&2',
      '  exit 127',
      'fi',
      'if [ -z "${IDBOTS_NODE_SHIM_SCRIPT:-}" ]; then',
      '  echo "IDBOTS_NODE_SHIM_SCRIPT is not set" >&2',
      '  exit 127',
      'fi',
      'exec env ELECTRON_RUN_AS_NODE=1 "${IDBOTS_ELECTRON_PATH}" "${IDBOTS_NODE_SHIM_SCRIPT}" --mode=ts-node "$@"',
      '',
    ].join('\n');

    const nodeCmdContent = [
      '@echo off',
      'if "%IDBOTS_ELECTRON_PATH%"=="" (',
      '  echo IDBOTS_ELECTRON_PATH is not set 1>&2',
      '  exit /b 127',
      ')',
      'if "%IDBOTS_NODE_SHIM_SCRIPT%"=="" (',
      '  echo IDBOTS_NODE_SHIM_SCRIPT is not set 1>&2',
      '  exit /b 127',
      ')',
      'set ELECTRON_RUN_AS_NODE=1',
      '"%IDBOTS_ELECTRON_PATH%" "%IDBOTS_NODE_SHIM_SCRIPT%" --mode=node %*',
      '',
    ].join('\r\n');

    const npxCmdContent = [
      '@echo off',
      'if "%IDBOTS_ELECTRON_PATH%"=="" (',
      '  echo IDBOTS_ELECTRON_PATH is not set 1>&2',
      '  exit /b 127',
      ')',
      'if "%IDBOTS_NODE_SHIM_SCRIPT%"=="" (',
      '  echo IDBOTS_NODE_SHIM_SCRIPT is not set 1>&2',
      '  exit /b 127',
      ')',
      'set ELECTRON_RUN_AS_NODE=1',
      '"%IDBOTS_ELECTRON_PATH%" "%IDBOTS_NODE_SHIM_SCRIPT%" --mode=npx %*',
      '',
    ].join('\r\n');

    const tsNodeCmdContent = [
      '@echo off',
      'if "%IDBOTS_ELECTRON_PATH%"=="" (',
      '  echo IDBOTS_ELECTRON_PATH is not set 1>&2',
      '  exit /b 127',
      ')',
      'if "%IDBOTS_NODE_SHIM_SCRIPT%"=="" (',
      '  echo IDBOTS_NODE_SHIM_SCRIPT is not set 1>&2',
      '  exit /b 127',
      ')',
      'set ELECTRON_RUN_AS_NODE=1',
      '"%IDBOTS_ELECTRON_PATH%" "%IDBOTS_NODE_SHIM_SCRIPT%" --mode=ts-node %*',
      '',
    ].join('\r\n');

    writeFileSync(shimScriptPath, shimScriptContent, 'utf8');
    writeFileSync(nodeSh, nodeShContent, 'utf8');
    writeFileSync(nodeCmd, nodeCmdContent, 'utf8');
    writeFileSync(npxSh, npxShContent, 'utf8');
    writeFileSync(npxCmd, npxCmdContent, 'utf8');
    writeFileSync(tsNodeSh, tsNodeShContent, 'utf8');
    writeFileSync(tsNodeCmd, tsNodeCmdContent, 'utf8');
    try {
      chmodSync(nodeSh, 0o755);
      chmodSync(npxSh, 0o755);
      chmodSync(tsNodeSh, 0o755);
    } catch {
      // Ignore chmod errors on Windows file systems that do not support POSIX modes.
    }

    // Cygpath shim: Claude Code CLI may invoke cygpath from bash or cmd contexts.
    // Provide both POSIX and CMD shims so path conversion does not fail when one runtime is missing.
    const cygpathSh = join(shimDir, 'cygpath');
    const cygpathCmd = join(shimDir, 'cygpath.cmd');
    const cygpathShContent = [
      '#!/usr/bin/env bash',
      'if [ "$1" = "-u" ]; then',
      '  p="$2"',
      '  [ -z "$p" ] && exit 1',
      '  p="${p#\\\'}"; p="${p%\\\'}"',
      '  p="${p#\\"}"; p="${p%\\"}"',
      '  p="${p//\\\\/\\/}"',
      '  if [[ "$p" =~ ^([a-zA-Z]):(.*) ]]; then',
      '    d="${BASH_REMATCH[1]}"',
      '    r="${BASH_REMATCH[2]}"',
      '    printf "/%s%s\\n" "$(echo "$d" | tr "[:upper:]" "[:lower:]")" "$r"',
      '  else',
      '    echo "$p"',
      '  fi',
      '  exit 0',
      'fi',
      'if [ "$1" = "-w" ]; then',
      '  p="$2"',
      '  [ -z "$p" ] && exit 1',
      '  p="${p#\\\'}"; p="${p%\\\'}"',
      '  p="${p#\\"}"; p="${p%\\"}"',
      '  if [[ "$p" =~ ^/([a-zA-Z])(.*) ]]; then',
      '    d="${BASH_REMATCH[1]}"',
      '    r="${BASH_REMATCH[2]}"',
      '    r="${r//\\//\\\\}"',
      '    printf "%s:\\\\%s\\n" "$(echo "$d" | tr "[:lower:]" "[:upper:]")" "$r"',
      '  else',
      '    echo "${p//\\//\\\\}"',
      '  fi',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n');
    const cygpathCmdContent = [
      '@echo off',
      'setlocal EnableExtensions EnableDelayedExpansion',
      'set "mode=%~1"',
      'set "p=%~2"',
      'if "%mode%"=="" exit /b 1',
      'if "%p%"=="" exit /b 1',
      'if /I "%mode%"=="-u" goto to_unix',
      'if /I "%mode%"=="-w" goto to_win',
      'exit /b 1',
      ':trim_quotes',
      'if not "!p!"=="" if "!p:~0,1!"=="\'" set "p=!p:~1!"',
      'if not "!p!"=="" if "!p:~-1!"=="\'" set "p=!p:~0,-1!"',
      'if not "!p!"=="" if "!p:~0,1!"=="\\"" set "p=!p:~1!"',
      'if not "!p!"=="" if "!p:~-1!"=="\\"" set "p=!p:~0,-1!"',
      'goto :eof',
      ':to_unix',
      'call :trim_quotes',
      'set "p=!p:\\=/!"',
      'if "!p:~1,1!"==":" (',
      '  set "drive=!p:~0,1!"',
      '  set "rest=!p:~2!"',
      '  call set "drive=%%drive:A=a%%"',
      '  call set "drive=%%drive:B=b%%"',
      '  call set "drive=%%drive:C=c%%"',
      '  call set "drive=%%drive:D=d%%"',
      '  call set "drive=%%drive:E=e%%"',
      '  call set "drive=%%drive:F=f%%"',
      '  call set "drive=%%drive:G=g%%"',
      '  call set "drive=%%drive:H=h%%"',
      '  call set "drive=%%drive:I=i%%"',
      '  call set "drive=%%drive:J=j%%"',
      '  call set "drive=%%drive:K=k%%"',
      '  call set "drive=%%drive:L=l%%"',
      '  call set "drive=%%drive:M=m%%"',
      '  call set "drive=%%drive:N=n%%"',
      '  call set "drive=%%drive:O=o%%"',
      '  call set "drive=%%drive:P=p%%"',
      '  call set "drive=%%drive:Q=q%%"',
      '  call set "drive=%%drive:R=r%%"',
      '  call set "drive=%%drive:S=s%%"',
      '  call set "drive=%%drive:T=t%%"',
      '  call set "drive=%%drive:U=u%%"',
      '  call set "drive=%%drive:V=v%%"',
      '  call set "drive=%%drive:W=w%%"',
      '  call set "drive=%%drive:X=x%%"',
      '  call set "drive=%%drive:Y=y%%"',
      '  call set "drive=%%drive:Z=z%%"',
      '  echo//!drive!!rest!',
      '  exit /b 0',
      ')',
      'echo/!p!',
      'exit /b 0',
      ':to_win',
      'call :trim_quotes',
      'if "!p:~0,1!"=="/" if not "!p:~2,1!"=="" (',
      '  set "drive=!p:~1,1!"',
      '  set "rest=!p:~2!"',
      '  set "rest=!rest:/=\\!"',
      '  call set "drive=%%drive:a=A%%"',
      '  call set "drive=%%drive:b=B%%"',
      '  call set "drive=%%drive:c=C%%"',
      '  call set "drive=%%drive:d=D%%"',
      '  call set "drive=%%drive:e=E%%"',
      '  call set "drive=%%drive:f=F%%"',
      '  call set "drive=%%drive:g=G%%"',
      '  call set "drive=%%drive:h=H%%"',
      '  call set "drive=%%drive:i=I%%"',
      '  call set "drive=%%drive:j=J%%"',
      '  call set "drive=%%drive:k=K%%"',
      '  call set "drive=%%drive:l=L%%"',
      '  call set "drive=%%drive:m=M%%"',
      '  call set "drive=%%drive:n=N%%"',
      '  call set "drive=%%drive:o=O%%"',
      '  call set "drive=%%drive:p=P%%"',
      '  call set "drive=%%drive:q=Q%%"',
      '  call set "drive=%%drive:r=R%%"',
      '  call set "drive=%%drive:s=S%%"',
      '  call set "drive=%%drive:t=T%%"',
      '  call set "drive=%%drive:u=U%%"',
      '  call set "drive=%%drive:v=V%%"',
      '  call set "drive=%%drive:w=W%%"',
      '  call set "drive=%%drive:x=X%%"',
      '  call set "drive=%%drive:y=Y%%"',
      '  call set "drive=%%drive:z=Z%%"',
      '  echo/!drive!:!rest!',
      '  exit /b 0',
      ')',
      'set "p=!p:/=\\!"',
      'echo/!p!',
      'exit /b 0',
      '',
    ].join('\r\n');
    writeFileSync(cygpathSh, cygpathShContent, 'utf8');
    writeFileSync(cygpathCmd, cygpathCmdContent, 'utf8');
    try {
      chmodSync(cygpathSh, 0o755);
    } catch {
      // Ignore chmod errors
    }

    return {
      shimDir,
      shimScriptPath,
    };
  } catch (error) {
    coworkLog('WARN', 'resolveNodeShim', `Failed to prepare Electron Node shim: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Resolve git-bash path on Windows.
 * Claude Code CLI requires git-bash for shell tool execution.
 * Checks: env var > common install paths > PATH lookup > bundled PortableGit fallback.
 */
function resolveWindowsGitBashPath(): string | null {
  if (cachedGitBashPath !== undefined) return cachedGitBashPath;

  if (process.platform !== 'win32') {
    cachedGitBashPath = null;
    return null;
  }

  // 1. Explicit env var (user override)
  const envPath = normalizeWindowsPath(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  if (envPath && existsSync(envPath)) {
    coworkLog('INFO', 'resolveGitBash', `Using CLAUDE_CODE_GIT_BASH_PATH: ${envPath}`);
    cachedGitBashPath = envPath;
    return envPath;
  }

  // 2. Common Git for Windows installation paths (prefer user/system install first)
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  const userProfile = process.env.USERPROFILE || '';

  const candidates = [
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'),
    join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
    join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
    join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    join(userProfile, 'scoop', 'apps', 'git', 'current', 'usr', 'bin', 'bash.exe'),
    'C:\\Git\\bin\\bash.exe',
    'C:\\Git\\usr\\bin\\bash.exe',
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      coworkLog('INFO', 'resolveGitBash', `Found git-bash at: ${candidate}`);
      cachedGitBashPath = candidate;
      return candidate;
    }
  }

  // 3. Query Git for Windows install root from registry
  const registryInstallRoots = listGitInstallPathsFromRegistry();
  for (const installRoot of registryInstallRoots) {
    const registryCandidates = [
      join(installRoot, 'bin', 'bash.exe'),
      join(installRoot, 'usr', 'bin', 'bash.exe'),
    ];
    for (const candidate of registryCandidates) {
      if (existsSync(candidate)) {
        coworkLog('INFO', 'resolveGitBash', `Found git-bash via registry: ${candidate}`);
        cachedGitBashPath = candidate;
        return candidate;
      }
    }
  }

  // 4. Try `where bash`
  const bashPaths = listWindowsCommandPaths('where bash');
  for (const bashPath of bashPaths) {
    if (bashPath.toLowerCase().endsWith('\\bash.exe')) {
      coworkLog('INFO', 'resolveGitBash', `Found bash via PATH: ${bashPath}`);
      cachedGitBashPath = bashPath;
      return bashPath;
    }
  }

  // 5. Try `where git` and derive bash from git location
  const gitPaths = listWindowsCommandPaths('where git');
  for (const gitPath of gitPaths) {
    const gitRoot = dirname(dirname(gitPath));
    const bashCandidates = [
      join(gitRoot, 'bin', 'bash.exe'),
      join(gitRoot, 'usr', 'bin', 'bash.exe'),
    ];
    for (const candidate of bashCandidates) {
      if (existsSync(candidate)) {
        coworkLog('INFO', 'resolveGitBash', `Found bash via PATH git: ${candidate}`);
        cachedGitBashPath = candidate;
        return candidate;
      }
    }
  }

  // 6. Bundled PortableGit fallback.
  // - Packaged app: resources/mingit
  // - Development mode: project resources/mingit (for local Windows dev without system Git install)
  const bundledRoots = app.isPackaged
    ? [join(process.resourcesPath, 'mingit')]
    : [
      join(__dirname, '..', '..', 'resources', 'mingit'),
      join(app.getAppPath(), 'resources', 'mingit'),
      join(process.cwd(), 'resources', 'mingit'),
    ];
  for (const root of bundledRoots) {
    // Prefer bin/bash.exe on Windows; invoking usr/bin/bash.exe directly may miss Git toolchain PATH.
    const bundledPaths = [
      join(root, 'bin', 'bash.exe'),
      join(root, 'usr', 'bin', 'bash.exe'),
    ];
    for (const p of bundledPaths) {
      if (existsSync(p)) {
        coworkLog('INFO', 'resolveGitBash', `Using bundled PortableGit: ${p}`);
        cachedGitBashPath = p;
        return p;
      }
    }
  }

  coworkLog('WARN', 'resolveGitBash', 'git-bash not found on this system');
  cachedGitBashPath = null;
  return null;
}

/**
 * Resolve Node.js installation directories on Windows.
 * Covers standard installers, nvm-windows, Volta, fnm, and Scoop.
 * Returns de-duplicated list of directories that contain node.exe / npm / npx.
 */
function resolveWindowsNodeDirs(): string[] {
  if (process.platform !== 'win32') return [];

  const found = new Set<string>();

  // 1. Derive from 'where node' — uses cmd.exe PATH which includes user PATH entries
  //    even when the Electron process was launched from a non-terminal context.
  const nodePaths = listWindowsCommandPaths('where node');
  for (const nodePath of nodePaths) {
    found.add(dirname(nodePath));
  }

  // 2. Scan current process.env.PATH entries that contain node.exe
  //    (covers cases where PATH is already set but node dir wasn't found above)
  for (const entry of (process.env.PATH || '').split(';')) {
    const trimmed = entry.trim();
    if (trimmed && existsSync(join(trimmed, 'node.exe'))) {
      found.add(trimmed);
    }
  }

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  const appData = process.env.APPDATA || '';
  const userProfile = process.env.USERPROFILE || '';

  // 3. Standard Node.js installer paths
  for (const candidate of [
    join(programFiles, 'nodejs'),
    join(programFilesX86, 'nodejs'),
    localAppData && join(localAppData, 'Programs', 'nodejs'),
  ]) {
    if (candidate && existsSync(join(candidate, 'node.exe'))) {
      found.add(candidate);
    }
  }

  // 4. npm global prefix — where globally-installed CLIs (npx, ts-node, etc.) live
  if (appData) {
    const npmGlobal = join(appData, 'npm');
    if (existsSync(npmGlobal)) {
      found.add(npmGlobal);
    }
  }

  // 5. nvm-windows: active version symlink
  if (appData) {
    const nvmLink = join(appData, 'nvm', 'nodejs');
    if (existsSync(join(nvmLink, 'node.exe'))) {
      found.add(nvmLink);
    }
  }

  // 6. Volta shims (handles node/npm/npx through its own launcher)
  if (localAppData) {
    const voltaBin = join(localAppData, 'Volta', 'bin');
    if (existsSync(voltaBin)) {
      found.add(voltaBin);
    }
  }

  // 7. fnm (Fast Node Manager) — default install shim dir
  if (localAppData) {
    const fnmBin = join(localAppData, 'fnm');
    if (existsSync(fnmBin)) {
      found.add(fnmBin);
    }
  }

  // 8. Scoop — node and shims directories
  if (userProfile) {
    const scoopNode = join(userProfile, 'scoop', 'apps', 'nodejs', 'current');
    if (existsSync(join(scoopNode, 'node.exe'))) {
      found.add(scoopNode);
    }
    const scoopShims = join(userProfile, 'scoop', 'shims');
    if (existsSync(scoopShims)) {
      found.add(scoopShims);
    }
  }

  return Array.from(found).filter(Boolean);
}

function applyPackagedEnvOverrides(env: Record<string, string | undefined>): void {
  // On Windows, resolve git-bash and ensure Git toolchain directories are available in PATH.
  if (process.platform === 'win32') {
    const electronExe = resolveElectronExecutablePath();
    env.IDBOTS_ELECTRON_PATH = electronExe;

    const configuredBashPath = normalizeWindowsPath(env.CLAUDE_CODE_GIT_BASH_PATH);
    const bashPath = configuredBashPath && existsSync(configuredBashPath)
      ? configuredBashPath
      : resolveWindowsGitBashPath();

    if (bashPath) {
      env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
      const gitToolDirs = getWindowsGitToolDirs(bashPath);
      env.PATH = appendEnvPath(env.PATH, gitToolDirs);
      coworkLog('INFO', 'resolveGitBash', `Injected Windows Git toolchain PATH entries: ${gitToolDirs.join(', ')}`);
    }

    // Prepend shim dir so our cygpath (and node) shims are found first — avoids "cygpath -u" failures when Git's cygpath is missing
    const shimInfo = ensureWindowsElectronNodeShim();
    if (shimInfo) {
      env.PATH = appendEnvPath(env.PATH, [shimInfo.shimDir]);
      env.IDBOTS_NODE_SHIM_SCRIPT = shimInfo.shimScriptPath;
      env.IDBOTS_NODE_SHIM_DIR = shimInfo.shimDir;
      coworkLog('INFO', 'resolveNodeShim', `Injected Electron Node shim PATH entry: ${shimInfo.shimDir}`);
    }

    // Inject Node.js directories so that npx/npm/ts-node are findable inside git-bash.
    // Electron apps launched from a shortcut/Start menu only receive the system PATH,
    // which typically excludes user-level Node.js installations.
    const nodeDirs = resolveWindowsNodeDirs();
    if (nodeDirs.length > 0) {
      env.PATH = appendEnvPath(env.PATH, nodeDirs);
      coworkLog('INFO', 'resolveNodeDirs', `Injected Windows Node.js PATH entries: ${nodeDirs.join(', ')}`);
    }

    // Disable MSYS2/Git Bash automatic path conversion.
    // Without this, Unix-style arguments like --path "/protocols/simplebuzz" are silently
    // rewritten to Windows paths (e.g. C:/Program Files/Git/protocols/simplebuzz) before
    // reaching the target process, corrupting MetaID protocol paths and similar values.
    env.MSYS_NO_PATHCONV = '1';
    env.MSYS2_ARG_CONV_EXCL = '*';
  }

  if (!app.isPackaged) {
    return;
  }

  if (!env.HOME) {
    env.HOME = app.getPath('home');
  }

  // Resolve user's shell PATH so that node, npm, and other tools are findable
  const userPath = resolveUserShellPath();
  if (userPath) {
    env.PATH = userPath;
  } else {
    // Fallback: append common node installation paths
    const home = env.HOME || app.getPath('home');
    const commonPaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      `${home}/.nvm/current/bin`,
      `${home}/.volta/bin`,
      `${home}/.fnm/current/bin`,
    ];
    env.PATH = [env.PATH, ...commonPaths].filter(Boolean).join(delimiter);
  }

  const resourcesPath = process.resourcesPath;
  const nodePaths = [
    join(resourcesPath, 'app.asar', 'node_modules'),
    join(resourcesPath, 'app.asar.unpacked', 'node_modules'),
  ].filter((nodePath) => existsSync(nodePath));

  if (nodePaths.length > 0) {
    env.NODE_PATH = appendEnvPath(env.NODE_PATH, nodePaths);
  }
}

/**
 * Resolve system proxy configuration from Electron session
 * @param targetUrl Target URL to resolve proxy for
 */
async function resolveSystemProxy(targetUrl: string): Promise<string | null> {
  try {
    const proxyResult = await session.defaultSession.resolveProxy(targetUrl);
    if (!proxyResult || proxyResult === 'DIRECT') {
      return null;
    }

    // proxyResult format: "PROXY host:port" or "SOCKS5 host:port"
    const match = proxyResult.match(/^(PROXY|SOCKS5?)\s+(.+)$/i);
    if (match) {
      const [, type, hostPort] = match;
      const prefix = type.toUpperCase().startsWith('SOCKS') ? 'socks5' : 'http';
      return `${prefix}://${hostPort}`;
    }

    return null;
  } catch (error) {
    console.error('Failed to resolve system proxy:', error);
    return null;
  }
}

/**
 * Get SKILLs directory path (handles both development and production)
 */
export function getSkillsRoot(): string {
  const envRoots = [process.env.IDBOTS_SKILLS_ROOT, process.env.SKILLS_ROOT]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (envRoots.length > 0) {
    return resolve(envRoots[0]);
  }

  if (app.isPackaged) {
    // In production, SKILLs are copied to userData
    return join(app.getPath('userData'), 'SKILLs');
  }

  // In development, __dirname can vary with bundling output (e.g. dist-electron/ or dist-electron/libs/).
  // Resolve from several stable anchors and pick the first existing SKILLs directory.
  const candidates = [
    ...envRoots,
    join(app.getAppPath(), 'SKILLs'),
    join(process.cwd(), 'SKILLs'),
    join(__dirname, '..', 'SKILLs'),
    join(__dirname, '..', '..', 'SKILLs'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Final fallback for first-run dev environments where SKILLs may not exist yet.
  return join(app.getAppPath(), 'SKILLs');
}

/**
 * Get enhanced environment variables (including proxy configuration)
 * Async function to fetch system proxy and inject into environment variables
 */
export async function getEnhancedEnv(target: OpenAICompatProxyTarget = 'local'): Promise<Record<string, string | undefined>> {
  const config = getCurrentApiConfig(target);
  const env = config
    ? buildEnvForConfig(config)
    : { ...process.env };

  applyPackagedEnvOverrides(env);

  // Inject SKILLs directory path for skill scripts
  const skillsRoot = getSkillsRoot();
  env.SKILLS_ROOT = skillsRoot;
  env.IDBOTS_SKILLS_ROOT = skillsRoot; // Alternative name for clarity
  env.IDBOTS_ELECTRON_PATH = resolveElectronExecutablePath();

  // Inject internal API base URL for skill scripts (e.g. scheduled-task creation)
  const internalApiBaseURL = getInternalApiBaseURL();
  if (internalApiBaseURL) {
    env.IDBOTS_API_BASE_URL = internalApiBaseURL;
  }

  const mergedNoProxy = mergeNoProxyList(
    env.NO_PROXY || env.no_proxy,
    LOCAL_NO_PROXY_HOSTS
  );
  env.NO_PROXY = mergedNoProxy;
  env.no_proxy = mergedNoProxy;

  // Skip system proxy resolution if proxy env vars already exist
  if (env.http_proxy || env.HTTP_PROXY || env.https_proxy || env.HTTPS_PROXY) {
    return env;
  }

  // Resolve proxy from system settings
  const proxyUrl = await resolveSystemProxy('https://openrouter.ai');
  if (proxyUrl) {
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    console.log('Injected system proxy for subprocess:', proxyUrl);
  }

  return env;
}

/**
 * Ensure the cowork temp directory exists in the given working directory
 * @param cwd Working directory path
 * @returns Path to the temp directory
 */
export function ensureCoworkTempDir(cwd: string): string {
  const tempDir = join(cwd, '.cowork-temp');
  if (!existsSync(tempDir)) {
    try {
      mkdirSync(tempDir, { recursive: true });
      console.log('Created cowork temp directory:', tempDir);
    } catch (error) {
      console.error('Failed to create cowork temp directory:', error);
      // Fall back to cwd if we can't create the temp dir
      return cwd;
    }
  }
  return tempDir;
}

/**
 * Get enhanced environment variables with TMPDIR set to the cowork temp directory
 * This ensures Claude Agent SDK creates temporary files in the user's working directory
 * @param cwd Working directory path
 */
export async function getEnhancedEnvWithTmpdir(
  cwd: string,
  target: OpenAICompatProxyTarget = 'local'
): Promise<Record<string, string | undefined>> {
  const env = await getEnhancedEnv(target);
  const tempDir = ensureCoworkTempDir(cwd);

  // Set temp directory environment variables for all platforms
  env.TMPDIR = tempDir;  // macOS, Linux
  env.TMP = tempDir;     // Windows
  env.TEMP = tempDir;    // Windows

  return env;
}

export async function generateSessionTitle(userIntent: string | null): Promise<string> {
  if (!userIntent) return 'New Session';

  const claudeCodePath = getClaudeCodePath();
  const currentEnv = await getEnhancedEnv();

  // Ensure child_process.fork() runs cli.js as Node, not as another Electron app
  if (app.isPackaged) {
    currentEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  try {
    const { unstable_v2_prompt } = await loadClaudeSdk();
    const promptOptions: Record<string, unknown> = {
      model: getCurrentApiConfig()?.model || 'claude-sonnet',
      env: currentEnv,
      pathToClaudeCodeExecutable: claudeCodePath,
    };

    const result: SDKResultMessage = await unstable_v2_prompt(
      `Generate a short, clear title (max 50 chars) for this conversation based on the user input below.
IMPORTANT: The title MUST be in the SAME language as the user input. If user writes in Chinese, output Chinese title. If user writes in English, output English title.
User input: ${userIntent}
Output only the title, nothing else.`,
      promptOptions as any
    );

    if (result.subtype === 'success') {
      return result.result;
    }

    console.error('Claude SDK returned non-success result:', result);
    return 'New Session';
  } catch (error) {
    console.error('Failed to generate session title:', error);
    console.error('Claude Code path:', claudeCodePath);
    console.error('Is packaged:', app.isPackaged);
    console.error('Resources path:', process.resourcesPath);

    if (userIntent) {
      const words = userIntent.trim().split(/\s+/).slice(0, 5);
      return words.join(' ').toUpperCase() + (userIntent.trim().split(/\s+/).length > 5 ? '...' : '');
    }

    return 'New Session';
  }
}
