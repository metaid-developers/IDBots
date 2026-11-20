/**
 * Server-mode runtime switch and C1 tenant-runtime resolutions
 * (REQ-A-1, REQ-A-7, REQ-A-31, REQ-A-33).
 *
 * Server mode is enabled exclusively by `IDBOTS_SERVER_MODE=1`. With the
 * variable unset, every function here is either never called (the guarded
 * branches in main.ts) or returns the desktop value, so desktop behavior is
 * byte-identical.
 *
 * This module must stay free of electron imports: it is loaded from plain
 * node tests (tests/serverMode.test.mjs) against the compiled
 * dist-electron output.
 *
 * Contract: docs/cloud-mobile/01-interface-contracts.md, C1 (environment,
 * paths) and docs/cloud-mobile/10-ws-a-idbots-server-mode.md
 * (REQ-A-31/REQ-A-33).
 */

import path from 'path';
import { resolveRuntimeDataPaths } from '../libs/runtimeDataPaths';

export const SERVER_MODE_ENV = 'IDBOTS_SERVER_MODE';

/** C1: tenant id logged with every line; dev fallback matches the gateway. */
export const DEFAULT_TENANT_ID = 't_dev_local';

/** C1 volume layout: the container mounts one named volume at /data. */
export const SERVER_USER_DATA_DEFAULT = '/data/userdata';
export const SERVER_APP_DATA_DEFAULT = '/data/appdata';
export const SERVER_WORKSPACE_DEFAULT = '/data/workspace';

/**
 * REQ-A-31: the desktop DSH runtime idle TTL (30 min) lives in
 * coworkDshTurn.ts as DSH_RUNTIME_IDLE_TTL_MS. Server mode must reclaim the
 * idle DSH session (and its playwright MCP) within 10 minutes of the last
 * turn so tenant memory returns near its idle value.
 */
export const DSH_RUNTIME_IDLE_TTL_SERVER_MS = 10 * 60_000;

/**
 * REQ-A-33: spread post-boot background jobs by at most this much per job so
 * a host restarting many tenants at once does not run every tenant's jobs
 * in the same instant (Phase 0 saw ~80% CPU right after onboarding).
 */
export const SERVER_BOOT_JITTER_MAX_MS = 120_000;

/** REQ-A-1: the single mode switch every gate checks first. */
export function isServerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SERVER_MODE_ENV] === '1';
}

/** C1: tenant id from the control plane; the dev default matches the gateway. */
export function resolveTenantId(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.IDBOTS_TENANT_ID?.trim();
  return value || DEFAULT_TENANT_ID;
}

/**
 * REQ-A-7 / C1: in server mode, default the C1 data paths under /data before
 * app path resolution runs. Explicit env overrides always win; desktop is
 * untouched because the function no-ops when server mode is off. This
 * reuses libs/runtimeDataPaths.ts (resolveRuntimeDataPaths) rather than
 * duplicating the override logic — the env set here is consumed by
 * configureUserDataPath() in main.ts through that same module.
 */
export function applyServerModeEnvDefaults(env: NodeJS.ProcessEnv = process.env): void {
  if (!isServerMode(env)) return;
  env.IDBOTS_USER_DATA_PATH = env.IDBOTS_USER_DATA_PATH?.trim() || SERVER_USER_DATA_DEFAULT;
  env.IDBOTS_APP_DATA_PATH = env.IDBOTS_APP_DATA_PATH?.trim() || SERVER_APP_DATA_DEFAULT;
}

/**
 * REQ-A-7 / C1: resolve the runtime data paths exactly the way
 * configureUserDataPath() does (same env precedence, same appName defaulting)
 * but with the C1 /data defaults applied first. Server mode only in effect;
 * on desktop the current app paths pass through unchanged.
 */
export function resolveServerDataPaths(
  currentAppDataPath: string,
  currentUserDataPath: string,
  appName: string,
  env: NodeJS.ProcessEnv = process.env,
): { appDataPath: string; userDataPath: string } {
  if (!isServerMode(env)) {
    return { appDataPath: currentAppDataPath, userDataPath: currentUserDataPath };
  }
  const withDefaults: NodeJS.ProcessEnv = { ...env };
  applyServerModeEnvDefaults(withDefaults);
  return resolveRuntimeDataPaths({
    appDataPath: currentAppDataPath,
    currentUserDataPath,
    appName,
    env: withDefaults,
  });
}

/**
 * REQ-A-7: the cowork working directory root. Server mode defaults to
 * /data/workspace (C1: the only allowed working directory root); desktop
 * callers pass their own default (~/idbots/project).
 */
export function resolveServerWorkspacePath(
  desktopDefault: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isServerMode(env)) return desktopDefault;
  const override = env.IDBOTS_WORKSPACE_PATH?.trim();
  return path.resolve(override || SERVER_WORKSPACE_DEFAULT);
}

/**
 * REQ-A-31: the DSH runtime idle TTL. Desktop keeps the 30-minute default
 * owned by coworkDshTurn.ts (passed here so this module stays electron-free
 * and cycle-free); server mode reclaims within 10 minutes.
 */
export function resolveDshRuntimeIdleTtlMs(
  desktopTtlMs: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return isServerMode(env) ? DSH_RUNTIME_IDLE_TTL_SERVER_MS : desktopTtlMs;
}

/**
 * REQ-A-33: deterministic per-(tenant, job) jitter in [0, maxMs). FNV-1a over
 * `tenantId:label` — stable across restarts of the same tenant, and distinct
 * jobs of one tenant spread apart instead of piling onto one instant.
 */
export function computeServerBootJitterMs(
  tenantId: string,
  label: string,
  maxMs: number = SERVER_BOOT_JITTER_MAX_MS,
): number {
  const input = `${tenantId}:${label}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return maxMs <= 0 ? 0 : hash % maxMs;
}

/**
 * REQ-A-33: the delay a boot job actually gets. Desktop returns baseDelayMs
 * unchanged; server mode adds the deterministic jitter. Every staggered boot
 * job routes through this so the tenant fleet spreads its post-boot work.
 */
export function resolveServerBootDelayMs(
  baseDelayMs: number,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!isServerMode(env)) return baseDelayMs;
  return baseDelayMs + computeServerBootJitterMs(resolveTenantId(env), label);
}

/**
 * REQ-A-5: agent tools that depend on desktop-only features (Bot Browser,
 * OS screen capture, local MetaApp open, local Projects). In server mode
 * buildSessionInlineTools filters these out so the model is never offered
 * them. Underlying IPC channels stay registered but are never invoked (the
 * gateway allowlist denies them); Docker sandbox execution is already
 * retired at runtime — sandbox turns fall through to the local DSH kernel —
 * and MCP local servers are disabled at the composition providers.
 */
export const SERVER_MODE_DISABLED_AGENT_TOOLS: ReadonlySet<string> = new Set([
  // Bot Browser (botBrowserAgentTools.ts, browserOpenAgentTools.ts,
  // buildBotBrowserScreenshotTool / buildBotBrowserActTool).
  'bot_browser_tabs',
  'bot_browser_open_uri',
  'bot_browser_preview_local',
  'bot_browser_read_page',
  'bot_browser_fork_current_app',
  'bot_browser_publish_app',
  'bot_browser_screenshot',
  'bot_browser_act',
  'browser_open',
  // OS screen capture via desktopCapturer (screenshotAgentTools.ts).
  'screenshot',
  // Local MetaApp open/resolve (coworkRunner inline tools).
  'open_metaapp',
  'resolve_metaapp_url',
  // Local project folders (projectsAgentTools.ts).
  'project_query',
]);

/** REQ-A-5 filter used at the tool-list assembly seam. Desktop no-op. */
export function filterServerModeAgentTools<T extends { name?: unknown }>(tools: T[]): T[] {
  if (!isServerMode()) return tools;
  return tools.filter((tool) => !SERVER_MODE_DISABLED_AGENT_TOOLS.has(String(tool?.name ?? '')));
}

export interface MobileOwnerChatSessionShape {
  autoOrigin?: string | null;
  sessionType?: string | null;
}

/** Interactive cloud-PWA/native chat, including a desktop-created session reopened on mobile. */
export function isMobileOwnerChatSession(input: {
  serverMode: boolean;
  session: MobileOwnerChatSessionShape | null | undefined;
  sourceChannel: string;
}): boolean {
  const sessionType = input.session?.sessionType ?? 'standard';
  return input.serverMode
    && input.session != null
    && !input.session.autoOrigin
    && (sessionType === 'standard' || sessionType === 'browser')
    && input.sourceChannel === 'cowork_ui';
}

export const MOBILE_TOOL_EXPANSIONS = [
  'workerEconomy',
  'financial',
  'social',
  'metaweb',
  'orchestration',
  'memoryAdvanced',
  'automation',
] as const;
export type MobileToolExpansion = typeof MOBILE_TOOL_EXPANSIONS[number];

const MOBILE_TOOL_PATTERNS: Record<MobileToolExpansion, RegExp> = {
  workerEconomy: /\b(?:metatask|agentpedia|escrow|prediction_record|metaprotocol|group[_ -]?task)\b|群任务|托管订单|预测账本|元协议|竞赛任务/i,
  financial: /\b(?:wallet|btc|mrc20|mrc721|nft|token|tokens|payment|multisig)\b|钱包|转账|余额|比特币|代币|支付|付款|收款|充值|积分|手续费|矿工费/i,
  social: /\b(?:buzz|simpleqa|simplenote|simplelog|omni_cast|group[_ -]?chat|private[_ -]?chat)\b|动态|私聊|群聊|问答|笔记|日志|点赞|评论|发帖|发文章|发短文|发长文|好友|关注|转发/i,
  metaweb: /\b(?:metaweb|metaid|metaapp|chain|pin|protocol)\b|链上|协议|动态|问答|帖子| agent internet|agent 互联网/i,
  orchestration: /\b(?:task|tasks|subagent|delegate|orchestrat\w*|longterm|schedule|todo|worker)\b|任务|督办|长期|定时|编排|委派|员工|团队|分身|子代理|子任务|待办/i,
  memoryAdvanced: /\b(?:memory|remember|recall|history|previous|experience|knowledge|procedure|preference)\b|记忆|记得|历史|之前|上次|经验|知识|偏好|流程|梦|回顾|总结/i,
  automation: /\b(?:browser|playwright|automation|screenshot|click)\b|浏览器|网页|网站|链接|自动化|截图|点击|播放/i,
};

/** Expand only on explicit intent and keep the expansion for follow-up turns. */
export function resolveMobileToolExpansions(
  previous: readonly MobileToolExpansion[] | undefined,
  prompt: string,
): MobileToolExpansion[] {
  const next = new Set(previous ?? []);
  for (const expansion of MOBILE_TOOL_EXPANSIONS) {
    if (MOBILE_TOOL_PATTERNS[expansion].test(prompt)) next.add(expansion);
  }
  return MOBILE_TOOL_EXPANSIONS.filter((expansion) => next.has(expansion));
}

export function resolveMobileToolMountPolicy(input: {
  isStudioOwnerChat: boolean;
  isMobileOwnerChat: boolean;
  expansions: readonly MobileToolExpansion[];
}): Record<MobileToolExpansion, boolean> {
  return {
    workerEconomy: !input.isStudioOwnerChat && (!input.isMobileOwnerChat || input.expansions.includes('workerEconomy')),
    financial: !input.isMobileOwnerChat || input.expansions.includes('financial'),
    social: !input.isStudioOwnerChat && (!input.isMobileOwnerChat || input.expansions.includes('social')),
    metaweb: !input.isMobileOwnerChat || input.expansions.includes('metaweb'),
    orchestration: !input.isMobileOwnerChat || input.expansions.includes('orchestration'),
    memoryAdvanced: !input.isMobileOwnerChat || input.expansions.includes('memoryAdvanced'),
    automation: !input.isMobileOwnerChat || input.expansions.includes('automation'),
  };
}

const MOBILE_CORE_TOOLS: ReadonlySet<string> = new Set([
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'read_image',
  'web_search', 'web_fetch', 'skill_tool',
  'conversation_recall', 'conversation_search', 'recent_chats', 'memory_user_edits',
  'upload_file', 'describe_image', 'describe_video', 'describe_audio',
  'media_info', 'convert_media', 'grab_video_frame', 'check_metafile_route',
  'ask_user_question', 'get_host_location', 'metabot_getinfo',
  'task_list_active', 'task_context_read', 'task_get', 'task_subtask_progress',
  'longterm_task_list', 'longterm_task_get', 'longterm_subtask_wait',
  'list_agents', 'interrupt_agent',
]);

const MOBILE_EXPANSION_TOOL_PATTERNS: Record<Exclude<MobileToolExpansion, 'automation'>, RegExp> = {
  workerEconomy: /^(?:metatask_|agentpedia_|prediction_record$|post_metaprotocol$|escrow_)/,
  financial: /^(?:wallet_|mrc721_|me_charge$|payment_card_emit$)/,
  social: /^(?:post_buzz$|post_simplenote$|post_simpleqa$|post_simplelog$|omni_cast$|like_pin$|comment_pin$|group_chat$|private_chat$|im_send_message$)/,
  metaweb: /^(?:omni_read$|search_metaapps$|search_qa$|list_latest_questions$|get_question_answers$|search_metaweb$|read_metaweb_pins_batch$|read_metaweb_pin$|metaweb_surf_start$|metaweb_surf_status$|metaweb_study_enqueue$|metaweb_study_status$|metaweb_qa_surf_enqueue$|metaweb_qa_surf_disable$|search_social_posts$|search_metaids$|list_social_connections$|list_online_bots$|list_online_services$|social_post_detail$|social_post_comments$|metaid_profile$|check_peer_relationship$|metaweb_pin_versions$|metaprotocol_registry$)/,
  orchestration: /^(?:task_|longterm_|preference_|subagent$|send_message$|list_subagent_models$|local_workers_list$|local_worker_delegate$|twin_task_|worker_session_stop$|idbots_session_)/,
  memoryAdvanced: /^(?:chain_history_recall$|standing_pages$|experience_recall$|knowledge_recall$|knowledge_upsert$|knowledge_base_|procedure_)/,
};

/** Core chat stays small; optional families appear only after explicit intent. */
export function isMobileToolVisible(toolName: string, expansions: readonly MobileToolExpansion[]): boolean {
  if (MOBILE_CORE_TOOLS.has(toolName)) return true;
  if (toolName.startsWith('mcp__playwright-mcp__')) return expansions.includes('automation');
  for (const [expansion, pattern] of Object.entries(MOBILE_EXPANSION_TOOL_PATTERNS) as Array<[Exclude<MobileToolExpansion, 'automation'>, RegExp]>) {
    if (pattern.test(toolName)) return expansions.includes(expansion);
  }
  return true;
}
