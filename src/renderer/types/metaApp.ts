export interface MetaAppRecord {
  id: string;
  name: string;
  description: string;
  icon?: string;
  cover?: string;
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

export interface CommunityMetaAppRecord {
  appId: string;
  name: string;
  description: string;
  icon?: string;
  cover?: string;
  version: string;
  runtime: string;
  creatorMetaId: string;
  sourcePinId: string;
  publishedAt: number;
  indexFile: string;
  codeUri: string;
  codePinId: string;
  status: 'install' | 'installed' | 'update' | 'uninstallable';
  installable: boolean;
  reason: string;
}

export interface MetaAppUrlResult {
  success: boolean;
  appId?: string;
  name?: string;
  url?: string;
  error?: string;
}

export interface CommunityMetaAppListResult {
  success: boolean;
  apps?: CommunityMetaAppRecord[];
  error?: string;
}

export interface CommunityMetaAppInstallResult {
  success: boolean;
  appId?: string;
  name?: string;
  status?: 'installed' | 'updated' | 'already-installed';
  error?: string;
}
