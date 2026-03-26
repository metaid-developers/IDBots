export type GigSquareRefundRisk = {
  hasUnresolvedRefund: boolean;
  unresolvedRefundAgeHours: number;
  hidden?: boolean;
};

export type GigSquareService = {
  id: string;
  serviceName: string;
  displayName: string;
  description: string;
  price: string;
  currency: string;
  providerMetaId: string;
  providerGlobalMetaId: string;
  providerAddress: string;
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
  serviceName: string;
  displayName: string;
  description: string;
  price: string;
  currency: string;
  providerMetaId: string;
  providerGlobalMetaId: string;
  providerAddress: string;
  avatar?: string | null;
  serviceIcon?: string | null;
  providerSkill?: string | null;
  successCount: number;
  refundCount: number;
  grossRevenue: string;
  netIncome: string;
  ratingAvg: number;
  ratingCount: number;
  updatedAt: number;
};

export type GigSquareMyServiceOrderRating = {
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
  coworkSessionId: string | null;
  rating: GigSquareMyServiceOrderRating | null;
};
