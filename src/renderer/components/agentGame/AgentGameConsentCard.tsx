/**
 * Agent-Game-v2 task authorization card (docs/14 §3). Surfaces a start-time
 * consent request — actor, MetaApp, groupId, gameId, rules/Adapter hash,
 * protocol paths, TTL, budget — and lets the user approve or deny. Deny maps
 * to consent_denied on the host. Mirrors the CoworkPermissionPanel confirmation
 * pattern (Tailwind + heroicons).
 */

import React from 'react';
import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { AgentGameConsentCardInfo } from '../../types/agentGame';

interface AgentGameConsentCardProps {
  info: AgentGameConsentCardInfo;
  onRespond: (approved: boolean, reason?: string) => void;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function shortHash(hash: string): string {
  if (!hash) return '—';
  return hash.length > 20 ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : hash;
}

const AgentGameConsentCard: React.FC<AgentGameConsentCardProps> = ({ info, onRespond }) => {
  const handleDeny = () => onRespond(false, 'Denied by user');

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Actor', value: info.actor || '—' },
    { label: 'Game', value: info.gameId || '—' },
    { label: 'Seat', value: info.seat || '—' },
    { label: 'Group', value: info.groupId ? `${info.groupId.slice(0, 12)}…` : '—' },
    { label: 'MetaApp', value: info.appId || '—' },
    { label: 'Rules hash', value: shortHash(info.rulesHash) },
    { label: 'Adapter hash', value: shortHash(info.adapterHash) },
    { label: 'Time-to-live', value: formatDuration(info.ttlMs) },
    { label: 'Budget', value: `${info.budget.llmCalls} LLM · ${info.budget.writes} writes` },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop">
      <div className="modal-content w-full max-w-lg mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal overflow-hidden animate-scale-in">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b dark:border-claude-darkBorder border-claude-border">
          <div className="p-2 rounded-full bg-yellow-100 dark:bg-yellow-900/30">
            <ExclamationTriangleIcon className="h-6 w-6 text-yellow-600 dark:text-yellow-500" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
              Agent-Game authorization
            </h2>
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              A MetaApp is requesting a persistent game session on your behalf.
            </p>
          </div>
          <button
            onClick={handleDeny}
            className="p-2 rounded-lg dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors"
            aria-label="Close"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
          <dl className="rounded-xl border dark:border-claude-darkBorder border-claude-border divide-y dark:divide-claude-darkBorder divide-claude-border">
            {rows.map((row) => (
              <div key={row.label} className="flex items-center justify-between px-4 py-2.5">
                <dt className="text-xs uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {row.label}
                </dt>
                <dd className="text-sm font-mono dark:text-claude-darkText text-claude-text max-w-[60%] truncate">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          {info.protocolPaths.length > 0 && (
            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              Auto-write will be limited to: {info.protocolPaths.join(', ')}
            </div>
          )}
          <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            If approved, the session keeps running after the MetaApp closes and will write game actions on-chain on your behalf until it finishes, expires, or you stop it.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t dark:border-claude-darkBorder border-claude-border">
          <button
            onClick={handleDeny}
            className="px-4 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
          >
            Deny
          </button>
          <button
            onClick={() => onRespond(true)}
            className="border border-[var(--btn-primary-edge)] bg-claude-accent text-claude-accentInk hover:brightness-[0.96] active:brightness-[0.9] transition-[filter] px-4 py-2 rounded-lg text-sm font-medium "
          >
            Authorize
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentGameConsentCard;
