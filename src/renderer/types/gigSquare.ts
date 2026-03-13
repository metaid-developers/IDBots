export type GigSquareService = {
  id: string;
  serviceName: string;
  displayName: string;
  description: string;
  price: number;
  currency: string;
  providerMetaId: string;
  providerGlobalMetaId: string;
  providerAddress: string;
  avatar?: string | null;
};

export type GigSquareProviderInfo = {
  chatPubkey: string;
};
