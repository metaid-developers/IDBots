export function getDefaultOnboardingProvider(language) {
  return language === 'zh' ? 'deepseek' : 'openai';
}
