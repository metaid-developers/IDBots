import React from 'react';
import { i18nService } from '../../services/i18n';

interface GigSquareHeaderActionsProps {
  pendingRefundCount: number;
  onOpenMyServices: () => void;
  onOpenRefunds: () => void;
  onOpenPublish: () => void;
}

const GigSquareHeaderActions: React.FC<GigSquareHeaderActionsProps> = ({
  pendingRefundCount,
  onOpenMyServices,
  onOpenRefunds,
  onOpenPublish,
}) => (
  <div className="flex items-center gap-2.5">
    <button
      type="button"
      onClick={onOpenMyServices}
      className="btn-idchat-primary whitespace-nowrap px-3 py-1.5 text-xs font-medium"
    >
      {i18nService.t('gigSquareMyServicesButton')}
    </button>
    <button
      type="button"
      onClick={onOpenRefunds}
      className="btn-idchat-primary whitespace-nowrap px-3 py-1.5 text-xs font-medium"
    >
      <span>{i18nService.t('gigSquareRefundsButton')}</span>
      {pendingRefundCount > 0 && (
        <span className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
          {pendingRefundCount}
        </span>
      )}
    </button>
    <button
      type="button"
      onClick={onOpenPublish}
      className="btn-idchat-primary whitespace-nowrap px-3 py-1.5 text-xs font-medium"
    >
      {i18nService.t('gigSquarePublishButton')}
    </button>
  </div>
);

export default GigSquareHeaderActions;
