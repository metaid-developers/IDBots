/**
 * Owner-facing copy for a failed cowork turn. Pure module — the renderer will
 * import it later, so no node/electron imports are allowed here.
 *
 * `describeStudioTurnError` maps a raw runtime error string to a short reason
 * plus a recovery hint, first matching rule wins. Everything returned is
 * already localized; callers only join reason + hint.
 */
export type StudioTurnErrorCopy = {
  reason: string;
  hint: string;
};

type StudioTurnErrorRule = {
  pattern: RegExp;
  zh: StudioTurnErrorCopy;
  en: StudioTurnErrorCopy;
};

const RULES: StudioTurnErrorRule[] = [
  {
    pattern: /free_quota_exhausted|quota|insufficient[_ ]?(balance|quota)|余额|402/i,
    zh: { reason: '模型的免费额度用完了', hint: '换个模型或晚点再试；说「继续」我就接着做。' },
    en: { reason: "The model's free quota is used up", hint: 'Switch models or try later; say “continue” and I\'ll pick it up.' },
  },
  {
    pattern: /429|rate.?limit|too many requests/i,
    zh: { reason: '模型服务太忙，被限流了', hint: '稍等一会儿再说「继续」。' },
    en: { reason: 'The model service is busy and rate-limited', hint: 'Wait a moment, then say “continue”.' },
  },
  {
    pattern: /compaction|context window|context length|maximum context|too long/i,
    zh: { reason: '对话太长，整理上下文时出了问题', hint: '可以新开一个对话，或说「继续」让我再试一次。' },
    en: { reason: 'The conversation grew too long and context compaction failed', hint: 'Start a new conversation, or say “continue” and I\'ll try again.' },
  },
  {
    pattern: /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|fetch failed|socket/i,
    zh: { reason: '网络连接断了', hint: '说「继续」我就接着做。' },
    en: { reason: 'The network connection dropped', hint: 'Say “continue” and I\'ll pick it up.' },
  },
  {
    pattern: /\b401\b|\b403\b|unauthori[sz]ed|invalid api key|authentication/i,
    zh: { reason: '模型服务的登录凭证失效了', hint: '请到设置里检查模型配置。' },
    en: { reason: 'The model service credentials expired', hint: 'Check the model configuration in Settings.' },
  },
];

const FALLBACK: Record<'zh' | 'en', StudioTurnErrorCopy> = {
  zh: { reason: '运行时出了点问题', hint: '说「继续」我就接着做。' },
  en: { reason: 'Something went wrong at runtime', hint: 'Say “continue” and I\'ll pick it up.' },
};

export function describeStudioTurnError(error: string, language: 'zh' | 'en'): StudioTurnErrorCopy {
  const value = typeof error === 'string' ? error : '';
  for (const rule of RULES) {
    if (rule.pattern.test(value)) return rule[language];
  }
  return FALLBACK[language];
}
