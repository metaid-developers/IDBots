export interface BuildDelegationOrderPayloadInput {
  taskContext?: string | null;
  userTask?: string | null;
  serviceName?: string | null;
  providerSkill?: string | null;
  servicePinId?: string | null;
  paymentTxid: string;
  price: string;
  currency: string;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveDelegationOrderSkillName(input: {
  providerSkill?: string | null;
  serviceName?: string | null;
}): string {
  return normalizeText(input.providerSkill) || normalizeText(input.serviceName) || 'Service Order';
}

export function buildDelegationOrderPayload(
  input: BuildDelegationOrderPayloadInput
): string {
  const naturalText =
    normalizeText(input.taskContext)
    || normalizeText(input.userTask)
    || normalizeText(input.serviceName)
    || resolveDelegationOrderSkillName(input);
  const skillName = resolveDelegationOrderSkillName(input);
  const structuredFields = [
    `支付金额 ${normalizeText(input.price)} ${normalizeText(input.currency)}`,
    `txid: ${normalizeText(input.paymentTxid)}`,
    `service id: ${normalizeText(input.servicePinId)}`,
    `skill name: ${skillName}`,
  ].join('\n');

  return `[ORDER] ${naturalText}\n${structuredFields}`;
}
