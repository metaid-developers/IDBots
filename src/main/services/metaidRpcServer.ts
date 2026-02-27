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
import { createPin, getPinData, type MetaidDataPayload } from './metaidCore';

const RPC_HOST = '127.0.0.1';
const RPC_PORT = 31200;

const PIN_ROUTE_PREFIX = '/api/metaid/pin/';

export function startMetaidRpcServer(
  getMetabotStore: () => MetabotStore,
  getStore: () => SqliteStore
): http.Server {
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

    if (req.method === 'GET' && pathname.startsWith(PIN_ROUTE_PREFIX)) {
      const pinId = pathname.slice(PIN_ROUTE_PREFIX.length).trim();
      if (!pinId) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'pinId required' }));
        return;
      }
      try {
        const store = getStore();
        const data = await getPinData(
          pinId,
          persist,
          store.getDatabase(),
          store.getSaveFunction()
        );
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

    if (req.method !== 'POST' || req.url !== '/api/metaid/create-pin') {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: 'Not found' }));
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let payload: { metabot_id: number; metaidData: MetaidDataPayload };
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
      return;
    }

    const { metabot_id, metaidData } = payload;
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

    try {
      const store = getMetabotStore();
      const result = await createPin(store, metabot_id, metaidData as MetaidDataPayload);
      res.writeHead(200);
      res.end(
        JSON.stringify({
          success: true,
          txids: result.txids,
          txid: result.txids[0],
          pinId: result.txids[0],
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

  server.listen(RPC_PORT, RPC_HOST, () => {
    console.log(`[MetaID RPC] Gateway listening on http://${RPC_HOST}:${RPC_PORT}`);
  });

  return server;
}
