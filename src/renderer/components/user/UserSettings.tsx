/**
 * User Settings Component
 * Local human user identity: create / import / mnemonic backup / profile /
 * switch account / logout.
 * Single-user model: at most one identity per device. "Switch Account" removes
 * the current local identity (chain data is unaffected) and lands directly on
 * the mnemonic import view; "Log Out" removes it and lands on the empty view.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  UserCircleIcon,
  UserPlusIcon,
  KeyIcon,
  PhotoIcon,
  ClipboardDocumentIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
  ArrowLeftIcon,
  ArrowRightStartOnRectangleIcon,
  CreditCardIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import { refreshUserProfileIdentity } from '../../features/userProfile/userProfileStore';
import MnemonicWordGrid from './MnemonicWordGrid';
import UserBackupMnemonicModal from './UserBackupMnemonicModal';
import ChainBackupRestorePrompt from './ChainBackupRestorePrompt';
import ChainBackupMnemonicReminderModal from './ChainBackupMnemonicReminderModal';
import PaymentReceivingSettingsModal, {
  initialPaymentModalState,
  paymentModalReducer,
} from '../settings/PaymentReceivingSettings';
import AvatarPickerModal, { type AvatarPickerNftItem } from '../avatar/AvatarPickerModal';
import NftAvatarFrame from '../metabots/NftAvatarFrame';

type ViewState = 'loading' | 'empty' | 'create' | 'backup' | 'import' | 'profile';

const DEFAULT_DERIVATION_PATH = "m/44'/10001'/0'/0/0";
const AVATAR_MAX_SIZE_BYTES = 200 * 1024; // 200KB

/** Subset of the main-process PublicUserIdentity fields this panel needs. */
interface UserIdentity {
  id: number;
  name: string;
  avatar: string | null;
  avatar_fallback?: string | null;
  metaid: string;
  globalmetaid: string | null;
  mvc_address: string;
  chat_public_key_pin_id: string | null;
  subsidy_state: 'pending' | 'claimed' | 'failed' | null;
  subsidy_error: string | null;
  sync_state: 'pending' | 'synced' | 'partial' | 'failed' | null;
  sync_error: string | null;
}

const showToast = (message: string) => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

/** Map IPC error codes to localized copy; unknown/free-text errors are shown as-is. */
const resolveErrorMessage = (raw: string | undefined): string => {
  switch (raw) {
    case 'INVALID_MNEMONIC':
      return i18nService.t('userSettingsErrorInvalidMnemonic');
    case 'CHAT_PUBKEY_MISMATCH':
      return i18nService.t('userSettingsErrorChatPubkeyMismatch');
    case 'NAME_EMPTY':
      return i18nService.t('userSettingsErrorNameEmpty');
    case 'USER_IDENTITY_EXISTS':
      return i18nService.t('userSettingsErrorExists');
    case 'INVALID_AVATAR':
      return i18nService.t('userSettingsErrorInvalidAvatar');
    case 'SUBSIDY_NOT_CLAIMED':
      return i18nService.t('userSettingsErrorSubsidyNotClaimed');
    default:
      return raw || i18nService.t('userSettingsErrorUnknown');
  }
};

const inputClass = 'block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors';
const labelClass = 'block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary';
const hintClass = 'text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary';

interface AvatarPickerProps {
  value: string;
  disabled?: boolean;
  onChange: (dataUrl: string) => void;
  onError: (message: string) => void;
}

const AvatarPicker: React.FC<AvatarPickerProps> = ({ value, disabled, onChange, onError }) => {
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > AVATAR_MAX_SIZE_BYTES) {
      onError(i18nService.t('userSettingsAvatarSizeError'));
      showToast(i18nService.t('userSettingsAvatarSizeError'));
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      onChange(reader.result as string);
      onError('');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div className="min-w-0 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="w-16 h-16 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border overflow-hidden flex-shrink-0 flex items-center justify-center">
        {value && value.startsWith('data:') ? (
          <img src={value} alt="" className="w-full h-full object-cover" />
        ) : (
          <PhotoIcon className="h-8 w-8 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
          className="hidden"
          onChange={handleAvatarFileChange}
        />
        <button
          type="button"
          onClick={() => avatarInputRef.current?.click()}
          disabled={disabled}
          className="px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {i18nService.t('userSettingsAvatarUpload')}
        </button>
        <p className={hintClass}>
          {i18nService.t('userSettingsAvatarHint')}
        </p>
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            disabled={disabled}
            className="mt-1 text-xs text-red-500 dark:text-red-400 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {i18nService.t('userSettingsAvatarClear')}
          </button>
        )}
      </div>
    </div>
  );
};

const UserSettings: React.FC = () => {
  const [view, setView] = useState<ViewState>('loading');
  const [identity, setIdentity] = useState<UserIdentity | null>(null);
  const [loadError, setLoadError] = useState('');
  const [, setLanguage] = useState(i18nService.getLanguage());

  // Create flow
  const [createName, setCreateName] = useState('');
  const [createAvatar, setCreateAvatar] = useState('');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdMnemonic, setCreatedMnemonic] = useState('');
  const [createChainSyncFailed, setCreateChainSyncFailed] = useState(false);
  const [createSubsidyFailed, setCreateSubsidyFailed] = useState(false);
  const [createSubsidyError, setCreateSubsidyError] = useState('');

  // Import flow
  const [importWordCount, setImportWordCount] = useState<12 | 24>(12);
  const [importWords, setImportWords] = useState<string[]>(Array.from({ length: 12 }, () => ''));
  const [importPath, setImportPath] = useState(DEFAULT_DERIVATION_PATH);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);

  // Profile
  const [retryingSync, setRetryingSync] = useState(false);
  const [chainBackupRunning, setChainBackupRunning] = useState(false);
  const [chainBackupRestoring, setChainBackupRestoring] = useState(false);
  const [chainBackupResult, setChainBackupResult] = useState<Awaited<ReturnType<typeof window.electron.chainBackup.backup>> | null>(null);
  const [chainRestoreResult, setChainRestoreResult] = useState<Awaited<ReturnType<typeof window.electron.chainBackup.restore>> | null>(null);
  const [chainRestorePrompt, setChainRestorePrompt] = useState<{ botCount: number; backupBotCount: number } | null>(null);
  const [chainBackupProgressText, setChainBackupProgressText] = useState('');
  const [chainBackupLastRun, setChainBackupLastRun] = useState<number | null>(null);
  const [subsidyRetrying, setSubsidyRetrying] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState('');
  const [avatarEditing, setAvatarEditing] = useState(false);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [backupModalOpen, setBackupModalOpen] = useState(false);
  const loadUserNfts = useCallback(async (): Promise<AvatarPickerNftItem[]> => {
    const response = await window.electron.userIdentity.getNfts();
    if (!response.success) throw new Error(response.error || i18nService.t('metabotNftLoadFailed'));
    return (response.items ?? []) as unknown as AvatarPickerNftItem[];
  }, []);

  // Logout / switch account — the same confirm modal with different copy and a
  // different landing view ('switch' lands directly on the mnemonic import).
  const [logoutModalOpen, setLogoutModalOpen] = useState(false);
  // S3 收款设置：入口按钮 + Modal。reducer 与 Modal 壳同源（PaymentReceivingSettings），
  // 开合与 tab 门的转移函数是纯函数，单测直接驱动同一模块。
  const [paymentSettings, dispatchPaymentSettings] = useReducer(
    paymentModalReducer,
    initialPaymentModalState,
  );
  const [logoutMode, setLogoutMode] = useState<'logout' | 'switch'>('logout');
  const [mnemonicReminderOpen, setMnemonicReminderOpen] = useState(false);
  const [revealedMnemonic, setRevealedMnemonic] = useState('');
  const [revealLoading, setRevealLoading] = useState(false);
  const [revealError, setRevealError] = useState('');
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  // Subscribe to language changes
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const loadIdentity = async () => {
      setLoadError('');
      try {
        const result = await window.electron.userIdentity.get();
        if (!result.success) {
          setIdentity(null);
          setView('empty');
          setLoadError(result.error || i18nService.t('userSettingsLoadFailed'));
          return;
        }
        const next = result.identity ?? null;
        setIdentity(next);
        setView(next ? 'profile' : 'empty');
      } catch (error: any) {
        setIdentity(null);
        setView('empty');
        setLoadError(error?.message || i18nService.t('userSettingsLoadFailed'));
      }
    };
    void loadIdentity();
  }, []);

  // Keep the name draft in sync whenever a (different) identity is loaded
  useEffect(() => {
    setNameDraft(identity?.name ?? '');
    setNameError('');
  }, [identity?.id]);

  // Close the logout confirmation with Escape
  useEffect(() => {
    if (!logoutModalOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !logoutLoading) {
        setLogoutModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [logoutModalOpen, logoutLoading]);

  const createdWords = useMemo(
    () => (createdMnemonic ? createdMnemonic.split(/\s+/).filter(Boolean) : []),
    [createdMnemonic]
  );

  const revealedWords = useMemo(
    () => (revealedMnemonic ? revealedMnemonic.split(/\s+/).filter(Boolean) : []),
    [revealedMnemonic]
  );

  const normalizedImportMnemonic = useMemo(
    () => importWords.map((w) => w.trim().toLowerCase()).filter(Boolean).join(' '),
    [importWords]
  );

  const canImport = useMemo(() => {
    if (importing) return false;
    const normalizedWords = importWords.map((w) => w.trim()).filter(Boolean);
    return normalizedWords.length === importWordCount && importPath.trim().length > 0;
  }, [importWords, importPath, importing, importWordCount]);

  const canSaveName = useMemo(() => {
    if (!identity || nameSaving) return false;
    const next = nameDraft.trim();
    return next.length > 0 && next !== identity.name.trim();
  }, [identity, nameDraft, nameSaving]);

  const handleImportWordCountChange = (raw: string) => {
    const count: 12 | 24 = raw === '24' ? 24 : 12;
    setImportWordCount(count);
    // Reset all cells on count switch (same behavior as Metalet)
    setImportWords(Array.from({ length: count }, () => ''));
  };

  const handleImportWordChange = (index: number, value: string) => {
    setImportWords((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  /** Fill the whole grid from a pasted phrase; only when the word count matches the current mode. */
  const handleImportPasteMnemonic = (value: string): boolean => {
    const parts = value
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length !== importWordCount) return false;
    setImportWords(Array.from({ length: importWordCount }, (_, i) => parts[i].toLowerCase()));
    return true;
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(i18nService.t('userSettingsCopied'));
    } catch {
      // ignore clipboard failures
    }
  };

  const handleCreate = async () => {
    const name = createName.trim();
    if (!name || creating) return;
    setCreateError('');
    setCreating(true);
    try {
      const result = await window.electron.userIdentity.create({
        name,
        avatar: createAvatar || undefined,
      });
      if (!result.success || !result.identity || !result.mnemonic) {
        setCreateError(resolveErrorMessage(result.error));
        return;
      }
      setIdentity(result.identity);
      setCreatedMnemonic(result.mnemonic);
      setCreateChainSyncFailed(result.chainSync ? !result.chainSync.success : false);
      setCreateSubsidyFailed(result.subsidy ? !result.subsidy.success : false);
      setCreateSubsidyError(result.subsidy?.error ?? '');
      setView('backup');
    } catch (error: any) {
      setCreateError(resolveErrorMessage(error?.message));
    } finally {
      setCreating(false);
    }
  };

  const handleBackupConfirmed = () => {
    setCreatedMnemonic('');
    setCreateChainSyncFailed(false);
    setCreateSubsidyFailed(false);
    setCreateSubsidyError('');
    setCreateName('');
    setCreateAvatar('');
    setCreateError('');
    setView('profile');
  };

  const handleImport = async () => {
    if (!canImport) return;
    setImportError('');
    setChainRestorePrompt(null);
    setImporting(true);
    try {
      const result = await window.electron.userIdentity.importFromMnemonic({
        mnemonic: normalizedImportMnemonic,
        path: importPath.trim(),
      });
      if (!result.success || !result.identity) {
        setImportError(resolveErrorMessage(result.error));
        return;
      }
      setIdentity(result.identity);
      if (result.chainBackup?.success && result.chainBackup.hasBackup) {
        setChainRestorePrompt({
          botCount: result.chainBackup.botCount,
          backupBotCount: result.chainBackup.backupBotCount,
        });
      } else if (result.chainBackup && !result.chainBackup.success) {
        console.warn('[ChainBackup] post-import availability probe failed:', result.chainBackup.error);
      }
      setImportWordCount(12);
      setImportWords(Array.from({ length: 12 }, () => ''));
      setImportPath(DEFAULT_DERIVATION_PATH);
      setView('profile');
      showToast(i18nService.t('userSettingsImportSuccess'));
    } catch (error: any) {
      setImportError(resolveErrorMessage(error?.message));
    } finally {
      setImporting(false);
    }
  };

  const handleSaveName = async () => {
    const name = nameDraft.trim();
    if (!name || !canSaveName) return;
    setNameSaving(true);
    setNameError('');
    try {
      const result = await window.electron.userIdentity.updateName({ name });
      if (!result.success || !result.identity) {
        setNameError(resolveErrorMessage(result.error));
        return;
      }
      setIdentity(result.identity);
      setNameDraft(result.identity.name);
      showToast(i18nService.t('userSettingsNameSaveSuccess'));
    } catch (error: any) {
      setNameError(resolveErrorMessage(error?.message));
    } finally {
      setNameSaving(false);
    }
  };

  // Replace/clear the avatar of the existing identity. `dataUrl === ''` is the
  // AvatarPicker clear affordance → maps to avatar:null on the IPC. Success
  // updates the local identity AND invalidates the user-center module-level
  // identity cache (refreshUserProfileIdentity) so the profile card updates
  // without reopening. A failed chain sync is non-blocking: the staged avatar
  // shows immediately and the sync warning + Retry button cover the catch-up.
  const handleAvatarChange = async (value: string): Promise<boolean> => {
    if (avatarSaving) return false;
    setAvatarSaving(true);
    setAvatarError('');
    try {
      const result = await window.electron.userIdentity.updateAvatar({
        avatar: value === '' ? null : value,
      });
      if (!result.success || !result.identity) {
        const message = resolveErrorMessage(result.error);
        setAvatarError(message);
        showToast(message);
        return false;
      }
      setIdentity(result.identity);
      void refreshUserProfileIdentity();
      if (result.chainSync && !result.chainSync.success) {
        showToast(i18nService.t('userSettingsAvatarSyncFailed'));
      } else {
        showToast(i18nService.t('userSettingsAvatarSaved'));
      }
      setAvatarEditing(false);
      return true;
    } catch (error: any) {
      const message = resolveErrorMessage(error?.message);
      setAvatarError(message);
      showToast(message);
      return false;
    } finally {
      setAvatarSaving(false);
    }
  };

  const handleRetryChainSync = async () => {
    if (retryingSync) return;
    setRetryingSync(true);
    try {
      const result = await window.electron.userIdentity.retryChainSync();
      const syncOk = result.success && (!result.chainSync || result.chainSync.success);
      if (result.identity) {
        setIdentity(result.identity);
      }
      if (syncOk) {
        showToast(i18nService.t('userSettingsRetrySuccess'));
      } else {
        const detail = result.error || result.chainSync?.error || '';
        showToast(detail ? `${i18nService.t('userSettingsRetryFailed')}: ${detail}` : i18nService.t('userSettingsRetryFailed'));
      }
    } catch (error: any) {
      showToast(`${i18nService.t('userSettingsRetryFailed')}: ${error?.message || ''}`);
    } finally {
      setRetryingSync(false);
    }
  };

  const handleRetrySubsidy = async () => {
    if (subsidyRetrying) return;
    setSubsidyRetrying(true);
    try {
      const result = await window.electron.userIdentity.retrySubsidy();
      if (result.identity) {
        setIdentity(result.identity);
      }
      const ok = result.success && (result.subsidy ? result.subsidy.success : true);
      if (ok) {
        showToast(i18nService.t('userSettingsSubsidySuccess'));
      } else {
        const detail = result.error || result.subsidy?.error || '';
        showToast(detail
          ? `${i18nService.t('userSettingsSubsidyFailed')}: ${detail}`
          : i18nService.t('userSettingsSubsidyFailed'));
      }
    } catch (error: any) {
      showToast(`${i18nService.t('userSettingsSubsidyFailed')}: ${error?.message || ''}`);
    } finally {
      setSubsidyRetrying(false);
    }
  };

  useEffect(() => {
    const formatProgress = (p: {
      phase: string;
      botName?: string;
      segmentsDone?: number;
      segmentsTotal?: number;
      resumedSegments?: number;
      retryAttempt?: number;
      retryDelayMs?: number;
    }) => {
      const bot = p.botName ?? 'Backup';
      if (p.retryAttempt && p.retryDelayMs) {
        return i18nService.t('userSettingsChainBackupRetryProgress')
          .replace('{bot}', bot)
          .replace('{attempt}', String(p.retryAttempt))
          .replace('{seconds}', String(Math.ceil(p.retryDelayMs / 1000)));
      }
      if ((p.resumedSegments ?? 0) > 0) {
        const seg = typeof p.segmentsDone === 'number' && typeof p.segmentsTotal === 'number'
          ? ` ${p.segmentsDone}/${p.segmentsTotal}`
          : '';
        return `${i18nService.t('userSettingsChainBackupResumeProgress')
          .replace('{bot}', bot)
          .replace('{resumed}', String(p.resumedSegments))}${seg}`;
      }
      const seg = typeof p.segmentsDone === 'number' && typeof p.segmentsTotal === 'number'
        ? ` ${p.segmentsDone}/${p.segmentsTotal}`
        : '';
      return p.botName ? `${p.phase}: ${p.botName}${seg}` : p.phase;
    };
    const unsubBackup = window.electron.chainBackup.onProgress((p) => setChainBackupProgressText(formatProgress(p)));
    const unsubRestore = window.electron.chainBackup.onRestoreProgress((p) => setChainBackupProgressText(formatProgress(p)));
    void window.electron.chainBackup.getState().then((res) => {
      if (res?.success && res.states.length > 0) {
        const latest = res.states.reduce((acc, s) => Math.max(acc, s.last_backup_at ?? 0), 0);
        if (latest > 0) setChainBackupLastRun(latest);
      }
    }).catch(() => undefined);
    return () => {
      unsubBackup();
      unsubRestore();
    };
  }, []);

  const handleChainBackup = async () => {
    if (chainBackupRunning || chainBackupRestoring) return;
    setChainBackupRunning(true);
    setChainBackupResult(null);
    setChainBackupProgressText('');
    try {
      const result = await window.electron.chainBackup.backup();
      setChainBackupResult(result);
      if (result.success) {
        setChainBackupLastRun(Date.now());
        showToast(i18nService.t('userSettingsChainBackupSuccess'));
        // The reminder matters the moment new data actually became recoverable
        // on-chain: without the mnemonic no other device can decrypt it. A
        // no-op incremental run (nothing new uploaded) does not re-prompt.
        const uploadedNow = result.bots.reduce((n, bot) => n + bot.uploadedObjects, 0);
        const segmentsNow = result.bots.reduce((n, bot) => n + bot.segments, 0);
        if (uploadedNow > 0 || segmentsNow > 0) {
          setMnemonicReminderOpen(true);
        }
      } else if (result.resumable) {
        showToast(i18nService.t('userSettingsChainBackupPaused'));
      } else {
        showToast(`${i18nService.t('userSettingsChainBackupFailed')}: ${result.error ?? ''}`);
      }
    } catch (error: any) {
      showToast(`${i18nService.t('userSettingsChainBackupFailed')}: ${error?.message || ''}`);
    } finally {
      setChainBackupRunning(false);
      setChainBackupProgressText('');
    }
  };

  const handleChainRestore = async (skipConfirm = false) => {
    if (chainBackupRunning || chainBackupRestoring) return;
    if (!skipConfirm && !window.confirm(i18nService.t('userSettingsChainBackupRestoreConfirm'))) return;
    setChainBackupRestoring(true);
    setChainRestoreResult(null);
    setChainBackupProgressText('');
    try {
      const result = await window.electron.chainBackup.restore();
      setChainRestoreResult(result);
      if (result.success) {
        showToast(i18nService.t('userSettingsChainBackupRestoreSuccess'));
        // The restore added bots and sessions behind the live UI's back
        // (Settings renders as an overlay over CoworkView). Reload the bot
        // roster and the session list so the restored state is visible
        // immediately, without an app restart.
        window.dispatchEvent(new CustomEvent('app:metabots-changed'));
        void coworkService.loadSessions();
      } else {
        const restoreError = result.error ?? result.bots.find((bot) => bot.error)?.error ?? '';
        showToast(`${i18nService.t('userSettingsChainBackupRestoreFailed')}: ${restoreError}`);
      }
    } catch (error: any) {
      showToast(`${i18nService.t('userSettingsChainBackupRestoreFailed')}: ${error?.message || ''}`);
    } finally {
      setChainBackupRestoring(false);
      setChainBackupProgressText('');
    }
  };

  const openLogoutModal = (mode: 'logout' | 'switch' = 'logout') => {
    setLogoutMode(mode);
    setLogoutError('');
    setRevealError('');
    setRevealedMnemonic('');
    setLogoutModalOpen(true);
  };

  const handleRevealMnemonic = async () => {
    if (revealedMnemonic) {
      setRevealedMnemonic('');
      return;
    }
    if (revealLoading) return;
    setRevealLoading(true);
    setRevealError('');
    try {
      const result = await window.electron.userIdentity.revealMnemonic();
      if (result.success && result.mnemonic) {
        setRevealedMnemonic(result.mnemonic);
      } else {
        setRevealError(result.error || i18nService.t('userSettingsRevealFailed'));
      }
    } catch (error: any) {
      setRevealError(error?.message || i18nService.t('userSettingsRevealFailed'));
    } finally {
      setRevealLoading(false);
    }
  };

  const handleLogout = async () => {
    if (logoutLoading) return;
    const mode = logoutMode;
    setLogoutLoading(true);
    setLogoutError('');
    try {
      const result = await window.electron.userIdentity.logout();
      if (!result.success) {
        setLogoutError(result.error || i18nService.t('userSettingsLogoutFailed'));
        return;
      }
      setIdentity(null);
      setLogoutModalOpen(false);
      setRevealedMnemonic('');
      setView(mode === 'switch' ? 'import' : 'empty');
      showToast(mode === 'switch' ? i18nService.t('userSettingsSwitchSuccess') : i18nService.t('userSettingsLogoutSuccess'));
    } catch (error: any) {
      setLogoutError(error?.message || i18nService.t('userSettingsLogoutFailed'));
    } finally {
      setLogoutLoading(false);
    }
  };

  const renderSubViewHeader = (titleKey: string, onBack?: () => void) => (
    <div className="flex items-center gap-3 pb-3 border-b dark:border-claude-darkBorder/60 border-claude-border/60">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label={i18nService.t('back')}
          className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
      )}
      <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
        {i18nService.t(titleKey)}
      </h3>
    </div>
  );

  const renderLoading = () => (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        <ArrowPathIcon className="h-4 w-4 animate-spin shrink-0" />
        {i18nService.t('loading')}
      </div>
    </div>
  );

  const renderEmpty = () => (
    <div className="flex h-full flex-col items-center justify-center text-center px-8">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-claude-accent/10 dark:bg-claude-accent/20">
        <UserCircleIcon className="h-8 w-8 text-claude-accent" />
      </div>
      <h4 className="mt-4 text-base font-semibold dark:text-claude-darkText text-claude-text">
        {i18nService.t('userSettingsEmptyTitle')}
      </h4>
      <p className="mt-2 max-w-md text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('userSettingsEmptyDesc')}
      </p>
      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-md">
        <button
          type="button"
          onClick={() => setView('import')}
          className="flex flex-col items-center gap-1.5 rounded-xl border-2 dark:border-claude-darkBorder border-claude-border px-4 py-4 transition-colors hover:border-claude-accent/60 dark:hover:border-claude-accent/60 dark:hover:bg-claude-darkSurfaceHover/60 hover:bg-claude-surfaceHover/60 active:scale-[0.98]"
        >
          <KeyIcon className="h-6 w-6 text-claude-accent" />
          <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('userSettingsImportEntry')}
          </span>
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('userSettingsImportEntryDesc')}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setView('create')}
          className="flex flex-col items-center gap-1.5 rounded-xl border-2 dark:border-claude-darkBorder border-claude-border px-4 py-4 transition-colors hover:border-claude-accent/60 dark:hover:border-claude-accent/60 dark:hover:bg-claude-darkSurfaceHover/60 hover:bg-claude-surfaceHover/60 active:scale-[0.98]"
        >
          <UserPlusIcon className="h-6 w-6 text-claude-accent" />
          <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('userSettingsCreateEntry')}
          </span>
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('userSettingsCreateEntryDesc')}
          </span>
        </button>
      </div>
    </div>
  );

  const renderCreate = () => (
    <div className="space-y-4 relative">
      {renderSubViewHeader('userSettingsCreateTitle', () => setView('empty'))}

      <div className="space-y-1.5">
        <label className={labelClass}>
          {i18nService.t('userSettingsNameLabel')}
        </label>
        <input
          type="text"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          disabled={creating}
          placeholder={i18nService.t('userSettingsNamePlaceholder')}
          className={`${inputClass} disabled:opacity-50 disabled:cursor-not-allowed`}
        />
      </div>

      <div className="space-y-1.5">
        <label className={labelClass}>
          {`${i18nService.t('userSettingsAvatarLabel')} ${i18nService.t('userSettingsOptional')}`}
        </label>
        <AvatarPicker
          value={createAvatar}
          disabled={creating}
          onChange={setCreateAvatar}
          onError={setCreateError}
        />
      </div>

      {createError && (
        <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
          {createError}
        </div>
      )}

      <div className="pt-1">
        <button
          type="button"
          onClick={() => { void handleCreate(); }}
          disabled={!createName.trim() || creating}
          className="btn-idchat-primary-filled px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? i18nService.t('userSettingsCreating') : i18nService.t('userSettingsCreateSubmit')}
        </button>
      </div>

      {/* Blocking overlay while creating (wallet derivation + gas + on-chain pins) */}
      {creating && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-[var(--bg-main)]/90 dark:bg-claude-darkBg/90 backdrop-blur-sm">
          <div className="w-full max-w-sm mx-4 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-6 shadow-xl text-center space-y-4">
            <div className="flex justify-center">
              <ArrowPathIcon className="h-10 w-10 text-claude-accent animate-spin" />
            </div>
            <p className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {i18nService.t('userSettingsCreatingOnChain')}
            </p>
            <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('userSettingsCreatingOnChainHint')}
            </p>
          </div>
        </div>
      )}
    </div>
  );

  const renderBackup = () => (
    <div className="space-y-4">
      {renderSubViewHeader('userSettingsBackupTitle')}

      <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
        <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {i18nService.t('userSettingsBackupWarning')}
        </p>
      </div>

      {createSubsidyFailed && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {i18nService.t('userSettingsSubsidyBackupWarning')}
          </p>
          {createSubsidyError && (
            <p className="text-xs mt-1 text-amber-700/80 dark:text-amber-300/80 break-all">
              {createSubsidyError}
            </p>
          )}
        </div>
      )}

      {createChainSyncFailed && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {i18nService.t('userSettingsChainSyncWarning')}
          </p>
        </div>
      )}

      <div className="rounded-lg bg-claude-surface dark:bg-claude-darkSurface border dark:border-claude-darkBorder border-claude-border p-4">
        <MnemonicWordGrid words={createdWords} />
      </div>

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => { void handleCopy(createdWords.join(' ')); }}
          className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
        >
          <ClipboardDocumentIcon className="h-3.5 w-3.5 mr-1.5" />
          {i18nService.t('copy')}
        </button>
        <button
          type="button"
          onClick={handleBackupConfirmed}
          className="btn-idchat-primary-filled px-4 py-2 text-sm"
        >
          {i18nService.t('userSettingsBackupConfirm')}
        </button>
      </div>
    </div>
  );

  const renderImport = () => (
    <div className="space-y-4">
      {renderSubViewHeader('userSettingsImportTitle', () => setView('empty'))}

      <div className="space-y-1.5">
        <label className={labelClass}>
          {i18nService.t('userSettingsWordCountLabel')}
        </label>
        <select
          value={String(importWordCount)}
          onChange={(e) => handleImportWordCountChange(e.target.value)}
          disabled={importing}
          className={`${inputClass} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          <option value="12">{i18nService.t('userSettingsWordCount12')}</option>
          <option value="24">{i18nService.t('userSettingsWordCount24')}</option>
        </select>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {importWords.map((word, index) => (
          <label key={`import-word-${index}`} className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {i18nService.t('userSettingsWord').replace('{index}', String(index + 1))}
            <input
              type="text"
              value={word}
              disabled={importing}
              onChange={(e) => handleImportWordChange(index, e.target.value)}
              onPaste={(e) => {
                if (index === 0 && handleImportPasteMnemonic(e.clipboardData.getData('text'))) {
                  e.preventDefault();
                }
              }}
              className="mt-1 w-full rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-2 text-sm dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder={i18nService.t('userSettingsWordPlaceholder')}
            />
          </label>
        ))}
      </div>

      <div className="space-y-1.5">
        <label className={labelClass}>
          {i18nService.t('userSettingsPathLabel')}
        </label>
        <input
          type="text"
          value={importPath}
          onChange={(e) => setImportPath(e.target.value)}
          disabled={importing}
          className={`${inputClass} font-mono disabled:opacity-50 disabled:cursor-not-allowed`}
        />
      </div>

      {importError && (
        <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
          {importError}
        </div>
      )}

      <div className="pt-1">
        <button
          type="button"
          onClick={() => { void handleImport(); }}
          disabled={!canImport}
          className="btn-idchat-primary-filled px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {importing ? i18nService.t('userSettingsImporting') : i18nService.t('userSettingsImportSubmit')}
        </button>
      </div>
    </div>
  );

  const renderIdRow = (labelKey: string, value: string | null) => (
    <div className="space-y-1.5">
      <label className={labelClass}>
        {i18nService.t(labelKey)}
      </label>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border px-3 py-2 font-mono text-xs dark:text-claude-darkText text-claude-text">
          {value || '—'}
        </code>
        {value && (
          <button
            type="button"
            onClick={() => { void handleCopy(value); }}
            aria-label={i18nService.t('copy')}
            className="p-2 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
          >
            <ClipboardDocumentIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );

  const renderSyncWarning = (messageKey: string, detail?: string) => (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <div className="flex items-start gap-3 min-w-0">
        <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0">
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {i18nService.t(messageKey)}
          </p>
          {detail && (
            <p className="text-xs mt-1 text-amber-700/80 dark:text-amber-300/80 break-all">
              {detail}
            </p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => { void handleRetryChainSync(); }}
        disabled={retryingSync}
        className="inline-flex shrink-0 items-center px-3 py-1.5 text-xs font-medium rounded-xl border border-amber-500/50 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
      >
        <ArrowPathIcon className={`h-3.5 w-3.5 mr-1.5 ${retryingSync ? 'animate-spin' : ''}`} />
        {retryingSync ? i18nService.t('userSettingsRetrying') : i18nService.t('userSettingsRetryChainSync')}
      </button>
    </div>
  );

  const renderSubsidyWarning = (detail?: string) => (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <div className="flex items-start gap-3 min-w-0">
        <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
            {i18nService.t('userSettingsSubsidyFailedTitle')}
          </p>
          <p className="text-xs mt-1 text-amber-700/80 dark:text-amber-300/80">
            {i18nService.t('userSettingsSubsidyFailedMessage')}
          </p>
          {detail && (
            <p className="text-xs mt-1 text-amber-700/80 dark:text-amber-300/80 break-all">
              {detail}
            </p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => { void handleRetrySubsidy(); }}
        disabled={subsidyRetrying}
        className="inline-flex shrink-0 items-center px-3 py-1.5 text-xs font-medium rounded-xl border border-amber-500/50 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
      >
        <ArrowPathIcon className={`h-3.5 w-3.5 mr-1.5 ${subsidyRetrying ? 'animate-spin' : ''}`} />
        {subsidyRetrying ? i18nService.t('userSettingsRetryingSubsidy') : i18nService.t('userSettingsRetrySubsidy')}
      </button>
    </div>
  );

  const renderProfile = () => {
    if (!identity) return null;
    const nameMissing = !identity.name.trim();
    const nameInitial = identity.name.trim().charAt(0).toUpperCase() || '?';
    const chatPubkeyPinned = Boolean(identity.chat_public_key_pin_id);
    // Legacy identities have no recorded subsidy state; when nothing is pinned
    // yet, treat them as needing a subsidy claim so the user gets a retry path.
    const subsidyFailed = identity.subsidy_state === 'failed'
      || (!identity.subsidy_state && !chatPubkeyPinned);
    const syncIncomplete =
      identity.sync_state === 'failed' ||
      identity.sync_state === 'partial' ||
      identity.sync_state === 'pending' ||
      (!identity.sync_state && !chatPubkeyPinned);
    return (
      <div className="space-y-4">
        {/* Header with backup + logout */}
        <div className="flex items-center justify-between gap-3 pb-3 border-b dark:border-claude-darkBorder/60 border-claude-border/60">
          <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('userSettingsProfileTitle')}
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setBackupModalOpen(true)}
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
            >
              <KeyIcon className="h-3.5 w-3.5 mr-1.5" />
              {i18nService.t('userSettingsBackupMnemonic')}
            </button>
            <button
              type="button"
              onClick={() => openLogoutModal('switch')}
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
            >
              <ArrowRightStartOnRectangleIcon className="h-3.5 w-3.5 mr-1.5" />
              {i18nService.t('userSettingsSwitchAccount')}
            </button>
            <button
              type="button"
              onClick={() => openLogoutModal('logout')}
              className="px-3 py-1.5 text-xs font-medium rounded-xl bg-red-600 hover:bg-red-700 text-white transition-colors active:scale-[0.98]"
            >
              {i18nService.t('userSettingsLogout')}
            </button>
          </div>
        </div>

        {/* Name missing warning */}
        {nameMissing && (
          <div className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3">
            <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-600 dark:text-red-400">
              {i18nService.t('userSettingsNameMissingWarning')}
            </p>
          </div>
        )}

        {/* Identity card with editable name */}
        <div className="flex items-start gap-4">
          <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
            <NftAvatarFrame
              avatar={identity.avatar}
              fallbackSource={identity.avatar_fallback}
              frameClassName="w-16 h-16 rounded-full"
              imgClassName="border dark:border-claude-darkBorder border-claude-border"
              fallback={(
                <div className="flex w-16 h-16 items-center justify-center rounded-full dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
                  <span className="text-xl font-semibold dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {nameInitial}
                  </span>
                </div>
              )}
            />
            <button
              type="button"
              data-slot="user-avatar-set"
              onClick={() => {
                setAvatarEditing(true);
                setAvatarError('');
              }}
              disabled={avatarSaving}
              aria-expanded={avatarEditing}
              className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent dark:hover:text-claude-accent hover:underline disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {i18nService.t('metabotAvatarSet')}
            </button>
            {identity.avatar && (
              <button
                type="button"
                onClick={() => { void handleAvatarChange(''); }}
                disabled={avatarSaving}
                className="text-xs text-red-500 hover:underline disabled:opacity-50"
              >
                {i18nService.t('userSettingsAvatarClear')}
              </button>
            )}
          </div>
          <div className="flex-1 min-w-0 space-y-1.5">
            <label className={labelClass}>
              {i18nService.t('userSettingsNameLabel')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => {
                  setNameDraft(e.target.value);
                  if (nameError) setNameError('');
                }}
                disabled={nameSaving}
                placeholder={i18nService.t('userSettingsNamePlaceholder')}
                className={`${inputClass} ${nameMissing ? 'border-red-500 dark:border-red-500' : ''} disabled:opacity-50 disabled:cursor-not-allowed`}
              />
              <button
                type="button"
                onClick={() => { void handleSaveName(); }}
                disabled={!canSaveName}
                className="btn-idchat-primary-filled shrink-0 px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {nameSaving ? i18nService.t('saving') : i18nService.t('save')}
              </button>
            </div>
            {nameError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {nameError}
              </div>
            )}
          </div>
        </div>

        {avatarEditing && (
          <AvatarPickerModal
            ownerAddress={identity.mvc_address}
            ownerGlobalMetaId={identity.globalmetaid}
            currentReference={identity.avatar ?? ''}
            loadNfts={loadUserNfts}
            maxLocalBytes={AVATAR_MAX_SIZE_BYTES}
            onPick={(reference) => { void handleAvatarChange(reference); }}
            onPickLocal={(dataUrl) => { void handleAvatarChange(dataUrl); }}
            onError={setAvatarError}
            onClose={() => setAvatarEditing(false)}
          />
        )}
        {avatarSaving && (
          <div className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <ArrowPathIcon className="h-3.5 w-3.5 animate-spin shrink-0" />
            {i18nService.t('userSettingsAvatarSaving')}
          </div>
        )}
        {avatarError && !avatarEditing && (
          <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
            {avatarError}
          </div>
        )}

        {renderIdRow('userSettingsGlobalMetaId', identity.globalmetaid)}
        {renderIdRow('userSettingsMvcAddress', identity.mvc_address)}

        {/* MVC subsidy status: must be claimed before on-chain writes can work */}
        {subsidyFailed && renderSubsidyWarning(identity.subsidy_error ?? undefined)}

        {/* Chain sync status */}
        {syncIncomplete && (
          <div className="space-y-3">
            {!chatPubkeyPinned && !identity.sync_state && renderSyncWarning('userSettingsChatPubkeyNotPinned', identity.sync_error ?? undefined)}
            {(chatPubkeyPinned || identity.sync_state) && renderSyncWarning('userSettingsChainSyncWarning', identity.sync_error ?? undefined)}
          </div>
        )}

        {(subsidyFailed || syncIncomplete) && (
          <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('userSettingsDepositHint')}
          </div>
        )}

        {/* Chain backup & restore: encrypted soul data to /protocols/metabot-backup.
            Also refreshes the public /info/bots discovery manifest, replacing the
            old standalone "sync bots to mobile" card. */}
        <div className="flex items-start justify-between gap-3 rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {i18nService.t('userSettingsChainBackupTitle')}
            </p>
            <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('userSettingsChainBackupDescription')}
            </p>
            <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {chainBackupLastRun
                ? i18nService.t('userSettingsChainBackupLastRun').replace('{time}', new Date(chainBackupLastRun).toLocaleString())
                : i18nService.t('userSettingsChainBackupNever')}
            </p>
            {chainBackupProgressText && (
              <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {chainBackupProgressText}
              </p>
            )}
            {chainBackupResult && (
              <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary break-all">
                {chainBackupResult.success
                  ? i18nService.t('userSettingsChainBackupStats')
                      .replace('{uploaded}', String(chainBackupResult.bots.reduce((n, b) => n + b.uploadedObjects, 0)))
                      .replace('{skipped}', String(chainBackupResult.bots.reduce((n, b) => n + b.skippedObjects, 0)))
                      .replace('{segments}', String(chainBackupResult.bots.reduce((n, b) => n + b.segments, 0)))
                      .replace('{cost}', String(chainBackupResult.totalCostSats))
                  : chainBackupResult.resumable
                    ? i18nService.t('userSettingsChainBackupPaused')
                    : (chainBackupResult.error ?? chainBackupResult.bots.find((b) => b.error)?.error ?? '')}
              </p>
            )}
            {chainBackupResult && (
              chainBackupResult.bots.some((bot) => bot.resumedSegments > 0 || bot.networkRetries > 0)
              || (chainBackupResult.discoveryNetworkRetries ?? 0) > 0
            ) && (
              <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('userSettingsChainBackupResumeStats')
                  .replace('{resumed}', String(chainBackupResult.bots.reduce((n, bot) => n + bot.resumedSegments, 0)))
                  .replace('{retries}', String(
                    chainBackupResult.bots.reduce((n, bot) => n + bot.networkRetries, 0)
                    + (chainBackupResult.discoveryNetworkRetries ?? 0),
                  ))}
              </p>
            )}
            {chainBackupResult?.botsManifestError && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 break-all">
                {i18nService.t('userSettingsChainBackupManifestFailed').replace('{error}', chainBackupResult.botsManifestError)}
              </p>
            )}
            {chainBackupResult?.success && chainBackupResult.botsManifestSynced && (
              <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('userSettingsChainBackupManifestSynced')}
              </p>
            )}
            {chainRestoreResult && (
              <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary break-all">
                {chainRestoreResult.success
                  ? i18nService.t('userSettingsChainBackupRestoreStats')
                      .replace('{restored}', String(chainRestoreResult.bots.filter((b) => b.restored).length))
                      .replace('{imported}', String(chainRestoreResult.bots.reduce((n, b) => n + b.imported, 0)))
                  : (chainRestoreResult.error ?? chainRestoreResult.bots.find((b) => b.error)?.error ?? '')}
              </p>
            )}
            {chainRestoreResult?.success && chainRestoreResult.bots.some((b) => (b.warnings?.length ?? 0) > 0) && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 break-all">
                {i18nService.t('userSettingsChainBackupRestorePartial')
                  .replace('{details}', chainRestoreResult.bots
                    .flatMap((b) => (b.warnings ?? []).map((w) => `${b.name}: ${w}`))
                    .join('; ')
                    .slice(0, 400))}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-col gap-2">
            <button
              type="button"
              onClick={() => { void handleChainBackup(); }}
              disabled={chainBackupRunning || chainBackupRestoring}
              className="btn-idchat-primary-filled px-3 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ArrowPathIcon className={`h-3.5 w-3.5 mr-1.5 inline ${chainBackupRunning ? 'animate-spin' : ''}`} />
              {chainBackupRunning
                ? i18nService.t('userSettingsChainBackupRunning')
                : chainBackupResult?.resumable
                  ? i18nService.t('userSettingsChainBackupContinueButton')
                  : i18nService.t('userSettingsChainBackupButton')}
            </button>
            <button
              type="button"
              onClick={() => { void handleChainRestore(); }}
              disabled={chainBackupRunning || chainBackupRestoring}
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-black/5 dark:hover:bg-white/5 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ArrowPathIcon className={`h-3.5 w-3.5 mr-1.5 inline ${chainBackupRestoring ? 'animate-spin' : ''}`} />
              {chainBackupRestoring ? i18nService.t('userSettingsChainBackupRestoreRunning') : i18nService.t('userSettingsChainBackupRestoreButton')}
            </button>
          </div>
        </div>

        {/* S3 收款设置入口：不再直接摊开表单（design doc 02；owner 2026-11-04 要求收敛），
            点击弹出 Modal 面板配置收款信息，表单加密逻辑不变 */}
        <button
          type="button"
          data-payment-settings-entry="true"
          onClick={() => dispatchPaymentSettings({ type: 'open' })}
          className="w-full flex items-center gap-3 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-claude-accent/5 dark:hover:bg-white/5 hover:bg-black/[0.03] active:scale-[0.995] px-4 py-3 text-left transition-colors"
        >
          <span className="flex-shrink-0 w-10 h-10 rounded-xl bg-claude-accent/15 flex items-center justify-center">
            <CreditCardIcon className="h-5 w-5 text-claude-accent" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium dark:text-claude-darkText text-claude-text">
              {i18nService.t('paymentSettingsTitle')}
            </span>
            <span className="block mt-0.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
              {i18nService.t('paymentSettingsEntryDesc')}
            </span>
          </span>
          <ChevronRightIcon className="flex-shrink-0 h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        </button>

        {/* Logout confirmation modal */}
        {logoutModalOpen && (
          <div
            className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
            onClick={() => { if (!logoutLoading) setLogoutModalOpen(false); }}
          >
            <div
              className="w-full max-w-lg dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal border dark:border-claude-darkBorder border-claude-border overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-6 py-6 max-h-[75vh] overflow-y-auto">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                    <ExclamationTriangleIcon className="h-5 w-5 text-red-500" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                      {i18nService.t(logoutMode === 'switch' ? 'userSettingsSwitchConfirmTitle' : 'userSettingsLogoutConfirmTitle')}
                    </h2>
                    <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t(logoutMode === 'switch' ? 'userSettingsSwitchConfirmWarning' : 'userSettingsLogoutConfirmWarning')}
                    </p>
                  </div>
                </div>

                <div className="mt-5">
                  <button
                    type="button"
                    onClick={() => { void handleRevealMnemonic(); }}
                    disabled={revealLoading || logoutLoading}
                    className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                  >
                    {revealLoading
                      ? i18nService.t('loading')
                      : revealedMnemonic
                        ? i18nService.t('userSettingsHideMnemonic')
                        : i18nService.t('userSettingsRevealMnemonic')}
                  </button>
                  {revealError && (
                    <div className="mt-2 text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                      {revealError}
                    </div>
                  )}
                  {revealedWords.length > 0 && (
                    <div className="mt-3 rounded-lg bg-claude-surface dark:bg-claude-darkBg border dark:border-claude-darkBorder border-claude-border p-4">
                      <MnemonicWordGrid words={revealedWords} />
                    </div>
                  )}
                </div>

                {logoutError && (
                  <div className="mt-4 text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                    {logoutError}
                  </div>
                )}

                <div className="mt-6 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setLogoutModalOpen(false)}
                    disabled={logoutLoading}
                    className="px-4 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleLogout(); }}
                    disabled={logoutLoading}
                    className="px-4 py-2 text-sm rounded-xl bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {i18nService.t(logoutMode === 'switch' ? 'userSettingsSwitchConfirm' : 'userSettingsLogoutConfirm')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* S3 收款设置 Modal —— 点遮罩 / 右上角 ✕ / 取消均可关闭；
            保存成功后 2 秒提示并停留在 Modal 内（可继续编辑或手动关闭） */}
        {paymentSettings.open && (
          <PaymentReceivingSettingsModal
            state={paymentSettings}
            dispatch={dispatchPaymentSettings}
            onClose={() => dispatchPaymentSettings({ type: 'close' })}
          />
        )}

        {chainRestorePrompt && (
          <ChainBackupRestorePrompt
            botCount={chainRestorePrompt.botCount}
            backupBotCount={chainRestorePrompt.backupBotCount}
            restoring={chainBackupRestoring}
            onCancel={() => setChainRestorePrompt(null)}
            onConfirm={() => {
              setChainRestorePrompt(null);
              void handleChainRestore(true);
            }}
          />
        )}

        {/* Post-backup mnemonic reminder */}
        {mnemonicReminderOpen && (
          <ChainBackupMnemonicReminderModal
            onViewMnemonic={() => {
              setMnemonicReminderOpen(false);
              setBackupModalOpen(true);
            }}
            onClose={() => setMnemonicReminderOpen(false)}
          />
        )}

        {/* Backup mnemonic modal */}
        {backupModalOpen && (
          <UserBackupMnemonicModal onClose={() => setBackupModalOpen(false)} />
        )}
      </div>
    );
  };

  return (
    <div className="h-full">
      {loadError && (
        <div className="mb-3 text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
          {loadError}
        </div>
      )}
      {view === 'loading' && renderLoading()}
      {view === 'empty' && renderEmpty()}
      {view === 'create' && renderCreate()}
      {view === 'backup' && renderBackup()}
      {view === 'import' && renderImport()}
      {view === 'profile' && renderProfile()}
    </div>
  );
};

export default UserSettings;
