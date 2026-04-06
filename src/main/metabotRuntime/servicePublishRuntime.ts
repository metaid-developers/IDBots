import {
  buildGigSquareLocalServiceRecordForPublish,
  type GigSquareLocalServiceMutationRecord,
  type GigSquareModifyDraft,
  type GigSquareServicePayload,
} from '../services/gigSquareServiceMutationService';

const PORTABLE_SERVICE_PATH = '/protocols/skill-service';

export interface PortableServicePublishDeps {
  buildGigSquareServicePayload(input: {
    draft: GigSquareModifyDraft;
    providerGlobalMetaId: string;
    paymentAddress: string;
  }): GigSquareServicePayload;
  createPin(
    store: unknown,
    metabotId: number,
    pinInput: {
      operation: 'create';
      path: string;
      encryption: '0';
      version: '1.0.0';
      contentType: 'application/json';
      payload: string;
    },
  ): Promise<{ pinId: string; txids?: string[] }>;
  insertLocalServiceRow(row: GigSquareLocalServiceMutationRecord): void;
  scheduleRemoteSync(): void;
}

export interface BuildPortableServicePublishRecordInput {
  pinId: string;
  txid?: string;
  metabotId: number;
  providerGlobalMetaId: string;
  payload: GigSquareServicePayload;
  payloadJson: string;
  now?: number;
}

export interface PublishPortableServiceInput {
  store?: unknown;
  metabotId: number;
  serviceDraft: GigSquareModifyDraft;
  providerGlobalMetaId?: string;
  paymentAddress?: string;
  deps: PortableServicePublishDeps;
}

export interface PublishPortableServiceResult {
  pinId: string;
  txids: string[];
  payloadJson: string;
  normalizedRecord: GigSquareLocalServiceMutationRecord;
}

export function buildPortableServicePublishRecord(
  input: BuildPortableServicePublishRecordInput,
): GigSquareLocalServiceMutationRecord {
  return buildGigSquareLocalServiceRecordForPublish({
    pinId: input.pinId,
    txid: input.txid,
    metabotId: input.metabotId,
    providerGlobalMetaId: input.providerGlobalMetaId,
    payload: input.payload,
    payloadJson: input.payloadJson,
    now: input.now,
  });
}

export async function publishPortableService(
  input: PublishPortableServiceInput,
): Promise<PublishPortableServiceResult> {
  const payload = input.deps.buildGigSquareServicePayload({
    draft: input.serviceDraft,
    providerGlobalMetaId: input.providerGlobalMetaId ?? '',
    paymentAddress: input.paymentAddress ?? '',
  });
  const payloadJson = JSON.stringify(payload);
  const result = await input.deps.createPin(input.store, input.metabotId, {
    operation: 'create',
    path: PORTABLE_SERVICE_PATH,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: payloadJson,
  });
  const txids = Array.isArray(result.txids) ? result.txids : [];
  const normalizedRecord = buildPortableServicePublishRecord({
    pinId: result.pinId,
    txid: txids[0] || '',
    metabotId: input.metabotId,
    providerGlobalMetaId: input.providerGlobalMetaId ?? payload.providerMetaBot,
    payload,
    payloadJson,
  });

  input.deps.insertLocalServiceRow(normalizedRecord);
  input.deps.scheduleRemoteSync();

  return {
    pinId: result.pinId,
    txids,
    payloadJson,
    normalizedRecord,
  };
}
