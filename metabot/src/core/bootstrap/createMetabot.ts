export interface BootstrapCreateRequest {
  name: string;
  avatar?: string | null;
  role?: string | null;
}

export interface BootstrapSubsidyInput {
  mvcAddress: string;
  mnemonic?: string;
  path?: string;
}

export interface BootstrapCreateResult<TMetabot> {
  metabot: TMetabot;
  subsidyInput?: BootstrapSubsidyInput;
}

export type BootstrapCreateStep<TRequest extends BootstrapCreateRequest, TMetabot> = (
  request: TRequest
) => Promise<BootstrapCreateResult<TMetabot>>;

export async function runCreateMetabotStep<TRequest extends BootstrapCreateRequest, TMetabot>(
  step: BootstrapCreateStep<TRequest, TMetabot>,
  request: TRequest
): Promise<BootstrapCreateResult<TMetabot>> {
  return step(request);
}
