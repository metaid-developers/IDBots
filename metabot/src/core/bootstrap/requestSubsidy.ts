import type { BootstrapCreateRequest, BootstrapSubsidyInput } from './createMetabot';

export interface BootstrapSubsidyResult {
  success: boolean;
  error?: string;
  step1?: unknown;
  step2?: unknown;
}

export interface BootstrapSubsidyContext<TRequest extends BootstrapCreateRequest, TMetabot> {
  request: TRequest;
  metabot: TMetabot;
  subsidyInput?: BootstrapSubsidyInput;
}

export type BootstrapRequestSubsidyStep<TRequest extends BootstrapCreateRequest, TMetabot> = (
  context: BootstrapSubsidyContext<TRequest, TMetabot>
) => Promise<BootstrapSubsidyResult>;

export async function runRequestSubsidyStep<TRequest extends BootstrapCreateRequest, TMetabot>(
  step: BootstrapRequestSubsidyStep<TRequest, TMetabot>,
  context: BootstrapSubsidyContext<TRequest, TMetabot>
): Promise<BootstrapSubsidyResult> {
  return step(context);
}
