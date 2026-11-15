import type { CoworkConfig, CoworkStartOptions } from '../types/cowork';

export interface CoworkBotSelection {
  id: number;
  metabot_type?: string | null;
}

export function resolveDefaultMetabotId<T extends CoworkBotSelection>(
  bots: T[],
  selectedId: number | null,
): number | null {
  if (selectedId !== null && bots.some((bot) => bot.id === selectedId)) return selectedId;
  const twin = bots.find((bot) => bot.metabot_type === 'twin');
  return twin?.id ?? bots[0]?.id ?? null;
}

export function resolveTwinOnlyMetabotId<T extends CoworkBotSelection>(
  bots: T[],
): number | null {
  const twin = bots.find((bot) => bot.metabot_type === 'twin');
  return twin?.id ?? bots[0]?.id ?? null;
}

export function buildCoworkSessionStartOptions(input: {
  metabotId: number;
  title: string;
  config?: Pick<CoworkConfig, 'workingDirectory' | 'systemPrompt'> | null;
}): Omit<CoworkStartOptions, 'prompt'> {
  const cwd = input.config?.workingDirectory?.trim();
  const systemPrompt = input.config?.systemPrompt?.trim();
  return {
    metabotId: input.metabotId,
    title: input.title,
    ...(cwd ? { cwd } : {}),
    ...(systemPrompt ? { systemPrompt: input.config!.systemPrompt } : {}),
  };
}
