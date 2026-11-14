import React from 'react';
import ReactMarkdown from 'react-markdown';
import { XMarkIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../services/i18n';

interface UpdateNotificationModalProps {
  title: string;
  content: string;
  onClose: () => void;
}

/**
 * Update notification modal component
 *
 * Displays important update notices to users after app upgrades.
 * Features:
 * - Clean, centered modal with backdrop
 * - Markdown support for rich content
 * - Smooth animations
 * - Beautiful close button with icon
 */
const UpdateNotificationModal: React.FC<UpdateNotificationModalProps> = ({
  title,
  content,
  onClose,
}) => {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center animate-fadeIn"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-notification-title"
        className="relative w-[90%] max-w-2xl max-h-[80vh] rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] shadow-2xl animate-slideUp"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-color)] px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600">
              <SparklesIcon className="h-5 w-5 text-white" />
            </div>
            <h2
              id="update-notification-title"
              className="text-lg font-semibold text-[var(--text-primary)]"
            >
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto px-6 py-5 max-h-[calc(80vh-140px)]">
          <div className="prose prose-sm max-w-none text-[var(--text-primary)]">
            <ReactMarkdown
              components={{
                h2: ({ children }) => (
                  <h2 className="text-base font-semibold text-[var(--text-primary)] mb-3 mt-4 first:mt-0">
                    {children}
                  </h2>
                ),
                h3: ({ children }) => (
                  <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2 mt-3">
                    {children}
                  </h3>
                ),
                p: ({ children }) => (
                  <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3">
                    {children}
                  </p>
                ),
                ul: ({ children }) => (
                  <ul className="list-disc pl-5 mb-3 space-y-1.5">
                    {children}
                  </ul>
                ),
                ol: ({ children }) => (
                  <ol className="list-decimal pl-5 mb-3 space-y-1.5">
                    {children}
                  </ol>
                ),
                li: ({ children }) => (
                  <li className="text-sm text-[var(--text-secondary)]">
                    {children}
                  </li>
                ),
                strong: ({ children }) => (
                  <strong className="font-semibold text-[var(--text-primary)]">
                    {children}
                  </strong>
                ),
                code: ({ children }) => (
                  <code className="px-1.5 py-0.5 rounded bg-[var(--bg-main)] border border-[var(--border-color)] text-xs font-mono text-[var(--color-primary)]">
                    {children}
                  </code>
                ),
                blockquote: ({ children }) => (
                  <blockquote className="border-l-3 border-[var(--color-primary)] pl-4 italic text-[var(--text-secondary)] my-3">
                    {children}
                  </blockquote>
                ),
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-[var(--border-color)] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="btn-idchat-primary-filled text-sm font-medium transition-[filter]"
          >
            {i18nService.t('gotIt')}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(20px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        .animate-fadeIn {
          animation: fadeIn 0.2s ease-out;
        }

        .animate-slideUp {
          animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }
      `}</style>
    </div>
  );
};

export default UpdateNotificationModal;
