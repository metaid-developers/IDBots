/**
 * The "reply" entry on a message's hover action bar: quoting one whole
 * message into the composer's quote slot, so the next message answers that
 * message directly.
 *
 * It only exists for messages that carry text — tool blocks, placeholders and
 * empty blocks render nothing. Both user and assistant messages mount it, so a
 * reply can target either side of the conversation.
 */

import React from 'react';
import { ChatBubbleBottomCenterTextIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { hasQuotableText } from './coworkQuotedSelections';

interface CoworkMessageReplyActionProps {
  /** The message text the reply would quote; empty/whitespace renders nothing. */
  text: string;
  visible?: boolean;
  onReply: () => void;
}

const CoworkMessageReplyAction: React.FC<CoworkMessageReplyActionProps> = ({
  text,
  visible = true,
  onReply,
}) => {
  if (!hasQuotableText(text)) return null;
  const label = i18nService.t('coworkQuoteReplyAction');
  return (
    <button
      type="button"
      data-cowork-quote-reply-action="true"
      onClick={onReply}
      title={label}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-all duration-200 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      <ChatBubbleBottomCenterTextIcon className="h-3 w-3" />
      {label}
    </button>
  );
};

export default CoworkMessageReplyAction;
