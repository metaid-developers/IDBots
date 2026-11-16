import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon, ArrowPathIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { preferenceService, type PreferencePreview } from '../../services/preference';
import type {
  PreferenceAnswers,
  PreferenceChoice,
  PreferenceHumanRoundView,
  PreferencePairAnswer,
} from '../../types/preference';
import PreferenceSealConfirmModal from './PreferenceSealConfirmModal';
import {
  MAX_REASON_CHARS,
  answersToBallot,
  ballotToAnswers,
  buildPairSchedule,
  pairAnswerError,
  remainingParts,
  scheduleProgress,
} from './preferencePairs.js';

type Viewport = 'desktop' | 'mobile';

const t = (key: string): string => i18nService.t(key);

const formatAt = (sec: number): string => new Date(sec * 1000).toLocaleString();

const formatRemaining = (seconds: number): string => {
  const parts = remainingParts(seconds);
  if (parts.kind === 'now') return t('preference.time.now');
  if (parts.kind === 'm') return t('preference.time.minutes').replace('{m}', String(parts.m));
  if (parts.kind === 'hm') {
    return t('preference.time.hoursMinutes').replace('{h}', String(parts.h)).replace('{m}', String(parts.m));
  }
  return t('preference.time.daysHours').replace('{d}', String(parts.d)).replace('{h}', String(parts.h));
};

const EMPTY_ANSWER: PreferencePairAnswer = { choice: null, reason: '', dims: {} };

const CHOICES: { choice: PreferenceChoice; label: string; short: string }[] = [
  { choice: 'left', label: 'preference.panel.pickLeft', short: 'preference.panel.left' },
  { choice: 'tie', label: 'preference.panel.pickTie', short: 'preference.panel.tieShort' },
  { choice: 'right', label: 'preference.panel.pickRight', short: 'preference.panel.right' },
];

const choiceClass = (active: boolean): string =>
  active
    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
    : 'border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]';

const CandidateFrame: React.FC<{
  label: string;
  artifact: string;
  preview: PreferencePreview | undefined;
  viewport: Viewport;
  onReload: () => void;
}> = ({ label, artifact, preview, viewport, onReload }) => (
  <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-panel)]">
    <div className="flex items-center justify-between border-b border-[var(--border-color)] px-3 py-1.5 text-xs">
      <span className="font-semibold text-[var(--text-primary)]">{label}</span>
      <button
        type="button"
        onClick={onReload}
        className="inline-flex items-center gap-1 rounded-[8px] px-1.5 py-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
      >
        <ArrowPathIcon className="h-3.5 w-3.5" />
        {t('preference.panel.reload')}
      </button>
    </div>
    <div className="flex min-h-0 flex-1 justify-center overflow-auto">
      {!preview && <div className="m-auto text-xs text-[var(--text-secondary)]">{t('preference.panel.loading')}</div>}
      {preview && 'error' in preview && (
        <div className="m-auto max-w-sm px-4 text-center text-xs text-[var(--text-secondary)]">
          {preview.error === 'unsupported'
            ? t('preference.panel.unsupportedArtifact').replace('{artifact}', artifact)
            : t('preference.panel.previewFailed').replace('{error}', preview.error)}
        </div>
      )}
      {preview && 'url' in preview && (
        <iframe
          key={preview.url}
          src={preview.url}
          title={label}
          sandbox="allow-scripts allow-same-origin allow-forms"
          className="h-full shrink-0 border-0"
          style={{ width: viewport === 'mobile' ? 390 : '100%' }}
        />
      )}
    </div>
  </section>
);

const RoundStatusView: React.FC<{ view: PreferenceHumanRoundView; nowSec: number }> = ({ view, nowSec }) => {
  const reason = !view.me.globalMetaId
    ? t('preference.panel.noIdentity')
    : !view.me.listed
      ? t('preference.panel.notJudge')
      : view.status === 'pending'
        ? t('preference.panel.notConfirmed')
        : view.status === 'collecting' && nowSec >= view.commitCutoffAt
          ? t('preference.panel.closed')
          : t(`preference.status.${view.status}`);
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 text-sm">
      <div className="mx-auto max-w-2xl space-y-4">
        <p className="text-[var(--text-primary)]">{reason}</p>
        <p className="text-xs text-[var(--text-secondary)]">
          {t('preference.panel.windows')
            .replace('{commit}', formatAt(view.commitCloseAt))
            .replace('{reveal}', formatAt(view.revealCloseAt))}
        </p>
        {view.myBallots.length > 0 && (
          <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-panel)] px-3 py-2">
            <div className="mb-1 text-xs font-medium">{t('preference.panel.myBallots')}</div>
            <ul className="space-y-1 text-xs text-[var(--text-secondary)]">
              {view.myBallots.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-[var(--text-primary)]">
                    {t(`preference.ballotStatus.${row.status}`)}
                  </span>
                  {row.commitPinId && <span className="select-all font-mono">{row.commitPinId}</span>}
                  {row.lastError && <span className="text-red-500">{row.lastError}</span>}
                </li>
              ))}
            </ul>
            {view.myBallots.some((row) => row.status === 'committed') && (
              <p className="mt-2 text-xs text-[var(--text-secondary)]">
                {t('preference.panel.revealHint').replace('{time}', formatAt(view.revealCloseAt))}
              </p>
            )}
          </section>
        )}
        {view.ranking.length > 0 && (
          <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-panel)] px-3 py-2">
            <div className="mb-1 flex items-center justify-between text-xs font-medium">
              <span>{t('preference.panel.ranking')}</span>
              {view.winner && (
                <span className="text-[var(--color-accent)]">{t('preference.panel.winner').replace('{id}', view.winner)}</span>
              )}
            </div>
            <ol className="space-y-0.5 text-xs text-[var(--text-secondary)]">
              {view.ranking.map((entry, position) => (
                <li key={entry.id} className="flex gap-3 font-mono">
                  <span className="w-5 text-right">{position + 1}</span>
                  <span className="w-10 text-[var(--text-primary)]">{entry.id}</span>
                  <span>
                    {entry.wins}-{entry.losses}-{entry.ties}
                  </span>
                  <span>C{entry.copeland}</span>
                  <span>P{entry.points}</span>
                </li>
              ))}
            </ol>
            {view.tallyHash && (
              <p className="mt-2 break-all font-mono text-[11px] text-[var(--text-secondary)]">
                {t('preference.panel.tallyHash')}: <span className="select-all">{view.tallyHash}</span>
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
};

interface PreferenceComparePanelProps {
  roundPinId: string;
  onClose: () => void;
}

// In-flow panel: fills the nearest flex-column container (the MetaTask board
// or detail page swaps it in for its scroll area), so it never blocks the rest
// of the app the way the old fullscreen overlay did.
const PreferenceComparePanel: React.FC<PreferenceComparePanelProps> = ({ roundPinId, onClose }) => {
  const [view, setView] = useState<PreferenceHumanRoundView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<PreferenceAnswers>({});
  const [note, setNote] = useState('');
  const [index, setIndex] = useState(0);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [previews, setPreviews] = useState<Record<string, PreferencePreview>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [sealedSignature, setSealedSignature] = useState<string | null>(null);
  const restoredBallotId = useRef<string | null>(null);
  const previewsRef = useRef(previews);
  previewsRef.current = previews;

  const load = useCallback(async () => {
    try {
      setView(await preferenceService.roundStatus(roundPinId));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [roundPinId]);

  useEffect(() => {
    // Cache-first render; the refresh broadcasts preference:update, which the
    // subscription turns into a re-load, so an open panel catches up to the
    // chain (e.g. a reveal confirming or the round settling) without a manual
    // refresh action.
    preferenceService.refresh().catch(() => undefined);
    void load();
    const unsubscribe = preferenceService.subscribe(() => void load());
    const timer = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [load]);

  // Keyboard exit for judging mode: once an iframe takes focus, keydown events
  // no longer reach this window, so the header/footer back buttons remain the
  // reliable exits there.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || sealing) return;
      if (confirmOpen) setConfirmOpen(false);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmOpen, sealing, onClose]);

  const schedule = useMemo(
    () => (view ? buildPairSchedule(view.me.globalMetaId ?? '', view.pinId, view.candidates) : []),
    [view],
  );

  const latestBallot = view?.myBallots.find((row) => row.status !== 'commit_failed' && row.status !== 'superseded') ?? null;

  useEffect(() => {
    if (!latestBallot || schedule.length === 0 || restoredBallotId.current === latestBallot.id) return;
    restoredBallotId.current = latestBallot.id;
    setAnswers(ballotToAnswers(schedule, latestBallot.ballot));
    setNote(latestBallot.ballot.note ?? '');
    setSealedSignature(latestBallot.commitPinId ? JSON.stringify(latestBallot.ballot) : null);
  }, [latestBallot, schedule]);

  const judging = Boolean(view && view.me.listed && view.status === 'collecting' && nowSec < view.commitCutoffAt);
  const current = schedule.length > 0 ? schedule[Math.min(index, schedule.length - 1)] : null;
  const currentKey = current?.key ?? null;
  const currentLeft = current?.left ?? null;
  const currentRight = current?.right ?? null;

  const artifactOf = useCallback(
    (id: string): string => view?.candidates.find((candidate) => candidate.id === id)?.artifact ?? '',
    [view],
  );

  const ensurePreview = useCallback(
    async (id: string, force = false) => {
      const artifact = artifactOf(id);
      if (!artifact) return;
      if (!force && preferenceService.previewIsFresh(previewsRef.current[id])) return;
      const preview = await preferenceService.resolvePreview(artifact);
      setPreviews((prev) => ({ ...prev, [id]: preview }));
    },
    [artifactOf],
  );

  useEffect(() => {
    if (!judging || !currentLeft || !currentRight) return;
    void ensurePreview(currentLeft);
    void ensurePreview(currentRight);
  }, [judging, currentLeft, currentRight, ensurePreview]);

  useEffect(() => {
    if (!judging || !currentKey) return;
    const startedAt = Date.now();
    return () => {
      const seconds = Math.min(3600, Math.round((Date.now() - startedAt) / 1000));
      preferenceService.recordPairTime(roundPinId, currentKey, seconds);
    };
  }, [judging, roundPinId, currentKey]);

  const answer = currentKey ? answers[currentKey] ?? EMPTY_ANSWER : EMPTY_ANSWER;
  const answerError = pairAnswerError(answer);
  const progress = scheduleProgress(schedule, answers);
  const ballotSignature = useMemo(
    () => (view ? JSON.stringify(answersToBallot(schedule, answers, note)) : ''),
    [view, schedule, answers, note],
  );

  const updateAnswer = (patch: Partial<PreferencePairAnswer>) => {
    if (!currentKey) return;
    setAnswers((prev) => ({ ...prev, [currentKey]: { ...(prev[currentKey] ?? EMPTY_ANSWER), ...patch } }));
  };

  const seal = async () => {
    if (!view) return;
    setSealing(true);
    setSealError(null);
    try {
      const ballot = answersToBallot(schedule, answers, note);
      await preferenceService.commit(view.pinId, ballot);
      setSealedSignature(JSON.stringify(ballot));
      setConfirmOpen(false);
      await load();
    } catch (error) {
      setSealError(error instanceof Error ? error.message : String(error));
    } finally {
      setSealing(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-[var(--border-color)] bg-[var(--bg-main)] text-[var(--text-primary)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border-color)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex shrink-0 items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            {t('back')}
          </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{view?.title ?? t('preference.panel.loading')}</div>
            {view && (
              <div className="text-xs text-[var(--text-secondary)]">
                {t(`preference.status.${view.status}`)}
                {judging && ` · ${t('preference.panel.commitClosesIn').replace('{time}', formatRemaining(view.commitCutoffAt - nowSec))}`}
                {judging &&
                  current &&
                  ` · ${t('preference.panel.pairProgress')
                    .replace('{index}', String(Math.min(index, schedule.length - 1) + 1))
                    .replace('{total}', String(schedule.length))}`}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {judging && (
            <div className="flex overflow-hidden rounded-lg border border-[var(--border-color)] text-xs">
              {(['desktop', 'mobile'] as Viewport[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setViewport(option)}
                  className={`px-2.5 py-1 ${viewport === option ? 'bg-[var(--bg-hover)] text-[var(--color-accent)]' : 'text-[var(--text-secondary)]'}`}
                >
                  {t(`preference.panel.${option}`)}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('preference.panel.close')}
            className="rounded-[8px] p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
      </header>

      {loadError && (
        <div className="mx-4 mt-3 rounded-lg border border-red-500/40 px-3 py-2 text-sm text-red-500">
          {t('preference.error.generic').replace('{error}', loadError)}
        </div>
      )}

      {view && !judging && <RoundStatusView view={view} nowSec={nowSec} />}

      {view && judging && schedule.length === 0 && (
        <p className="px-4 py-6 text-sm text-[var(--text-secondary)]">{t('preference.panel.nothingToJudge')}</p>
      )}

      {view && judging && current && (
        <>
          <details className="mx-4 mt-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-panel)] px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium">{t('preference.panel.brief')}</summary>
            {view.brief && <p className="mt-1 whitespace-pre-wrap text-[var(--text-secondary)]">{view.brief}</p>}
            {view.tasks.length > 0 && (
              <>
                <div className="mt-2 font-medium">{t('preference.panel.tasks')}</div>
                <ul className="mt-1 list-disc pl-4 text-[var(--text-secondary)]">
                  {view.tasks.map((task) => (
                    <li key={task}>{task}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-2 text-[var(--text-secondary)]">{t('preference.panel.blindNote')}</p>
          </details>

          {latestBallot?.commitPinId && (
            <p className="mx-4 mt-2 text-xs text-[var(--text-secondary)]">
              {t('preference.panel.alreadySealed')
                .replace('{pin}', latestBallot.commitPinId)
                .replace('{time}', formatAt(view.commitCutoffAt))}
            </p>
          )}

          <div className="flex min-h-0 flex-1 gap-3 px-4 py-3">
            <CandidateFrame
              label={t('preference.panel.left')}
              artifact={artifactOf(current.left)}
              preview={previews[current.left]}
              viewport={viewport}
              onReload={() => void ensurePreview(current.left, true)}
            />
            <CandidateFrame
              label={t('preference.panel.right')}
              artifact={artifactOf(current.right)}
              preview={previews[current.right]}
              viewport={viewport}
              onReload={() => void ensurePreview(current.right, true)}
            />
          </div>

          <footer className="space-y-2 border-t border-[var(--border-color)] px-4 py-3">
            <div className="flex flex-wrap gap-2">
              {CHOICES.map((entry) => (
                <button
                  key={entry.choice}
                  type="button"
                  onClick={() => updateAnswer({ choice: entry.choice })}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${choiceClass(answer.choice === entry.choice)}`}
                >
                  {t(entry.label)}
                </button>
              ))}
            </div>
            <label className="block text-xs text-[var(--text-secondary)]">
              {t('preference.panel.reasonLabel')}
              <textarea
                value={answer.reason}
                maxLength={MAX_REASON_CHARS * 2}
                rows={2}
                onChange={(event) => updateAnswer({ reason: event.target.value })}
                placeholder={t('preference.panel.reasonPlaceholder')}
                className="mt-1 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-panel)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
              />
            </label>
            {answerError === 'reason-too-long' && (
              <p className="text-xs text-red-500">{t('preference.panel.reasonTooLong')}</p>
            )}
            {view.dimensions.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs text-[var(--text-secondary)]">{t('preference.panel.dimensions')}</div>
                {view.dimensions.map((dimension) => (
                  <div key={dimension.id} className="flex items-center gap-2 text-xs">
                    <span className="w-40 truncate">{dimension.label}</span>
                    {CHOICES.map((entry) => (
                      <button
                        key={entry.choice}
                        type="button"
                        onClick={() => updateAnswer({ dims: { ...answer.dims, [dimension.id]: entry.choice } })}
                        className={`rounded border px-2 py-0.5 ${choiceClass(answer.dims[dimension.id] === entry.choice)}`}
                      >
                        {t(entry.short)}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {progress.complete && (
              <label className="block text-xs text-[var(--text-secondary)]">
                {t('preference.panel.note')}
                <textarea
                  value={note}
                  maxLength={2000}
                  rows={1}
                  onChange={(event) => setNote(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-panel)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
                />
              </label>
            )}
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => setIndex((value) => Math.max(0, value - 1))}
                  className="rounded-lg border border-[var(--border-color)] px-3 py-1.5 text-sm hover:bg-[var(--bg-hover)] disabled:opacity-40"
                >
                  {t('preference.panel.prev')}
                </button>
                <button
                  type="button"
                  disabled={index >= schedule.length - 1}
                  onClick={() => setIndex((value) => Math.min(schedule.length - 1, value + 1))}
                  className="rounded-lg border border-[var(--border-color)] px-3 py-1.5 text-sm hover:bg-[var(--bg-hover)] disabled:opacity-40"
                >
                  {t('preference.panel.next')}
                </button>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-[var(--text-secondary)]">
                  {progress.done}/{progress.total}
                </span>
                <button
                  type="button"
                  disabled={!progress.complete || (sealedSignature !== null && sealedSignature === ballotSignature)}
                  onClick={() => {
                    setSealError(null);
                    setConfirmOpen(true);
                  }}
                  className="btn-idchat-primary-filled rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
                >
                  {t('preference.panel.review')}
                </button>
              </div>
            </div>
          </footer>
        </>
      )}

      <div className="flex shrink-0 items-center border-t border-[var(--border-color)] px-4 py-2">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          {t('back')}
        </button>
      </div>

      {confirmOpen && view && (
        <PreferenceSealConfirmModal
          pairCount={progress.total}
          commitCloseAt={view.commitCloseAt}
          revealCloseAt={view.revealCloseAt}
          sealing={sealing}
          error={sealError}
          onConfirm={() => void seal()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
};

export default PreferenceComparePanel;
