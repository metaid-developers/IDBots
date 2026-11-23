import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { ConfigError } from './config.js';
import { sha256Hex } from './crypto.js';

/**
 * SMS providers. Verification logic (rate limits, attempts, expiry) lives in
 * the auth service; a provider only delivers (or, for the fake provider,
 * records) a code. Codes are 6 digits and always stored/transported hashed.
 */

export type SmsPurpose = 'login' | 'reverify';

export interface SmsSendRecord {
  phone: string;
  purpose: SmsPurpose;
  code: string;
  at: number;
}

export interface SmsProvider {
  readonly mode: string;
  send(phone: string, purpose: SmsPurpose, code: string): Promise<void>;
}

/** 6-digit numeric code, zero-padded. */
export function generateSmsCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashSmsCode(phone: string, purpose: SmsPurpose, code: string): string {
  return sha256Hex(`${phone}:${purpose}:${code}`);
}

/**
 * Staging-only provider: accepts only the configured test numbers and always
 * "sends" the fixed code 246810 so tests and demos can log in. Sends are
 * recorded in memory for assertions; nothing leaves the process.
 */
export class FakeSmsProvider implements SmsProvider {
  readonly mode = 'fake';
  readonly fixedCode = '246810';
  readonly sends: SmsSendRecord[] = [];
  readonly #allowed: Set<string>;

  constructor(allowedNumbers: string[]) {
    this.#allowed = new Set(allowedNumbers);
  }

  async send(phone: string, purpose: SmsPurpose, code: string): Promise<void> {
    if (!this.#allowed.has(phone)) {
      throw new Error(`fake SMS rejected: number not in CP_FAKE_SMS_NUMBERS (${phone})`);
    }
    this.sends.push({ phone, purpose, code, at: Date.now() });
  }
}

const DEFAULT_ALIYUN_SMS_ENDPOINT = 'https://dysmsapi.aliyuncs.com/';

/** RFC 3986 percent-encoding required by Alibaba Cloud POP RPC v1 signatures. */
export function popPercentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, '~');
}

/** Normalize E.164 mainland China phone (+861xxxxxxxxxx) to Dysmsapi 11-digit format. */
export function normalizeAliyunPhoneNumber(phone: string): string {
  if (phone.startsWith('+86') && phone.length === 14) {
    return phone.slice(3);
  }
  return phone.replace(/^\+/, '');
}

export interface AliyunSmsOptions {
  accessKeyId: string | null;
  accessKeySecret: string | null;
  signName: string | null;
  templateLogin: string | null;
  templateReverify?: string | null;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

interface AliyunSendSmsResponse {
  Code?: string;
  Message?: string;
  RequestId?: string;
  BizId?: string;
}

export function buildAliyunSignedFormBody(
  params: Record<string, string>,
  accessKeySecret: string,
  httpMethod = 'POST',
): string {
  const sortedKeys = Object.keys(params).sort();
  const canonicalQuery = sortedKeys
    .map((key) => `${popPercentEncode(key)}=${popPercentEncode(params[key])}`)
    .join('&');
  const stringToSign = `${httpMethod.toUpperCase()}&${popPercentEncode('/')}&${popPercentEncode(canonicalQuery)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign, 'utf8')
    .digest('base64');
  return `Signature=${popPercentEncode(signature)}&${canonicalQuery}`;
}

/**
 * Alibaba Cloud Dysmsapi (`SendSms`, API version `2017-05-25`) implemented over
 * native `node:crypto` + `fetch` with HMAC-SHA1 POP RPC signing and zero SDK
 * bloat. Never logs or leaks phone numbers, SMS codes, or AccessKey secrets.
 */
export class AliyunSmsProvider implements SmsProvider {
  readonly mode = 'aliyun';
  readonly #accessKeyId: string;
  readonly #accessKeySecret: string;
  readonly #signName: string;
  readonly #templateLogin: string;
  readonly #templateReverify: string;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(options: AliyunSmsOptions) {
    const accessKeyId = options.accessKeyId?.trim() ?? '';
    const accessKeySecret = options.accessKeySecret?.trim() ?? '';
    const signName = options.signName?.trim() ?? '';
    const templateLogin = options.templateLogin?.trim() ?? '';
    const templateReverify = options.templateReverify?.trim() || templateLogin;
    if (!accessKeyId || !accessKeySecret || !signName || !templateLogin) {
      throw new ConfigError(
        'AliyunSmsProvider requires CP_SMS_ACCESS_KEY_ID, CP_SMS_ACCESS_KEY_SECRET, ' +
          'CP_SMS_SIGN_NAME, and CP_SMS_TEMPLATE_LOGIN',
      );
    }
    this.#accessKeyId = accessKeyId;
    this.#accessKeySecret = accessKeySecret;
    this.#signName = signName;
    this.#templateLogin = templateLogin;
    this.#templateReverify = templateReverify;
    this.#endpoint = options.endpoint ?? DEFAULT_ALIYUN_SMS_ENDPOINT;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async send(phone: string, purpose: SmsPurpose, code: string): Promise<void> {
    const templateCode = purpose === 'reverify' ? this.#templateReverify : this.#templateLogin;
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const params: Record<string, string> = {
      AccessKeyId: this.#accessKeyId,
      Action: 'SendSms',
      Format: 'JSON',
      PhoneNumbers: normalizeAliyunPhoneNumber(phone),
      RegionId: 'cn-hangzhou',
      SignName: this.#signName,
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: randomUUID(),
      SignatureVersion: '1.0',
      TemplateCode: templateCode,
      TemplateParam: JSON.stringify({ code }),
      Timestamp: timestamp,
      Version: '2017-05-25',
    };
    const formBody = buildAliyunSignedFormBody(params, this.#accessKeySecret, 'POST');
    const res = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        Accept: 'application/json',
      },
      body: formBody,
      signal: AbortSignal.timeout(10_000),
    });

    let parsed: AliyunSendSmsResponse | null = null;
    try {
      parsed = (await res.json()) as AliyunSendSmsResponse;
    } catch {
      parsed = null;
    }

    if (!res.ok || parsed?.Code !== 'OK') {
      const upstreamCode = parsed?.Code ?? `HTTP_${res.status}`;
      const upstreamMsg = parsed?.Message ? parsed.Message.slice(0, 120) : 'upstream rejected';
      throw new Error(`aliyun SendSms failed: ${upstreamCode} (${upstreamMsg})`);
    }
  }
}
