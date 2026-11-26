export interface RemoteTenantTask {
  id: string;
  userId: string;
  containerName: string;
  volumeName: string;
  image: string;
  previousImage: string | null;
  imageDigest: string | null;
  status: string;
  appVersion: string | null;
  contractVersion: string | null;
}

export interface RemoteUpgradeTask {
  tenant: RemoteTenantTask;
  user: { id: string; displayName: string; locale: string };
  gatewaySecret: string;
  newImage: string;
  config: {
    publicOrigin: string;
    tenantNetwork: string;
    tenantMemoryMb: number;
    tenantCpus: number;
    tenantEnv: Record<string, string>;
  };
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

export interface RemoteUpgradeResult {
  result: { tenantId: string; outcome: string; detail: string };
  tenant: {
    status: string;
    image: string;
    previous_image: string | null;
    image_digest: string | null;
    app_version: string | null;
    contract_version: string | null;
    last_error: string | null;
  };
}

interface RequestMessage {
  type: 'request';
  id: string;
  action: 'preflight' | 'upgrade';
  payload: unknown;
}

interface ResponseMessage {
  type: 'response';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export type AgentRequestMessage = RequestMessage;
export type AgentResponseMessage = ResponseMessage;
