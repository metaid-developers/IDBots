export type GigSquareRefundRisk = {
  hasUnresolvedRefund: boolean;
  unresolvedRefundAgeHours: number;
  hidden?: boolean;
};

export type GigSquareService = {
  id: string;
  currentPinId?: string;
  sourceServicePinId?: string;
  serviceName: string;
  displayName: string;
  description: string;
  price: string;
  currency: string;
  settlementKind?: string | null;
  paymentChain?: string | null;
  mrc20Ticker?: string | null;
  mrc20Id?: string | null;
  providerMetaId: string;
  providerGlobalMetaId: string;
  providerAddress: string;
  createAddress?: string | null;
  paymentAddress?: string | null;
  avatar?: string | null;
  serviceIcon?: string | null;
  providerSkill?: string | null;
  ratingAvg?: number;
  ratingCount?: number;
  updatedAt?: number;
  refundRisk?: GigSquareRefundRisk | null;
};

export type GigSquareProviderInfo = {
  chatPubkey?: string;
  globalMetaId?: string;
  metaid?: string;
  address?: string;
  name?: string;
  avatar?: string | null;
};

export type GigSquarePageResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type GigSquareMyServiceSummary = {
  id: string;
  currentPinId: string;
  sourceServicePinId: string;
  serviceName: string;
  displayName: string;
  description: string;
  price: string;
  currency: string;
  settlementKind?: string | null;
  paymentChain?: string | null;
  mrc20Ticker?: string | null;
  mrc20Id?: string | null;
  providerMetaId: string;
  providerGlobalMetaId: string;
  providerAddress: string;
  createAddress?: string | null;
  paymentAddress?: string | null;
  avatar?: string | null;
  serviceIcon?: string | null;
  providerSkill?: string | null;
  outputType?: string | null;
  creatorMetabotId: number | null;
  creatorMetabotName?: string | null;
  creatorMetabotAvatar?: string | null;
  canModify: boolean;
  canRevoke: boolean;
  blockedReason: string | null;
  successCount: number;
  refundCount: number;
  grossRevenue: string;
  netIncome: string;
  ratingAvg: number;
  ratingCount: number;
  updatedAt: number;
};

export type GigSquareMyServiceOrderRating = {
  pinId?: string | null;
  rate: number;
  comment: string | null;
  createdAt: number | null;
  raterGlobalMetaId: string | null;
  raterMetaId: string | null;
};

export type GigSquareMyServiceOrderDetail = {
  id: string;
  status: string;
  paymentTxid: string | null;
  paymentAmount: string;
  paymentCurrency: string;
  servicePinId: string | null;
  createdAt: number | null;
  deliveredAt: number | null;
  refundCompletedAt: number | null;
  counterpartyGlobalMetaid: string | null;
  counterpartyName?: string | null;
  counterpartyAvatar?: string | null;
  coworkSessionId: string | null;
  rating: GigSquareMyServiceOrderRating | null;
};

export type GigSquareModifyServiceParams = {
  serviceId: string;
  serviceName?: string;
  displayName?: string;
  description?: string;
  providerSkill?: string;
  price?: string;
  currency?: string;
  mrc20Ticker?: string;
  mrc20Id?: string;
  outputType?: string;
  serviceIconDataUrl?: string | null;
};

export type GigSquareServiceMutationResult = {
  success: boolean;
  txids?: string[];
  pinId?: string;
  creatorMetabotId?: number;
  warning?: string;
  error?: string;
  errorCode?: string;
};
