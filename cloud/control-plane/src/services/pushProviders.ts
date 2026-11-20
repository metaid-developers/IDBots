import { createSign, randomUUID } from 'node:crypto';
import type { ControlPlaneConfig } from '../config.js';

export interface AgentPushEvent {
  eventId: string;
  type: string;
  category: 'work' | 'action' | 'report' | 'system';
  title: string;
  body: string;
  priority: 'normal' | 'high';
}

export class PushProviderError extends Error {
  constructor(readonly errorClass: string, readonly retryable: boolean, readonly invalidToken = false) {
    super(errorClass);
  }
}

export interface PushProvider {
  send(input: { token: string; event: AgentPushEvent }): Promise<{ messageId: string }>;
}

export class FakePushProvider implements PushProvider {
  readonly messages: Array<{ token: string; event: AgentPushEvent }> = [];
  failure: PushProviderError | null = null;

  async send(input: { token: string; event: AgentPushEvent }): Promise<{ messageId: string }> {
    if (this.failure) throw this.failure;
    this.messages.push(input);
    return { messageId: `fake:${randomUUID()}` };
  }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class FcmPushProvider implements PushProvider {
  private accessToken: { token: string; expiresAt: number } | null = null;

  constructor(
    private config: NonNullable<ControlPlaneConfig['push']['fcm']>,
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > this.now() + 60_000) return this.accessToken.token;
    const issuedAt = Math.floor(this.now() / 1000);
    const assertion = [
      base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
      base64url(JSON.stringify({
        iss: this.config.clientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: issuedAt,
        exp: issuedAt + 3600,
      })),
    ].join('.');
    const signer = createSign('RSA-SHA256');
    signer.update(assertion);
    const jwt = `${assertion}.${signer.sign(this.config.privateKey, 'base64url')}`;
    let response: Response;
    try {
      response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PushProviderError('FCM_AUTH_UNAVAILABLE', true);
    }
    const body = await responseBody(response);
    if (!response.ok || typeof body.access_token !== 'string') throw new PushProviderError('FCM_AUTH_REJECTED', response.status >= 500);
    this.accessToken = {
      token: body.access_token,
      expiresAt: this.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000,
    };
    return this.accessToken.token;
  }

  async send(input: { token: string; event: AgentPushEvent }): Promise<{ messageId: string }> {
    const accessToken = await this.token();
    let response: Response;
    try {
      response = await this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: input.token,
            notification: { title: input.event.title, body: input.event.body },
            data: { eventId: input.event.eventId, category: input.event.category, type: input.event.type },
            android: {
              priority: input.event.priority === 'high' ? 'HIGH' : 'NORMAL',
              notification: {
                channel_id: input.event.category,
                tag: input.event.eventId,
                notification_priority: input.event.priority === 'high' ? 'PRIORITY_HIGH' : 'PRIORITY_DEFAULT',
              },
            },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PushProviderError('FCM_UNAVAILABLE', true);
    }
    const body = await responseBody(response);
    if (response.ok && typeof body.name === 'string') return { messageId: body.name };
    const details = body.error as { status?: unknown; details?: Array<{ errorCode?: unknown }> } | undefined;
    const errorCode = details?.details?.find((entry) => typeof entry.errorCode === 'string')?.errorCode;
    const status = String(errorCode ?? details?.status ?? 'FCM_REJECTED');
    const invalidToken = status === 'UNREGISTERED';
    throw new PushProviderError(`FCM_${status}`.slice(0, 100), !invalidToken && (response.status === 429 || response.status >= 500), invalidToken);
  }
}

export function createPushProvider(config: ControlPlaneConfig['push']): PushProvider | null {
  if (config.provider === 'fake') return new FakePushProvider();
  if (config.provider === 'fcm' && config.fcm) return new FcmPushProvider(config.fcm);
  return null;
}
