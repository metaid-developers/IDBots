import React from 'react';
import { XMarkIcon, InformationCircleIcon } from '@heroicons/react/24/outline';

interface ToastProps {
  message: string;
  onClose?: () => void;
}

const Toast: React.FC<ToastProps> = ({ message, onClose }) => {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none bg-transparent dark:bg-black/20">
      <div className="w-full max-w-sm mx-4 rounded-2xl border border-claude-border/70 dark:border-white/15 pointer-events-auto bg-white/95 dark:bg-[#111827] text-claude-text dark:text-white px-6 py-4 shadow-xl dark:shadow-[0_20px_60px_rgba(0,0,0,0.55)] backdrop-blur-md animate-scale-in">
        <div className="flex items-center gap-4">
          <div className="shrink-0 rounded-full bg-claude-accent/10 dark:bg-claude-accent/20 p-2.5">
            <InformationCircleIcon className="h-5 w-5 text-claude-accent" />
          </div>
          <div className="flex-1 text-base font-semibold leading-none">
            {message}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="shrink-0 text-claude-textSecondary dark:text-white/70 hover:text-claude-text dark:hover:text-white rounded-full p-1 hover:bg-claude-surfaceHover dark:hover:bg-white/10 transition-colors"
              aria-label="Close"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Toast;
