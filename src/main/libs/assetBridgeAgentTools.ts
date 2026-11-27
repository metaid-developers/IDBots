import { z } from 'zod';
import type { AssetBridgeJobView } from '../../renderer/components/chat/assetBridgeCardSyntax';
import { buildAssetBridgeCardFence } from '../../renderer/components/chat/assetBridgeCardSyntax';

type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>,
) => unknown;

export interface AssetBridgeToolsControl {
  createQuote(input: {
    sessionId: string;
    metabotId: number;
    asset: string;
    fromChain: 'btc' | 'mvc';
    amount: string;
    onComplete?: string | null;
    btcFeeRate?: number;
  }): Promise<AssetBridgeJobView>;
  getJob(jobId: string): AssetBridgeJobView | null;
  listJobs(metabotId: number, limit?: number): AssetBridgeJobView[];
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

function cardResult(text: string, job: AssetBridgeJobView, isError = false) {
  return {
    content: [
      { type: 'text' as const, text },
      { type: 'text' as const, text: buildAssetBridgeCardFence(job) },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function summarize(job: AssetBridgeJobView): string {
  return `${job.jobId}: ${job.amountDisplay} ${job.symbol} ${job.sourceChain.toUpperCase()} -> ${job.targetChain.toUpperCase()} ${job.targetSymbol}; state=${job.state}; blockers=${job.blockers.length}`;
}

export function buildAssetBridgeAgentTools(deps: {
  tool: SdkToolFactory;
  control: AssetBridgeToolsControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId } = deps;
  return [
    tool(
      'asset_bridge_quote',
      [
        'Prepare an owner-confirmed Octopus asset bridge quote for the session bot\'s own wallet.',
        'Supports BTC<->WBTC (MVC) and MRC-20<->MVC MetaContract token pairs.',
        'This tool ONLY prepares a quote and never starts or executes a bridge: the owner must click Confirm in the card.',
        'Never claim the bridge started after calling this tool. Include the emitted asset-bridge-card fence verbatim in the visible reply.',
        'Pass on_complete when the owner said what to do after arrival. If no amount was provided, ask for an amount unless the owner clearly meant everything (use "max").',
      ].join(' '),
      {
        asset: z.string().describe('Asset symbol such as BTC/WBTC or an MRC-20 symbol; leading $ is accepted'),
        from_chain: z.enum(['btc', 'mvc']).describe('Chain the asset currently sits on'),
        amount: z.string().describe('Display-unit amount, or "max" when the owner clearly means everything'),
        on_complete: z.string().optional().describe('Owner instruction to carry out after the bridge completes'),
        btc_fee_rate: z.number().positive().optional().describe('BTC fee rate in sat/vB'),
      },
      async (args: { asset: string; from_chain: 'btc' | 'mvc'; amount: string; on_complete?: string; btc_fee_rate?: number }) => {
        try {
          const metabotId = resolveMetabotId(sessionId);
          if (!metabotId) return textResult('Unable to resolve the session MetaBot.', true);
          const job = await control.createQuote({
            sessionId,
            metabotId,
            asset: args.asset,
            fromChain: args.from_chain,
            amount: args.amount,
            onComplete: args.on_complete ?? null,
            btcFeeRate: args.btc_fee_rate,
          });
          const blockerText = job.blockers.length ? ` Blocked: ${job.blockers.map((item) => item.messageEn).join('; ')}` : '';
          return cardResult(
            `Bridge quote prepared only — not started. ${job.amountDisplay} ${job.symbol} ${job.sourceChain.toUpperCase()} -> ${job.targetChain.toUpperCase()} ${job.targetSymbol}. The owner must click Confirm in this card.${blockerText}`,
            job,
          );
        } catch (error) {
          return textResult(`Failed to prepare bridge quote: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      },
    ),
    tool(
      'asset_bridge_status',
      'Read-only status lookup for built-in asset bridge jobs. With job_id returns that job and its asset-bridge-card fence; without job_id lists the session bot\'s last 5 jobs and includes the newest job card fence.',
      { job_id: z.string().optional().describe('Asset bridge job id (ab_...)') },
      async (args: { job_id?: string }) => {
        try {
          const metabotId = resolveMetabotId(sessionId);
          if (!metabotId) return textResult('Unable to resolve the session MetaBot.', true);
          if (args.job_id?.trim()) {
            const job = control.getJob(args.job_id.trim());
            if (!job || job.metabotId !== metabotId) return textResult('Asset bridge job not found for this session bot.', true);
            return cardResult(summarize(job), job);
          }
          const jobs = control.listJobs(metabotId, 5);
          if (!jobs.length) return textResult('No asset bridge jobs found for this session bot.');
          const text = jobs.map(summarize).join('\n');
          return cardResult(text, jobs[0]);
        } catch (error) {
          return textResult(`Failed to read bridge status: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      },
    ),
  ];
}
