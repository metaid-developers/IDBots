import type { AsrUpstreamProvider } from './types.js';

/**
 * FunASR upstream — RESERVED slot for the self-deployed FunASR switch the
 * owner planned after the Doubao P0 (decision recorded in the voice channel
 * plan). Selecting `funasr` in config is accepted (with an endpoint), but
 * starting a session fails loudly instead of pretending to work; filling
 * this file in later does not touch the gateway or the client protocol.
 */
export class FunAsrUpstream implements AsrUpstreamProvider {
  readonly name = 'funasr';

  constructor(private readonly endpoint: string) {}

  startSession(): Promise<never> {
    return Promise.reject(
      new Error(
        `FunASR upstream is not implemented yet (endpoint ${this.endpoint}); ` +
          'implement src/services/asr/upstream-funasr.ts to switch — the gateway and client protocol stay unchanged',
      ),
    );
  }
}
