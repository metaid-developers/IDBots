import { z } from 'zod';
import { sha256Hex } from '../services/metatask/canon';
import type { MetaTaskTaskProjection } from '../services/metatask/types';
import { ARTIFACT_RE, PILOT_CANDIDATE_CAP, REVEAL_DELAY_SEC } from '../services/preference/constants';
import { checkBallot } from '../services/preference/schemas';
import type { PreferenceRoundView, PreferenceService, PreferenceSigner } from '../services/preference/service';
import type {
  BallotPair,
  JudgeClass,
  JudgeKind,
  PreferenceChainEvent,
  RoundBody,
  RoundCandidate,
} from '../services/preference/types';

export type CandidateDerivation = { ok: true; candidates: RoundCandidate[] } | { ok: false; reason: string };

const byteCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function candidatesFromMetaTaskNode(
  detail: MetaTaskTaskProjection,
  node: string,
  cap: number = PILOT_CANDIDATE_CAP,
): CandidateDerivation {
  const nodeState = detail.nodeStates[node];
  if (!nodeState) return { ok: false, reason: `preference:node-not-found:${node}` };
  const eligible = (nodeState.submissions ?? [])
    .filter(
      (submission) =>
        submission.chainValid &&
        submission.verified &&
        !submission.failed &&
        !submission.superseded &&
        typeof submission.attachment === 'string' &&
        ARTIFACT_RE.test(submission.attachment),
    )
    .sort(
      (a, b) =>
        (a.verifiedHeight ?? 0) - (b.verifiedHeight ?? 0) ||
        (a.verifiedTxIndex ?? 0) - (b.verifiedTxIndex ?? 0) ||
        byteCompare(a.pinId, b.pinId),
    );
  if (eligible.length < 2) return { ok: false, reason: `preference:too-few-candidates:${eligible.length}` };
  const chosen = eligible.slice(0, cap).sort((a, b) => byteCompare(a.pinId, b.pinId));
  return {
    ok: true,
    candidates: chosen.map((submission, index) => ({
      id: `c${index + 1}`,
      ref: submission.pinId,
      artifact: String(submission.attachment),
      author: submission.submitter,
    })),
  };
}

export function judgePairOrder(judge: string, roundPinId: string, round: RoundBody): { a: string; b: string }[] {
  const ids = round.candidates
    .filter((candidate) => candidate.author !== judge)
    .map((candidate) => candidate.id)
    .sort(byteCompare);
  const pairs: { a: string; b: string; key: string }[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const key = sha256Hex(`${roundPinId}|${judge}|${ids[i]}|${ids[j]}`);
      const swap = Number.parseInt(key.slice(0, 1), 16) % 2 === 1;
      pairs.push({ a: swap ? ids[j] : ids[i], b: swap ? ids[i] : ids[j], key });
    }
  }
  return pairs.sort((x, y) => byteCompare(x.key, y.key)).map(({ a, b }) => ({ a, b }));
}

/**
 * Preference agent tools: the session bot's surface for /protocols/preference
 * (docs/metaid_protocols/09-preference.md). Writes go through
 * PreferenceService, which owns salts, windows, and writer-side refusals.
 *
 * Judge independence: views never show candidate authors, never show another
 * local judge's sealed ballot, and show ballot reasons only after the commit
 * window has closed.
 */

type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: never) => Promise<unknown>,
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

const refuse = (reason: string) => textResult(`Refused: ${reason}`, true);

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface PreferenceAgentControl {
  service: () => PreferenceService;
  resolveGlobalMetaId: (metabotId: number) => string | null;
  metataskDetail: (rootPinId: string) => MetaTaskTaskProjection | null;
  refreshMetaTask: (reason: string, options?: { bypassCache?: boolean }) => Promise<{ ok: boolean; error: string | null }>;
}

interface JudgeRole {
  listed: boolean;
  kind: JudgeKind | null;
  class: JudgeClass;
}

interface RevealReason {
  reveal: string;
  judgeKind: JudgeKind | 'public';
  judgeClass: JudgeClass;
  pairs: BallotPair[];
  note: string | null;
}

const judgeRole = (round: RoundBody, me: string | null): JudgeRole => {
  const entry = me ? round.judges.find((judge) => judge.id === me) : undefined;
  if (!entry) return { listed: false, kind: null, class: 'public' };
  return { listed: true, kind: entry.kind, class: round.decision.kinds.includes(entry.kind) ? 'deciding' : 'shadow' };
};

const revealReasons = (events: readonly PreferenceChainEvent[], view: PreferenceRoundView): RevealReason[] => {
  if (!view.tally) return [];
  const byReveal = new Map(view.tally.output.judges.map((judge) => [judge.reveal, judge] as const));
  return view.tally.output.evidence.flatMap((revealPinId) => {
    const event = events.find((candidate) => candidate.path === 'reveal' && candidate.pinId === revealPinId);
    const judge = byReveal.get(revealPinId);
    if (!event || !judge) return [];
    const parsed = checkBallot(event.body.ballot, view.round);
    if (parsed.ok === false) return [];
    return [
      {
        reveal: revealPinId,
        judgeKind: judge.kind,
        judgeClass: judge.class,
        pairs: parsed.value.pairs,
        note: parsed.value.note ?? null,
      },
    ];
  });
};

const roundStatusView = (view: PreferenceRoundView, events: readonly PreferenceChainEvent[], me: string | null) => {
  const output = view.tally?.output ?? null;
  const collecting = output ? output.status === 'collecting' : !view.confirmed;
  const winner = output?.winner ?? null;
  const winnerCandidate = winner ? view.round.candidates.find((candidate) => candidate.id === winner) : undefined;
  return {
    roundPinId: view.pinId,
    confirmed: view.confirmed,
    title: view.round.title,
    brief: view.round.brief ?? '',
    category: view.round.category,
    subject: view.round.subject ?? null,
    windows: {
      commitCloseAt: view.round.commitCloseAt,
      revealsFrom: view.round.commitCloseAt + REVEAL_DELAY_SEC,
      revealCloseAt: view.round.revealCloseAt,
    },
    decision: view.round.decision,
    dimensions: view.round.dimensions,
    tasks: view.round.tasks,
    candidates: view.round.candidates.map((candidate) => ({
      id: candidate.id,
      artifact: candidate.artifact,
      own: me !== null && candidate.author === me,
    })),
    myRole: judgeRole(view.round, me),
    pairsToJudge: me && collecting ? judgePairOrder(me, view.pinId, view.round) : [],
    myBallots: view.localBallots
      .filter((row) => me !== null && row.judgeGlobalMetaId === me)
      .map((row) => ({
        id: row.id,
        status: row.status,
        commitPinId: row.commitPinId,
        revealPinId: row.revealPinId,
        lastError: row.lastError,
      })),
    status: output?.status ?? 'pending',
    tallyError: view.tallyError,
    winner,
    winnerRef: winnerCandidate?.ref ?? null,
    winnerArtifact: winnerCandidate?.artifact ?? null,
    tallyHash: view.tally?.tallyHash ?? null,
    ranking: output?.ranking ?? [],
    ballots: output?.ballots ?? null,
    judges: (output?.judges ?? []).map((judge) => ({
      kind: judge.kind,
      class: judge.class,
      pairs: judge.pairs,
      agreementBP: judge.agreementBP,
      reveal: judge.reveal,
      isMe: judge.id === me,
    })),
    dimensionPoints: output?.dimensions ?? {},
    evidence: output?.evidence ?? [],
    reasons: collecting ? [] : revealReasons(events, view),
    lesson: view.lesson,
  };
};

interface RoundsListArgs {
  mine?: boolean;
  taskRootPinId?: string;
  refresh?: boolean;
}

interface SubjectArg {
  rootPinId: string;
  node: string;
}

interface RoundStatusArgs {
  roundPinId?: string;
  subject?: SubjectArg;
  lessonPinId?: string;
  refresh?: boolean;
}

interface LessonsSearchArgs {
  category?: string[];
  limit?: number;
  refresh?: boolean;
}

interface CandidateArg {
  id: string;
  ref: string;
  artifact: string;
  author: string;
}

interface RoundOpenArgs {
  title: string;
  brief?: string;
  category: string[];
  subject?: SubjectArg;
  candidates?: CandidateArg[];
  judges: { globalMetaId: string; kind: JudgeKind }[];
  decisionKinds?: JudgeKind[];
  minBallots: number;
  dimensions?: { id: string; label: string }[];
  tasks?: string[];
  commitHours: number;
  revealHours: number;
}

interface VoteCommitArgs {
  roundPinId: string;
  pairs: BallotPair[];
  note?: string;
}

interface LessonPrincipleArg {
  text: string;
  conditions: string;
  uncertainty?: string;
  evidence: string[];
}

interface LessonPublishArgs {
  roundPinId: string;
  summary: string;
  principles: LessonPrincipleArg[];
  category?: string[];
  rejected?: string[];
}

const pickSchema = z.enum(['a', 'b', 'tie']);

export function buildPreferenceAgentTools(deps: {
  tool: SdkToolFactory;
  control: PreferenceAgentControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
  nowMs?: () => number;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId } = deps;

  const sessionBot = (): { metabotId: number; globalMetaId: string } | { error: string } => {
    const metabotId = resolveMetabotId(sessionId);
    if (metabotId === undefined) return { error: 'preference:no-session-bot' };
    const globalMetaId = control.resolveGlobalMetaId(metabotId);
    if (!globalMetaId) return { error: 'METABOT_IDENTITY_MISSING' };
    return { metabotId, globalMetaId };
  };

  const sessionGlobalMetaId = (): string | null => {
    const bot = sessionBot();
    return 'error' in bot ? null : bot.globalMetaId;
  };

  const nowMs = deps.nowMs ?? (() => Date.now());

  const signerOf = (metabotId: number): PreferenceSigner => ({ type: 'metabot', metabotId });

  const roundsList = tool(
    'preference_rounds_list',
    'List preference rounds (/protocols/preference) from the local chain cache, newest first: round pinId, title, status (collecting / revealing / settling / decided / no_decision, or pending while the round pin is unconfirmed), winner, category, MetaTask subject, and windows. mine=true keeps rounds that list YOU as a judge and reports your judge kind. Read-only.',
    {
      mine: z.boolean().optional().describe('Only rounds where the session bot is a listed judge.'),
      taskRootPinId: z.string().optional().describe('Only rounds whose subject is this MetaTask root pinId.'),
      refresh: z.boolean().optional().describe('Sweep the chain pools first (slower, fresher).'),
    },
    async (args: RoundsListArgs) => {
      try {
        const service = control.service();
        if (args.refresh) await service.refresh('preference_rounds_list', { bypassCache: true });
        let judge: string | undefined;
        if (args.mine) {
          const bot = sessionBot();
          if ('error' in bot) return refuse(bot.error);
          judge = bot.globalMetaId;
        }
        const rounds = service.listRounds({ judge, taskid: args.taskRootPinId });
        return jsonResult({
          rounds: rounds.map((entry) => ({
            roundPinId: entry.pinId,
            title: entry.title,
            status: entry.status,
            winner: entry.winner,
            confirmed: entry.confirmed,
            category: entry.category,
            subject: entry.subject,
            candidateCount: entry.candidateCount,
            commitCloseAt: entry.commitCloseAt,
            revealCloseAt: entry.revealCloseAt,
            myRole: judge ? entry.judges.find((listed) => listed.id === judge)?.kind ?? null : null,
          })),
        });
      } catch (error) {
        return textResult(`Failed to list preference rounds: ${errorOf(error)}`, true);
      }
    },
  );

  const roundStatus = tool(
    'preference_round_status',
    'Read one preference round and its deterministic tally. Pass roundPinId, or subject {rootPinId, node} to resolve the canonical round of a MetaTask node (protocol §7: the earliest valid round by the task root author that did not end no_decision). Returns windows, candidates (id + artifact URI + whether it is yours; builder identities are hidden), your judge role, pairsToJudge (your stable pair order while commits are open; own candidates excluded), your own ballot statuses, status, ranking, winner + winnerRef + winnerArtifact, tallyHash (final only), per-judge agreement, evidence reveal pinIds, and — only after the commit window closed — the evidence ballots\' pairs and reasons for lesson distillation. With lessonPinId it also reports whether that lesson is valid for the round. Read-only.',
    {
      roundPinId: z.string().optional(),
      subject: z.object({ rootPinId: z.string().min(1), node: z.string().min(1) }).optional(),
      lessonPinId: z.string().optional().describe('Also validate this lesson pin against the round.'),
      refresh: z.boolean().optional(),
    },
    async (args: RoundStatusArgs) => {
      try {
        const service = control.service();
        if (args.refresh) await service.refresh('preference_round_status', { bypassCache: true });
        let roundPinId = args.roundPinId;
        let canonical: 'decided' | 'pending' | null = null;
        if (!roundPinId && args.subject) {
          const detail = control.metataskDetail(args.subject.rootPinId);
          if (!detail) return refuse(`preference:task-not-found:${args.subject.rootPinId}`);
          const resolution = service.canonicalRound({
            taskid: args.subject.rootPinId,
            node: args.subject.node,
            rootAuthor: detail.publisher,
          });
          if (resolution.state === 'none') {
            return jsonResult({
              canonical: 'none',
              note: 'No canonical round yet: the task author has not opened one for this node, or every round ended no_decision.',
            });
          }
          roundPinId = resolution.roundPinId;
          canonical = resolution.state;
        }
        if (!roundPinId) return refuse('preference:round-required (pass roundPinId or subject)');
        let view = service.roundStatus(roundPinId, { lessonPinId: args.lessonPinId });
        if ('error' in view && !args.refresh) {
          await service.refresh('preference_round_status', { bypassCache: true });
          view = service.roundStatus(roundPinId, { lessonPinId: args.lessonPinId });
        }
        if ('error' in view) return refuse(view.error);
        return jsonResult({ ...roundStatusView(view, service.events(), sessionGlobalMetaId()), canonical });
      } catch (error) {
        return textResult(`Failed to read the preference round: ${errorOf(error)}`, true);
      }
    },
  );

  const lessonsSearch = tool(
    'preference_lessons_search',
    'Search valid on-chain preference lessons (/protocols/preference/lesson), newest first. category matches by tag prefix: "ui" matches "ui:qa-community". Each lesson lists principles (text, conditions, uncertainty, evidence count), the preferred exemplar artifact (open it with bot_browser_open_uri), rejected artifacts, round size, and shadow AI agreement. Lessons are evidence-backed options, not orders: apply a principle only when its conditions match your app. Read-only.',
    {
      category: z.array(z.string()).max(8).optional().describe('Tag filters, e.g. ["ui:qa-community"] or ["ui"].'),
      limit: z.number().int().min(1).max(50).optional(),
      refresh: z.boolean().optional(),
    },
    async (args: LessonsSearchArgs) => {
      try {
        const service = control.service();
        if (args.refresh) await service.refresh('preference_lessons_search', { bypassCache: true });
        const lessons = service.searchLessons({ category: args.category, limit: args.limit });
        return jsonResult({
          usage:
            'Treat principles as options with conditions; prefer lessons with more deciding ballots; open preferredArtifact before designing; respect an explicit explorer assignment that tells you not to use lessons.',
          lessons: lessons.map((lesson) => {
            const view = service.roundStatus(lesson.roundPinId);
            const judges = 'error' in view || !view.tally ? [] : view.tally.output.judges;
            return {
              lessonPinId: lesson.pinId,
              roundPinId: lesson.roundPinId,
              roundTitle: lesson.roundTitle,
              author: lesson.author,
              publishedAt: new Date(lesson.timestampMs).toISOString(),
              category: lesson.category,
              summary: lesson.summary,
              principles: lesson.principles.map((principle) => ({
                text: principle.text,
                conditions: principle.conditions,
                uncertainty: principle.uncertainty,
                evidenceCount: principle.evidence.length,
              })),
              preferredArtifact: lesson.preferred.artifact,
              rejectedArtifacts: lesson.rejected.map((candidate) => candidate.artifact),
              roundSize: {
                candidates: 'error' in view ? null : view.round.candidates.length,
                decidingBallots: lesson.decidingBallots,
              },
              shadowAgreementBP: judges.filter((judge) => judge.class === 'shadow').map((judge) => judge.agreementBP),
            };
          }),
        });
      } catch (error) {
        return textResult(`Failed to search preference lessons: ${errorOf(error)}`, true);
      }
    },
  );

  const roundOpen = tool(
    'preference_round_open',
    'Open a blind preference round (/protocols/preference/round). Subject mode (MetaTask taste node): pass subject {rootPinId, node}; you must be the task root author; candidates are derived from the node — every chain-valid verified submission with a metaapp:// / pin:// / metafile:// attachment, capped at 6 by earliest verification — and explicit candidates are refused. Explicit mode (no subject): pass candidates. Judges are {globalMetaId, kind: human|ai}; decisionKinds (default ["human"]) decide, other listed kinds are shadow judges. Windows in hours from now: commit ≥ 2, reveal ≥ 1 (24 recommended). Spends one pin fee. Refused when the subject already has a decided or pending canonical round, or your earlier round for it is still unconfirmed.',
    {
      title: z.string().min(1).max(200),
      brief: z.string().max(4000).optional().describe('Markdown: what is judged, for whom, how to use the candidates.'),
      category: z.array(z.string()).min(1).max(8).describe('Lesson retrieval tags, e.g. ["ui:qa-community", "audience:human"].'),
      subject: z.object({ rootPinId: z.string().min(1), node: z.string().min(1).max(64) }).optional(),
      candidates: z
        .array(z.object({ id: z.string(), ref: z.string(), artifact: z.string(), author: z.string() }))
        .max(8)
        .optional()
        .describe('Explicit mode only.'),
      judges: z.array(z.object({ globalMetaId: z.string(), kind: z.enum(['human', 'ai']) })).min(1).max(32),
      decisionKinds: z.array(z.enum(['human', 'ai'])).min(1).max(2).optional(),
      minBallots: z.number().int().min(1).max(32),
      dimensions: z.array(z.object({ id: z.string(), label: z.string() })).max(6).optional(),
      tasks: z.array(z.string()).max(5).optional().describe('Concrete tasks a judge performs in each candidate.'),
      commitHours: z.number().int().min(2).max(336),
      revealHours: z.number().int().min(1).max(336),
    },
    async (args: RoundOpenArgs) => {
      try {
        const bot = sessionBot();
        if ('error' in bot) return refuse(bot.error);
        const service = control.service();
        let candidates: RoundCandidate[];
        let subject: { taskid: string; node: string } | undefined;
        if (args.subject) {
          if (args.candidates && args.candidates.length > 0) return refuse('preference:candidates-derived-from-subject');
          const taskid = args.subject.rootPinId;
          const node = args.subject.node;
          await control.refreshMetaTask('preference_round_open', { bypassCache: true });
          const detail = control.metataskDetail(taskid);
          if (!detail) return refuse(`preference:task-not-found:${taskid}`);
          if (detail.publisher !== bot.globalMetaId) {
            return refuse('preference:not-task-author (only the task root author opens the canonical round, protocol §7)');
          }
          await service.refresh('preference_round_open', { bypassCache: true });
          const canonical = service.canonicalRound({ taskid, node, rootAuthor: bot.globalMetaId });
          if (canonical.state !== 'none') return refuse(`preference:subject-round-${canonical.state}:${canonical.roundPinId}`);
          const unconfirmed = service
            .listRounds({ taskid })
            .find((entry) => !entry.confirmed && entry.author === bot.globalMetaId && entry.subject?.node === node);
          if (unconfirmed) return refuse(`preference:subject-round-unconfirmed:${unconfirmed.pinId}`);
          const derived = candidatesFromMetaTaskNode(detail, node);
          if (derived.ok === false) return refuse(derived.reason);
          candidates = derived.candidates;
          subject = { taskid, node };
        } else {
          if (!args.candidates || args.candidates.length === 0) return refuse('preference:candidates-required');
          candidates = args.candidates;
        }
        const commitCloseAt = Math.floor(nowMs() / 1000) + args.commitHours * 3600;
        const revealCloseAt = commitCloseAt + args.revealHours * 3600;
        const body = {
          title: args.title,
          ...(args.brief ? { brief: args.brief } : {}),
          category: args.category,
          ...(subject ? { subject } : {}),
          candidates,
          judges: args.judges.map((judge) => ({ id: judge.globalMetaId, kind: judge.kind })),
          decision: { kinds: args.decisionKinds ?? ['human'], minBallots: args.minBallots },
          ...(args.dimensions && args.dimensions.length > 0 ? { dimensions: args.dimensions } : {}),
          ...(args.tasks && args.tasks.length > 0 ? { tasks: args.tasks } : {}),
          commitCloseAt,
          revealCloseAt,
        };
        const result = await service.openRound(signerOf(bot.metabotId), body);
        if ('error' in result) return refuse(result.error);
        return jsonResult({
          roundPinId: result.pinId,
          commitCloseAt,
          revealCloseAt,
          candidates: candidates.map((candidate) => ({ id: candidate.id, ref: candidate.ref, artifact: candidate.artifact })),
          next: [
            'Announce the round with post_buzz (title, round pinId, deadline) so judges find it.',
            'AI judges: preference_round_status then preference_vote_commit (metaapp-preference-judge skill). Human judges: the IDBots compare panel.',
            'Reveals are automatic after the commit window closes; the tally is final 2 h after revealCloseAt.',
          ],
        });
      } catch (error) {
        return textResult(`Failed to open the preference round: ${errorOf(error)}`, true);
      }
    },
  );

  const voteCommit = tool(
    'preference_vote_commit',
    'Commit your sealed pairwise ballot to a preference round where you are a listed judge. Judge every pair in pairsToJudge from preference_round_status (never a pair with your own candidate); pick "a", "b", or "tie" with a concrete, observable reason (1..1000 chars); optional dims {dimensionId: a|b|tie}. Only a hash goes on-chain now; the host stores salt + ballot locally and publishes the reveal automatically after the commit window closes — keep IDBots running or reopen it before revealCloseAt. Re-committing before the cutoff replaces your ballot. Refused within 30 min of commitCloseAt. Spends one pin fee.',
    {
      roundPinId: z.string().min(1),
      pairs: z
        .array(
          z.object({
            a: z.string(),
            b: z.string(),
            pick: pickSchema,
            reason: z.string().min(1).max(1000),
            dims: z.record(z.string(), pickSchema).optional(),
          }),
        )
        .min(1)
        .max(28),
      note: z.string().max(2000).optional().describe('Optional overall remark.'),
    },
    async (args: VoteCommitArgs) => {
      try {
        const bot = sessionBot();
        if ('error' in bot) return refuse(bot.error);
        const service = control.service();
        let view: PreferenceRoundView | { error: string } = service.roundStatus(args.roundPinId);
        if ('error' in view) {
          await service.refresh('preference_vote_commit', { bypassCache: true });
          view = service.roundStatus(args.roundPinId);
        }
        if ('error' in view) return refuse(view.error);
        const role = judgeRole(view.round, bot.globalMetaId);
        if (!role.listed) {
          return refuse('preference:not-a-listed-judge (an unlisted ballot is public and never decides; ask the round author to list you)');
        }
        const ballot = { pairs: args.pairs, ...(args.note ? { note: args.note } : {}) };
        const result = await service.commitBallot(signerOf(bot.metabotId), args.roundPinId, ballot);
        if ('error' in result) return refuse(result.error);
        return jsonResult({
          commitPinId: result.pinId,
          ballotId: result.ballotId,
          judgeClass: role.class,
          revealsFrom: view.round.commitCloseAt + REVEAL_DELAY_SEC,
          revealCloseAt: view.round.revealCloseAt,
          note: 'Sealed. Do not read other judges\' reasons for this round before the commit window closes.',
        });
      } catch (error) {
        return textResult(`Failed to commit the ballot: ${errorOf(error)}`, true);
      }
    },
  );

  const lessonPublish = tool(
    'preference_lesson_publish',
    'Publish a lesson distilled from a FINAL decided preference round (/protocols/preference/lesson). Read preference_round_status first: its reasons list is your only source. Write 1..12 principles phrased as reusable practices (10..400 chars) with concrete conditions (when it held) and uncertainty (what is untested); each principle cites 1..20 evidence reveal pinIds whose reasons support it. The tool fills exemplars.preferred = the winner, rejected = the other ranked candidates (or your subset), tallyHash, and category (default: the round\'s). Validated against the tally before any spend. Spends one pin fee.',
    {
      roundPinId: z.string().min(1),
      summary: z.string().min(1).max(1200).describe('What the round taught, for a builder about to start.'),
      principles: z
        .array(
          z.object({
            text: z.string().min(10).max(400),
            conditions: z.string().min(1).max(300),
            uncertainty: z.string().max(300).optional(),
            evidence: z.array(z.string()).min(1).max(20),
          }),
        )
        .min(1)
        .max(12),
      category: z.array(z.string()).min(1).max(8).optional(),
      rejected: z.array(z.string()).max(7).optional().describe('Subset of non-winning candidate ids; default all of them.'),
    },
    async (args: LessonPublishArgs) => {
      try {
        const bot = sessionBot();
        if ('error' in bot) return refuse(bot.error);
        const service = control.service();
        await service.refresh('preference_lesson_publish', { bypassCache: true });
        const view = service.roundStatus(args.roundPinId);
        if ('error' in view) return refuse(view.error);
        const tally = view.tally;
        if (!tally || tally.output.status !== 'decided' || tally.output.winner === null || tally.tallyHash === null) {
          return refuse(`preference:round-not-decided:${tally?.output.status ?? view.tallyError ?? 'unknown'}`);
        }
        const winner: string = tally.output.winner;
        const tallyHash: string = tally.tallyHash;
        const body = {
          round: args.roundPinId,
          category: args.category ?? view.round.category,
          summary: args.summary,
          principles: args.principles.map((principle) => ({
            text: principle.text,
            conditions: principle.conditions,
            uncertainty: principle.uncertainty ?? '',
            evidence: principle.evidence,
          })),
          exemplars: {
            preferred: winner,
            rejected: args.rejected ?? tally.output.ranking.map((entry) => entry.id).filter((id) => id !== winner),
          },
          tallyHash,
        };
        const result = await service.publishLesson(signerOf(bot.metabotId), body);
        if ('error' in result) return refuse(result.error);
        const winnerCandidate = view.round.candidates.find((candidate) => candidate.id === winner);
        const winnerRef = winnerCandidate?.ref ?? '';
        const subject = view.round.subject;
        return jsonResult({
          lessonPinId: result.pinId,
          winner,
          winnerRef,
          tallyHash,
          next: [
            subject
              ? `Submit the task's terminal node that depends on "${subject.node}" (normally LESSON) with metatask_submit: rootPinId ${subject.taskid}, parentRefs {"${subject.node}": "${winnerRef}"}, attachment "pin://${result.pinId}", and quote tallyHash ${tallyHash} and winner ${winner} in the result. The task root author must not submit it.`
              : 'This round has no MetaTask subject; no node submission is needed.',
            `Announce the lesson with post_buzz quoting pin://${result.pinId} and the winner artifact ${winnerCandidate?.artifact ?? ''}.`,
          ],
        });
      } catch (error) {
        return textResult(`Failed to publish the lesson: ${errorOf(error)}`, true);
      }
    },
  );

  return [roundsList, roundStatus, lessonsSearch, roundOpen, voteCommit, lessonPublish];
}
