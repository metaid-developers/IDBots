import { chatCompletionWithTools, type ChatCompletionOptions, type ChatCompletionResult, type ChatMessage } from './cognitiveChatCompletion';
import type { LiveStageState } from './studioLiveStageModel';

export type LiveStageDirectorScene = Pick<LiveStageState, 'headline' | 'caption' | 'composition' | 'motif' | 'motion'>;
export type LiveStageDirectorUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMs: number;
};

export type LiveStageDirectorResult = {
  scene: LiveStageDirectorScene;
  usage: LiveStageDirectorUsage;
};

const DIRECTOR_SYSTEM_PROMPT = `You are the visual director for IDBots Studio. You receive a small, trusted semantic scene, never the primary agent's full transcript or raw reasoning. Return ONE JSON object only, with no markdown and no explanation.

You may change only headline, caption, composition, motif, and motion. You cannot change task facts, participants, family, topology, completion, errors, or report readiness. Never invent workers, sources, dependencies, results, percentages, or deadlines. Keep the current Bot's presence continuous and make the variation feel alive within the given scene.

Schema:
{
  "headline": "short plain-language headline, max 80 characters",
  "caption": "one factual sentence, max 240 characters",
  "composition": "presence | gather | topology | converge | ready",
  "motif": "liquid | gather | orbit | proof-loop | projection | rest",
  "motion": {
    "preset": "short-safe-motion-name",
    "seed": 1000,
    "durationMs": 720,
    "easing": "emphasized-decelerate | gentle-spring | smooth-in-out",
    "energy": 0.4,
    "density": 0.3
  }
}

Structured topology must stay topology or converge. Presence scenes cannot become topology. Report-ready and complete must use ready. Match the requested language exactly. Keep motion tasteful and readable, with energy and density between 0 and 1, duration 200-2000 ms, and seed 1000-99999.`;

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Director response did not contain a JSON object');
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Director response was not a JSON object');
  return parsed as Record<string, unknown>;
}

export function validateLiveStageDirectorScene(content: string, state: LiveStageState): LiveStageDirectorScene {
  const value = parseJsonObject(content);
  if (typeof value.headline !== 'string' || !value.headline.trim() || value.headline.length > 80) throw new Error('Invalid director headline');
  if (typeof value.caption !== 'string' || !value.caption.trim() || value.caption.length > 240) throw new Error('Invalid director caption');
  const composition = String(value.composition || '');
  if (!['presence', 'gather', 'topology', 'converge', 'ready'].includes(composition)) throw new Error('Invalid director composition');
  if (state.topology.mode === 'structured' && !['topology', 'converge'].includes(composition)) throw new Error('Director removed structured topology');
  if (state.topology.mode !== 'structured' && composition === 'topology') throw new Error('Director invented topology');
  if (state.family === 'report-ready' || state.family === 'complete') {
    if (composition !== 'ready') throw new Error('Director changed the terminal composition');
  } else if (composition === 'ready') throw new Error('Director invented terminal readiness');
  const motif = String(value.motif || '');
  if (!['liquid', 'gather', 'orbit', 'proof-loop', 'projection', 'rest'].includes(motif)) throw new Error('Invalid director motif');
  const motion = value.motion;
  if (!motion || typeof motion !== 'object' || Array.isArray(motion)) throw new Error('Invalid director motion');
  const m = motion as Record<string, unknown>;
  const preset = typeof m.preset === 'string' ? m.preset.trim() : '';
  if (!/^[a-z0-9-]{2,40}$/.test(preset)) throw new Error('Invalid director motion preset');
  const seed = Number(m.seed);
  const durationMs = Number(m.durationMs);
  const energy = Number(m.energy);
  const density = Number(m.density);
  const easing = String(m.easing || '');
  if (!Number.isInteger(seed) || seed < 1000 || seed > 99999) throw new Error('Invalid director seed');
  if (!Number.isFinite(durationMs) || durationMs < 200 || durationMs > 2000) throw new Error('Invalid director duration');
  if (!Number.isFinite(energy) || energy < 0 || energy > 1 || !Number.isFinite(density) || density < 0 || density > 1) throw new Error('Invalid director energy or density');
  if (!['emphasized-decelerate', 'gentle-spring', 'smooth-in-out'].includes(easing)) throw new Error('Invalid director easing');
  return {
    headline: value.headline.trim(),
    caption: value.caption.trim(),
    composition: composition as LiveStageState['composition'],
    motif,
    motion: { preset, seed, durationMs, easing, energy, density },
  };
}

export async function directLiveStageScene(
  state: LiveStageState,
  brain: Pick<ChatCompletionOptions, 'llmId' | 'llmProvider' | 'fallbackLlmId' | 'fallbackLlmProvider'>,
  complete: (messages: ChatMessage[], options: ChatCompletionOptions) => Promise<ChatCompletionResult> = chatCompletionWithTools,
  now: () => number = Date.now,
): Promise<LiveStageDirectorResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({
      language: state.language,
      currentScene: {
        family: state.family,
        headline: state.headline,
        caption: state.caption,
        composition: state.composition,
        motif: state.motif,
        participants: state.participants,
        topology: {
          mode: state.topology.mode,
          nodes: state.topology.nodes.map(({ id, label, kind }) => ({ id, label, kind })),
          edges: state.topology.edges,
        },
      },
      recentEvents: state.eventWindow,
      instruction: state.language === 'zh' ? '仅使用中文输出标题和说明。保留事实，只创造视觉表现。' : 'Write the headline and caption in English. Preserve facts and vary only the presentation.',
    }) },
  ];
  const startedAt = now();
  const result = await complete(messages, {
    ...brain,
    effort: 'off',
    maxTokens: 700,
    temperature: .75,
    webSearch: false,
    attemptTimeoutMs: 9000,
    throwOnEmptyContent: true,
  });
  const content = result.content?.trim();
  if (!content) throw new Error('Director returned an empty scene');
  const scene = validateLiveStageDirectorScene(content, state);
  const metadata = result.responseMetadata;
  return {
    scene,
    usage: {
      inputTokens: Math.max(0, metadata?.inputTokens ?? 0),
      outputTokens: Math.max(0, metadata?.outputTokens ?? 0),
      cacheReadTokens: Math.max(0, metadata?.cacheReadTokens ?? 0),
      cacheCreationTokens: Math.max(0, metadata?.cacheCreationTokens ?? 0),
      latencyMs: Math.max(0, now() - startedAt),
    },
  };
}
