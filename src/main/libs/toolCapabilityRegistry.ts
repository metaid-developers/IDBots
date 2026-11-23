/**
 * Declarative ToolCapabilityRegistry (P1 governance).
 *
 * Single source of truth for:
 * 1. Tool domain ownership (every host/inline/DSH tool declares a domain).
 * 2. Host environment eligibility (`desktopOnly`, `serverOnly`, `imOnly`).
 * 3. Surface mount policy (Studio slimming + Cloud Mobile intent expansion).
 * 4. Fail-closed visibility (`isMobileToolVisible` returns `false` for any
 *    unclassified tool instead of leaking it onto mobile).
 *
 * Must stay free of Electron imports so plain Node tests and server-mode helpers
 * can load it directly from compiled `dist-electron`.
 */

import type { ConversationProfile, ExecutionRole, HostEnv } from './conversationProfile';

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

export type ToolDomain =
  | 'core'
  | 'studio_projector'
  | 'desktop_browser'
  | 'desktop_native'
  | 'mobile_host'
  | 'im'
  | 'browser_automation'
  | 'worker_economy'
  | 'financial'
  | 'social'
  | 'metaweb'
  | 'orchestration'
  | 'memory_advanced';

export interface ToolCapabilitySpec {
  readonly domain: ToolDomain;
  readonly desktopOnly?: boolean;
  readonly serverOnly?: boolean;
  readonly imOnly?: boolean;
  readonly readOnly?: boolean;
  readonly expansion?: MobileToolExpansion;
}

const READ_ONLY_ECONOMY_TOOLS: ReadonlySet<string> = new Set([
  'escrow_order_info',
  'escrow_order_list',
  'metatask_get',
  'metatask_list',
  'metatask_replay',
]);

const READ_ONLY_SOCIAL_METAWEB_TOOLS: ReadonlySet<string> = new Set([
  'check_peer_relationship',
  'get_question_answers',
  'list_latest_questions',
  'list_online_bots',
  'list_online_services',
  'list_social_connections',
  'metaid_profile',
  'metaprotocol_registry',
  'metaweb_pin_versions',
  'omni_read',
  'read_metaweb_pin',
  'read_metaweb_pins_batch',
  'search_metaapps',
  'search_metaids',
  'search_metaweb',
  'search_preference_comparisons',
  'search_qa',
  'search_social_posts',
  'social_post_comments',
  'social_post_detail',
]);

const DOMAIN_DEFAULT_SPEC: Record<ToolDomain, ToolCapabilitySpec> = {
  core: { domain: 'core' },
  studio_projector: { domain: 'studio_projector', desktopOnly: true },
  desktop_browser: { domain: 'desktop_browser', desktopOnly: true },
  desktop_native: { domain: 'desktop_native', desktopOnly: true },
  mobile_host: { domain: 'mobile_host', serverOnly: true },
  im: { domain: 'im', imOnly: true },
  browser_automation: { domain: 'browser_automation', expansion: 'automation' },
  worker_economy: { domain: 'worker_economy', expansion: 'workerEconomy' },
  financial: { domain: 'financial', expansion: 'financial' },
  social: { domain: 'social', expansion: 'social' },
  metaweb: { domain: 'metaweb', expansion: 'metaweb' },
  orchestration: { domain: 'orchestration', expansion: 'orchestration' },
  memory_advanced: { domain: 'memory_advanced', expansion: 'memoryAdvanced' },
};

const TOOLS_BY_DOMAIN: Record<Exclude<ToolDomain, 'browser_automation'>, readonly string[]> = {
  core: [
    // DSH runtime built-ins
    'bash',
    'read',
    'write',
    'edit',
    'multiedit',
    'notebookedit',
    'glob',
    'grep',
    'read_image',
    'web_search',
    'web_fetch',
    'ask_user_question',
    'exit_plan_mode',
    'todo_write',
    'list_agents',
    'interrupt_agent',
    // Always-on host inline tools
    'conversation_recall',
    'conversation_search',
    'recent_chats',
    'memory_user_edits',
    'skill_tool',
    'owner_update',
    'get_host_location',
    'metabot_getinfo',
    'intuition',
    // Media & Metafile tools
    'upload_file',
    'describe_image',
    'describe_video',
    'describe_audio',
    'media_info',
    'convert_media',
    'grab_video_frame',
    'check_metafile_route',
    // Basic read/progress task & longterm tools kept in Mobile core
    'task_list_active',
    'task_context_read',
    'task_get',
    'task_subtask_progress',
    'longterm_task_list',
    'longterm_task_get',
    'longterm_subtask_wait',
  ],

  studio_projector: [
    'browser_tabs',
    'projection_begin',
    'studio_decision_enqueue',
    'studio_decision_list',
    'studio_decision_resolve',
    'studio_decision_defer',
    'studio_presence_mark',
    'studio_task_focus',
    'twin_stamp_publish',
  ],

  desktop_browser: [
    'bot_browser_tabs',
    'bot_browser_open_uri',
    'bot_browser_preview_local',
    'bot_browser_read_page',
    'bot_browser_fork_current_app',
    'bot_browser_publish_app',
    'bot_browser_screenshot',
    'bot_browser_act',
    'browser_open',
  ],

  desktop_native: [
    'screenshot',
    'open_metaapp',
    'resolve_metaapp_url',
    'project_query',
  ],

  mobile_host: [
    'mobile_open_page',
  ],

  im: [
    'start_new_im_session',
  ],

  worker_economy: [
    'agentpedia_challenge',
    'agentpedia_constitution',
    'agentpedia_editor',
    'agentpedia_param_proposal',
    'agentpedia_rev',
    'agentpedia_review',
    'agentpedia_ruling',
    'escrow_order_act',
    'escrow_order_create',
    'escrow_order_info',
    'escrow_order_list',
    'escrow_tick',
    'metatask_amend',
    'metatask_claim',
    'metatask_get',
    'metatask_list',
    'metatask_publish',
    'metatask_publish_spec',
    'metatask_release',
    'metatask_replay',
    'metatask_submit',
    'metatask_verify',
    'post_metaprotocol',
    'prediction_record',
  ],

  financial: [
    'goods_accept_inquiry',
    'goods_buy_with_me',
    'goods_buy_with_token',
    'goods_holder_lookup',
    'goods_market_search',
    'goods_market_summary',
    'goods_send_inquiry',
    'me_charge',
    'mrc721_balance',
    'mrc721_buy',
    'mrc721_collection_create',
    'mrc721_collection_info',
    'mrc721_collection_update',
    'mrc721_collections',
    'mrc721_issue_estimate',
    'mrc721_item_desc_batch',
    'mrc721_item_info',
    'mrc721_market_intents',
    'mrc721_mint',
    'mrc721_offer',
    'mrc721_offer_cancel',
    'mrc721_offers',
    'mrc721_offers_market',
    'mrc721_search_collections',
    'mrc721_sell',
    'mrc721_sell_intent',
    'mrc721_sell_intent_cancel',
    'mrc721_sell_intents',
    'mrc721_sell_orders',
    'mrc721_take_offer',
    'mrc721_transfer',
    'mrc721_verify_holding',
    'nft_swap_order_status',
    'nft_swap_submit_batch',
    'nft_swap_verify_official_station',
    'payment_card_emit',
    'wallet_balance',
    'wallet_btc_broadcast',
    'wallet_btc_build_multisig_psbt',
    'wallet_btc_combine_psbts',
    'wallet_btc_finalize_psbt',
    'wallet_btc_multisig_address',
    'wallet_btc_pubkey',
    'wallet_btc_sign_psbt',
    'wallet_btc_utxos',
    'wallet_mrc20_balance',
    'wallet_nft_balance',
    'wallet_nft_buy',
    'wallet_nft_cancel_sell',
    'wallet_nft_sell',
    'wallet_nft_sell_orders',
    'wallet_nft_transfer',
    'wallet_token_balance',
    'wallet_token_bridge_card',
    'wallet_token_buy',
    'wallet_token_card',
    'wallet_token_cancel_sell',
    'wallet_token_my_orders',
    'wallet_token_portfolio',
    'wallet_token_issue',
    'wallet_token_issued_list',
    'wallet_token_mint',
    'wallet_token_sell',
    'wallet_token_sell_orders',
    'wallet_token_send',
    'wallet_token_take',
    'wallet_token_transfer',
    'wallet_transfer',
    'wallet_tx_status',
    'wallet_tx_verify',
  ],

  social: [
    'comment_pin',
    'group_chat',
    'im_send_message',
    'like_pin',
    'omni_cast',
    'post_buzz',
    'post_simpleanswer',
    'post_simplelog',
    'post_simplenote',
    'post_simplequestion',
    'request_user_permission',
    'send_private_chat',
  ],

  metaweb: [
    'check_peer_relationship',
    'get_question_answers',
    'list_latest_questions',
    'list_online_bots',
    'list_online_services',
    'list_social_connections',
    'metaid_profile',
    'metaprotocol_registry',
    'metaweb_pin_versions',
    'metaweb_qa_surf_disable',
    'metaweb_qa_surf_enqueue',
    'metaweb_study_enqueue',
    'metaweb_study_status',
    'metaweb_surf_start',
    'metaweb_surf_status',
    'omni_read',
    'read_metaweb_pin',
    'read_metaweb_pins_batch',
    'search_metaapps',
    'search_metaids',
    'search_metaweb',
    'search_preference_comparisons',
    'search_qa',
    'search_social_posts',
    'social_post_comments',
    'social_post_detail',
  ],

  orchestration: [
    // DSH subagent tools
    'subagent',
    'send_message',
    'list_subagent_models',
    // Scheduling & followups
    'create_scheduled_task',
    'followup_defer',
    'followup_enqueue',
    'followup_list',
    'followup_promote_to_task',
    'followup_reply_a2a',
    'followup_resolve',
    // Cross-session inspection/dispatch
    'idbots_session_insert_user_message',
    'idbots_session_read_all',
    'idbots_session_read_latest',
    // Worker delegation & Twin supervision
    'local_worker_delegate',
    'local_workers_list',
    'worker_session_stop',
    'twin_task_accept',
    'twin_task_cancel',
    'twin_task_reassign',
    'twin_task_status',
    'twin_todo',
    // Longterm task writes
    'longterm_delegation_anchor',
    'longterm_event_note',
    'longterm_subtask_accept',
    'longterm_subtask_add',
    'longterm_subtask_begin',
    'longterm_subtask_propose',
    'longterm_subtask_reject',
    'longterm_subtask_skip',
    'longterm_subtask_unblock',
    'longterm_subtask_update',
    'longterm_task_activate',
    'longterm_task_complete',
    'longterm_task_create',
    'longterm_task_quick_create',
    'longterm_task_update',
    // MetaBot management (Welcome Bot gets metabot_list + metabot_create via role grant)
    'metabot_create',
    'metabot_delete',
    'metabot_list',
    'metabot_update',
    // Preference rounds & lessons
    'preference_lesson_publish',
    'preference_lessons_search',
    'preference_round_open',
    'preference_round_status',
    'preference_rounds_list',
    'preference_vote_commit',
    // Managed task writes & search
    'task_create',
    'task_search',
    'task_subtask_accept',
    'task_subtask_propose',
    'task_subtask_submit',
  ],

  memory_advanced: [
    'chain_history_recall',
    'experience_recall',
    'knowledge_base_add_document',
    'knowledge_base_learn',
    'knowledge_base_list',
    'knowledge_base_query',
    'knowledge_recall',
    'knowledge_upsert',
    'procedure_archive',
    'procedure_recall',
    'procedure_save',
    'standing_pages',
  ],
};

const registryEntries = new Map<string, ToolCapabilitySpec>();
for (const [domain, names] of Object.entries(TOOLS_BY_DOMAIN) as Array<[Exclude<ToolDomain, 'browser_automation'>, readonly string[]]>) {
  const baseSpec = DOMAIN_DEFAULT_SPEC[domain];
  for (const name of names) {
    if (registryEntries.has(name)) {
      throw new Error(`Duplicate tool capability registration: "${name}"`);
    }
    const isReadOnly =
      (domain === 'worker_economy' && READ_ONLY_ECONOMY_TOOLS.has(name))
      || (domain === 'metaweb' && READ_ONLY_SOCIAL_METAWEB_TOOLS.has(name));
    registryEntries.set(name, isReadOnly ? { ...baseSpec, readOnly: true } : baseSpec);
  }
}

export const TOOL_CAPABILITY_REGISTRY: ReadonlyMap<string, ToolCapabilitySpec> = registryEntries;

/**
 * REQ-A-5: desktop-only agent tools derived directly from the capability
 * registry (`studio_projector`, `desktop_browser`, `desktop_native`).
 */
export const SERVER_MODE_DISABLED_AGENT_TOOLS: ReadonlySet<string> = new Set(
  [...TOOL_CAPABILITY_REGISTRY.entries()]
    .filter(([, spec]) => spec.desktopOnly === true)
    .map(([name]) => name),
);

const WELCOME_MOBILE_CORE_TOOLS: ReadonlySet<string> = new Set([
  'metabot_list',
  'metabot_create',
]);

export function getToolCapabilitySpec(toolName: string): ToolCapabilitySpec | null {
  const direct = TOOL_CAPABILITY_REGISTRY.get(toolName);
  if (direct) return direct;
  if (toolName.startsWith('mcp__playwright-mcp__')) {
    return DOMAIN_DEFAULT_SPEC.browser_automation;
  }
  return null;
}

export function isToolAllowedForHostEnv(toolName: string, hostEnv: HostEnv): boolean {
  const spec = getToolCapabilitySpec(toolName);
  if (!spec) return hostEnv === 'desktop';
  if (hostEnv === 'server' && spec.desktopOnly) return false;
  if (hostEnv === 'desktop' && spec.serverOnly) return false;
  return true;
}

const MOBILE_TOOL_PATTERNS: Record<MobileToolExpansion, RegExp> = {
  workerEconomy: /\b(?:metatask|agentpedia|escrow|prediction_record|metaprotocol|group[_ -]?task)\b|群任务|托管订单|预测账本|元协议|竞赛任务/i,
  financial: /(?:^|[\s(（])\$[A-Za-z][A-Za-z0-9_-]{1,15}\b|\b(?:wallet|btc|space|doge|mrc20|idcoin|id-coin|mrc721|nft|token|tokens|issue|mint|bridge|payment|multisig|goods)\b|钱包|转账|余额|持仓|比特币|代币|币价|行情|市值|地板价|涨幅|挂单|撤单|跨链|资产桥|发币|铸造|增发|支付|付款|收款|充值|积分|手续费|矿工费|商品/i,
  social: /\b(?:buzz|simpleqa|simplequestion|simplenote|simplelog|omni_cast|group[_ -]?chat|private[_ -]?chat)\b|动态|私聊|群聊|问答|笔记|日志|点赞|评论|发帖|发文章|发短文|发长文|好友|关注|转发/i,
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

/**
 * Apply semantic Cerebellum mobile-intent verdicts when available, preserving
 * sticky prior expansions, and fall back to regex heuristics (`resolveMobileToolExpansions`)
 * whenever `cerebellumExpanded` is null or undefined.
 */
export function applyMobileToolExpansionVerdict(
  previous: readonly MobileToolExpansion[] | undefined,
  prompt: string,
  cerebellumExpanded: readonly MobileToolExpansion[] | null | undefined,
): MobileToolExpansion[] {
  if (cerebellumExpanded !== null && cerebellumExpanded !== undefined) {
    const next = new Set(previous ?? []);
    for (const expansion of cerebellumExpanded) {
      if (MOBILE_TOOL_EXPANSIONS.includes(expansion)) {
        next.add(expansion);
      }
    }
    return MOBILE_TOOL_EXPANSIONS.filter((expansion) => next.has(expansion));
  }
  return resolveMobileToolExpansions(previous, prompt);
}

export interface ReadOnlyToolMountPolicy {
  readonly economyRead: boolean;
  readonly socialRead: boolean;
}

/**
 * Read-only verification surface policy (P2-1):
 * Studio Twin front-office blocks heavy write/production domains (`workerEconomy`,
 * `social`) while keeping read-only verification tools (`economy_read` for
 * MetaTask/Escrow status checks and `social_read` for MetaWeb/social lookups)
 * open for supervisory inspection.
 */
export function resolveReadOnlyToolMountPolicy(
  profile: Pick<ConversationProfile, 'isStudioOwnerChat' | 'isMobileOwnerChat'>,
  expansions: readonly MobileToolExpansion[],
): ReadOnlyToolMountPolicy {
  return {
    economyRead: !profile.isMobileOwnerChat || expansions.includes('workerEconomy'),
    socialRead: !profile.isMobileOwnerChat || expansions.includes('metaweb') || expansions.includes('social'),
  };
}

export function resolveToolMountPolicy(
  profile: Pick<ConversationProfile, 'isStudioOwnerChat' | 'isMobileOwnerChat'>,
  expansions: readonly MobileToolExpansion[],
): Record<MobileToolExpansion, boolean> {
  const effectiveStudioOwnerChat = profile.isStudioOwnerChat && !profile.isMobileOwnerChat;
  return {
    workerEconomy: !effectiveStudioOwnerChat && (!profile.isMobileOwnerChat || expansions.includes('workerEconomy')),
    financial: !profile.isMobileOwnerChat || expansions.includes('financial'),
    social: !effectiveStudioOwnerChat && (!profile.isMobileOwnerChat || expansions.includes('social')),
    metaweb: !profile.isMobileOwnerChat || expansions.includes('metaweb'),
    orchestration: !profile.isMobileOwnerChat || expansions.includes('orchestration'),
    memoryAdvanced: !profile.isMobileOwnerChat || expansions.includes('memoryAdvanced'),
    automation: !profile.isMobileOwnerChat || expansions.includes('automation'),
  };
}

/**
 * Fail-closed tool visibility gate for Cloud Mobile owner chats.
 * Any tool not declared in `TOOL_CAPABILITY_REGISTRY` (or Playwright MCP)
 * returns `false` so newly added tools never leak onto the mobile core surface.
 */
export function isMobileToolVisible(
  toolName: string,
  expansions: readonly MobileToolExpansion[],
  options?: { executionRole?: ExecutionRole },
): boolean {
  const spec = getToolCapabilitySpec(toolName);
  if (!spec) return false;
  if (spec.desktopOnly || spec.imOnly) return false;
  if (spec.domain === 'core' || spec.domain === 'mobile_host') return true;
  if (options?.executionRole === 'welcome' && WELCOME_MOBILE_CORE_TOOLS.has(toolName)) {
    return true;
  }
  if (spec.expansion) {
    return expansions.includes(spec.expansion);
  }
  return false;
}
