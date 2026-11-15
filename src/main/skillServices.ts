/**
 * Skill Services Manager - Manages background services for skills
 */

import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { getEnhancedEnv } from './libs/coworkUtil';
import { resolveElectronSkillExecutablePath } from './libs/runtimePaths';
import { resolveBundledSkillsRoot, resolveWritableSkillsRoot } from './libs/skillRoots';

const WEB_SEARCH_HEALTH_POLL_INTERVAL_MS = 200;
const WEB_SEARCH_HEALTH_WAIT_MS = 3000;

/**
 * Build an environment for spawning skill service scripts.
 * Reuses cowork env hardening so Windows/macOS/Linux behavior stays aligned.
 */
async function buildSkillServiceEnv(): Promise<Record<string, string | undefined>> {
  const startedAt = Date.now();
  console.log('[SkillServices] Building skill service env...');
  const env = await getEnhancedEnv('local');
  env.IDBOTS_ELECTRON_PATH = resolveElectronSkillExecutablePath();
  console.log(`[SkillServices] Built skill service env in ${Date.now() - startedAt}ms`);
  return env;
}

export class SkillServiceManager {
  private webSearchPid: number | null = null;
  private skillEnv: Record<string, string | undefined> | null = null;
  private stopping = false;

  /**
   * Async stand-in for execSync: the web-search repair runs on the main
   * process, so npm must not freeze the UI while it works.
   */
  private runRepairCommand(commandLine: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(commandLine, {
        cwd,
        stdio: 'ignore',
        env,
        shell: true,
        windowsHide: true,
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`${commandLine} failed (${signal ?? `exit code ${code}`})`));
      });
    });
  }

  private hasWebSearchRuntimeScriptSupport(skillPath: string): boolean {
    const startServerScript = path.join(skillPath, 'scripts', 'start-server.sh');
    const searchScript = path.join(skillPath, 'scripts', 'search.sh');
    if (!fs.existsSync(startServerScript)) {
      return false;
    }
    if (!fs.existsSync(searchScript)) {
      return false;
    }
    try {
      const startScript = fs.readFileSync(startServerScript, 'utf-8');
      const searchScriptContent = fs.readFileSync(searchScript, 'utf-8');
      return startScript.includes('WEB_SEARCH_FORCE_REPAIR')
        && startScript.includes('detect_healthy_bridge_server')
        && searchScriptContent.includes('ACTIVE_SERVER_URL')
        && searchScriptContent.includes('try_switch_to_local_server');
    } catch {
      return false;
    }
  }

  private isWebSearchRuntimeHealthy(skillPath: string): boolean {
    const requiredPaths = [
      path.join(skillPath, 'scripts', 'start-server.sh'),
      path.join(skillPath, 'scripts', 'search.sh'),
      path.join(skillPath, 'dist', 'server', 'index.js'),
      path.join(skillPath, 'node_modules', 'iconv-lite', 'encodings', 'index.js'),
    ];
    return requiredPaths.every(requiredPath => fs.existsSync(requiredPath))
      && this.hasWebSearchRuntimeScriptSupport(skillPath);
  }

  private hasCommand(command: string, env: NodeJS.ProcessEnv): boolean {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(checker, [command], { stdio: 'ignore', env, windowsHide: true });
    return result.status === 0;
  }

  private repairWebSearchRuntimeFromBundled(skillPath: string): void {
    if (!app.isPackaged) return;

    const candidates = [
      path.join(process.resourcesPath, 'SKILLs', 'web-search'),
      path.join(app.getAppPath(), 'SKILLs', 'web-search'),
    ];

    const bundledPath = candidates.find(candidate => candidate !== skillPath && fs.existsSync(candidate));
    if (!bundledPath) {
      return;
    }

    try {
      fs.cpSync(bundledPath, skillPath, {
        recursive: true,
        dereference: true,
        force: true,
        errorOnExist: false,
      });
      console.log('[SkillServices] Repaired web-search runtime from bundled resources');
    } catch (error) {
      console.warn('[SkillServices] Failed to repair web-search runtime from bundled resources:', error);
    }
  }

  private resolveNodeRuntime(
    env: NodeJS.ProcessEnv
  ): { command: string; args: string[]; extraEnv?: NodeJS.ProcessEnv } {
    if (!app.isPackaged && this.hasCommand('node', env)) {
      return { command: 'node', args: [] };
    }

    const electronExecutable = resolveElectronSkillExecutablePath();
    return {
      command: electronExecutable,
      args: [],
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }

  private async ensureWebSearchRuntimeReady(skillPath: string): Promise<void> {
    const startedAt = Date.now();
    console.log(`[SkillServices] Checking web-search runtime health: ${skillPath}`);
    if (this.isWebSearchRuntimeHealthy(skillPath)) {
      console.log(`[SkillServices] Web-search runtime already healthy in ${Date.now() - startedAt}ms`);
      return;
    }

    this.repairWebSearchRuntimeFromBundled(skillPath);
    if (this.isWebSearchRuntimeHealthy(skillPath)) {
      console.log(`[SkillServices] Web-search runtime repaired from bundled resources in ${Date.now() - startedAt}ms`);
      return;
    }

    const nodeModules = path.join(skillPath, 'node_modules');
    const distDir = path.join(skillPath, 'dist');
    const env = this.skillEnv as NodeJS.ProcessEnv ?? process.env;
    const npmAvailable = this.hasCommand('npm', env);

    const shouldInstallDeps = !fs.existsSync(nodeModules) || !this.isWebSearchRuntimeHealthy(skillPath);
    if (shouldInstallDeps) {
      if (!npmAvailable) {
        throw new Error('Web-search runtime is incomplete and npm is not available to repair it');
      }
      console.log('[SkillServices] Installing/reparing web-search dependencies...');
      await this.runRepairCommand('npm install', skillPath, env);
      console.log(`[SkillServices] Web-search dependencies repaired in ${Date.now() - startedAt}ms`);
    }

    if (!fs.existsSync(distDir)) {
      if (!npmAvailable) {
        throw new Error('Web-search dist files are missing and npm is not available to rebuild them');
      }
      console.log('[SkillServices] Compiling web-search TypeScript...');
      await this.runRepairCommand('npm run build', skillPath, env);
      console.log(`[SkillServices] Web-search dist rebuilt in ${Date.now() - startedAt}ms`);
    }

    if (!this.isWebSearchRuntimeHealthy(skillPath)) {
      throw new Error('Web-search runtime is still unhealthy after attempted repair');
    }
    console.log(`[SkillServices] Web-search runtime healthy after repair in ${Date.now() - startedAt}ms`);
  }

  /**
   * Start all skill services
   */
  async startAll(): Promise<void> {
    const startedAt = Date.now();
    this.stopping = false;
    console.log('[SkillServices] Starting skill services...');

    // Resolve environment once for all service spawns
    this.skillEnv = await buildSkillServiceEnv();
    console.log(`[SkillServices] Skill service env ready after ${Date.now() - startedAt}ms`);

    try {
      await this.startWebSearchService();
    } catch (error) {
      console.error('[SkillServices] Error starting services:', error);
    }
    console.log(`[SkillServices] startAll complete in ${Date.now() - startedAt}ms`);
  }

  /**
   * Stop all skill services
   */
  async stopAll(): Promise<void> {
    console.log('[SkillServices] Stopping skill services...');
    this.stopping = true;

    try {
      await this.stopWebSearchService();
    } catch (error) {
      console.error('[SkillServices] Error stopping services:', error);
    }
  }

  /**
   * Wait for the bridge server to answer its health probe, polling instead of
   * sleeping a fixed 3s: the server usually answers within a few hundred ms,
   * and a shutdown must not be held behind the wait.
   */
  private async waitForWebSearchHealth(timeoutMs: number = WEB_SEARCH_HEALTH_WAIT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.checkWebSearchHealth()) {
        return true;
      }
      if (this.stopping || Date.now() >= deadline) {
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, WEB_SEARCH_HEALTH_POLL_INTERVAL_MS));
    }
  }

  /**
   * Start Web Search Bridge Server
   */
  async startWebSearchService(): Promise<void> {
    try {
      const startedAt = Date.now();
      const skillPath = this.getWebSearchPath();
      if (!skillPath) {
        console.log('[SkillServices] Web Search skill not found, skipping');
        return;
      }
      console.log(`[SkillServices] Web Search skill path resolved in ${Date.now() - startedAt}ms: ${skillPath}`);

      // Check if already running
      if (this.isWebSearchServiceRunning()) {
        console.log('[SkillServices] Web Search service already running');
        return;
      }

      console.log('[SkillServices] Starting Web Search Bridge Server...');

      await this.startWebSearchServiceProcess(skillPath);

      if (this.stopping) {
        await this.stopWebSearchService();
        return;
      }

      if (!(await this.waitForWebSearchHealth())) {
        console.warn('[SkillServices] Web Search Bridge Server did not answer its health probe in time');
      }

      // Check if server started successfully
      const pidFile = path.join(skillPath, '.server.pid');
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
        this.webSearchPid = pid;
        console.log(`[SkillServices] Web Search Bridge Server started (PID: ${pid})`);
      } else {
        console.warn('[SkillServices] Web Search Bridge Server may not have started correctly');
      }
      console.log(`[SkillServices] startWebSearchService complete in ${Date.now() - startedAt}ms`);
    } catch (error) {
      console.error('[SkillServices] Failed to start Web Search service:', error);
    }
  }

  private async startWebSearchServiceProcess(skillPath: string): Promise<void> {
    const startedAt = Date.now();
    const pidFile = path.join(skillPath, '.server.pid');
    const logFile = path.join(skillPath, '.server.log');
    const serverEntry = path.join(skillPath, 'dist', 'server', 'index.js');
    await this.ensureWebSearchRuntimeReady(skillPath);
    const baseEnv = this.skillEnv as NodeJS.ProcessEnv ?? process.env;
    const runtime = this.resolveNodeRuntime(baseEnv);
    const env = {
      ...baseEnv,
      ...(runtime.extraEnv ?? {}),
      IDBOTS_ELECTRON_PATH: resolveElectronSkillExecutablePath(),
    };

    // Node/Electron validates stdio streams synchronously. Use fd to avoid
    // races where createWriteStream has not opened the file descriptor yet.
    const logFd = fs.openSync(logFile, 'a');
    let child;
    try {
      child = spawn(runtime.command, [...runtime.args, serverEntry], {
        cwd: skillPath,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env,
        windowsHide: true,
      });
    } finally {
      fs.closeSync(logFd);
    }

    fs.writeFileSync(pidFile, child.pid!.toString());
    child.unref();

    const runtimeLabel = runtime.command === resolveElectronSkillExecutablePath() ? 'electron-node' : 'node';
    console.log(`[SkillServices] Web Search Bridge Server starting (PID: ${child.pid}, runtime: ${runtimeLabel})`);
    console.log(`[SkillServices] Logs: ${logFile}`);
    console.log(`[SkillServices] startWebSearchServiceProcess complete in ${Date.now() - startedAt}ms`);
  }

  /**
   * Stop Web Search Bridge Server
   */
  async stopWebSearchService(): Promise<void> {
    try {
      const skillPath = this.getWebSearchPath();
      if (!skillPath) {
        return;
      }

      if (!this.isWebSearchServiceRunning()) {
        console.log('[SkillServices] Web Search service not running');
        return;
      }

      console.log('[SkillServices] Stopping Web Search Bridge Server...');

      if (this.webSearchPid) {
        const pidToKill = this.webSearchPid;
        try {
          process.kill(pidToKill, 'SIGTERM');
        } catch (error) {
          console.warn('[SkillServices] Failed to kill process:', error);
        }
        if (process.platform === 'win32') {
          try {
            spawnSync('taskkill', ['/PID', String(pidToKill), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
          } catch {
            // Best effort
          }
        }
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
          try {
            process.kill(pidToKill, 0);
          } catch {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }

      const pidFile = path.join(skillPath, '.server.pid');
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }

      console.log('[SkillServices] Web Search Bridge Server stopped');
      this.webSearchPid = null;
    } catch (error) {
      console.error('[SkillServices] Failed to stop Web Search service:', error);
    }
  }

  /**
   * Check if Web Search service is running
   */
  isWebSearchServiceRunning(): boolean {
    if (this.webSearchPid === null) {
      // Try to read PID from file
      const skillPath = this.getWebSearchPath();
      if (!skillPath) {
        return false;
      }

      const pidFile = path.join(skillPath, '.server.pid');
      if (fs.existsSync(pidFile)) {
        try {
          const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
          this.webSearchPid = pid;
        } catch (error) {
          return false;
        }
      } else {
        return false;
      }
    }

    // Check if process is actually running
    try {
      process.kill(this.webSearchPid, 0); // Signal 0 checks if process exists
      return true;
    } catch (error) {
      this.webSearchPid = null;
      return false;
    }
  }

  /**
   * Get Web Search skill path
   */
  private getWebSearchPath(): string | null {
    const candidates: string[] = [];
    const envSkillsRoot = process.env.IDBOTS_SKILLS_ROOT?.trim() || process.env.SKILLS_ROOT?.trim();
    if (envSkillsRoot) {
      candidates.push(path.join(path.resolve(envSkillsRoot), 'web-search'));
    }

    candidates.push(path.join(resolveWritableSkillsRoot(), 'web-search'));
    candidates.push(path.join(resolveBundledSkillsRoot(), 'web-search'));

    return candidates.find(skillPath => fs.existsSync(skillPath)) ?? null;
  }

  /**
   * Get service status
   */
  getStatus(): { webSearch: boolean } {
    return {
      webSearch: this.isWebSearchServiceRunning()
    };
  }

  /**
   * Health check for Web Search service
   */
  async checkWebSearchHealth(): Promise<boolean> {
    try {
      const response = await fetch('http://127.0.0.1:8923/api/health', {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }
}

// Singleton instance
let serviceManager: SkillServiceManager | null = null;

export function getSkillServiceManager(): SkillServiceManager {
  if (!serviceManager) {
    serviceManager = new SkillServiceManager();
  }
  return serviceManager;
}
