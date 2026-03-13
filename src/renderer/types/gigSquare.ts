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
};

export type GigSquareProviderInfo = {
  chatPubkey?: string;
  globalMetaId?: string;
  metaid?: string;
  address?: string;
  name?: string;
  avatar?: string | null;
};
