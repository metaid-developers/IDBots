import React, { useState } from 'react';
import type { CoworkMessage } from '../../types/cowork';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';

interface A2AMessageItemProps {
  message: CoworkMessage;
  /** Remote peer MetaBot name */
  peerName?: string | null;
  /** Remote peer MetaBot avatar data URL */
  peerAvatar?: string | null;
  /** Local MetaBot name */
  metabotName?: string | null;
  /** Local MetaBot avatar data URL */
  metabotAvatar?: string | null;
}

const formatTime = (timestamp: number): string => {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
};

const DEFAULT_METABOT_AVATAR = '/default_metabot.png';

const Avatar: React.FC<{ src?: string | null; name?: string | null; size?: number }> = ({
  src,
  name,
  size = 32,
}) => (
  <img
    src={src || DEFAULT_METABOT_AVATAR}
    alt={name || ''}
    style={{ width: size, height: size }}
    className="rounded-full object-cover flex-shrink-0"
    onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_METABOT_AVATAR; }}
  />
);

const ToolCallBlock: React.FC<{ message: CoworkMessage }> = ({ message }) => {
  const [open, setOpen] = useState(false);
  const toolName = (message.metadata?.toolName as string | undefined) || message.content || 'tool';
  const toolInput = message.metadata?.toolInput;
  const toolResult = message.metadata?.toolResult as string | undefined;

  return (
    <div className="my-1 rounded-lg border dark:border-claude-darkBorder border-claude-border overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary hover:opacity-80 transition-opacity text-left"
      >
        {open ? (
          <ChevronDownIcon className="h-3.5 w-3.5 flex-shrink-0" />
        ) : (
          <ChevronRightIcon className="h-3.5 w-3.5 flex-shrink-0" />
        )}
        <span className="font-mono">{toolName}</span>
      </button>
      {open && (
        <div className="px-3 py-2 dark:bg-claude-darkBg bg-claude-bg space-y-1">
          {toolInput !== undefined && (
            <pre className="whitespace-pre-wrap break-all dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {JSON.stringify(toolInput, null, 2)}
            </pre>
          )}
          {toolResult !== undefined && (
            <pre className="whitespace-pre-wrap break-all dark:text-claude-darkText text-claude-text border-t dark:border-claude-darkBorder border-claude-border pt-1 mt-1">
              {toolResult}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

const A2AMessageItem: React.FC<A2AMessageItemProps> = ({
  message,
  peerName,
  peerAvatar,
  metabotName,
  metabotAvatar,
}) => {
  // tool_use / tool_result: collapsible block, shown inline (local MetaBot only)
  if (message.type === 'tool_use' || message.type === 'tool_result') {
    return (
      <div className="px-4 py-0.5">
        <ToolCallBlock message={message} />
      </div>
    );
  }

  // system messages: subtle center label
  if (message.type === 'system') {
    return (
      <div className="px-4 py-1 flex justify-center">
        <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary italic">
          {message.content}
        </span>
      </div>
    );
  }

  // user = incoming from peer MetaBot (left side)
  // assistant = outgoing from local MetaBot (right side)
  const isLocal = message.type === 'assistant';

  // Resolve display name and avatar
  const fromName = isLocal
    ? (metabotName || 'MetaBot')
    : ((message.metadata?.fromName as string | undefined) || peerName || 'Peer');
  const fromAvatar = isLocal
    ? ((message.metadata?.fromAvatar as string | undefined) || metabotAvatar)
    : ((message.metadata?.fromAvatar as string | undefined) || peerAvatar);

  return (
    <div className={`flex items-end gap-2 px-4 py-1 ${isLocal ? 'flex-row-reverse' : 'flex-row'}`}>
      <Avatar src={fromAvatar} name={fromName} size={32} />
      <div className={`flex flex-col max-w-[70%] ${isLocal ? 'items-end' : 'items-start'}`}>
        <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-0.5 px-1">
          {fromName}
        </span>
        <div
          className={`rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
            isLocal
              ? 'bg-blue-500 text-white rounded-br-sm'
              : 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text rounded-bl-sm'
          }`}
        >
          {message.content}
        </div>
        <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5 px-1">
          {formatTime(message.timestamp)}
        </span>
      </div>
    </div>
  );
};

export default A2AMessageItem;
