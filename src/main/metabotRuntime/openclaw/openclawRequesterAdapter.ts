import fs from 'fs/promises';
import path from 'path';
import { normalizeAttachmentRefs } from '../attachmentRefs';
import type {
  PendingRequesterDeliveryTarget,
  ProviderDeliveryEnvelope,
  ProviderWakeUpEnvelope,
  RequestWriteRecord,
} from '../transportRuntime';
import { resolveRequesterDeliveryTarget } from '../transportRuntime';

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const toSafeNullableString = (value: unknown): string | null => {
  const normalized = toSafeString(value);
  return normalized || null;
};

const toSafeArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const toSafeNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function requireNonEmptyString(name: string, value: unknown): string {
  const normalized = toSafeString(value);
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function requirePositiveInteger(name: string, value: unknown): number {
  const normalized = Math.trunc(toSafeNumber(value));
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return normalized;
}

export interface OpenClawRemoteServiceCandidate {
  pinId: string;
  displayName: string;
  serviceName?: string;
  description?: string;
  providerGlobalMetaId?: string;
  price?: string;
  currency?: string;
}

export interface OpenClawLocalExecutionState {
  status: string;
}

export interface EvaluateRequesterRoutingInput {
  localExecution?: Partial<OpenClawLocalExecutionState> | null;
  remoteCandidates?: Array<Partial<OpenClawRemoteServiceCandidate> | Record<string, unknown>>;
  explicitRemoteServicePinId?: string | null;
}

export type RequesterRoutingDecision =
  | { action: 'use_local' }
  | { action: 'wait_local' }
  | { action: 'recommend_remote'; recommendedService: OpenClawRemoteServiceCandidate }
  | { action: 'await_confirmation'; selectedService: OpenClawRemoteServiceCandidate };

export interface OpenClawPendingRequestRecord extends PendingRequesterDeliveryTarget {
  requesterConversationId?: string | null;
  servicePinId?: string;
  createdAt?: number;
}

export interface RequesterResultInjection {
  requestId: string;
  requesterSessionId: string;
  requesterConversationId: string | null;
  targetSessionId: string;
  message: {
    text: string;
    attachments: string[];
    servicePinId: string;
    paymentTxid: string | null;
    deliveryMessagePinId: string | null;
    deliveredAt: number;
  };
}

export interface SubmitOpenClawRemoteRequestInput {
  metabotId: number;
  servicePinId: string;
  requestId: string;
  requesterSessionId: string;
  requesterConversationId?: string | null;
  requesterGlobalMetaId: string;
  targetSessionId: string;
  userTask: string;
  taskContext: string;
  confirm: boolean;
  price?: string;
  currency?: string;
  paymentTxid?: string | null;
  paymentChain?: string | null;
  orderReferenceId?: string | null;
}

export interface OpenClawRequesterBridgeDeps {
  pendingRequestsFile: string;
  listServices(): Promise<{ services: Array<Partial<OpenClawRemoteServiceCandidate> | Record<string, unknown>> }>;
  requestService(input: SubmitOpenClawRemoteRequestInput): Promise<{
    request_write: RequestWriteRecord;
    provider_wakeup: ProviderWakeUpEnvelope;
  }>;
}

function normalizeRemoteServiceCandidate(
  input: Partial<OpenClawRemoteServiceCandidate> | Record<string, unknown>,
): OpenClawRemoteServiceCandidate | null {
  const record = input as Record<string, unknown>;
  const pinId = toSafeString(record.pinId ?? record.service_pin_id);
  if (!pinId) return null;

  return {
    pinId,
    displayName: toSafeString(record.displayName ?? record.serviceName ?? record.service_name) || pinId,
    serviceName: toSafeString(record.serviceName ?? record.service_name) || undefined,
    description: toSafeString(record.description) || undefined,
    providerGlobalMetaId: toSafeString(record.providerGlobalMetaId ?? record.provider_global_metaid) || undefined,
    price: toSafeString(record.price) || undefined,
    currency: toSafeString(record.currency) || undefined,
  };
}

function normalizePendingRequestRecord(input: Partial<OpenClawPendingRequestRecord>): OpenClawPendingRequestRecord | null {
  const requestId = toSafeString(input.requestId);
  const requesterSessionId = toSafeString(input.requesterSessionId);
  const targetSessionId = toSafeString(input.targetSessionId);
  if (!requestId || !requesterSessionId || !targetSessionId) return null;

  return {
    requestId,
    requesterSessionId,
    requesterConversationId: toSafeNullableString(input.requesterConversationId),
    targetSessionId,
    servicePinId: toSafeString(input.servicePinId) || undefined,
    createdAt: Math.trunc(toSafeNumber(input.createdAt)) || undefined,
  };
}

async function quarantineCorruptPendingRequestRegistry(filePath: string, raw: string): Promise<void> {
  const corruptPath = `${filePath}.corrupt-${Date.now()}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.rename(filePath, corruptPath);
  } catch {
    await fs.writeFile(corruptPath, raw, 'utf8');
    await fs.rm(filePath, { force: true });
  }
}

async function readPendingRequestRegistry(filePath: string): Promise<OpenClawPendingRequestRecord[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (!raw.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError) {
        await quarantineCorruptPendingRequestRegistry(filePath, raw);
        return [];
      }
      throw error;
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizePendingRequestRecord((item ?? {}) as Partial<OpenClawPendingRequestRecord>))
      .filter((item): item is OpenClawPendingRequestRecord => item !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

async function writePendingRequestRegistry(
  filePath: string,
  records: OpenClawPendingRequestRecord[],
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFilePath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempFilePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await fs.rename(tempFilePath, filePath);
}

function upsertPendingRequest(
  records: OpenClawPendingRequestRecord[],
  nextRecord: OpenClawPendingRequestRecord,
): OpenClawPendingRequestRecord[] {
  const filtered = records.filter((record) => (
    record.requestId !== nextRecord.requestId
    || record.requesterSessionId !== nextRecord.requesterSessionId
  ));
  filtered.push(nextRecord);
  return filtered;
}

export function evaluateRequesterRouting(input: EvaluateRequesterRoutingInput): RequesterRoutingDecision {
  const localStatus = toSafeString(input.localExecution?.status);
  const remoteCandidates = toSafeArray(input.remoteCandidates)
    .map((candidate) => normalizeRemoteServiceCandidate(candidate as Record<string, unknown>))
    .filter((candidate): candidate is OpenClawRemoteServiceCandidate => candidate !== null);
  const explicitRemoteServicePinId = toSafeString(input.explicitRemoteServicePinId);

  if (localStatus === 'success') {
    return { action: 'use_local' };
  }

  if (localStatus !== 'miss') {
    return { action: 'wait_local' };
  }

  if (explicitRemoteServicePinId) {
    const selectedService = remoteCandidates.find((candidate) => candidate.pinId === explicitRemoteServicePinId);
    if (selectedService) {
      return {
        action: 'await_confirmation',
        selectedService,
      };
    }
  }

  const recommendedService = remoteCandidates[0];
  if (!recommendedService) {
    return { action: 'wait_local' };
  }

  return {
    action: 'recommend_remote',
    recommendedService,
  };
}

export function buildRequesterResultInjection(input: {
  delivery: Record<string, unknown> | ProviderDeliveryEnvelope;
  pendingRequest: OpenClawPendingRequestRecord;
}): RequesterResultInjection | null {
  const deliveryRequestId = toSafeString(input.delivery.request_id);
  const deliveryRequesterSessionId = toSafeString(input.delivery.requester_session_id);
  if (!deliveryRequestId || !deliveryRequesterSessionId) return null;

  const matchedTarget = resolveRequesterDeliveryTarget({
    delivery: {
      ...input.delivery,
      request_id: deliveryRequestId,
      requester_session_id: deliveryRequesterSessionId,
    },
    pendingRequest: input.pendingRequest,
  });
  if (!matchedTarget) return null;

  return {
    requestId: deliveryRequestId,
    requesterSessionId: deliveryRequesterSessionId,
    requesterConversationId: toSafeNullableString(input.delivery.requester_conversation_id)
      ?? toSafeNullableString(matchedTarget.requesterConversationId),
    targetSessionId: matchedTarget.targetSessionId,
    message: {
      text: toSafeString(input.delivery.text),
      attachments: normalizeAttachmentRefs(toSafeArray(input.delivery.attachments)),
      servicePinId: toSafeString(input.delivery.service_pin_id),
      paymentTxid: toSafeNullableString(input.delivery.payment_txid),
      deliveryMessagePinId: toSafeNullableString(input.delivery.delivery_message_pin_id),
      deliveredAt: Math.trunc(toSafeNumber(input.delivery.delivered_at)),
    },
  };
}

export function createOpenClawRequesterBridge(deps: OpenClawRequesterBridgeDeps) {
  return {
    evaluateRouting(input: EvaluateRequesterRoutingInput): RequesterRoutingDecision {
      return evaluateRequesterRouting(input);
    },

    async discoverRemoteServices(): Promise<{ services: OpenClawRemoteServiceCandidate[] }> {
      const payload = await deps.listServices();
      return {
        services: toSafeArray(payload.services)
          .map((candidate) => normalizeRemoteServiceCandidate(candidate as Record<string, unknown>))
          .filter((candidate): candidate is OpenClawRemoteServiceCandidate => candidate !== null),
      };
    },

    async submitRemoteRequest(input: SubmitOpenClawRemoteRequestInput): Promise<{
      request_write: RequestWriteRecord;
      provider_wakeup: ProviderWakeUpEnvelope;
      pending_request: OpenClawPendingRequestRecord;
    }> {
      const metabotId = requirePositiveInteger('metabotId', input.metabotId);
      const servicePinId = requireNonEmptyString('servicePinId', input.servicePinId);
      const requestId = requireNonEmptyString('requestId', input.requestId);
      const requesterSessionId = requireNonEmptyString('requesterSessionId', input.requesterSessionId);
      const requesterGlobalMetaId = requireNonEmptyString('requesterGlobalMetaId', input.requesterGlobalMetaId);
      const targetSessionId = requireNonEmptyString('targetSessionId', input.targetSessionId);
      if (!input.confirm) {
        throw new Error('requester confirmation is required before request-service');
      }

      const result = await deps.requestService({
        ...input,
        metabotId,
        servicePinId,
        requestId,
        requesterSessionId,
        requesterGlobalMetaId,
        targetSessionId,
      });
      const pendingRequest = normalizePendingRequestRecord({
        requestId: result.request_write.requestId || requestId,
        requesterSessionId: result.request_write.requesterSessionId || requesterSessionId,
        requesterConversationId: result.request_write.requesterConversationId ?? input.requesterConversationId,
        targetSessionId,
        servicePinId: result.request_write.servicePinId || servicePinId,
        createdAt: Date.now(),
      });
      if (!pendingRequest) {
        throw new Error('request-service did not produce a valid pending request record');
      }

      const existingPending = await readPendingRequestRegistry(deps.pendingRequestsFile);
      await writePendingRequestRegistry(
        deps.pendingRequestsFile,
        upsertPendingRequest(existingPending, pendingRequest),
      );

      return {
        request_write: result.request_write,
        provider_wakeup: result.provider_wakeup,
        pending_request: pendingRequest,
      };
    },

    async reinjectProviderDelivery(input: {
      delivery: Record<string, unknown> | ProviderDeliveryEnvelope;
      consume?: boolean;
    }): Promise<RequesterResultInjection | null> {
      const pendingRequests = await readPendingRequestRegistry(deps.pendingRequestsFile);
      let matchedRecord: OpenClawPendingRequestRecord | null = null;
      let injection: RequesterResultInjection | null = null;

      for (const record of pendingRequests) {
        injection = buildRequesterResultInjection({
          delivery: input.delivery,
          pendingRequest: record,
        });
        if (injection) {
          matchedRecord = record;
          break;
        }
      }

      if (!matchedRecord || !injection) return null;

      if (input.consume !== false) {
        const remaining = pendingRequests.filter((record) => (
          record.requestId !== matchedRecord?.requestId
          || record.requesterSessionId !== matchedRecord?.requesterSessionId
        ));
        await writePendingRequestRegistry(deps.pendingRequestsFile, remaining);
      }

      return injection;
    },
  };
}
