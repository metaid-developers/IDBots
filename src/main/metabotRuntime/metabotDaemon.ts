import type { MetabotStore } from '../metabotStore';
import { buildDeliveryMessage } from '../services/serviceOrderProtocols.js';
import type { OrderSource } from '../services/orderPayment';
import { normalizeServiceRequestContract, type ServiceRequestContract } from './contracts';
import type { HostSessionAdapter } from './hostSessionAdapter';
import {
  executeProviderRequest,
  type ExecuteProviderRequestResult,
  type ProviderExecutionContext,
} from './providerExecutionRuntime';
import {
  createServiceOrderTraceWriter,
  type RequestTraceRuntime,
} from './requestTraceRuntime';
import {
  verifyPortablePaymentEligibility,
  type VerifyPortablePaymentEligibilityResult,
} from './paymentVerificationRuntime';
import {
  writePortableDeliveryRecord,
  type WritePortableDeliveryDeps,
  type WritePortableDeliveryRecordResult,
} from './resultDeliveryRuntime';
import {
  buildDeliveryTransportEnvelope,
  type ProviderDeliveryEnvelope,
} from './transportRuntime';
import type { ServiceOrderTraceLifecycle } from '../services/serviceOrderLifecycleService';

const missingDeliveryDeps = (): never => {
  throw new Error('MetabotDaemon requires delivery write dependencies in normal mode');
};

export interface MetabotDaemonProviderContext extends ProviderExecutionContext {
  metabotStore: MetabotStore;
  source: OrderSource;
  serviceOrderLifecycle?: ServiceOrderTraceLifecycle | null;
  store?: unknown;
  buildDeliveryMessage?: WritePortableDeliveryDeps['buildDeliveryMessage'];
  prepareSimpleMessagePayload?: WritePortableDeliveryDeps['prepareSimpleMessagePayload'];
  createPin?: WritePortableDeliveryDeps['createPin'];
  deliveredAt?: number;
}

interface MetabotDaemonOptions {
  verifyPortablePaymentEligibility?: typeof verifyPortablePaymentEligibility;
  createServiceOrderTraceWriter?: typeof createServiceOrderTraceWriter;
  executeProviderRequest?: typeof executeProviderRequest;
  writePortableDeliveryRecord?: typeof writePortableDeliveryRecord;
  buildDeliveryTransportEnvelope?: typeof buildDeliveryTransportEnvelope;
  now?: () => number;
}

export interface HandleWakeUpInput {
  request: Partial<ServiceRequestContract>;
  providerContext: MetabotDaemonProviderContext;
  hostAdapter: HostSessionAdapter;
}

export interface HandleWakeUpResult {
  request: ServiceRequestContract;
  verification: VerifyPortablePaymentEligibilityResult;
  execution: ExecuteProviderRequestResult;
  deliveryRecord: WritePortableDeliveryRecordResult | null;
  providerDelivery: ProviderDeliveryEnvelope | null;
}

export class MetabotDaemon {
  private readonly verifyPortablePaymentEligibilityImpl: typeof verifyPortablePaymentEligibility;
  private readonly createServiceOrderTraceWriterImpl: typeof createServiceOrderTraceWriter;
  private readonly executeProviderRequestImpl: typeof executeProviderRequest;
  private readonly writePortableDeliveryRecordImpl: typeof writePortableDeliveryRecord;
  private readonly buildDeliveryTransportEnvelopeImpl: typeof buildDeliveryTransportEnvelope;
  private readonly now: () => number;

  constructor(options: MetabotDaemonOptions = {}) {
    this.verifyPortablePaymentEligibilityImpl =
      options.verifyPortablePaymentEligibility ?? verifyPortablePaymentEligibility;
    this.createServiceOrderTraceWriterImpl =
      options.createServiceOrderTraceWriter ?? createServiceOrderTraceWriter;
    this.executeProviderRequestImpl =
      options.executeProviderRequest ?? executeProviderRequest;
    this.writePortableDeliveryRecordImpl =
      options.writePortableDeliveryRecord ?? writePortableDeliveryRecord;
    this.buildDeliveryTransportEnvelopeImpl =
      options.buildDeliveryTransportEnvelope ?? buildDeliveryTransportEnvelope;
    this.now = options.now ?? Date.now;
  }

  async handleWakeUp(input: HandleWakeUpInput): Promise<HandleWakeUpResult> {
    const request = normalizeServiceRequestContract(input.request);
    const verification = await this.verifyPortablePaymentEligibilityImpl({
      request,
      providerContext: {
        metabotId: input.providerContext.metabotId,
        metabotStore: input.providerContext.metabotStore,
        source: input.providerContext.source,
      },
    });

    const trace = this.createServiceOrderTraceWriterImpl(input.providerContext.serviceOrderLifecycle ?? null);
    const execution = await this.executeProviderRequestImpl({
      request,
      verification,
      providerContext: input.providerContext,
      trace,
      hostAdapter: input.hostAdapter,
    });

    if (!execution.executable) {
      return {
        request,
        verification,
        execution,
        deliveryRecord: null,
        providerDelivery: null,
      };
    }

    const deliveryRecord = await this.writePortableDeliveryRecordImpl({
      store: input.providerContext.store,
      metabotId: input.providerContext.metabotId,
      request,
      paymentTxid: execution.paymentTxid,
      counterpartyGlobalMetaId: input.providerContext.counterpartyGlobalMetaId,
      serviceName: input.providerContext.serviceName,
      delivery: {
        text: execution.text,
        attachments: execution.attachments,
      },
      deliveredAt: input.providerContext.deliveredAt
        ?? Math.floor(this.now() / 1000),
      trace: {
        markSellerDelivered: (traceInput) => trace.markSellerDelivered(traceInput),
      },
      deps: {
        buildDeliveryMessage: input.providerContext.buildDeliveryMessage ?? buildDeliveryMessage,
        prepareSimpleMessagePayload: input.providerContext.prepareSimpleMessagePayload,
        createPin: input.providerContext.createPin ?? missingDeliveryDeps,
      },
    });

    const providerDelivery = this.buildDeliveryTransportEnvelopeImpl({
      request,
      deliveryWrite: deliveryRecord.deliveryWrite,
    });

    return {
      request,
      verification,
      execution,
      deliveryRecord,
      providerDelivery,
    };
  }
}
