function normalizeMetabotCount(metabotCount) {
  return Number.isFinite(metabotCount) && metabotCount > 0 ? Math.floor(metabotCount) : 0;
}

export function shouldShowInitialOnboarding(metabotCount) {
  return normalizeMetabotCount(metabotCount) === 0;
}

export function shouldRouteFirstMetabotCreationToOnboarding(metabotCount) {
  return normalizeMetabotCount(metabotCount) === 0;
}

export function shouldShowOnboardingClose({
  hasCloseHandler,
  step,
  running,
  awakeningComplete,
}) {
  if (!hasCloseHandler) {
    return false;
  }
  return !(step === 3 && running && !awakeningComplete);
}

export function getOnboardingCloseButtonClassName() {
  return [
    'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors',
    'bg-white text-slate-700 border-slate-300 shadow-sm hover:bg-slate-100 hover:text-slate-900',
    'dark:border-white/15 dark:bg-white/10 dark:text-white/80 dark:shadow-none dark:hover:bg-white/15 dark:hover:text-white',
  ].join(' ');
}
