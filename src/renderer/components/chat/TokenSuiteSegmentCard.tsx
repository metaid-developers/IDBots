import React from 'react';
import TokenCard, { TokenCardStreamingPlaceholder } from './TokenCard';
import FtOrderCard from './FtOrderCard';
import FtQuoteCard from './FtQuoteCard';
import FtFillCard from './FtFillCard';
import FtMyOrdersCard from './FtMyOrdersCard';
import FtPortfolioCard from './FtPortfolioCard';
import FtBridgeCard from './FtBridgeCard';
import FtActionCard from './FtActionCard';
import type { TokenCardMessageSegment } from './tokenCardSyntax';

export interface TokenSuiteSegmentCardProps {
  segment: Exclude<TokenCardMessageSegment, { kind: 'markdown' }>;
}

/**
 * Renders any standalone Token / FT Suite card segment outside of gray prose
 * bubbles across Studio, Desktop Cowork, and Cloud Mobile.
 */
export const TokenSuiteSegmentCard: React.FC<TokenSuiteSegmentCardProps> = ({ segment }) => {
  switch (segment.kind) {
    case 'token-card':
      return <TokenCard data={segment.data} />;
    case 'ft-order-card':
      return <FtOrderCard data={segment.data} />;
    case 'ft-quote-card':
      return <FtQuoteCard data={segment.data} />;
    case 'ft-fill-card':
      return <FtFillCard data={segment.data} />;
    case 'ft-my-orders-card':
      return <FtMyOrdersCard data={segment.data} />;
    case 'ft-portfolio-card':
      return <FtPortfolioCard data={segment.data} />;
    case 'ft-bridge-card':
      return <FtBridgeCard data={segment.data} />;
    case 'ft-action-card':
      return <FtActionCard data={segment.data} />;
    case 'token-card-streaming':
      return <TokenCardStreamingPlaceholder />;
  }
};

export default TokenSuiteSegmentCard;
