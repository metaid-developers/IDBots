import path from 'node:path';
import { resolveMetabotDistModulePath } from '../libs/runtimePaths';

export interface SharedPrivateChatIdentity {
  globalMetaId?: string | null;
  privateKeyHex?: string | Buffer | null;
}

export interface SharedSendPrivateChatInput {
  fromIdentity: SharedPrivateChatIdentity;
  toGlobalMetaId: string;
  peerChatPublicKey: string;
  content: string;
  replyPinId?: string | null;
  timestamp?: number;
  secretVariant?: 'sha256' | 'raw';
  sharedSecretOverride?: string | null;
}

export interface SharedSendPrivateChatResult {
  path: '/protocols/simplemsg';
  encryption: '0';
  version: '1.0.0';
  contentType: 'application/json';
  payload: string;
  encryptedContent: string;
  sharedSecret: string;
  secretVariant: 'sha256' | 'raw';
}

export interface SharedReceivePrivateChatPayload {
  fromGlobalMetaId?: string | null;
  content?: string | null;
  rawData?: string | null;
  replyPinId?: string | null;
}

export interface SharedReceivePrivateChatInput {
  localIdentity: SharedPrivateChatIdentity;
  peerChatPublicKey: string;
  payload: SharedReceivePrivateChatPayload;
}

export interface SharedReceivePrivateChatResult {
  fromGlobalMetaId: string;
  replyPinId: string;
  plaintext: string;
  sharedSecret: string;
  secretVariant: 'sha256' | 'raw';
}

export type SharedServiceOrderObserverRole = 'buyer' | 'seller';

export interface SharedBuildServiceOrderObserverConversationIdInput {
  role: SharedServiceOrderObserverRole;
  metabotId: number;
  peerGlobalMetaId: string;
  paymentTxid?: string | null;
}

export interface SharedBuildServiceOrderFallbackPayloadInput {
  servicePaidTx?: string | null;
  servicePrice?: string | null;
  serviceCurrency?: string | null;
  serviceId?: string | null;
  serviceSkill?: string | null;
  peerGlobalMetaId?: string | null;
}

export interface SharedServiceOrderEventMessageInput {
  role: SharedServiceOrderObserverRole;
  refundRequestPinId?: string | null;
  refundTxid?: string | null;
}

interface SharedPrivateChatModule {
  sendPrivateChat(input: SharedSendPrivateChatInput): SharedSendPrivateChatResult;
  receivePrivateChat(input: SharedReceivePrivateChatInput): SharedReceivePrivateChatResult;
}

interface SharedSessionTraceModule {
  buildServiceOrderObserverConversationId(
    input: SharedBuildServiceOrderObserverConversationIdInput
  ): string;
  buildServiceOrderFallbackPayload(
    input: SharedBuildServiceOrderFallbackPayloadInput
  ): string;
  buildServiceOrderEventMessage(
    type: 'refund_requested' | 'refunded',
    order: SharedServiceOrderEventMessageInput
  ): string;
}

let cachedPrivateChatModule: SharedPrivateChatModule | null = null;
let cachedSessionTraceModule: SharedSessionTraceModule | null = null;

function resolveMetabotModulePath(relativePath: string): string {
  return resolveMetabotDistModulePath(relativePath, { startDir: __dirname });
}

function loadPrivateChatModule(): SharedPrivateChatModule {
  if (cachedPrivateChatModule) {
    return cachedPrivateChatModule;
  }
  cachedPrivateChatModule = require(resolveMetabotModulePath('core/chat/privateChat.js')) as SharedPrivateChatModule;
  return cachedPrivateChatModule;
}

function loadSessionTraceModule(): SharedSessionTraceModule {
  if (cachedSessionTraceModule) {
    return cachedSessionTraceModule;
  }
  cachedSessionTraceModule = require(resolveMetabotModulePath('core/chat/sessionTrace.js')) as SharedSessionTraceModule;
  return cachedSessionTraceModule;
}

export function sendSharedPrivateChat(
  input: SharedSendPrivateChatInput
): SharedSendPrivateChatResult {
  return loadPrivateChatModule().sendPrivateChat(input);
}

export function receiveSharedPrivateChat(
  input: SharedReceivePrivateChatInput
): SharedReceivePrivateChatResult {
  return loadPrivateChatModule().receivePrivateChat(input);
}

export function buildSharedServiceOrderObserverConversationId(
  input: SharedBuildServiceOrderObserverConversationIdInput
): string {
  return loadSessionTraceModule().buildServiceOrderObserverConversationId(input);
}

export function buildSharedServiceOrderFallbackPayload(
  input: SharedBuildServiceOrderFallbackPayloadInput
): string {
  return loadSessionTraceModule().buildServiceOrderFallbackPayload(input);
}

export function buildSharedServiceOrderEventMessage(
  type: 'refund_requested' | 'refunded',
  order: SharedServiceOrderEventMessageInput
): string {
  return loadSessionTraceModule().buildServiceOrderEventMessage(type, order);
}
