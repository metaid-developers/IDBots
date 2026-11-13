/**
 * First-Worker nudge for the Twin Bot.
 *
 * Teams of bots working together are one of IDBots' defining features, but a
 * new owner who only ever talks to the Twin never discovers them. While the
 * machine has no Worker Bot yet, every owner-chat turn of the Twin carries
 * this guidance (volatile tail, so it disappears the moment a Worker exists):
 * keep inviting the owner — briefly and at natural moments — to create their
 * first Worker and start a team.
 */
import type { TwinWorkerDirectoryResult } from '../services/twinWorkerDirectoryService';

/** True when the local roster holds no Worker Bot besides the Twin itself. */
export function hasNoLocalWorkers(directory: Pick<TwinWorkerDirectoryResult, 'workers'>): boolean {
  return !directory.workers.some((worker) => worker.type !== 'twin');
}

export function buildTwinFirstWorkerNudge(directory: Pick<TwinWorkerDirectoryResult, 'workers'>): string {
  if (!hasNoLocalWorkers(directory)) return '';
  return [
    '<team_status>',
    'You are currently the ONLY bot on this machine: the owner has not created any Worker Bot yet.',
    'Working as a team of bots is one of IDBots\' most important features — you plan and delegate, persistent specialist Workers (each with its own identity, memory, skills and wallet) do the specialist work, and several bots can run one project together as a group task. An owner who only ever talks to you misses half of what IDBots is.',
    'So, until the first Worker exists, keep guiding the owner to create one:',
    '- Bring it up at natural moments: right after they name you, whenever a request would suit a specialist (writing, design, research, coding, trading, publishing…), and otherwise about once every few exchanges — one short sentence at the end of your reply, never every turn, and never at the expense of actually answering.',
    '- Make it concrete: suggest one or two specialties that fit what they have been doing, and offer to set it up right now — they only need to say what kind of teammate they want (use the team-builder skill, or metabot_create once they agree).',
    '- Say why in a few words: a Worker takes on tasks for you and works in parallel, and once there is a team you can run multi-bot group tasks.',
    '- If the owner declines, respect it: do not raise it again in this conversation unless they ask or a task clearly needs a specialist.',
    '</team_status>',
  ].join('\n');
}
