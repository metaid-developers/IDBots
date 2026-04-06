import { normalizeAttachmentRefs } from '../attachmentRefs';
import { normalizeServiceRequestContract } from '../contracts';
import type { HostSessionAdapter, ProviderSessionResult, StartProviderSessionInput } from '../hostSessionAdapter';

type OpenClawWakeUpEnvelope = Record<string, unknown>;

interface OpenClawProviderPort {
  createSession(input: { title: string; autoStart: true }): Promise<{ sessionId: string }>;
  injectPrompt(sessionId: string, prompt: string): Promise<void>;
  waitForSessionResult(sessionId: string): Promise<ProviderSessionResult>;
}

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

function requireNonEmptyField(name: string, value: unknown): string {
  const normalized = toSafeString(value);
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function buildOpenClawProviderPrompt(input: StartProviderSessionInput): string {
  const sections = [
    'Remote MetaBot service request',
    `service: ${toSafeString(input.servicePinId)}`,
    `requester: ${toSafeString(input.requesterGlobalMetaId)}`,
    `goal: ${toSafeString(input.userTask)}`,
  ];

  const systemPrompt = toSafeString(input.systemPrompt);
  const prompt = toSafeString(input.prompt);
  const taskContext = toSafeString(input.taskContext);

  if (systemPrompt) {
    sections.push('', 'System prompt:', systemPrompt);
  }
  if (prompt) {
    sections.push('', 'Execution prompt:', prompt);
  }
  if (taskContext) {
    sections.push('', 'Task context:', taskContext);
  }

  return sections.join('\n');
}

export function normalizeOpenClawWakeUpEnvelope(input: OpenClawWakeUpEnvelope) {
  const payment = input.payment && typeof input.payment === 'object'
    ? input.payment as Record<string, unknown>
    : {};

  return normalizeServiceRequestContract({
    correlation: {
      requestId: requireNonEmptyField('request_id', input.request_id),
      requesterSessionId: requireNonEmptyField('requester_session_id', input.requester_session_id),
      requesterConversationId: toSafeString(input.requester_conversation_id) || null,
    },
    servicePinId: requireNonEmptyField('service_pin_id', input.service_pin_id),
    requesterGlobalMetaId: toSafeString(input.requester_global_metaid),
    price: toSafeString(input.price) || '0',
    currency: toSafeString(input.currency) || 'SPACE',
    paymentProof: {
      txid: toSafeString(payment.txid) || null,
      chain: toSafeString(payment.chain) || null,
      amount: toSafeString(payment.amount) || toSafeString(input.price) || '0',
      currency: toSafeString(payment.currency) || toSafeString(input.currency) || 'SPACE',
      orderMessage: toSafeString(payment.order_message),
      orderMessagePinId: toSafeString(payment.order_message_pin_id) || null,
    },
    userTask: toSafeString(input.user_task),
    taskContext: toSafeString(input.task_context),
  });
}

export function createOpenClawProviderAdapter(port: OpenClawProviderPort): HostSessionAdapter {
  return {
    async startProviderSession(input) {
      const created = await port.createSession({
        title: `Remote service ${toSafeString(input.servicePinId) || 'request'}`,
        autoStart: true,
      });
      await port.injectPrompt(created.sessionId, buildOpenClawProviderPrompt(input));
      return created;
    },
    async waitForProviderResult(sessionId) {
      const result = await port.waitForSessionResult(sessionId);
      return {
        sessionId,
        text: toSafeString(result.text),
        attachments: normalizeAttachmentRefs(Array.isArray(result.attachments) ? result.attachments : []),
        ratingInvite: toSafeString(result.ratingInvite),
      };
    },
  };
}
