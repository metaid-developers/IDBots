/**
 * MetaID Core RPC Gateway: local HTTP service for create-pin and read operations.
 * Binds to 127.0.0.1 only for security.
 */

import http from 'http';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type { SqliteStore } from '../sqliteStore';
import type { MetabotStore } from '../metabotStore';
import { createPin, getPinData, setMetaidCoreStore, type MetaidDataPayload } from './metaidCore';
import {
  assignGroupChatTask,
  resolveMetabotIdByName,
  type AssignGroupChatTaskParams,
} from './assignGroupChatTaskService';
import { getAddressBalance } from './addressBalanceService';
import { getRate as getGlobalFeeRate, getAllTiers as getGlobalFeeTiers } from './feeRateStore';
import { listenWithRetry } from './httpListenWithRetry';
import { DEFAULT_METAID_RPC_HOST, getMetaidRpcBase, resolveMetaidRpcPort } from './metaidRpcEndpoint';
import { getMetabotAccountSummary } from './metabotAccountService';
import { buildMvcFtTransferRawTx, buildMvcOrderedRawTxBundle, buildMvcTransferRawTx } from './walletRawTxService';
import { executeTransfer } from './transferService';

const RPC_HOST = DEFAULT_METAID_RPC_HOST;

const PIN_ROUTE_PREFIX = '/api/metaid/pin/';
const ASSIGN_GROUP_CHAT_TASK_PATH = '/api/idbots/assign-group-chat-task';
const RESOLVE_METABOT_ID_PATH = '/api/idbots/resolve-metabot-id';
const METABOT_ACCOUNT_SUMMARY_PATH = '/api/idbots/metabot/account-summary';
const ADDRESS_BALANCE_PATH = '/api/idbots/address/balance';
const FEE_RATE_SUMMARY_PATH = '/api/idbots/fee-rate-summary';
const BUILD_MVC_TRANSFER_RAW_TX_PATH = '/api/idbots/wallet/mvc/build-transfer-rawtx';
const BUILD_MVC_FT_TRANSFER_RAW_TX_PATH = '/api/idbots/wallet/mvc-ft/build-transfer-rawtx';
const BUILD_MVC_RAW_TX_BUNDLE_PATH = '/api/idbots/wallet/mvc/build-rawtx-bundle';
const EXECUTE_TRANSFER_PATH = '/api/idbots/wallet/transfer';

export function startMetaidRpcServer(
  getMetabotStore: () => MetabotStore,
  getStore: () => SqliteStore
): http.Server {
  setMetaidCoreStore(getStore);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '';
    const [pathname, search] = url.split('?');
    const persist = new URLSearchParams(search || '').get('persist') === 'true';

    if (req.method === 'POST' && pathname === RESOLVE_METABOT_ID_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      let parsed: { name?: string };
      try {
        parsed = JSON.parse(body) as { name?: string };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      if (!name) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'name is required' }));
        return;
      }
      try {
        const store = getMetabotStore();
        const metabotId = resolveMetabotIdByName(store, name);
        if (metabotId == null) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: false, error: 'MetaBot not found' }));
          return;
        }
        const m = store.getMetabotById(metabotId);
        res.writeHead(200);
        res.end(
          JSON.stringify({
            success: true,
            metabot_id: metabotId,
            display_name: m?.name?.trim() ?? name,
          })
        );
      } catch (err) {
        const message =
          err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === ASSIGN_GROUP_CHAT_TASK_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      let params: AssignGroupChatTaskParams;
      try {
        params = JSON.parse(body) as AssignGroupChatTaskParams;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      try {
        const db = getStore().getDatabase();
        const saveDb = getStore().getSaveFunction();
        const result = assignGroupChatTask(db, saveDb, getMetabotStore(), params);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, message: '', error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === METABOT_ACCOUNT_SUMMARY_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      let parsed: { metabot_id?: number };
      try {
        parsed = JSON.parse(body) as { metabot_id?: number };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const summary = getMetabotAccountSummary(getMetabotStore(), Number(parsed.metabot_id));
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...summary }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === ADDRESS_BALANCE_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }

      let parsed: { metabot_id?: number; addresses?: { mvc?: string; btc?: string; doge?: string } };
      try {
        parsed = JSON.parse(body) as { metabot_id?: number; addresses?: { mvc?: string; btc?: string; doge?: string } };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const providedAddresses = parsed.addresses ?? {};
        const hasAddressPayload = parsed.addresses != null && typeof parsed.addresses === 'object';
        const normalizedAddresses: { mvc?: string; btc?: string; doge?: string } = {
          mvc: typeof providedAddresses.mvc === 'string' ? providedAddresses.mvc.trim() : '',
          btc: typeof providedAddresses.btc === 'string' ? providedAddresses.btc.trim() : '',
          doge: typeof providedAddresses.doge === 'string' ? providedAddresses.doge.trim() : '',
        };

        if (Number.isInteger(parsed.metabot_id) && Number(parsed.metabot_id) > 0) {
          const summary = getMetabotAccountSummary(getMetabotStore(), Number(parsed.metabot_id));
          if (!normalizedAddresses.mvc) normalizedAddresses.mvc = summary.mvc_address;
          if (hasAddressPayload && !normalizedAddresses.btc) normalizedAddresses.btc = summary.btc_address;
          if (hasAddressPayload && !normalizedAddresses.doge) normalizedAddresses.doge = summary.doge_address;
        }

        if (!normalizedAddresses.mvc && !normalizedAddresses.btc && !normalizedAddresses.doge) {
          throw new Error('Either metabot_id or addresses is required');
        }

        const balance: Record<string, { value: number; unit: string; satoshis: number; address: string }> = {};
        if (normalizedAddresses.mvc) {
          const mvcBalance = await getAddressBalance('mvc', normalizedAddresses.mvc);
          balance.mvc = {
            value: mvcBalance.value,
            unit: mvcBalance.unit,
            satoshis: mvcBalance.satoshis,
            address: mvcBalance.address,
          };
        }
        if (normalizedAddresses.btc) {
          const btcBalance = await getAddressBalance('btc', normalizedAddresses.btc);
          balance.btc = {
            value: btcBalance.value,
            unit: btcBalance.unit,
            satoshis: btcBalance.satoshis,
            address: btcBalance.address,
          };
        }
        if (normalizedAddresses.doge) {
          const dogeBalance = await getAddressBalance('doge', normalizedAddresses.doge);
          balance.doge = {
            value: dogeBalance.value,
            unit: dogeBalance.unit,
            satoshis: dogeBalance.satoshis,
            address: dogeBalance.address,
          };
        }

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, balance }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === FEE_RATE_SUMMARY_PATH) {
      const query = new URLSearchParams(search || '');
      const chainRaw = (query.get('chain') || 'mvc').toLowerCase();
      const chain = chainRaw === 'btc' || chainRaw === 'doge' ? chainRaw : 'mvc';
      const tiers = getGlobalFeeTiers();
      const list = Array.isArray((tiers as Record<string, unknown[]>)[chain]) ? (tiers as Record<string, unknown[]>)[chain] : [];
      res.writeHead(200);
      res.end(
        JSON.stringify({
          success: true,
          list,
          defaultFeeRate: getGlobalFeeRate(chain),
        }),
      );
      return;
    }

    if (req.method === 'POST' && pathname === EXECUTE_TRANSFER_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      let parsed: {
        metabot_id?: number;
        chain?: string;
        to_address?: string;
        amount?: string | number;
        fee_rate?: number;
      };
      try {
        parsed = JSON.parse(body) as {
          metabot_id?: number;
          chain?: string;
          to_address?: string;
          amount?: string | number;
          fee_rate?: number;
        };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      const chainRaw = String(parsed.chain || '').toLowerCase().trim();
      const chain = chainRaw === 'space' ? 'mvc' : chainRaw;
      if (chain !== 'mvc' && chain !== 'btc' && chain !== 'doge') {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'chain is required' }));
        return;
      }
      const metabotId = Number(parsed.metabot_id);
      if (!Number.isFinite(metabotId) || metabotId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'metabot_id is required' }));
        return;
      }
      const toAddress = String(parsed.to_address || '').trim();
      if (!toAddress) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'to_address is required' }));
        return;
      }
      const amountRaw = parsed.amount ?? '';
      const amount = typeof amountRaw === 'number' ? String(amountRaw) : String(amountRaw || '').trim();
      if (!amount || !Number.isFinite(Number(amount))) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'amount is required' }));
        return;
      }
      const feeRate = Number.isFinite(Number(parsed.fee_rate)) ? Number(parsed.fee_rate) : getGlobalFeeRate(chain);

      try {
        const result = await executeTransfer(getMetabotStore(), {
          metabotId,
          chain,
          toAddress,
          amountSpaceOrDoge: amount,
          feeRate,
        });
        if (!result.success) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: result.error || 'Transfer failed' }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, txid: result.txId }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === BUILD_MVC_TRANSFER_RAW_TX_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      let parsed: {
        metabot_id?: number;
        to_address?: string;
        amount_sats?: number;
        fee_rate?: number;
        exclude_outpoints?: string[];
      };
      try {
        parsed = JSON.parse(body) as {
          metabot_id?: number;
          to_address?: string;
          amount_sats?: number;
          fee_rate?: number;
          exclude_outpoints?: string[];
        };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const result = await buildMvcTransferRawTx(getMetabotStore(), {
          metabotId: Number(parsed.metabot_id),
          toAddress: String(parsed.to_address || '').trim(),
          amountSats: Number(parsed.amount_sats),
          feeRate: Number(parsed.fee_rate),
          excludeOutpoints: parsed.exclude_outpoints,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === BUILD_MVC_FT_TRANSFER_RAW_TX_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
        let parsed: {
          metabot_id?: number;
          token?: {
            symbol?: string;
            tokenID?: string;
            genesisHash?: string;
            codeHash?: string;
            decimal?: number;
          };
          to_address?: string;
          amount?: string;
          fee_rate?: number;
          exclude_outpoints?: string[];
          funding_raw_tx?: string;
          funding_outpoint?: string;
        };
      try {
        parsed = JSON.parse(body) as {
          metabot_id?: number;
          token?: {
            symbol?: string;
            tokenID?: string;
            genesisHash?: string;
            codeHash?: string;
            decimal?: number;
          };
          to_address?: string;
          amount?: string;
          fee_rate?: number;
          exclude_outpoints?: string[];
        };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const result = await buildMvcFtTransferRawTx(getMetabotStore(), {
          metabotId: Number(parsed.metabot_id),
          token: {
            symbol: parsed.token?.symbol,
            tokenID: parsed.token?.tokenID,
            genesisHash: String(parsed.token?.genesisHash || ''),
            codeHash: String(parsed.token?.codeHash || ''),
            decimal: parsed.token?.decimal,
          },
          toAddress: String(parsed.to_address || '').trim(),
          amount: String(parsed.amount || ''),
          feeRate: Number(parsed.fee_rate),
          excludeOutpoints: parsed.exclude_outpoints,
          fundingRawTx: typeof parsed.funding_raw_tx === 'string' ? parsed.funding_raw_tx : undefined,
          fundingOutpoint: typeof parsed.funding_outpoint === 'string' ? parsed.funding_outpoint : undefined,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === BUILD_MVC_RAW_TX_BUNDLE_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      let parsed: {
        metabot_id?: number;
        steps?: Array<{
          kind?: string;
          to_address?: string;
          amount_sats?: number;
          amount?: string;
          fee_rate?: number;
          exclude_outpoints?: string[];
          token?: {
            symbol?: string;
            tokenID?: string;
            genesisHash?: string;
            codeHash?: string;
            decimal?: number;
          };
          funding?: {
            step_index?: number;
            use_output?: string;
          };
        }>;
      };
      try {
        parsed = JSON.parse(body) as {
          metabot_id?: number;
          steps?: Array<{
            kind?: string;
            to_address?: string;
            amount_sats?: number;
            amount?: string;
            fee_rate?: number;
            exclude_outpoints?: string[];
            token?: {
              symbol?: string;
              tokenID?: string;
              genesisHash?: string;
              codeHash?: string;
              decimal?: number;
            };
            funding?: {
              step_index?: number;
              use_output?: string;
            };
          }>;
        };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const result = await buildMvcOrderedRawTxBundle(getMetabotStore(), {
          metabotId: Number(parsed.metabot_id),
          steps: Array.isArray(parsed.steps)
            ? parsed.steps.map((step) => {
                const kind = String(step?.kind || '').trim();
                if (kind === 'mvc_transfer') {
                return {
                  kind: 'mvc_transfer' as const,
                  toAddress: String(step?.to_address || '').trim(),
                  amountSats: Number(step?.amount_sats),
                  feeRate: Number(step?.fee_rate),
                  ...(Array.isArray(step?.exclude_outpoints) ? { excludeOutpoints: step.exclude_outpoints } : {}),
                };
              }
              return {
                  kind: 'mvc_ft_transfer' as const,
                  token: {
                    symbol: step?.token?.symbol,
                    tokenID: step?.token?.tokenID,
                    genesisHash: String(step?.token?.genesisHash || ''),
                    codeHash: String(step?.token?.codeHash || ''),
                    decimal: step?.token?.decimal,
                  },
                  toAddress: String(step?.to_address || '').trim(),
                  amount: String(step?.amount || ''),
                  feeRate: Number(step?.fee_rate),
                  ...(Array.isArray(step?.exclude_outpoints) ? { excludeOutpoints: step.exclude_outpoints } : {}),
                  funding: step?.funding
                    ? {
                        stepIndex: Number(step.funding.step_index),
                        useOutput: step.funding.use_output === 'change' ? 'change' : undefined,
                      }
                    : undefined,
                };
              })
            : [],
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'GET' && pathname.startsWith(PIN_ROUTE_PREFIX)) {
      const pinId = pathname.slice(PIN_ROUTE_PREFIX.length).trim();
      if (!pinId) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'pinId required' }));
        return;
      }
      try {
        const data = await getPinData(pinId, persist);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, data }));
      } catch (err) {
        const message =
          err && typeof err === 'object' && 'message' in err
            ? String((err as Error).message)
            : String(err);
        try {
          const logPath = path.join(app.getPath('userData'), 'metaid-rpc.log');
          const line = `[${new Date().toISOString()}] [ERROR] get-pin: ${message}\n`;
          fs.appendFileSync(logPath, line);
        } catch {
          /* ignore */
        }
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method !== 'POST' || pathname !== '/api/metaid/create-pin') {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: 'Not found' }));
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let payload: { metabot_id: number; metaidData: MetaidDataPayload; network?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
      return;
    }

    const { metabot_id, metaidData, network: networkRaw } = payload;
    if (
      typeof metabot_id !== 'number' ||
      !metaidData ||
      typeof metaidData !== 'object'
    ) {
      res.writeHead(400);
      res.end(
        JSON.stringify({ success: false, error: 'metabot_id and metaidData required' })
      );
      return;
    }

    const network = (networkRaw != null && String(networkRaw).trim() !== '')
      ? String(networkRaw).toLowerCase().trim()
      : 'mvc';

    try {
      const store = getMetabotStore();
      const feeRate = getGlobalFeeRate(network);
      const result = await createPin(store, metabot_id, metaidData as MetaidDataPayload, {
        network: network as 'mvc' | 'doge' | 'btc',
        feeRate,
      });
      res.writeHead(200);
      const txid = result.txids[0];
      const pinId = result.pinId ?? `${txid}i0`;
      res.end(
        JSON.stringify({
          success: true,
          txids: result.txids,
          txid,
          pinId,
          totalCost: result.totalCost,
        })
      );
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String((err as Error).message)
          : String(err);
      try {
        const logPath = path.join(app.getPath('userData'), 'metaid-rpc.log');
        const line = `[${new Date().toISOString()}] [ERROR] create-pin: ${message}\n`;
        fs.appendFileSync(logPath, line);
      } catch {
        /* ignore */
      }
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: message }));
    }
  });

  const rpcPort = resolveMetaidRpcPort();
  listenWithRetry(server, rpcPort, RPC_HOST, {
    onListening: () => {
      console.log(`[MetaID RPC] Gateway listening on ${getMetaidRpcBase()}`);
    },
  });

  return server;
}
