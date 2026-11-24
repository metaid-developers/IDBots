import React from 'react';
import TokenCard, { TokenCardStreamingPlaceholder } from './TokenCard';
import FtOrderCard from './FtOrderCard';
import FtOrderBookCard from './FtOrderBookCard';
import FtQuoteCard from './FtQuoteCard';
import FtFillCard from './FtFillCard';
import FtMyOrdersCard from './FtMyOrdersCard';
import FtPortfolioCard from './FtPortfolioCard';
import FtBridgeCard from './FtBridgeCard';
import FtActionCard from './FtActionCard';
import NftCard, { NftCardGroup } from './NftCard';
import NftCollectionCard from './NftCollectionCard';
import NftListingCard from './NftListingCard';
import NftFillCard from './NftFillCard';
import NftMyListingsCard from './NftMyListingsCard';
import NftPortfolioCard from './NftPortfolioCard';
import NftSwapCard from './NftSwapCard';
import NftActionCard from './NftActionCard';
import NftNegotiateCard from './NftNegotiateCard';
import EscrowCard from './EscrowCard';
import type { TokenCardMessageSegment } from './tokenCardSyntax';

export interface TokenSuiteSegmentCardProps {
  segment: Exclude<TokenCardMessageSegment, { kind: 'markdown' }>;
  /** True when rendered on the user's right-aligned message side. */
  userSide?: boolean;
}

/**
 * Renders any standalone Token, FT, NFT, or Escrow Suite card segment outside
 * of gray prose bubbles across Studio, Desktop Cowork, and Cloud Mobile.
 */
export const TokenSuiteSegmentCard: React.FC<TokenSuiteSegmentCardProps> = ({
  segment,
  userSide = false,
}) => {
  switch (segment.kind) {
    case 'token-card':
      return <TokenCard data={segment.data} />;
    case 'ft-order-card':
      return <FtOrderCard data={segment.data} />;
    case 'ft-orderbook-card':
      return <FtOrderBookCard data={segment.data} />;
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
    case 'nft-card':
      return <NftCard data={segment.data} userSide={userSide} />;
    case 'nft-card-group':
      return <NftCardGroup cards={segment.data} userSide={userSide} />;
    case 'nft-collection-card':
      return <NftCollectionCard data={segment.data} />;
    case 'nft-listing-card':
      return <NftListingCard data={segment.data} />;
    case 'nft-fill-card':
      return <NftFillCard data={segment.data} />;
    case 'nft-my-listings-card':
      return <NftMyListingsCard data={segment.data} />;
    case 'nft-portfolio-card':
      return <NftPortfolioCard data={segment.data} />;
    case 'nft-swap-card':
      return <NftSwapCard data={segment.data} />;
    case 'nft-action-card':
      return <NftActionCard data={segment.data} />;
    case 'nft-negotiate-card':
      return <NftNegotiateCard data={segment.data} />;
    case 'escrow-card':
      return <EscrowCard data={segment.data} />;
    case 'token-card-streaming':
      return <TokenCardStreamingPlaceholder />;
  }
};

export default TokenSuiteSegmentCard;
