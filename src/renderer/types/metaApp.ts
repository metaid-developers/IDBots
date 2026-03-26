export interface MetaAppRecord {
  id: string;
  name: string;
  description: string;
  isOfficial: boolean;
  updatedAt: number;
  entry: string;
  appPath: string;
  appRoot: string;
  prompt: string;
  version: string;
  creatorMetaId: string;
  sourceType: 'bundled-idbots' | 'chain-idbots' | 'chain-community' | 'manual' | string;
  managedByIdbots: boolean;
}

export interface MetaAppUrlResult {
  success: boolean;
  appId?: string;
  name?: string;
  url?: string;
  error?: string;
}
