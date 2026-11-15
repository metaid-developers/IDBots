import React, { useEffect, useRef, useState } from 'react';
import { BriefcaseIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { ProjectFormData, ProjectRecord, ProjectResource } from '../../types/project';

const ICON_MAX_SIZE_BYTES = 200 * 1024;

const showToast = (message: string) => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

interface ProjectFormModalProps {
  isOpen: boolean;
  project?: ProjectRecord | null; // null = create mode, defined = edit mode
  onClose: () => void;
  onSave: (data: ProjectFormData) => void;
}

const ProjectFormModal: React.FC<ProjectFormModalProps> = ({
  isOpen,
  project,
  onClose,
  onSave,
}) => {
  const isEdit = !!project;

  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [guidelines, setGuidelines] = useState('');
  const [sourceDir, setSourceDir] = useState('');
  const [resources, setResources] = useState<ProjectResource[]>([]);
  const [error, setError] = useState('');
  const iconInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (project) {
      // Edit mode
      setName(project.name);
      setIcon(project.icon || '');
      setGuidelines(project.guidelines || '');
      setSourceDir(project.sourceDir || '');
      setResources(project.resources.map((resource) => ({ ...resource })));
    } else {
      // Create mode
      setName('');
      setIcon('');
      setGuidelines('');
      setSourceDir('');
      setResources([]);
    }
    setError('');
  }, [isOpen, project]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleIconFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > ICON_MAX_SIZE_BYTES) {
      showToast(i18nService.t('projectIconTooLarge'));
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setIcon(reader.result as string);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleBrowseSourceDir = async () => {
    const result = await window.electron.dialog.selectDirectory();
    if (result.success && result.path) {
      setSourceDir(result.path);
    }
  };

  const addResourcePath = (path: string) => {
    if (!path) return;
    setResources((current) => {
      if (current.some((resource) => resource.path === path)) return current;
      return [...current, { path }];
    });
  };

  const handleAddDirectory = async () => {
    const result = await window.electron.dialog.selectDirectory();
    if (result.success && result.path) {
      addResourcePath(result.path);
    }
  };

  const handleAddFile = async () => {
    const result = await window.electron.dialog.selectFile({
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    if (result.success && result.path) {
      addResourcePath(result.path);
    }
  };

  const handleUpdateResourceNote = (index: number, note: string) => {
    setResources((current) => {
      const updated = [...current];
      updated[index] = { ...updated[index], note };
      return updated;
    });
  };

  const handleRemoveResource = (index: number) => {
    setResources((current) => current.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(i18nService.t('projectNameRequired'));
      return;
    }
    onSave({
      name: trimmedName,
      icon: icon || null,
      guidelines: guidelines.trim() || null,
      sourceDir: sourceDir || null,
      resources: resources
        .map((resource) => ({
          path: resource.path,
          note: resource.note?.trim() || undefined,
        })),
    });
  };

  const inputClass = 'w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent';
  const labelClass = 'text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary';
  const hintClass = 'text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary';
  const ghostButtonClass = 'px-4 py-2 text-xs rounded-[var(--rounded)] border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop"
      onClick={onClose}
    >
      <div
        className="modal-content w-full max-w-lg mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl max-h-[82vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b dark:border-claude-darkBorder border-claude-border">
          <div className="flex items-center gap-2">
            <BriefcaseIcon className="h-5 w-5 text-claude-accent" />
            <div className="text-base font-semibold dark:text-claude-darkText text-claude-text">
              {isEdit ? i18nService.t('editProject') : i18nService.t('addProject')}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-text dark:hover:text-claude-darkText transition-colors"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Name + Icon */}
          <div className="flex items-start gap-4">
            <div className="space-y-1.5 flex-1 min-w-0">
              <label className={labelClass}>{i18nService.t('projectName')}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
                autoFocus
              />
            </div>
            <div className="space-y-1.5 flex-shrink-0">
              <label className={labelClass}>{i18nService.t('projectIcon')}</label>
              <div className="flex items-center gap-2">
                <div className="w-10 h-10 rounded-xl dark:bg-claude-darkBg bg-claude-bg border dark:border-claude-darkBorder border-claude-border overflow-hidden flex-shrink-0 flex items-center justify-center">
                  {icon ? (
                    <img src={icon} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <BriefcaseIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                  )}
                </div>
                <input
                  ref={iconInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
                  className="hidden"
                  onChange={handleIconFileChange}
                />
                <button
                  type="button"
                  onClick={() => iconInputRef.current?.click()}
                  className={ghostButtonClass}
                >
                  {i18nService.t('browse')}
                </button>
                {icon && (
                  <button
                    type="button"
                    onClick={() => setIcon('')}
                    className="text-xs text-red-500 dark:text-red-400 hover:underline transition-colors"
                  >
                    {i18nService.t('clear')}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Guidelines */}
          <div className="space-y-1.5">
            <label className={labelClass}>{i18nService.t('projectGuidelines')}</label>
            <textarea
              value={guidelines}
              onChange={(e) => setGuidelines(e.target.value)}
              placeholder={i18nService.t('projectGuidelinesPlaceholder')}
              rows={4}
              className={inputClass + ' resize-none'}
            />
          </div>

          {/* Source directory */}
          <div className="space-y-1.5">
            <label className={labelClass}>{i18nService.t('projectSourceDir')}</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={sourceDir}
                readOnly
                placeholder="—"
                className={inputClass + ' opacity-60 cursor-not-allowed'}
              />
              <button
                type="button"
                onClick={handleBrowseSourceDir}
                className={ghostButtonClass + ' flex-shrink-0'}
              >
                {i18nService.t('browse')}
              </button>
              {sourceDir && (
                <button
                  type="button"
                  onClick={() => setSourceDir('')}
                  className="text-xs text-red-500 dark:text-red-400 hover:underline transition-colors flex-shrink-0"
                >
                  {i18nService.t('clear')}
                </button>
              )}
            </div>
            <p className={hintClass}>{i18nService.t('projectSourceDirHint')}</p>
          </div>

          {/* Resources */}
          <div className="space-y-1.5">
            <label className={labelClass}>{i18nService.t('projectResources')}</label>
            <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg p-2.5 space-y-2">
              {resources.length === 0 && (
                <p className="text-[11px] px-1 py-1 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('projectResourcesEmpty')}
                </p>
              )}
              {resources.map((resource, index) => (
                <div key={resource.path} className="flex items-center gap-2">
                  <div
                    className="flex-1 min-w-0 px-2 py-1.5 text-xs rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border truncate"
                    title={resource.path}
                  >
                    {resource.path}
                  </div>
                  <input
                    type="text"
                    value={resource.note || ''}
                    onChange={(e) => handleUpdateResourceNote(index, e.target.value)}
                    placeholder={i18nService.t('projectResourceNotePlaceholder')}
                    className="w-36 px-2 py-1.5 text-xs rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-1 focus:ring-claude-accent"
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveResource(index)}
                    className="p-1 text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 dark:hover:text-red-400 transition-colors flex-shrink-0"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={handleAddDirectory}
                  className={ghostButtonClass}
                >
                  + {i18nService.t('addDirectory')}
                </button>
                <button
                  type="button"
                  onClick={handleAddFile}
                  className={ghostButtonClass}
                >
                  + {i18nService.t('addFile')}
                </button>
              </div>
            </div>
          </div>

          {error && (
            <div className="text-xs text-red-500">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t dark:border-claude-darkBorder border-claude-border">
          <button
            type="button"
            onClick={onClose}
            className={ghostButtonClass}
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="btn-idchat-primary-filled text-xs"
          >
            {i18nService.t('save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProjectFormModal;
