import type { VersionedComposerField } from './coworkPromptSubmission';
import { runComposerSubmission } from './coworkPromptSubmission';

/**
 * The attachment contract of the Cowork composer: when an attachment may be
 * taken, how incoming files become attachments, how attachments ride a submit,
 * and how they roll back when the parent refuses one.
 *
 * Steering (typing/sending while a turn is still streaming) is gated by the
 * `steerDisabled` prop, NEVER by `isStreaming` alone: plain text already walks
 * through that door mid-run, so an attached image has to be treated exactly the
 * same. Three doors feed the attachment field — clipboard paste, file drop and
 * the '+' picker — and all three read the ONE predicate below so they cannot
 * drift apart again.
 *
 * The submit half used to be the half that silently ate the file: the running
 * branch composed the prompt from the text alone and never even snapshotted the
 * attachment field, so an image that got past a door vanished on send.
 * `composeCoworkSubmitPrompt` and `submitCoworkComposerDraft` are shared by both
 * branches on purpose — there is no `isStreaming` fork left in them.
 */

export interface CoworkComposerAttachment {
  path: string;
  name: string;
}

export interface CoworkAttachmentGate {
  disabled: boolean;
  isStreaming: boolean;
  steerDisabled: boolean;
}

/** May the composer take (or take back) an attachment right now? */
export const coworkAttachmentAdmission = ({
  disabled,
  isStreaming,
  steerDisabled,
}: CoworkAttachmentGate): boolean => !(disabled || (isStreaming && steerDisabled));

export interface CoworkIncomingAttachmentHandlers {
  /** Native filesystem path the File already carries (Finder drag, some pastes). */
  getNativeFilePath: (file: File) => string | null;
  /** Fallback for clipboard files that only have bytes: stage them, return the saved path. */
  saveInlineFile: (file: File) => Promise<string | null>;
  /** Receives each resolved path as soon as it is known, so a multi-file drop still fills in incrementally. */
  onAttachment: (path: string) => void;
}

/**
 * Resolve dropped/pasted files into attachment paths, in order. This is the
 * body BEHIND both the paste and the drop door, so they cannot disagree about
 * which files are attachable. An unresolvable file contributes nothing — never
 * a blank chip.
 */
export const forEachIncomingAttachmentPath = async (
  files: ArrayLike<File>,
  handlers: CoworkIncomingAttachmentHandlers,
): Promise<void> => {
  for (const file of Array.from(files ?? [])) {
    const nativePath = handlers.getNativeFilePath(file);
    if (nativePath) {
      handlers.onAttachment(nativePath);
      continue;
    }
    const stagedPath = await handlers.saveInlineFile(file);
    if (stagedPath) {
      handlers.onAttachment(stagedPath);
    }
  }
};

export interface CoworkSubmitComposition {
  trimmedValue: string;
  attachmentLines: string;
  finalPrompt: string;
}

/**
 * The one composition rule for a submit, idle or steering. Attachments ride the
 * same `<label>: <path>` manifest the rest of the app already reads. No
 * `isStreaming` branch lives here — that fork is exactly what dropped a mid-run
 * image on the floor.
 */
export const composeCoworkSubmitPrompt = ({
  submittedValue,
  attachments,
  inputFileLabel,
}: {
  submittedValue: string;
  attachments: CoworkComposerAttachment[];
  inputFileLabel: string;
}): CoworkSubmitComposition => {
  const trimmedValue = submittedValue.trim();
  const attachmentLines = attachments
    .map((attachment) => `${inputFileLabel}: ${attachment.path}`)
    .join('\n');
  const finalPrompt = trimmedValue
    ? (attachmentLines ? `${trimmedValue}\n\n${attachmentLines}` : trimmedValue)
    : attachmentLines;
  return { trimmedValue, attachmentLines, finalPrompt };
};

/**
 * Hand a composed submission to the parent and keep the two composer fields in
 * step: text and attachments are cleared together, and BOTH come back when the
 * parent refuses (`false`) or throws. Taking only the text snapshot — the old
 * steering path — is how a refused mid-run send ate the attachment.
 */
export const submitCoworkComposerDraft = async ({
  draftField,
  attachmentField,
  onSubmit,
}: {
  draftField: VersionedComposerField<string>;
  attachmentField: VersionedComposerField<CoworkComposerAttachment[]>;
  onSubmit: () => void | boolean | Promise<void | boolean>;
}): Promise<void | boolean> => {
  const draftSnapshot = draftField.takeAndClear();
  const attachmentSnapshot = attachmentField.takeAndClear();
  try {
    const accepted = await runComposerSubmission(draftField, draftSnapshot, onSubmit);
    if (accepted === false) {
      attachmentField.restoreIfUnchanged(attachmentSnapshot);
    }
    return accepted;
  } catch (error) {
    attachmentField.restoreIfUnchanged(attachmentSnapshot);
    throw error;
  }
};
