#!/usr/bin/env node
"use strict";
/**
 * IDBots metabot-post-buzz: Send SimpleBuzz to MetaWeb via local RPC gateway.
 * Cross-platform TypeScript replacement for post-buzz.sh.
 *
 * Requires: Node.js 18+ (for fetch). Env: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional).
 *
 * Usage:
 *   node post-buzz.js --content "<content>" [--content-type "<mime-type>"] [--network mvc|doge|btc]
 */
Object.defineProperty(exports, "__esModule", { value: true });
const util_1 = require("util");
function writeStderr(message) {
    process.stderr.write(message + '\n');
}
function extractRpcField(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value.trim() : '';
}
const USAGE = 'Usage: node post-buzz.js --content "<content>" [--content-type "<mime-type>"] [--network mvc|doge|btc]';
function main() {
    const { values, positionals } = (0, util_1.parseArgs)({
        options: {
            content: { type: 'string' },
            'content-type': { type: 'string' },
            network: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: true,
    });
    if (values.help) {
        process.stderr.write('metabot-post-buzz: Send SimpleBuzz to MetaWeb via local RPC.\n\n' +
            USAGE +
            '\n\n' +
            'Options:\n' +
            '  --content <string>     (required) Text to post.\n' +
            '  --content-type <string> (optional) MIME type, default: text/plain;utf-8\n' +
            '  --network <string>     (optional) Target network: mvc (default), doge, btc\n' +
            '  -h, --help             Show this message.\n' +
            '\nEnv: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional).\n');
        process.exit(0);
    }
    let content = values.content ?? '';
    const contentType = values['content-type'] ?? 'text/plain;utf-8';
    const networkRaw = values.network?.toLowerCase?.()?.trim() ?? '';
    const network = networkRaw === 'doge' || networkRaw === 'btc' ? networkRaw : 'mvc';
    // Unknown options (unrecognized flags end up as positionals starting with -)
    for (const p of positionals) {
        if (p.startsWith('-')) {
            writeStderr(`Unknown option: ${p}`);
            process.exit(1);
        }
    }
    // Parameter validation: --content must not be empty
    if (typeof content !== 'string' || content.trim() === '') {
        writeStderr('Error: --content is required and must not be empty.');
        writeStderr(USAGE);
        process.exit(1);
    }
    // Environment check: IDBOTS_METABOT_ID must exist
    const metabotIdStr = process.env.IDBOTS_METABOT_ID;
    if (!metabotIdStr || metabotIdStr.trim() === '') {
        writeStderr('Error: IDBOTS_METABOT_ID is required. Set it when running from IDBots Cowork or manually.');
        process.exit(1);
    }
    const metabotId = parseInt(metabotIdStr.trim(), 10);
    if (Number.isNaN(metabotId) || metabotId < 1) {
        writeStderr('Error: IDBOTS_METABOT_ID must be a positive integer.');
        process.exit(1);
    }
    const rpcUrl = (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/+$/, '');
    const url = `${rpcUrl}/api/metaid/create-pin`;
    // Build payload and body (same structure as post-buzz.sh)
    const payload = {
        content: content.trim(),
        contentType,
        attachments: [],
        quotePin: '',
    };
    // metaidData.payload must be a JSON string (same as jq --arg payload "$PAYLOAD_JSON" in the shell)
    const body = {
        metabot_id: metabotId,
        network,
        metaidData: {
            operation: 'create',
            path: '/protocols/simplebuzz',
            encryption: '0',
            version: '1.0',
            contentType: 'application/json',
            payload: JSON.stringify(payload),
        },
    };
    (async () => {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const rawText = await res.text();
            let parsed = null;
            if (rawText.trim()) {
                try {
                    const maybe = JSON.parse(rawText);
                    parsed = maybe && typeof maybe === 'object'
                        ? maybe
                        : null;
                }
                catch {
                    parsed = null;
                }
            }
            if (!res.ok) {
                writeStderr(`HTTP ${res.status}: ${rawText}`);
                process.exit(1);
            }
            if (parsed && parsed.success === false) {
                const errorText = extractRpcField(parsed, 'error') || 'Unknown RPC error';
                writeStderr(`RPC request failed: ${errorText}`);
                process.exit(1);
            }
            const txidFromList = parsed && Array.isArray(parsed.txids) && typeof parsed.txids[0] === 'string'
                ? String(parsed.txids[0]).trim()
                : '';
            const txid = parsed ? (extractRpcField(parsed, 'txid') || txidFromList) : '';
            const pinId = parsed ? (extractRpcField(parsed, 'pinId') || (txid ? `${txid}i0` : '')) : '';
            const totalCost = parsed && typeof parsed.totalCost === 'number'
                ? parsed.totalCost
                : undefined;
            const result = {
                success: true,
                message: pinId ? `Buzz posted: ${pinId}` : 'Buzz posted successfully.',
            };
            if (txid)
                result.txid = txid;
            if (pinId)
                result.pinId = pinId;
            if (typeof totalCost === 'number') {
                result.totalCost = totalCost;
            }
            process.stdout.write(`${JSON.stringify(result)}\n`);
            if (typeof totalCost === 'number') {
                writeStderr(`Cost: ${totalCost} satoshis`);
            }
        }
        catch (err) {
            writeStderr(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    })();
}
main();
