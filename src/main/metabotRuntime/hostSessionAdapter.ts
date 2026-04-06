import type { OrderSource } from '../services/orderPayment';

export interface StartProviderSessionInput {
  metabotId: number;
  source: OrderSource;
  externalConversationId: string;
  existingSessionId?: string | null;
  prompt: string;
  systemPrompt: string;
  title?: string;
  peerGlobalMetaId?: string | null;
  peerName?: string | null;
  peerAvatar?: string | null;
  servicePinId: string;
  requesterGlobalMetaId: string;
  userTask: string;
  taskContext: string;
}

export interface ProviderSessionResult {
  sessionId: string;
  text: string;
  attachments?: string[];
  ratingInvite?: string;
}

export interface HostSessionAdapter {
  startProviderSession(input: StartProviderSessionInput): Promise<{ sessionId: string }>;
  waitForProviderResult(sessionId: string): Promise<ProviderSessionResult>;
}
