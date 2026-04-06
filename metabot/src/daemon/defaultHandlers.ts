import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import {
  DEFAULT_DERIVATION_PATH,
  deriveIdentity,
  derivePrivateKeyHex,
} from '../core/identity/deriveIdentity';
import {
  commandFailed,
  commandManualActionRequired,
  commandSuccess,
  type MetabotCommandResult,
} from '../core/contracts/commandResult';
import { createHotStateStore } from '../core/state/hotStateStore';
import {
  createRuntimeStateStore,
  type RuntimeDaemonRecord,
  type RuntimeIdentityRecord,
} from '../core/state/runtimeStateStore';
import type { MetabotDaemonHttpHandlers } from './routes/types';
import { buildPublishedService } from '../core/services/publishService';
import { planRemoteCall } from '../core/delegation/remoteCall';
import { buildSessionTrace } from '../core/chat/sessionTrace';
import { exportSessionArtifacts } from '../core/chat/transcriptExport';
import { sendPrivateChat } from '../core/chat/privateChat';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeServiceSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'service';
}

function buildIdentityRecord(input: {
  name: string;
  metabotId: number;
  createdAt: number;
  identity: Awaited<ReturnType<typeof deriveIdentity>>;
}): RuntimeIdentityRecord {
  return {
    metabotId: input.metabotId,
    name: input.name,
    createdAt: input.createdAt,
    path: input.identity.path,
    publicKey: input.identity.publicKey,
    chatPublicKey: input.identity.chatPublicKey,
    mvcAddress: input.identity.mvcAddress,
    btcAddress: input.identity.btcAddress,
    dogeAddress: input.identity.dogeAddress,
    metaId: input.identity.metaId,
    globalMetaId: input.identity.globalMetaId,
  };
}

function resolvePaymentAddress(identity: RuntimeIdentityRecord, currency: string): string {
  const normalized = normalizeText(currency).toUpperCase();
  if (normalized === 'BTC') return identity.btcAddress;
  if (normalized === 'DOGE') return identity.dogeAddress;
  return identity.mvcAddress;
}

function summarizeService(record: ReturnType<typeof buildPublishedService>['record']) {
  return {
    servicePinId: record.currentPinId,
    sourceServicePinId: record.sourceServicePinId,
    providerGlobalMetaId: record.providerGlobalMetaId,
    providerSkill: record.providerSkill,
    serviceName: record.serviceName,
    displayName: record.displayName,
    description: record.description,
    price: record.price,
    currency: record.currency,
    outputType: record.outputType,
    available: Boolean(record.available),
    online: true,
    updatedAt: record.updatedAt,
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readCallRequest(rawInput: Record<string, unknown>) {
  const request = readObject(rawInput.request) ?? rawInput;
  return {
    servicePinId: normalizeText(request.servicePinId),
    providerGlobalMetaId: normalizeText(request.providerGlobalMetaId),
    providerDaemonBaseUrl: normalizeText(request.providerDaemonBaseUrl ?? rawInput.providerDaemonBaseUrl),
    userTask: normalizeText(request.userTask),
    taskContext: normalizeText(request.taskContext),
    rawRequest: normalizeText(request.rawRequest),
    spendCap: readObject(request.spendCap),
  };
}

function readPrivateChatRequest(rawInput: Record<string, unknown>) {
  return {
    to: normalizeText(rawInput.to),
    content: normalizeText(rawInput.content),
    replyPin: normalizeText(rawInput.replyPin),
    peerChatPublicKey: normalizeText(rawInput.peerChatPublicKey),
  };
}

function readExecuteServiceRequest(rawInput: Record<string, unknown>) {
  const buyer = readObject(rawInput.buyer) ?? {};
  const request = readObject(rawInput.request) ?? {};
  return {
    traceId: normalizeText(rawInput.traceId),
    externalConversationId: normalizeText(rawInput.externalConversationId),
    servicePinId: normalizeText(rawInput.servicePinId),
    providerGlobalMetaId: normalizeText(rawInput.providerGlobalMetaId),
    buyer: {
      host: normalizeText(buyer.host),
      globalMetaId: normalizeText(buyer.globalMetaId),
      name: normalizeText(buyer.name),
    },
    request: {
      userTask: normalizeText(request.userTask),
      taskContext: normalizeText(request.taskContext),
    },
  };
}

function renderDemoRemoteServiceResponse(input: {
  serviceName: string;
  displayName: string;
  userTask: string;
  taskContext: string;
}): string {
  const serviceName = normalizeText(input.serviceName).toLowerCase();
  const displayName = normalizeText(input.displayName);
  const userTask = normalizeText(input.userTask);
  const taskContext = normalizeText(input.taskContext);
  const weatherLike = serviceName.includes('weather')
    || displayName.toLowerCase().includes('weather')
    || /weather|天气/i.test(userTask)
    || /weather|天气/i.test(taskContext);

  if (weatherLike) {
    return 'Tomorrow will be bright with a light wind.';
  }

  const contextSuffix = taskContext ? ` Context: ${taskContext}` : '';
  return `${displayName || 'Remote MetaBot'} completed the remote request: ${userTask}.${contextSuffix}`.trim();
}

function isSuccessfulCommandEnvelope(value: unknown): value is {
  ok: true;
  data: Record<string, unknown>;
} {
  return Boolean(value && typeof value === 'object' && (value as { ok?: unknown }).ok === true);
}

function isManualActionEnvelope(value: unknown): value is {
  ok: false;
  state: 'manual_action_required';
  code?: unknown;
  message?: unknown;
  localUiUrl?: unknown;
} {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { ok?: unknown }).ok === false
    && (value as { state?: unknown }).state === 'manual_action_required'
  );
}

function isFailedCommandEnvelope(value: unknown): value is {
  ok: false;
  code?: unknown;
  message?: unknown;
} {
  return Boolean(value && typeof value === 'object' && (value as { ok?: unknown }).ok === false);
}

async function fetchRemoteAvailableServices(
  providerDaemonBaseUrl: string
): Promise<{ services: Array<Record<string, unknown>> } | MetabotCommandResult<unknown>> {
  try {
    const response = await fetch(`${providerDaemonBaseUrl}/api/network/services?online=true`);
    const payload = await response.json() as unknown;
    if (!response.ok) {
      return commandFailed('remote_directory_unreachable', `Remote service directory returned HTTP ${response.status}.`);
    }
    if (!isSuccessfulCommandEnvelope(payload)) {
      if (isManualActionEnvelope(payload)) {
        return commandManualActionRequired(
          normalizeText(payload.code) || 'remote_directory_manual_action_required',
          normalizeText(payload.message) || 'Remote directory requires manual action.',
          normalizeText(payload.localUiUrl) || undefined
        );
      }
      if (isFailedCommandEnvelope(payload)) {
        return commandFailed(
          normalizeText(payload.code) || 'remote_directory_unavailable',
          normalizeText(payload.message) || 'Remote directory is unavailable.'
        );
      }
      return commandFailed('remote_directory_invalid_response', 'Remote directory returned an invalid command envelope.');
    }

    const services = Array.isArray(payload.data.services)
      ? payload.data.services.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
      : [];
    return { services };
  } catch (error) {
    return commandFailed(
      'remote_directory_unreachable',
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function executeRemoteServiceCall(input: {
  providerDaemonBaseUrl: string;
  traceId: string;
  externalConversationId: string;
  servicePinId: string;
  providerGlobalMetaId: string;
  buyer: RuntimeIdentityRecord;
  request: {
    userTask: string;
    taskContext: string;
  };
}): Promise<MetabotCommandResult<Record<string, unknown>>> {
  try {
    const response = await fetch(`${input.providerDaemonBaseUrl}/api/services/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        traceId: input.traceId,
        externalConversationId: input.externalConversationId,
        servicePinId: input.servicePinId,
        providerGlobalMetaId: input.providerGlobalMetaId,
        buyer: {
          host: 'local-runtime',
          globalMetaId: input.buyer.globalMetaId,
          name: input.buyer.name,
        },
        request: input.request,
      }),
    });
    const payload = await response.json() as unknown;
    if (!response.ok) {
      return commandFailed('remote_execution_failed', `Remote execution returned HTTP ${response.status}.`);
    }
    if (isSuccessfulCommandEnvelope(payload)) {
      return commandSuccess(payload.data);
    }
    if (isManualActionEnvelope(payload)) {
      return commandManualActionRequired(
        normalizeText(payload.code) || 'remote_execution_manual_action_required',
        normalizeText(payload.message) || 'Remote execution requires manual action.',
        normalizeText(payload.localUiUrl) || undefined
      );
    }
    if (isFailedCommandEnvelope(payload)) {
      return commandFailed(
        normalizeText(payload.code) || 'remote_execution_failed',
        normalizeText(payload.message) || 'Remote execution failed.'
      );
    }
    return commandFailed('remote_execution_invalid_response', 'Remote execution returned an invalid command envelope.');
  } catch (error) {
    return commandFailed(
      'remote_execution_failed',
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function fetchPeerChatPublicKey(globalMetaId: string): Promise<string | null> {
  const normalized = normalizeText(globalMetaId);
  if (!normalized) return null;

  const urls = [
    `https://file.metaid.io/metafile-indexer/api/v1/info/globalmetaid/${encodeURIComponent(normalized)}`,
    `https://manapi.metaid.io/api/info/metaid/${encodeURIComponent(normalized)}`,
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const payload = await response.json() as {
        data?: { chatpubkey?: unknown };
        chatpubkey?: unknown;
      };
      const chatPublicKey = normalizeText(payload?.data?.chatpubkey ?? payload?.chatpubkey);
      if (chatPublicKey) {
        return chatPublicKey;
      }
    } catch {
      // ignore and fall through
    }
  }

  return null;
}

export function createDefaultMetabotDaemonHandlers(input: {
  homeDir: string;
  getDaemonRecord: () => RuntimeDaemonRecord | null;
}): MetabotDaemonHttpHandlers {
  const hotStateStore = createHotStateStore(input.homeDir);
  const runtimeStateStore = createRuntimeStateStore(input.homeDir);

  return {
    daemon: {
      getStatus: async () => {
        const daemon = input.getDaemonRecord();
        return commandSuccess({
          daemonId: daemon?.ownerId || 'metabot-daemon',
          state: 'online',
          lockOwner: daemon?.ownerId || 'metabot-daemon',
          baseUrl: daemon?.baseUrl || null,
          pid: daemon?.pid ?? process.pid,
        });
      },
      doctor: async () => {
        const state = await runtimeStateStore.readState();
        const daemon = input.getDaemonRecord();
        return commandSuccess({
          checks: [
            { code: 'daemon_reachable', ok: true },
            { code: 'identity_loaded', ok: Boolean(state.identity) },
            { code: 'service_registry_loaded', ok: true, count: state.services.length },
          ],
          daemon: daemon
            ? {
                baseUrl: daemon.baseUrl,
                pid: daemon.pid,
              }
            : null,
        });
      },
    },
    identity: {
      create: async ({ name }) => {
        const normalizedName = normalizeText(name);
        if (!normalizedName) {
          return commandFailed('missing_name', 'MetaBot name is required.');
        }

        const state = await runtimeStateStore.readState();
        if (state.identity) {
          return commandSuccess(state.identity);
        }

        const mnemonic = generateMnemonic(wordlist);
        const identity = await deriveIdentity({
          mnemonic,
          path: DEFAULT_DERIVATION_PATH,
        });
        const createdAt = Date.now();
        const identityRecord = buildIdentityRecord({
          name: normalizedName,
          metabotId: 1,
          createdAt,
          identity,
        });

        await hotStateStore.writeSecrets({
          mnemonic,
          path: identity.path,
          privateKeyHex: await derivePrivateKeyHex({
            mnemonic,
            path: identity.path,
          }),
          publicKey: identity.publicKey,
          chatPublicKey: identity.chatPublicKey,
          mvcAddress: identity.mvcAddress,
          btcAddress: identity.btcAddress,
          dogeAddress: identity.dogeAddress,
          metaId: identity.metaId,
          globalMetaId: identity.globalMetaId,
        });
        await runtimeStateStore.writeState({
          ...state,
          identity: identityRecord,
        });

        return commandSuccess(identityRecord);
      },
    },
    network: {
      listServices: async ({ online }) => {
        const state = await runtimeStateStore.readState();
        const services = state.services
          .filter((service) => service.available === 1)
          .map((service) => summarizeService(service))
          .sort((left, right) => right.updatedAt - left.updatedAt);

        return commandSuccess({
          services: online === false ? [] : services,
        });
      },
    },
    services: {
      publish: async (rawInput) => {
        const state = await runtimeStateStore.readState();
        if (!state.identity) {
          return commandFailed('identity_missing', 'Create a local MetaBot identity before publishing services.');
        }

        const serviceName = normalizeText(rawInput.serviceName);
        const displayName = normalizeText(rawInput.displayName);
        const description = normalizeText(rawInput.description);
        const providerSkill = normalizeText(rawInput.providerSkill);
        const price = normalizeText(rawInput.price);
        const currency = normalizeText(rawInput.currency);
        const outputType = normalizeText(rawInput.outputType);
        const serviceIconUri = normalizeText(rawInput.serviceIconUri) || null;
        const skillDocument = normalizeText(rawInput.skillDocument);

        if (!serviceName || !displayName || !description || !providerSkill || !price || !currency || !outputType) {
          return commandFailed('invalid_service_payload', 'Service payload is missing one or more required fields.');
        }

        const now = Date.now();
        const servicePinId = `service-${sanitizeServiceSegment(serviceName)}-${now.toString(36)}`;
        const published = buildPublishedService({
          sourceServicePinId: servicePinId,
          currentPinId: servicePinId,
          creatorMetabotId: state.identity.metabotId,
          providerGlobalMetaId: state.identity.globalMetaId,
          paymentAddress: resolvePaymentAddress(state.identity, currency),
          draft: {
            serviceName,
            displayName,
            description,
            providerSkill,
            price,
            currency,
            outputType,
            serviceIconUri,
          },
          skillDocument,
          now,
        });

        await runtimeStateStore.writeState({
          ...state,
          services: [
            published.record,
            ...state.services.filter((service) => service.currentPinId !== published.record.currentPinId),
          ],
        });

        return commandSuccess(summarizeService(published.record));
      },
      call: async (rawInput) => {
        const state = await runtimeStateStore.readState();
        if (!state.identity) {
          return commandFailed('identity_missing', 'Create a local MetaBot identity before calling services.');
        }

        const request = readCallRequest(rawInput);
        if (!request.servicePinId || !request.providerGlobalMetaId || !request.userTask) {
          return commandFailed(
            'invalid_call_request',
            'Call request must include servicePinId, providerGlobalMetaId, and userTask.'
          );
        }

        let availableServices: Array<Record<string, unknown>>;
        if (request.providerDaemonBaseUrl) {
          const remoteDirectory = await fetchRemoteAvailableServices(request.providerDaemonBaseUrl);
          if ('ok' in remoteDirectory) {
            if (!remoteDirectory.ok && remoteDirectory.state === 'manual_action_required') {
              return remoteDirectory;
            }
            return remoteDirectory;
          }
          availableServices = remoteDirectory.services;
        } else {
          availableServices = state.services
            .filter((service) => service.available === 1)
            .map((service) => ({
              servicePinId: service.currentPinId,
              providerGlobalMetaId: service.providerGlobalMetaId,
              serviceName: service.serviceName,
              displayName: service.displayName,
              description: service.description,
              price: service.price,
              currency: service.currency,
            }));
        }

        const plan = planRemoteCall({
          request: {
            servicePinId: request.servicePinId,
            providerGlobalMetaId: request.providerGlobalMetaId,
            userTask: request.userTask,
            taskContext: request.taskContext,
            rawRequest: request.rawRequest,
            spendCap: request.spendCap as { amount: string; currency: 'SPACE' | 'BTC' | 'DOGE' } | null,
          },
          availableServices,
        });

        if (!plan.ok) {
          if (plan.state === 'manual_action_required') {
            return commandManualActionRequired(plan.code, plan.message);
          }
          return commandFailed(plan.code, plan.message);
        }

        const service = availableServices.find((entry) => (
          normalizeText(entry.servicePinId) === plan.service.servicePinId
          && normalizeText(entry.providerGlobalMetaId) === plan.service.providerGlobalMetaId
        ));
        if (!service) {
          return commandFailed('service_not_found', 'Published service was not found in the available service directory.');
        }

        let remoteExecution: Record<string, unknown> | null = null;
        if (request.providerDaemonBaseUrl) {
          const execution = await executeRemoteServiceCall({
            providerDaemonBaseUrl: request.providerDaemonBaseUrl,
            traceId: plan.traceId,
            externalConversationId: plan.session.externalConversationId,
            servicePinId: plan.service.servicePinId,
            providerGlobalMetaId: plan.service.providerGlobalMetaId,
            buyer: state.identity,
            request: {
              userTask: request.userTask,
              taskContext: request.taskContext,
            },
          });
          if (!execution.ok) {
            if (execution.state === 'manual_action_required') {
              return execution;
            }
            return execution;
          }
          remoteExecution = execution.data;
        }

        const serviceDisplayName = normalizeText(service.displayName) || normalizeText(service.serviceName);
        const trace = buildSessionTrace({
          traceId: plan.traceId,
          channel: 'metaweb_order',
          exportRoot: runtimeStateStore.paths.exportRoot,
          session: {
            id: `session-${plan.traceId}`,
            title: `${serviceDisplayName} Call`,
            type: 'a2a',
            metabotId: state.identity.metabotId,
            peerGlobalMetaId: normalizeText(service.providerGlobalMetaId),
            peerName: serviceDisplayName,
            externalConversationId: plan.session.externalConversationId,
          },
          order: {
            id: `order-${plan.traceId}`,
            role: 'buyer',
            serviceId: plan.service.servicePinId,
            serviceName: serviceDisplayName,
            paymentTxid: `payment-${plan.traceId}`,
            paymentCurrency: plan.payment.currency,
            paymentAmount: plan.payment.amount,
          },
        });

        const artifacts = await exportSessionArtifacts({
          trace,
          transcript: {
            sessionId: trace.session.id,
            title: trace.session.title,
            messages: [
              {
                id: `${trace.traceId}-user`,
                type: 'user',
                timestamp: trace.createdAt,
                content: request.userTask,
                metadata: {
                  taskContext: request.taskContext || null,
                },
              },
              {
                id: `${trace.traceId}-assistant`,
                type: 'assistant',
                timestamp: trace.createdAt,
                content: remoteExecution
                  ? `Local MetaBot runtime executed a remote call to ${serviceDisplayName}.`
                  : `Local MetaBot runtime planned a remote call to ${serviceDisplayName}.`,
                metadata: {
                  servicePinId: plan.service.servicePinId,
                  providerGlobalMetaId: normalizeText(service.providerGlobalMetaId),
                  providerDaemonBaseUrl: request.providerDaemonBaseUrl || null,
                },
              },
              ...(remoteExecution && normalizeText(remoteExecution.responseText)
                ? [{
                    id: `${trace.traceId}-remote-result`,
                    type: 'assistant',
                    timestamp: trace.createdAt,
                    content: normalizeText(remoteExecution.responseText),
                    metadata: {
                      providerTraceJsonPath: normalizeText(remoteExecution.traceJsonPath) || null,
                      providerTraceMarkdownPath: normalizeText(remoteExecution.traceMarkdownPath) || null,
                    },
                  }]
                : []),
            ],
          },
        });

        await runtimeStateStore.writeState({
          ...state,
          traces: [
            trace,
            ...state.traces.filter((entry) => entry.traceId !== trace.traceId),
          ],
        });

        return commandSuccess({
          traceId: trace.traceId,
          externalConversationId: trace.session.externalConversationId,
          traceJsonPath: artifacts.traceJsonPath,
          traceMarkdownPath: artifacts.traceMarkdownPath,
          transcriptMarkdownPath: artifacts.transcriptMarkdownPath,
          providerGlobalMetaId: plan.service.providerGlobalMetaId,
          serviceName: serviceDisplayName,
          responseText: remoteExecution ? normalizeText(remoteExecution.responseText) : '',
          providerTraceJsonPath: remoteExecution ? normalizeText(remoteExecution.traceJsonPath) : '',
          providerTraceMarkdownPath: remoteExecution ? normalizeText(remoteExecution.traceMarkdownPath) : '',
          providerTranscriptMarkdownPath: remoteExecution ? normalizeText(remoteExecution.transcriptMarkdownPath) : '',
        });
      },
      execute: async (rawInput) => {
        const state = await runtimeStateStore.readState();
        if (!state.identity) {
          return commandFailed('identity_missing', 'Create a local MetaBot identity before serving remote calls.');
        }

        const execution = readExecuteServiceRequest(rawInput);
        if (
          !execution.servicePinId
          || !execution.providerGlobalMetaId
          || !execution.request.userTask
        ) {
          return commandFailed(
            'invalid_service_execution_request',
            'Execution request must include servicePinId, providerGlobalMetaId, and request.userTask.'
          );
        }

        if (execution.providerGlobalMetaId !== state.identity.globalMetaId) {
          return commandFailed('provider_identity_mismatch', 'Execution request does not match the local provider identity.');
        }

        const service = state.services.find((entry) => (
          entry.available === 1
          && entry.currentPinId === execution.servicePinId
          && entry.providerGlobalMetaId === execution.providerGlobalMetaId
        ));
        if (!service) {
          return commandFailed('service_not_found', `Published service was not found: ${execution.servicePinId}`);
        }

        const traceId = execution.traceId || `trace-${sanitizeServiceSegment(service.serviceName)}-${Date.now().toString(36)}`;
        const responseText = renderDemoRemoteServiceResponse({
          serviceName: service.serviceName,
          displayName: service.displayName,
          userTask: execution.request.userTask,
          taskContext: execution.request.taskContext,
        });

        const trace = buildSessionTrace({
          traceId,
          channel: 'metaweb_order',
          exportRoot: runtimeStateStore.paths.exportRoot,
          session: {
            id: `session-${traceId}`,
            title: `${service.displayName} Execution`,
            type: 'a2a',
            metabotId: state.identity.metabotId,
            peerGlobalMetaId: execution.buyer.globalMetaId || null,
            peerName: execution.buyer.name || execution.buyer.host || null,
            externalConversationId: execution.externalConversationId || null,
          },
          order: {
            id: `order-${traceId}`,
            role: 'seller',
            serviceId: service.currentPinId,
            serviceName: service.displayName,
            paymentTxid: null,
            paymentCurrency: service.currency,
            paymentAmount: service.price,
          },
        });

        const artifacts = await exportSessionArtifacts({
          trace,
          transcript: {
            sessionId: trace.session.id,
            title: trace.session.title,
            messages: [
              {
                id: `${trace.traceId}-buyer`,
                type: 'user',
                timestamp: trace.createdAt,
                content: execution.request.userTask,
                metadata: {
                  taskContext: execution.request.taskContext || null,
                  buyerHost: execution.buyer.host || null,
                  buyerGlobalMetaId: execution.buyer.globalMetaId || null,
                },
              },
              {
                id: `${trace.traceId}-provider`,
                type: 'assistant',
                timestamp: trace.createdAt,
                content: responseText,
                metadata: {
                  servicePinId: service.currentPinId,
                  providerGlobalMetaId: state.identity.globalMetaId,
                },
              },
            ],
          },
        });

        await runtimeStateStore.writeState({
          ...state,
          traces: [
            trace,
            ...state.traces.filter((entry) => entry.traceId !== trace.traceId),
          ],
        });

        return commandSuccess({
          traceId: trace.traceId,
          externalConversationId: trace.session.externalConversationId,
          responseText,
          providerGlobalMetaId: state.identity.globalMetaId,
          servicePinId: service.currentPinId,
          serviceName: service.displayName,
          traceJsonPath: artifacts.traceJsonPath,
          traceMarkdownPath: artifacts.traceMarkdownPath,
          transcriptMarkdownPath: artifacts.transcriptMarkdownPath,
        });
      },
    },
    chat: {
      private: async (rawInput) => {
        const state = await runtimeStateStore.readState();
        if (!state.identity) {
          return commandFailed('identity_missing', 'Create a local MetaBot identity before sending private chat.');
        }

        const request = readPrivateChatRequest(rawInput);
        if (!request.to || !request.content) {
          return commandFailed('invalid_chat_request', 'Private chat request must include to and content.');
        }

        const secrets = await hotStateStore.readSecrets<{
          privateKeyHex?: string;
          chatPublicKey?: string;
        }>();
        const localPrivateKeyHex = normalizeText(secrets?.privateKeyHex);
        if (!localPrivateKeyHex) {
          return commandFailed('identity_secret_missing', 'Local private chat key is missing from hot state.');
        }

        let peerChatPublicKey = request.peerChatPublicKey;
        if (!peerChatPublicKey && request.to === state.identity.globalMetaId) {
          peerChatPublicKey = state.identity.chatPublicKey;
        }
        if (!peerChatPublicKey) {
          peerChatPublicKey = await fetchPeerChatPublicKey(request.to) ?? '';
        }
        if (!peerChatPublicKey) {
          return commandFailed(
            'peer_chat_public_key_missing',
            'Target has no chat public key on chain and none was provided.'
          );
        }

        const sent = sendPrivateChat({
          fromIdentity: {
            globalMetaId: state.identity.globalMetaId,
            privateKeyHex: localPrivateKeyHex,
          },
          toGlobalMetaId: request.to,
          peerChatPublicKey,
          content: request.content,
          replyPinId: request.replyPin,
        });

        const traceId = `trace-private-${Date.now().toString(36)}`;
        const trace = buildSessionTrace({
          traceId,
          channel: 'simplemsg',
          exportRoot: runtimeStateStore.paths.exportRoot,
          session: {
            id: `chat-${traceId}`,
            title: 'Private Chat',
            type: 'a2a',
            metabotId: state.identity.metabotId,
            peerGlobalMetaId: request.to,
            peerName: null,
            externalConversationId: `simplemsg:${state.identity.globalMetaId}:${request.to}:${traceId}`,
          },
        });

        const artifacts = await exportSessionArtifacts({
          trace,
          transcript: {
            sessionId: trace.session.id,
            title: trace.session.title,
            messages: [
              {
                id: `${trace.traceId}-user`,
                type: 'user',
                timestamp: trace.createdAt,
                content: request.content,
              },
              {
                id: `${trace.traceId}-assistant`,
                type: 'assistant',
                timestamp: trace.createdAt,
                content: `Encrypted private message prepared for ${request.to}.`,
                metadata: {
                  path: sent.path,
                  replyPin: request.replyPin || null,
                },
              },
            ],
          },
        });

        await runtimeStateStore.writeState({
          ...state,
          traces: [
            trace,
            ...state.traces.filter((entry) => entry.traceId !== trace.traceId),
          ],
        });

        return commandSuccess({
          to: request.to,
          path: sent.path,
          payload: sent.payload,
          encryptedContent: sent.encryptedContent,
          secretVariant: sent.secretVariant,
          deliveryMode: 'local_runtime',
          peerChatPublicKey,
          traceId: trace.traceId,
          transcriptMarkdownPath: artifacts.transcriptMarkdownPath,
          traceMarkdownPath: artifacts.traceMarkdownPath,
          traceJsonPath: artifacts.traceJsonPath,
        });
      },
    },
    trace: {
      getTrace: async ({ traceId }) => {
        const state = await runtimeStateStore.readState();
        const trace = state.traces.find((entry) => entry.traceId === traceId);
        if (!trace) {
          return commandFailed('trace_not_found', `Trace not found: ${traceId}`);
        }
        return commandSuccess(trace);
      },
    },
  };
}
