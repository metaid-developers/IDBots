import React, { useEffect, useState } from 'react';
import {
  BriefcaseIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { projectsService } from '../../services/projects';
import { ProjectFormData, ProjectRecord } from '../../types/project';
import ProjectFormModal from './ProjectFormModal';

const showToast = (message: string) => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const ProjectsManager: React.FC<{ autoOpenCreateForm?: boolean }> = ({ autoOpenCreateForm = false }) => {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [actionError, setActionError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ProjectRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectRecord | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;
    const load = async () => {
      const loaded = await projectsService.loadProjects();
      if (!isActive) return;
      setProjects([...loaded]);
    };
    load();
    return () => { isActive = false; };
  }, []);

  // Auto-open the create form when Settings was opened with the "New Project"
  // intent (e.g. from the New Task composer's project menu). Fires once.
  useEffect(() => {
    if (autoOpenCreateForm) {
      setEditingProject(null);
      setIsFormOpen(true);
    }
  }, [autoOpenCreateForm]);

  const handleToggleEnabled = async (project: ProjectRecord) => {
    if (togglingId) return;
    setTogglingId(project.id);
    setActionError('');
    try {
      const updated = await projectsService.setProjectEnabled(project.id, !project.enabled);
      setProjects([...updated]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to update project');
    } finally {
      setTogglingId(null);
    }
  };

  const handleRequestDelete = (project: ProjectRecord) => {
    setActionError('');
    setPendingDelete(project);
  };

  const handleCancelDelete = () => {
    if (isDeleting) return;
    setPendingDelete(null);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete || isDeleting) return;
    setIsDeleting(true);
    setActionError('');
    const result = await projectsService.deleteProject(pendingDelete.id);
    if (!result.success) {
      setActionError(result.error || 'Failed to delete project');
      setIsDeleting(false);
      return;
    }
    if (result.projects) {
      setProjects([...result.projects]);
    }
    setIsDeleting(false);
    setPendingDelete(null);
    showToast(i18nService.t('projectDeleted'));
  };

  const handleOpenCreateForm = () => {
    setEditingProject(null);
    setIsFormOpen(true);
  };

  const handleOpenEditForm = (project: ProjectRecord) => {
    setEditingProject(project);
    setIsFormOpen(true);
  };

  const handleCloseForm = () => {
    setIsFormOpen(false);
    setEditingProject(null);
  };

  const handleSaveForm = async (data: ProjectFormData) => {
    setActionError('');
    const result = editingProject
      ? await projectsService.updateProject(editingProject.id, data)
      : await projectsService.createProject(data);
    if (!result.success) {
      setActionError(result.error || 'Failed to save project');
      showToast(result.error || 'Failed to save project');
      return;
    }
    if (result.projects) {
      setProjects([...result.projects]);
    }
    handleCloseForm();
    showToast(i18nService.t('projectSaved'));
  };

  const basename = (targetPath: string): string => {
    const normalized = targetPath.replace(/[/\\]+$/, '');
    const parts = normalized.split(/[/\\]/);
    return parts[parts.length - 1] || targetPath;
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('projectsTitle')}
        </p>
        <button
          type="button"
          onClick={handleOpenCreateForm}
          className="btn-idchat-primary-filled px-3 py-1.5 text-xs flex items-center gap-1"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          {i18nService.t('addProject')}
        </button>
      </div>

      {actionError && (
        <div className="text-xs text-red-500">{actionError}</div>
      )}

      {/* Project cards */}
      {projects.length === 0 ? (
        <div className="text-center py-12 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('projectsEmpty')}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {projects.map((project) => (
            <div
              key={project.id}
              className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-10 h-10 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border overflow-hidden flex items-center justify-center flex-shrink-0">
                    {project.icon ? (
                      <img src={project.icon} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <BriefcaseIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                        {project.name}
                      </span>
                      {!project.enabled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary flex-shrink-0">
                          {i18nService.t('projectFrozenTag')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => handleOpenEditForm(project)}
                    className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent dark:hover:text-claude-accent transition-colors"
                    title={i18nService.t('editProject')}
                  >
                    <PencilIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRequestDelete(project)}
                    className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                    title={i18nService.t('deleteProject')}
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={project.enabled}
                    onClick={() => handleToggleEnabled(project)}
                    disabled={togglingId === project.id}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
                      togglingId === project.id ? 'opacity-50 cursor-not-allowed' : ''
                    } ${
                      project.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        project.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                      }`}
                    />
                  </button>
                </div>
              </div>

              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate mb-1">
                {project.guidelines?.trim() || '—'}
              </p>

              <div className="flex items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {project.sourceDir && (
                  <>
                    <span className="truncate" title={project.sourceDir}>{basename(project.sourceDir)}</span>
                    <span>·</span>
                  </>
                )}
                <span>
                  {i18nService.t('projectResourceCount').replace('{count}', String(project.resources.length))}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation modal */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop"
          onClick={handleCancelDelete}
        >
          <div
            className="modal-content w-full max-w-sm mx-4 p-5 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('deleteProject')}
            </div>
            <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('deleteProjectConfirm').replace('{name}', pendingDelete.name)}
            </p>
            {actionError && (
              <div className="mt-3 text-xs text-red-500">
                {actionError}
              </div>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelDelete}
                disabled={isDeleting}
                className="px-3 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="border border-red-600 px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 dark:bg-red-500 dark:hover:bg-red-400 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {i18nService.t('confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / edit form modal */}
      <ProjectFormModal
        isOpen={isFormOpen}
        project={editingProject}
        onClose={handleCloseForm}
        onSave={handleSaveForm}
      />
    </div>
  );
};

export default ProjectsManager;
