import { normalizeDelegationPaymentTerms } from '../libs/coworkRunner';
import { parseGigSquareSettlementAsset } from '../shared/gigSquareSettlementAsset.js';
import { buildDelegationOrderPayload } from './delegationOrderMessage';

type DelegationSettlementKind = 'native' | 'mrc20';
type DelegationPaymentChain = 'mvc' | 'btc' | 'doge';

interface DelegationServiceSettlementSource {
  currency?: string | null;
  settlementKind?: string | null;
  paymentChain?: string | null;
  mrc20Ticker?: string | null;
  mrc20Id?: string | null;
}

export interface ResolvedDelegationSettlement {
  price: string;
  protocolCurrency: string;
  displayCurrency: string;
  paymentMode: DelegationSettlementKind;
  settlementKind: DelegationSettlementKind;
  paymentChain: DelegationPaymentChain;
  mrc20Ticker: string | null;
  mrc20Id: string | null;
}

interface ResolveDelegationSettlementInput {
  rawPrice?: string | null;
  rawCurrency?: string | null;
  service?: DelegationServiceSettlementSource | null;
}

interface BuildDelegationOrderPayloadFromSettlementInput {
  rawRequest?: string | null;
  taskContext?: string | null;
  userTask?: string | null;
  serviceName?: string | null;
  providerSkill?: string | null;
  servicePinId?: string | null;
  outputType?: string | null;
  paymentTxid: string;
  paymentCommitTxid?: string | null;
  orderReference?: string | null;
  settlement: ResolvedDelegationSettlement;
}

interface BuildDelegationOrderPayloadFromServiceInput
  extends Omit<BuildDelegationOrderPayloadFromSettlementInput, 'settlement'>,
    ResolveDelegationSettlementInput {}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveDelegationSettlement(
  input: ResolveDelegationSettlementInput
): ResolvedDelegationSettlement {
  const normalizedTerms = normalizeDelegationPaymentTerms(
    normalizeText(input.rawPrice),
    normalizeText(input.rawCurrency)
  );
  const price = normalizedTerms.price || '0';
  const service = input.service ?? null;
  const settlement = parseGigSquareSettlementAsset({
    paymentCurrency: normalizeText(service?.currency) || normalizedTerms.currency || 'SPACE',
    settlementKind: normalizeText(service?.settlementKind) || undefined,
    paymentChain: normalizeText(service?.paymentChain) || undefined,
    mrc20Ticker: normalizeText(service?.mrc20Ticker) || undefined,
    mrc20Id: normalizeText(service?.mrc20Id) || undefined,
  });
  const protocolCurrency = settlement.protocolCurrency;

  return {
    price,
    protocolCurrency,
    displayCurrency: protocolCurrency === 'MVC' ? 'SPACE' : protocolCurrency,
    paymentMode: settlement.settlementKind as DelegationSettlementKind,
    settlementKind: settlement.settlementKind as DelegationSettlementKind,
    paymentChain: settlement.paymentChain as DelegationPaymentChain,
    mrc20Ticker: settlement.mrc20Ticker,
    mrc20Id: settlement.mrc20Id,
  };
}

export function buildDelegationOrderPayloadFromSettlement(
  input: BuildDelegationOrderPayloadFromSettlementInput
): string {
  return buildDelegationOrderPayload({
    rawRequest: input.rawRequest,
    taskContext: input.taskContext,
    userTask: input.userTask,
    serviceName: input.serviceName,
    providerSkill: input.providerSkill,
    servicePinId: input.servicePinId,
    paymentTxid: input.paymentTxid,
    paymentCommitTxid: normalizeText(input.paymentCommitTxid),
    orderReference: input.orderReference,
    price: input.settlement.price,
    currency: input.settlement.displayCurrency,
    paymentChain: input.settlement.paymentChain,
    settlementKind: input.settlement.settlementKind,
    mrc20Ticker: input.settlement.mrc20Ticker,
    mrc20Id: input.settlement.mrc20Id,
    outputType: input.outputType,
  });
}

export function buildDelegationOrderPayloadFromService(
  input: BuildDelegationOrderPayloadFromServiceInput
): {
  settlement: ResolvedDelegationSettlement;
  payload: string;
} {
  const settlement = resolveDelegationSettlement({
    rawPrice: input.rawPrice,
    rawCurrency: input.rawCurrency,
    service: input.service,
  });

  return {
    settlement,
    payload: buildDelegationOrderPayloadFromSettlement({
      rawRequest: input.rawRequest,
      taskContext: input.taskContext,
      userTask: input.userTask,
      serviceName: input.serviceName,
      providerSkill: input.providerSkill,
      servicePinId: input.servicePinId,
      paymentTxid: input.paymentTxid,
      paymentCommitTxid: input.paymentCommitTxid,
      orderReference: input.orderReference,
      settlement,
    }),
  };
}
