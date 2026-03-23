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
import { assignGroupChatTask, type AssignGroupChatTaskParams } from './assignGroupChatTaskService';
import { getRate as getGlobalFeeRate } from './feeRateStore';
import { listenWithRetry } from './httpListenWithRetry';
import { DEFAULT_METAID_RPC_HOST, getMetaidRpcBase, resolveMetaidRpcPort } from './metaidRpcEndpoint';

const RPC_HOST = DEFAULT_METAID_RPC_HOST;

const PIN_ROUTE_PREFIX = '/api/metaid/pin/';
const ASSIGN_GROUP_CHAT_TASK_PATH = '/api/idbots/assign-group-chat-task';

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
