/**
 * IM platform → Redux config-action registry.
 *
 * This mapping used to be written inline, twice, inside IMSettings.tsx:
 *
 *   const setConfigAction = { dingtalk: ..., feishu: ..., telegram: ...,
 *                             discord: ..., weixin: ... }[platform];
 *
 * Nothing tied that object literal to the `IMPlatform` union, so any platform
 * missing from it evaluated to `undefined` and `dispatch(undefined(...))` threw
 * `TypeError: setConfigAction is not a function` before the gateway could ever
 * start. QQ was in exactly that state: the enable switch looked clickable,
 * rendered a QR code from a previous run, and did nothing.
 *
 * Keeping the registry here with `satisfies Record<IMPlatform, unknown>` makes
 * a missing platform a compile error instead of a runtime crash, and gives the
 * renderer a single place to look for platform-action wiring.
 */
import type { IMPlatform } from '../../types/im';
import {
  setDingTalkConfig,
  setDiscordConfig,
  setFeishuConfig,
  setQQConfig,
  setTelegramConfig,
  setWeixinConfig,
} from '../../store/slices/imSlice';

/**
 * Canonical runtime platform list. `satisfies readonly IMPlatform[]` keeps the
 * array honest against the type; the registry below must cover every entry.
 */
export const IM_PLATFORM_LIST = [
  'dingtalk',
  'feishu',
  'telegram',
  'discord',
  'weixin',
  'qq',
] as const satisfies readonly IMPlatform[];

const platformConfigActions = {
  dingtalk: setDingTalkConfig,
  feishu: setFeishuConfig,
  telegram: setTelegramConfig,
  discord: setDiscordConfig,
  weixin: setWeixinConfig,
  qq: setQQConfig,
} satisfies Record<IMPlatform, unknown>;

export type PlatformConfigAction = (typeof platformConfigActions)[IMPlatform];

/**
 * Returns the config action creator for `platform`.
 *
 * Never returns `undefined`: the registry is exhaustive over `IMPlatform` at the
 * type level, and every platform in `IM_PLATFORM_LIST` has a regression test.
 */
export const getPlatformConfigAction = (platform: IMPlatform): PlatformConfigAction =>
  platformConfigActions[platform];
