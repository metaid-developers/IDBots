import { z } from 'zod';
import {
  assertMultisigInputsSignable,
  buildMultisigPsbt,
  combinePsbts,
  createMultisigAddress,
  finalizePsbt,
  selectMultisigInputIndexes,
  summarizePsbt,
  summarizeRawTx,
  type PsbtSummary,
} from '../services/btcMultisigScript';

export interface BtcMultisigToolsControl {
  getBtcSignerIdentity(metabotId: number): { address: string; publicKey: string };
  listBtcUtxos(address: string): Promise<Array<{ txid: string; vout: number; value: number }>>;
  signBtcPsbtPartial(metabotId: number, input: { psbtHex: string; inputIndexes?: number[] }): { psbtHex: string };
  broadcastBtcTx(rawTx: string): Promise<string>;
}

type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>,
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signQuestion(summary: PsbtSummary): string {
  const inputs = summary.inputs
    .map((input) => `- ${input.txid}:${input.vout}  ${input.value == null ? 'unknown' : `${input.value} sats`}`)
    .join('\n');
  const outputs = summary.outputs
    .map((output) => `- ${output.address}  ${output.value} sats`)
    .join('\n');
  const fee = summary.feeSats == null ? 'unknown' : `${summary.feeSats} sats`;
  return [
    '用本机 MetaBot 的钥匙为这张多签 PSBT 签名。只签名，不广播。',
    'Sign this multisig PSBT with the local MetaBot key. This signs only. It does not broadcast.',
    'inputs:',
    inputs,
    `fee: ${fee}`,
    'outputs:',
    outputs,
  ].join('\n');
}

function broadcastQuestion(rawTx: string): string {
  const summary = summarizeRawTx(rawTx);
  const outputs = summary.outputs
    .map((output) => `- ${output.address}  ${output.value} sats`)
    .join('\n');
  const outputTotal = summary.outputs.reduce((sum, output) => sum + output.value, 0);
  return [
    '即将广播一笔已完成的比特币交易。广播不可撤销。',
    'Broadcast a fully signed Bitcoin transaction. Broadcasting is irreversible.',
    `txid: ${summary.txid}`,
    `outputs_total: ${outputTotal} sats`,
    'outputs:',
    outputs,
  ].join('\n');
}

/**
 * Host tools for an on-chain multisig skill. The skill itself is not bundled
 * with IDBots; a bot installs it from chain and calls these tools.
 * Signing never touches a personal (non-multisig) input and never broadcasts.
 */
export function buildBtcMultisigAgentTools(deps: {
  tool: SdkToolFactory;
  control: BtcMultisigToolsControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
  confirmSign?: (question: string) => Promise<boolean>;
  confirmBroadcast?: (question: string) => Promise<boolean>;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId } = deps;

  const requireSession = (toolName: string): number | { error: string } => {
    const metabotId = resolveMetabotId(sessionId);
    if (metabotId == null) {
      return { error: `${toolName} could not determine which MetaBot owns this session.` };
    }
    return metabotId;
  };

  const pubkey = tool(
    'wallet_btc_pubkey',
    'Return this session MetaBot\'s compressed BTC public key and legacy address. Use when creating a BTC or MRC20 multisig vault. The key stays on this machine; only the public key is returned.',
    {},
    async () => {
      const metabotId = requireSession('wallet_btc_pubkey');
      if (typeof metabotId !== 'number') return textResult(metabotId.error, true);
      try {
        const identity = control.getBtcSignerIdentity(metabotId);
        return textResult([
          `metabot_id: ${metabotId}`,
          `address: ${identity.address}`,
          `public_key: ${identity.publicKey}`,
        ].join('\n'));
      } catch (error) {
        return textResult(`wallet_btc_pubkey failed: ${errorText(error)}`, true);
      }
    },
  );

  const utxos = tool(
    'wallet_btc_utxos',
    'List plain BTC UTXOs for an address, including a multisig P2WSH address. Read-only. The list is FILTERED: every UTXO below 1000 sats is excluded, because a sub-1000-sat output may be an inscription / MRC20 carrier (546 sats) that must never be spent as plain BTC. Use the txid, vout, and value when building a multisig PSBT. Never use this list to locate MRC20 coins.',
    {
      address: z.string().min(1).describe('Bitcoin address to inspect.'),
    },
    async (args: { address: string }) => {
      try {
        const list = await control.listBtcUtxos(args.address.trim());
        const note = 'note: UTXOs below 1000 sats are filtered out — a sub-1000-sat output may be an inscription / MRC20 carrier and is not spendable as plain BTC.';
        if (list.length === 0) return textResult(`address: ${args.address.trim()}\nutxos: none\n${note}`);
        const lines = list.map((item) => `- ${item.txid}:${item.vout}  ${item.value} sats`);
        return textResult([`address: ${args.address.trim()}`, `count: ${list.length}`, ...lines, note].join('\n'));
      } catch (error) {
        return textResult(`wallet_btc_utxos failed: ${errorText(error)}`, true);
      }
    },
  );

  const address = tool(
    'wallet_btc_multisig_address',
    'Build a mainnet P2WSH M-of-N address from compressed public keys. Pubkeys are sorted, so the address does not depend on who joined first. Use for a BTC vault or an MRC20 vault on Bitcoin.',
    {
      m: z.number().int().positive().describe('Signatures required, chosen by the initiator.'),
      pubkeys: z.array(z.string().min(66).max(66)).min(1).max(16).describe('Compressed public keys, hex.'),
    },
    async (args: { m: number; pubkeys: string[] }) => {
      try {
        const descriptor = createMultisigAddress(args.m, args.pubkeys);
        return textResult([
          `address: ${descriptor.address}`,
          `m: ${descriptor.m}`,
          `n: ${descriptor.n}`,
          `witness_script: ${descriptor.witnessScriptHex}`,
          `pubkeys: ${descriptor.pubkeys.join(',')}`,
        ].join('\n'));
      } catch (error) {
        return textResult(`wallet_btc_multisig_address failed: ${errorText(error)}`, true);
      }
    },
  );

  const build = tool(
    'wallet_btc_build_multisig_psbt',
    'Build an unsigned PSBT that spends a P2WSH multisig output. The fee is the surplus of input sats over output sats. Every output must be at least 1000 sats: smaller outputs are frozen by the inscription-carrier rule and could never be spent. This does not sign or broadcast. For MRC20, spend the exact token UTXOs and pay the miner from those sats.',
    {
      witness_script: z.string().min(1).describe('Witness script hex from wallet_btc_multisig_address.'),
      inputs: z.array(z.object({
        txid: z.string(),
        vout: z.number().int().nonnegative(),
        value: z.number().int().positive().describe('Sats locked in this output.'),
      })).min(1),
      outputs: z.array(z.object({
        address: z.string(),
        value: z.number().int().positive(),
      })).min(1),
    },
    async (args: {
      witness_script: string;
      inputs: Array<{ txid: string; vout: number; value: number }>;
      outputs: Array<{ address: string; value: number }>;
    }) => {
      try {
        const built = buildMultisigPsbt({
          witnessScriptHex: args.witness_script,
          inputs: args.inputs,
          outputs: args.outputs,
        });
        return textResult([
          `psbt_hex: ${built.psbtHex}`,
          `fee_sats: ${built.feeSats}`,
          `fee_rate_sat_vb: ${built.feeRateSatVb}`,
          ...(built.warning ? [`warning: ${built.warning}`] : []),
        ].join('\n'));
      } catch (error) {
        return textResult(`wallet_btc_build_multisig_psbt failed: ${errorText(error)}`, true);
      }
    },
  );

  const combine = tool(
    'wallet_btc_combine_psbts',
    'Merge partial PSBTs of the same unsigned transaction into one PSBT. Use after independent signers each return their own partial PSBT. This does not finalize or broadcast.',
    {
      psbt_hexes: z.array(z.string().min(1)).min(2).describe('Partial PSBT hex strings of the same transaction.'),
    },
    async (args: { psbt_hexes: string[] }) => {
      try {
        const psbtHex = combinePsbts(args.psbt_hexes);
        const summary = summarizePsbt(psbtHex);
        const sigs = summary.inputs.map((item) => item.partialSigs).join(',');
        return textResult([
          `psbt_hex: ${psbtHex}`,
          `partial_sigs: ${sigs}`,
        ].join('\n'));
      } catch (error) {
        return textResult(`wallet_btc_combine_psbts failed: ${errorText(error)}`, true);
      }
    },
  );

  const finalize = tool(
    'wallet_btc_finalize_psbt',
    'Finish a PSBT that already has enough multisig signatures and return the raw transaction. This does not broadcast. Show the result to the owner, then call wallet_btc_broadcast only after they agree.',
    {
      psbt_hex: z.string().min(1),
    },
    async (args: { psbt_hex: string }) => {
      try {
        const finalized = finalizePsbt(args.psbt_hex);
        return textResult([
          `txid: ${finalized.txid}`,
          `raw_tx: ${finalized.rawTx}`,
        ].join('\n'));
      } catch (error) {
        return textResult(`wallet_btc_finalize_psbt failed: ${errorText(error)}`, true);
      }
    },
  );

  const sign = tool(
    'wallet_btc_sign_psbt',
    'Add this session MetaBot\'s signature to the multisig inputs of a PSBT. The owner must approve. Personal wallet inputs are refused. The result is a partial PSBT and is not broadcast. Pass input_indexes only to sign a subset of the multisig inputs.',
    {
      psbt_hex: z.string().min(1),
      input_indexes: z.array(z.number().int().nonnegative()).optional(),
    },
    async (args: { psbt_hex: string; input_indexes?: number[] }) => {
      const metabotId = requireSession('wallet_btc_sign_psbt');
      if (typeof metabotId !== 'number') return textResult(metabotId.error, true);
      let summary: PsbtSummary;
      let indexes: number[];
      try {
        // `indexes` is the carrier-filtered set: a sub-1000-sat input is never
        // selected, and the signer must be asked for exactly what was shown to
        // the owner — not the raw request, not the whole PSBT.
        indexes = selectMultisigInputIndexes(args.psbt_hex, args.input_indexes);
        if (indexes.length === 0) throw new Error('no multisig input to sign');
        // Fail before the owner prompt when this key cannot actually sign the
        // selected inputs (not in the script / prevout mismatch).
        const identity = control.getBtcSignerIdentity(metabotId);
        assertMultisigInputsSignable({
          psbtHex: args.psbt_hex,
          indexes,
          publicKey: identity.publicKey,
        });
        summary = summarizePsbt(args.psbt_hex);
      } catch (error) {
        return textResult(`wallet_btc_sign_psbt failed: ${errorText(error)}`, true);
      }
      if (!deps.confirmSign) {
        return textResult('wallet_btc_sign_psbt declined: owner confirmation is unavailable.', true);
      }
      const allowed = await deps.confirmSign(signQuestion(summary));
      if (!allowed) {
        return textResult('wallet_btc_sign_psbt declined by the owner. Nothing was signed.', true);
      }
      try {
        const signed = control.signBtcPsbtPartial(metabotId, {
          psbtHex: args.psbt_hex,
          inputIndexes: indexes,
        });
        return textResult([
          'signed: partial',
          'broadcast: false',
          `psbt_hex: ${signed.psbtHex}`,
        ].join('\n'));
      } catch (error) {
        return textResult(`wallet_btc_sign_psbt failed: ${errorText(error)}`, true);
      }
    },
  );

  const broadcast = tool(
    'wallet_btc_broadcast',
    'Broadcast a fully signed Bitcoin raw transaction. The owner must approve. Use this after wallet_btc_finalize_psbt, for both BTC and native MRC20 multisig spends.',
    {
      raw_tx: z.string().min(1).describe('Signed transaction hex.'),
    },
    async (args: { raw_tx: string }) => {
      const metabotId = requireSession('wallet_btc_broadcast');
      if (typeof metabotId !== 'number') return textResult(metabotId.error, true);
      let question: string;
      try {
        question = broadcastQuestion(args.raw_tx);
      } catch (error) {
        return textResult(`wallet_btc_broadcast failed: ${errorText(error)}`, true);
      }
      if (!deps.confirmBroadcast) {
        return textResult('wallet_btc_broadcast declined: owner confirmation is unavailable.', true);
      }
      const allowed = await deps.confirmBroadcast(question);
      if (!allowed) {
        return textResult('wallet_btc_broadcast declined by the owner. Nothing was broadcast.', true);
      }
      try {
        const txid = await control.broadcastBtcTx(args.raw_tx);
        return textResult(`txid: ${txid}`);
      } catch (error) {
        return textResult(`wallet_btc_broadcast failed: ${errorText(error)}`, true);
      }
    },
  );

  return [pubkey, utxos, address, build, combine, finalize, sign, broadcast];
}
