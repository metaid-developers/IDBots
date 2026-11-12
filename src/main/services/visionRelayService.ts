/**
 * Vision relay client (describe_image backend).
 *
 * Calls the assist-base-service vision relay so bots can read images no matter
 * which model backs the session. Reuses the free-quota relay credentials: the
 * same `metaid-free` relay key that serves chat also authorizes
 * POST /v2/assist/llm/vision/recognize. Credentials resolve lazily
 * (kv cache -> metaid-free provider config -> identity-signed bootstrap) and
 * one automatic re-bootstrap covers a revoked/lost key.
 *
 * Backend contract (assist-base-service "LLM 视觉识别中继接口"):
 * - POST {chatBaseUrl without trailing /v1}/vision/recognize
 *   Authorization: Bearer <relay key>
 *   {imageBase64 | imageUrl, mimeType?, prompt?}
 *   -> {code:0, data:{content, model, usage, remainingToday}} or
 *      {code:1, message:<stable machine-readable error>}.
 * - Vision calls are metered by a per-identity daily image count and do NOT
 *   consume the chat token quota.
 *
 * The service is Electron-free (store/fetch/bootstrap/image-codec injected)
 * so plain node:test coverage works, mirroring llmRelayService.
 */

import fs from 'fs';
import path from 'path';
import { parseFfmpegDuration, runFfmpegProcess } from './mediaToolsService';
import type { SqliteStore } from '../sqliteStore';

// Re-exported for existing import sites (tests); the canonical home of the
// generic ffmpeg layer is mediaToolsService.
export { parseFfmpegDuration, resolveFfmpegPath } from './mediaToolsService';

const VISION_RECOGNIZE_TIMEOUT_MS = 120_000;
/** Cap for the post-codec JPEG payload handed to the relay (base64 excluded). */
const VISION_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Keep the encoded audio body below the relay's suggested 10 MiB ceiling. */
export const VISION_AUDIO_MAX_BASE64_BYTES = 10 * 1024 * 1024;
/**
 * Target ceiling for a transcoded video's RAW bytes. The upstream accepts
 * base64 up to 10MB and base64 inflates by ~4/3, so 6.8MB raw encodes to
 * ~9.1MB — inside the cap with envelope margin.
 */
export const VISION_VIDEO_MAX_RAW_BYTES = 6.8 * 1024 * 1024;
/** Videos longer than this are truncated (the tool result says so). */
export const VISION_VIDEO_MAX_SECONDS = 180;
const VISION_VIDEO_TRANSCODE_TIMEOUT_MS = 120_000;

/** kv keys for the cached vision relay credentials. */
export const VISION_RELAY_API_KEY_KV = 'visionRelay.apiKey';
export const VISION_RELAY_BASE_URL_KV = 'visionRelay.baseUrl';

export class VisionRelayError extends Error {
  /** Stable server-side message (backend error contract) when available. */
  readonly relayMessage: string | null;

  constructor(message: string, relayMessage: string | null = null) {
    super(message);
    this.name = 'VisionRelayError';
    this.relayMessage = relayMessage;
  }
}

export interface VisionRelayRecognizeResult {
  content: string;
  model: string;
  remainingToday: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    imageTokens: number;
    estimated: boolean;
  };
}

export interface VisionRelayRecognizeInput {
  /** Absolute local path of the image to describe. */
  imagePath?: string;
  /** Pre-encoded base64 image (no data: prefix); used when no path is given. */
  imageBase64?: string;
  mimeType?: string;
  /** Optional question; the server default describes + OCRs when omitted. */
  prompt?: string;
}

export interface VisionAudioRecognizeInput {
  /** Absolute local audio path. */
  audioPath?: string;
  /** Public http(s) URL reachable by the relay backend. */
  audioUrl?: string;
  /** Pre-encoded base64 audio (without a data: prefix). */
  audioBase64?: string;
  mimeType?: string;
  prompt?: string;
}

export interface VisionTranscodeResult {
  /** Base64 of the transcoded mp4 (video/mp4, H.264, no audio). */
  base64: string;
  bytes: number;
  /** Source duration in seconds when probeable. */
  durationSec: number | null;
  /** True when the source exceeded VISION_VIDEO_MAX_SECONDS and was cut. */
  truncated: boolean;
}

export interface VisionRelayServiceDeps {
  getStore: () => SqliteStore | null;
  fetchImpl?: typeof fetch;
  /** Identity-signed relay bootstrap (default: llmRelayService.bootstrapLlmRelay). */
  bootstrapImpl?: () => Promise<{ apiKey: string; baseUrl: string }>;
  /**
   * Reads one local image file and returns downscaled JPEG base64 + size.
   * Default implementation uses Electron nativeImage; tests inject a stub.
   */
  loadImageBase64Impl?: (imagePath: string) => Promise<{ base64: string; bytes: number } | null>;
  /**
   * Transcodes one local video file to a small mp4 for recognition.
   * Default implementation shells out to the bundled ffmpeg; tests inject.
   */
  transcodeVideoImpl?: (videoPath: string) => Promise<VisionTranscodeResult>;
  extractAudioImpl?: (videoPath: string) => Promise<{ audioPath: string; mimeType: string; bytes: number }>;
  /** mkdtemp-like temp dir provider; tests inject. */
  tempDirImpl?: () => string;
}

let depsRef: VisionRelayServiceDeps | null = null;
let cachedCredentials: { apiKey: string; baseUrl: string } | null = null;

export function initVisionRelayService(deps: VisionRelayServiceDeps): void {
  depsRef = deps;
}

export function resetVisionRelayServiceForTests(): void {
  depsRef = null;
  cachedCredentials = null;
}

function getDeps(): VisionRelayServiceDeps {
  if (!depsRef) {
    throw new VisionRelayError('vision relay service not initialized');
  }
  return depsRef;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// URL + credential resolution
// ---------------------------------------------------------------------------

/**
 * Derive the recognize endpoint from the chat baseUrl the relay hands out
 * (`.../v2/assist/llm/v1` -> `.../v2/assist/llm/vision/recognize`). Exported
 * for tests; tolerant of a missing /v1 tail so custom gateways keep working.
 */
export function deriveVisionRecognizeUrl(chatBaseUrl: string): string {
  const base = (chatBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new VisionRelayError('vision relay baseUrl is empty');
  }
  const stem = base.endsWith('/v1') ? base.slice(0, -'/v1'.length) : base;
  return `${stem}/vision/recognize`;
}

function readPersistedCredentials(): { apiKey: string; baseUrl: string } | null {
  try {
    const store = depsRef?.getStore?.() ?? null;
    const apiKey = typeof store?.get(VISION_RELAY_API_KEY_KV) === 'string'
      ? (store.get(VISION_RELAY_API_KEY_KV) as string).trim()
      : '';
    const baseUrl = typeof store?.get(VISION_RELAY_BASE_URL_KV) === 'string'
      ? (store.get(VISION_RELAY_BASE_URL_KV) as string).trim()
      : '';
    if (apiKey && baseUrl) return { apiKey, baseUrl };
  } catch {
    // unreadable kv falls through to the next source
  }
  return null;
}

function readMetaIdFreeProviderCredentials(): { apiKey: string; baseUrl: string } | null {
  try {
    const store = depsRef?.getStore?.() ?? null;
    const appConfig = store?.get('app_config') as
      | { providers?: Record<string, { apiKey?: unknown; baseUrl?: unknown } | undefined> }
      | null;
    const provider = appConfig?.providers?.['idbots'] ?? appConfig?.providers?.['metaid-free'];
    const apiKey = typeof provider?.apiKey === 'string' ? provider.apiKey.trim() : '';
    const baseUrl = typeof provider?.baseUrl === 'string' ? provider.baseUrl.trim() : '';
    if (apiKey && baseUrl) return { apiKey, baseUrl };
  } catch {
    // unreadable config falls through to bootstrap
  }
  return null;
}

function persistCredentials(credentials: { apiKey: string; baseUrl: string }): void {
  try {
    const store = depsRef?.getStore?.() ?? null;
    if (store && typeof (store as { set?: unknown }).set === 'function') {
      (store as Pick<SqliteStore, 'set'>).set(VISION_RELAY_API_KEY_KV, credentials.apiKey);
      (store as Pick<SqliteStore, 'set'>).set(VISION_RELAY_BASE_URL_KV, credentials.baseUrl);
    }
  } catch {
    // persistence loss is non-fatal: the in-memory cache still serves this run
  }
}

/**
 * Resolve the relay key + chat baseUrl for vision calls. Order: in-memory
 * cache, persisted vision kv, the provisioned metaid-free provider, then a
 * fresh identity-signed bootstrap (persisted for later runs).
 */
export async function resolveVisionRelayCredentials(): Promise<{ apiKey: string; baseUrl: string }> {
  if (cachedCredentials) return cachedCredentials;
  const persisted = readPersistedCredentials();
  if (persisted) {
    cachedCredentials = persisted;
    return persisted;
  }
  const fromProvider = readMetaIdFreeProviderCredentials();
  if (fromProvider) {
    cachedCredentials = fromProvider;
    persistCredentials(fromProvider);
    return fromProvider;
  }
  const bootstrap = getDeps().bootstrapImpl
    ? getDeps().bootstrapImpl!()
    : import('./llmRelayService').then((m) => m.bootstrapLlmRelay());
  const info = await bootstrap;
  const credentials = { apiKey: info.apiKey.trim(), baseUrl: info.baseUrl.trim() };
  if (!credentials.apiKey || !credentials.baseUrl) {
    throw new VisionRelayError('vision relay bootstrap returned no apiKey/baseUrl');
  }
  cachedCredentials = credentials;
  persistCredentials(credentials);
  return credentials;
}

/**
 * Drop the vision relay credentials everywhere this service caches them: the
 * in-memory copy AND the visionRelay kv rows. Used on a rejected key and by
 * the identity-change closeout (a user_identity import/create leaves the
 * previous identity's key in both tiers otherwise).
 */
export function invalidateVisionRelayCredentials(): void {
  cachedCredentials = null;
  try {
    const store = depsRef?.getStore?.() ?? null;
    if (store && typeof (store as { delete?: unknown }).delete === 'function') {
      (store as { delete?: (key: string) => unknown }).delete(VISION_RELAY_API_KEY_KV);
      (store as { delete?: (key: string) => unknown }).delete(VISION_RELAY_BASE_URL_KV);
    }
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Image loading: Electron nativeImage fast path, bundled-ffmpeg fallback
// ---------------------------------------------------------------------------

/**
 * Build the ffmpeg argument list that re-encodes one image to a ≤1280px JPEG.
 * Pure; exported for tests. Mirrors the nativeImage pipeline's output shape.
 */
export function buildImageEncodeArgs(input: { inputPath: string; outputPath: string }): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', input.inputPath,
    '-frames:v', '1',
    '-vf', "scale='min(1280,iw)':-2",
    '-q:v', '5',
    input.outputPath,
  ];
}

const VISION_IMAGE_ENCODE_TIMEOUT_MS = 60_000;

/**
 * Re-encode one image via the bundled ffmpeg (temp file beside the temp dir).
 * Covers formats/profiles nativeImage mis-encodes — notably macOS screenshots:
 * RGB PNGs with an alpha channel decode to a correct size but re-encode to a
 * ZERO-byte JPEG, which used to surface as a confusing backend rejection.
 */
async function encodeImageViaFfmpeg(imagePath: string): Promise<{ base64: string; bytes: number } | null> {
  const fsMod = await import('fs');
  const osMod = await import('os');
  const tempDir = fsMod.mkdtempSync(path.join(osMod.tmpdir(), 'idbots-vision-img-'));
  const outputPath = path.join(tempDir, 'image.jpg');
  try {
    const run = await runFfmpegProcess(buildImageEncodeArgs({ inputPath: imagePath, outputPath }), VISION_IMAGE_ENCODE_TIMEOUT_MS);
    if (run.code !== 0) return null;
    const buffer = await fsMod.promises.readFile(outputPath);
    if (buffer.length === 0) return null;
    return { base64: buffer.toString('base64'), bytes: buffer.length };
  } catch {
    return null;
  } finally {
    try {
      fsMod.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}

async function defaultLoadImageBase64(imagePath: string): Promise<{ base64: string; bytes: number } | null> {
  try {
    const { nativeImage } = await import('electron');
    const image = nativeImage.createFromPath(imagePath);
    if (!image.isEmpty()) {
      const size = image.getSize();
      const longest = Math.max(size.width, size.height);
      const resized = longest > 1280 ? image.resize({ width: size.width >= size.height ? 1280 : 0, height: size.height > size.width ? 1280 : 0 }) : image;
      const buffer = resized.toJPEG(80);
      if (buffer.length > 0) {
        return { base64: buffer.toString('base64'), bytes: buffer.length };
      }
      // nativeImage produced nothing (alpha-channel screenshots do this);
      // fall through to the ffmpeg encoder.
    }
  } catch {
    // electron/nativeImage unavailable or threw — fall through to ffmpeg.
  }
  return encodeImageViaFfmpeg(imagePath);
}

async function loadImageBase64(imagePath: string): Promise<{ base64: string; bytes: number } | null> {
  const impl = depsRef?.loadImageBase64Impl ?? defaultLoadImageBase64;
  try {
    return await impl(imagePath);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recognize call
// ---------------------------------------------------------------------------

async function postRecognize(
  credentials: { apiKey: string; baseUrl: string },
  body: Record<string, unknown>,
  emptyContentMessage = 'vision relay returned no image description',
): Promise<VisionRelayRecognizeResult> {
  const fetchImpl = getDeps().fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_RECOGNIZE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(deriveVisionRecognizeUrl(credentials.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new VisionRelayError(`vision relay request failed: ${getErrorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== 'object') {
    throw new VisionRelayError(`vision relay returned an unreadable response (HTTP ${response.status})`);
  }
  if (payload.code !== 0) {
    const message = typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new VisionRelayError(`vision relay error: ${message}`, message);
  }
  const data = payload.data as Record<string, unknown> | null;
  const content = typeof data?.content === 'string' ? data.content : '';
  if (!content) {
    throw new VisionRelayError(emptyContentMessage);
  }
  const usageRaw = data?.usage as Record<string, unknown> | null;
  const toCount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    content,
    model: typeof data?.model === 'string' ? data.model : '',
    remainingToday: typeof data?.remainingToday === 'number' ? data.remainingToday : -1,
    usage: {
      promptTokens: toCount(usageRaw?.promptTokens),
      completionTokens: toCount(usageRaw?.completionTokens),
      totalTokens: toCount(usageRaw?.totalTokens),
      imageTokens: toCount(usageRaw?.imageTokens),
      estimated: usageRaw?.estimated === true,
    },
  };
}

/**
 * Describe one image through the vision relay. Accepts a local file path
 * (downscaled to a ≤1280px JPEG before upload) or pre-encoded base64. A
 * rejected relay key triggers exactly one re-bootstrap + retry.
 */
export async function recognizeImageViaRelay(input: VisionRelayRecognizeInput): Promise<VisionRelayRecognizeResult> {
  const body: Record<string, unknown> = {};
  if (input.imagePath) {
    const loaded = await loadImageBase64(input.imagePath);
    if (!loaded) {
      throw new VisionRelayError(`could not read image file: ${input.imagePath}`);
    }
    if (loaded.bytes > VISION_MAX_IMAGE_BYTES) {
      throw new VisionRelayError('image too large after compression; keep images under 8 MiB');
    }
    body.imageBase64 = loaded.base64;
    body.mimeType = 'image/jpeg';
  } else if (input.imageBase64) {
    body.imageBase64 = input.imageBase64;
    if (input.mimeType) body.mimeType = input.mimeType;
  } else {
    throw new VisionRelayError('imagePath or imageBase64 is required');
  }
  const prompt = (input.prompt || '').trim();
  if (prompt) body.prompt = prompt;

  return postRecognizeWithKeyRetry(body);
}

/**
 * Describe one local video through the vision relay. The video is transcoded
 * to a small H.264/mp4 clip first (downscaled, audio dropped, capped at
 * VISION_VIDEO_MAX_SECONDS) so any input format fits the upstream base64 cap.
 * A rejected relay key triggers exactly one re-bootstrap + retry.
 */
export async function recognizeVideoViaRelay(input: {
  videoPath?: string;
  videoBase64?: string;
  prompt?: string;
}): Promise<VisionRelayRecognizeResult & { truncated: boolean; durationSec: number | null }> {
  const body: Record<string, unknown> = {};
  let truncated = false;
  let durationSec: number | null = null;
  if (input.videoPath) {
    const transcoded = await transcodeVideoForVision(input.videoPath);
    body.videoBase64 = transcoded.base64;
    body.mimeType = 'video/mp4';
    truncated = transcoded.truncated;
    durationSec = transcoded.durationSec;
    if (transcoded.bytes > VISION_VIDEO_MAX_RAW_BYTES) {
      throw new VisionRelayError(
        'video still too large after compression; keep videos under ~3 minutes',
      );
    }
  } else if (input.videoBase64) {
    body.videoBase64 = input.videoBase64;
    body.mimeType = 'video/mp4';
  } else {
    throw new VisionRelayError('videoPath or videoBase64 is required');
  }
  const prompt = (input.prompt || '').trim();
  if (prompt) body.prompt = prompt;
  const result = await postRecognizeWithKeyRetry(body);
  return { ...result, truncated, durationSec };
}

async function postRecognizeWithKeyRetry(
  body: Record<string, unknown>,
  emptyContentMessage = 'vision relay returned no image description',
): Promise<VisionRelayRecognizeResult> {
  let credentials = await resolveVisionRelayCredentials();
  try {
    return await postRecognize(credentials, body, emptyContentMessage);
  } catch (error) {
    const relayMessage = error instanceof VisionRelayError ? error.relayMessage : null;
    const keyRejected = relayMessage === 'relay key invalid or revoked';
    if (!keyRejected) throw error;
    invalidateVisionRelayCredentials();
    credentials = await resolveVisionRelayCredentials();
    return postRecognize(credentials, body, emptyContentMessage);
  }
}

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mpeg': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/m4a',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.webm': 'audio/webm',
};

export function inferAudioMimeType(reference: string, explicit?: string): string {
  const provided = explicit?.trim().toLowerCase();
  if (provided) return provided;
  try {
    const extension = path.extname(new URL(reference).pathname).toLowerCase();
    if (AUDIO_MIME_BY_EXTENSION[extension]) return AUDIO_MIME_BY_EXTENSION[extension];
  } catch {
    // Local paths are handled below.
  }
  return AUDIO_MIME_BY_EXTENSION[path.extname(reference).toLowerCase()] ?? 'audio/wav';
}

const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/mp4',
  'audio/m4a', 'audio/ogg', 'audio/webm',
]);

function encodedAudioFitsRelay(base64: string): boolean {
  return Buffer.byteLength(base64, 'utf8') <= VISION_AUDIO_MAX_BASE64_BYTES;
}

/** Recognize an audio file, URL, or pre-encoded payload through the same relay. */
export async function recognizeAudioViaRelay(input: VisionAudioRecognizeInput): Promise<VisionRelayRecognizeResult> {
  const body: Record<string, unknown> = {};
  if (input.audioPath) {
    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(input.audioPath);
    } catch {
      throw new VisionRelayError(`could not read audio file: ${input.audioPath}`);
    }
    if (buffer.length === 0) throw new VisionRelayError('audio payload is invalid');
    const base64 = buffer.toString('base64');
    if (!encodedAudioFitsRelay(base64)) {
      throw new VisionRelayError('audio too large; compress or shorten the audio to keep it under 10 MiB encoded');
    }
    body.audioBase64 = base64;
    body.mimeType = inferAudioMimeType(input.audioPath, input.mimeType);
  } else if (input.audioUrl) {
    if (!/^https?:\/\//i.test(input.audioUrl.trim())) {
      throw new VisionRelayError('audio URL must be a public http/https URL');
    }
    body.audioUrl = input.audioUrl.trim();
    body.mimeType = inferAudioMimeType(input.audioUrl, input.mimeType);
  } else if (input.audioBase64) {
    const base64 = input.audioBase64.replace(/^data:[^;]+;base64,/, '').trim();
    if (!base64 || !encodedAudioFitsRelay(base64)) {
      throw new VisionRelayError('audio payload is invalid or too large; provide valid base64 under 10 MiB');
    }
    body.audioBase64 = base64;
    body.mimeType = inferAudioMimeType('', input.mimeType);
  } else {
    throw new VisionRelayError('audioPath, audioUrl, or audioBase64 is required');
  }
  if (!SUPPORTED_AUDIO_MIME_TYPES.has(String(body.mimeType))) {
    throw new VisionRelayError('audio payload is invalid');
  }
  body.prompt = (input.prompt || '').trim() || '请完整转写这段音频，保留原语言、标点和说话内容，不要总结。';
  return postRecognizeWithKeyRetry(body, 'vision relay returned no audio transcription');
}

// ---------------------------------------------------------------------------
// Video transcoding (bundled ffmpeg; aggressive one-shot-recognition settings)
// ---------------------------------------------------------------------------

/**
 * Build the ffmpeg argument list for one transcode pass. Exported for tests.
 * Recognition clips are throwaway: tiny resolution, low fps, no audio, high
 * CRF — the upstream samples 2 frames/second off the timeline regardless, so
 * visual fidelity only needs to survive 480px.
 */
export function buildVideoTranscodeArgs(input: {
  inputPath: string;
  outputPath: string;
  maxSeconds: number;
  pass: 'standard' | 'hard';
}): string[] {
  const scale = input.pass === 'standard' ? "scale='min(480,iw)':-2" : "scale='min(360,iw)':-2";
  const crf = input.pass === 'standard' ? '32' : '38';
  return [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', input.inputPath,
    '-t', String(Math.max(1, Math.floor(input.maxSeconds))),
    '-vf', scale,
    '-r', '4',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', crf,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    input.outputPath,
  ];
}

/** Parse the source duration (seconds) out of an `ffmpeg -i` stderr probe. */
// parseFfmpegDuration + resolveFfmpegPath live in mediaToolsService and are
// re-exported at the top of this file.

/**
 * Transcode one local video to a recognition-grade mp4: probe duration,
 * two escalating compression passes until the output fits the payload budget.
 */
export async function transcodeVideoForVision(videoPath: string): Promise<VisionTranscodeResult> {
  const deps = getDeps();
  if (deps.transcodeVideoImpl) return deps.transcodeVideoImpl(videoPath);

  // Probe duration (ffmpeg -i exits non-zero but prints the header)
  let durationSec: number | null = null;
  try {
    const probe = await runFfmpegProcess(['-hide_banner', '-i', videoPath], 15_000);
    durationSec = parseFfmpegDuration(probe.stderr);
  } catch {
    durationSec = null;
  }
  const truncated = durationSec != null && durationSec > VISION_VIDEO_MAX_SECONDS;

  const osMod = await import('os');
  const tempDir = deps.tempDirImpl
    ? deps.tempDirImpl()
    : fs.mkdtempSync(path.join(osMod.tmpdir(), 'idbots-vision-'));
  const readResult = async (outputPath: string): Promise<VisionTranscodeResult | null> => {
    try {
      const buffer = await fs.promises.readFile(outputPath);
      if (buffer.length === 0) return null;
      return {
        base64: buffer.toString('base64'),
        bytes: buffer.length,
        durationSec,
        truncated,
      };
    } catch {
      return null;
    }
  };

  const passes: Array<'standard' | 'hard'> = ['standard', 'hard'];
  let lastResult: VisionTranscodeResult | null = null;
  for (const pass of passes) {
    const outputPath = path.join(tempDir, `vision-${pass}.mp4`);
    const args = buildVideoTranscodeArgs({
      inputPath: videoPath,
      outputPath,
      maxSeconds: VISION_VIDEO_MAX_SECONDS,
      pass,
    });
    const run = await runFfmpegProcess(args, VISION_VIDEO_TRANSCODE_TIMEOUT_MS);
    if (run.code !== 0) {
      throw new VisionRelayError(`ffmpeg video compression failed: ${run.stderr.slice(-300)}`);
    }
    lastResult = await readResult(outputPath);
    if (lastResult && lastResult.bytes <= VISION_VIDEO_MAX_RAW_BYTES) {
      try {
        fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // temp cleanup is best-effort
      }
      return lastResult;
    }
  }
  try {
    fs.promises.rm(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  if (lastResult) return lastResult; // caller rejects oversized payloads
  throw new VisionRelayError('ffmpeg produced no output; the file may not be a valid video');
}

export function buildAudioExtractArgs(input: { inputPath: string; outputPath: string }): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', input.inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'libmp3lame',
    '-b:a', '64k',
    input.outputPath,
  ];
}

/** Extract only a video's audio track for the describe_audio relay path. */
export async function extractAudioFromVideo(videoPath: string): Promise<{
  audioPath: string;
  mimeType: string;
  bytes: number;
}> {
  const deps = getDeps();
  if (deps.extractAudioImpl) return deps.extractAudioImpl(videoPath);
  const osMod = await import('os');
  const tempDir = deps.tempDirImpl
    ? deps.tempDirImpl()
    : fs.mkdtempSync(path.join(osMod.tmpdir(), 'idbots-audio-'));
  const outputPath = path.join(tempDir, 'extracted.mp3');
  const run = await runFfmpegProcess(
    buildAudioExtractArgs({ inputPath: videoPath, outputPath }),
    VISION_VIDEO_TRANSCODE_TIMEOUT_MS,
  );
  if (run.code !== 0) {
    throw new VisionRelayError(`ffmpeg audio extraction failed: ${run.stderr.slice(-300)}`);
  }
  const stat = await fs.promises.stat(outputPath).catch(() => null);
  if (!stat || stat.size === 0) {
    throw new VisionRelayError('ffmpeg produced no audio track; the video may not contain audio');
  }
  return { audioPath: outputPath, mimeType: 'audio/mpeg', bytes: stat.size };
}

export async function recognizeVideoAudioViaRelay(input: { videoPath: string; prompt?: string }): Promise<VisionRelayRecognizeResult> {
  const extracted = await extractAudioFromVideo(input.videoPath);
  try {
    return await recognizeAudioViaRelay({
      audioPath: extracted.audioPath,
      mimeType: extracted.mimeType,
      prompt: input.prompt,
    });
  } finally {
    try {
      await fs.promises.rm(path.dirname(extracted.audioPath), { recursive: true, force: true });
    } catch {
      // best effort cleanup of the temporary extracted track
    }
  }
}
