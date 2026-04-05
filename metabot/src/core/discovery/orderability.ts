import { normalizeComparableGlobalMetaId } from './serviceDirectory';

export type DelegationOrderabilityStatus = 'available' | 'offline' | 'missing';

export interface ResolveDelegationOrderabilityParams {
  availableServices: any[];
  allServices: any[];
  servicePinId: string;
  providerGlobalMetaId: string;
}

export interface ResolveDelegationOrderabilityResult {
  status: DelegationOrderabilityStatus;
  service: any | null;
}

const serviceMatches = (service: any, servicePinId: string, providerGlobalMetaId: string): boolean => {
  return (
    (service?.pinId === servicePinId || service?.sourceServicePinId === servicePinId) &&
    normalizeComparableGlobalMetaId(service?.providerGlobalMetaId || service?.globalMetaId)
      === normalizeComparableGlobalMetaId(providerGlobalMetaId)
  );
};

export const resolveDelegationOrderability = (
  params: ResolveDelegationOrderabilityParams
): ResolveDelegationOrderabilityResult => {
  const availableService = params.availableServices.find((service) => (
    serviceMatches(service, params.servicePinId, params.providerGlobalMetaId)
  ));
  if (availableService) {
    return { status: 'available', service: availableService };
  }

  const dbService = params.allServices.find((service) => (
    serviceMatches(service, params.servicePinId, params.providerGlobalMetaId)
  ));
  if (dbService) {
    return { status: 'offline', service: null };
  }

  return { status: 'missing', service: null };
};
