import React, { useEffect, useState } from 'react';
import {
  ArrowUpTrayIcon,
  ArrowsUpDownIcon,
  BriefcaseIcon,
  FolderIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import { projectsService } from '../services/projects';
import { coworkService } from '../services/cowork';
import { i18nService } from '../services/i18n';
import { getCompactFolderName } from '../utils/path';
import type { ProjectRecord } from '../types/project';
import type { CoworkWorkspaceSelection } from '../types/cowork';

/**
 * The 「工作区」 section (regression order 2026-11-09 13:00, task 4e86b3e4;
 * relocation to the Studio face's visible middle column ruled by the
 * orchestrator 13:31: the section mounts INSIDE BotBrowserCoworkPanel, above
 * the composer — the records-column holding form never rendered on screen,
 * so the visible-face ruling supersedes it).
 *
 * FULLY CONTROLLED: the host passes its OWN workspace selection and a click
 * callback, so the section's highlight and the host composer's workspace
 * button are the SAME state — a click here genuinely switches the working
 * directory the next twin session starts in, never a fabricated linkage.
 * (In BotBrowserCoworkPanel that state is the panel's own
 * workspaceSelection/localStorage chain — the same one its 「在该 Bot 工作
 * 目录」 popover writes.)
 *
 * DATA SOURCE: rows map IDBots' REAL project management — projects come from
 * projectsService.loadProjects() (Settings > Projects), recent folders from
 * coworkService.getRecentCwds() (the popover's own 最近文件夹 source), both
 * re-read on every mount. The host resolves a project entry to its concrete
 * selection (same rule as its own popover), keeping the cwd fallback rule
 * per-host identical. 「未分组」 is the sanctioned static row: sessions carry
 * NO workspace/group assignment field anywhere in the store (no such field
 * on CoworkSessionSummary / coworkSlice), so the grouping cannot be derived
 * — its 数据接线点 is THIS section's row list.
 */
export type HomeWorkspaceEntry =
  | { kind: 'botWorkspace' }
  | { kind: 'project'; project: ProjectRecord }
  | { kind: 'folder'; cwd: string };

interface HomeWorkspaceSectionProps {
  /** The host's own workspace selection — the section mirrors it live. */
  selection: CoworkWorkspaceSelection | null;
  /** A workspace row was clicked; the host converts it to its own selection
      with the SAME rule its composer popover uses. */
  onSelectWorkspace: (entry: HomeWorkspaceEntry) => void;
}

const HomeWorkspaceSection: React.FC<HomeWorkspaceSectionProps> = ({
  selection,
  onSelectWorkspace,
}) => {
  // Real projects (Settings > Projects) and recent folders — loaded on
  // mount; the panel unmounts/remounts with its surface, so every visit
  // re-reads the live data.
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [recentFolders, setRecentFolders] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [loadedProjects, folders] = await Promise.all([
          projectsService.loadProjects(),
          coworkService.getRecentCwds(8),
        ]);
        if (!cancelled) {
          setProjects(loadedProjects);
          setRecentFolders(folders);
        }
      } catch {
        // Best-effort: an empty list degrades the section to its two
        // persistent rows (默认工作区 / 未分组) — never a broken panel.
        if (!cancelled) {
          setProjects([]);
          setRecentFolders([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Single-select highlight, DERIVED LIVE from the host's own selection (the
  // same state the composer workspace button shows): 'default' = the 默认工
  // 作区 row, 'project:<id>' / 'folder:<cwd>' = the matching real row, null
  // = nothing matches. 未分组 keeps a local UI-only flag (no store analog).
  const selectedWorkspaceKey = !selection || selection.kind === 'botWorkspace'
    ? 'default'
    : selection.kind === 'project'
      ? `project:${selection.projectId}`
      : `folder:${selection.cwd}`;
  const [ungroupedHighlighted, setUngroupedHighlighted] = useState(false);

  const handleSelectDefaultWorkspace = () => {
    setUngroupedHighlighted(false);
    onSelectWorkspace({ kind: 'botWorkspace' });
  };
  const handleSelectProject = (project: ProjectRecord) => {
    setUngroupedHighlighted(false);
    onSelectWorkspace({ kind: 'project', project });
  };
  const handleSelectFolder = (cwd: string) => {
    setUngroupedHighlighted(false);
    onSelectWorkspace({ kind: 'folder', cwd });
  };
  // Sanctioned STATIC row (annotated wiring point above): UI selection only.
  const handleSelectUngroupedWorkspace = () => {
    setUngroupedHighlighted(true);
  };

  const rowBaseClass =
    'w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40';
  const rowActiveClass =
    'dark:text-claude-darkText text-claude-text dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover';
  const rowIdleClass =
    'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover';

  return (
    <div data-slot="home-workspace-section" className="px-3 pb-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('workspaceSectionTitle')}
        </span>
        <span
          aria-hidden
          className="flex items-center gap-1.5 text-claude-textSecondary/70 dark:text-claude-darkTextSecondary/70"
        >
          <MagnifyingGlassIcon className="h-3.5 w-3.5" />
          <ArrowsUpDownIcon className="h-3.5 w-3.5" />
          <ArrowUpTrayIcon className="h-3.5 w-3.5" />
        </span>
      </div>
      <div className="mt-1 space-y-0.5">
        {/* REAL default row: mirrors the host's botWorkspace default (null /
            kind:'botWorkspace' = the default bot workspace chain). */}
        <button
          type="button"
          onClick={handleSelectDefaultWorkspace}
          aria-pressed={selectedWorkspaceKey === 'default'}
          title={i18nService.t('coworkBotWorkspace')}
          className={`${rowBaseClass} ${
            selectedWorkspaceKey === 'default' ? rowActiveClass : rowIdleClass
          }`}
        >
          <FolderIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{i18nService.t('workspaceSectionDefault')}</span>
        </button>
        {/* REAL project rows: Settings > Projects (the composer popover's own
            project list, same service). The host resolves the cwd. */}
        {projects.map((project) => {
          const key = `project:${project.id}`;
          return (
            <button
              key={key}
              type="button"
              onClick={() => handleSelectProject(project)}
              aria-pressed={selectedWorkspaceKey === key}
              title={project.sourceDir || project.name}
              className={`${rowBaseClass} ${
                selectedWorkspaceKey === key ? rowActiveClass : rowIdleClass
              }`}
            >
              {project.icon ? (
                <img src={project.icon} alt="" className="h-4 w-4 shrink-0 rounded-sm object-cover" />
              ) : (
                <BriefcaseIcon className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate">{project.name}</span>
            </button>
          );
        })}
        {/* REAL recent-folder rows: the composer popover's 最近文件夹 source
            (coworkService.getRecentCwds). */}
        {recentFolders.map((folder) => {
          const key = `folder:${folder}`;
          return (
            <button
              key={key}
              type="button"
              onClick={() => handleSelectFolder(folder)}
              aria-pressed={selectedWorkspaceKey === key}
              title={folder}
              className={`${rowBaseClass} ${
                selectedWorkspaceKey === key ? rowActiveClass : rowIdleClass
              }`}
            >
              <FolderIcon className="h-4 w-4 shrink-0" />
              <span className="truncate">{getCompactFolderName(folder) || folder}</span>
            </button>
          );
        })}
        {/* Sanctioned STATIC row (annotated wiring point above): sessions
            carry no workspace/group assignment anywhere in the store — UI
            selection only. 数据接线点: THIS section's row list. */}
        <button
          type="button"
          onClick={handleSelectUngroupedWorkspace}
          aria-pressed={ungroupedHighlighted}
          className={`${rowBaseClass} ${
            ungroupedHighlighted ? rowActiveClass : rowIdleClass
          }`}
        >
          <FolderIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{i18nService.t('workspaceSectionUngrouped')}</span>
        </button>
      </div>
    </div>
  );
};

export default HomeWorkspaceSection;
