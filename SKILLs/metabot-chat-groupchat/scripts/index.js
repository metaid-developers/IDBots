#!/usr/bin/env node
"use strict";
/**
 * metabot-chat-groupchat skill: group chat actions via local RPC.
 * Usage: node index.js --payload '<JSON>'
 * Or:    echo '<JSON>' | node index.js
 *
 * action:
 *   - orchestrate (default): assign local group_chat_tasks (reply / random reply).
 *   - join_group: chain SimpleGroupJoin (/protocols/simplegroupjoin).
 *   - send_group_message: chain SimpleGroupChat (/protocols/simplegroupchat), AES encrypts content like omni-caster.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const util_1 = require("util");
const fs = __importStar(require("fs"));
const crypto_1 = require("crypto");
const RPC_URL = process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200';
const ASSIGN_PATH = '/api/idbots/assign-group-chat-task';
const RESOLVE_PATH = '/api/idbots/resolve-metabot-id';
const CREATE_PIN_PATH = '/api/metaid/create-pin';
function groupIdToSecretKey(groupId) {
    const normalized = String(groupId ?? '').trim();
    if (normalized.length >= 16) {
        return normalized.slice(0, 16);
    }
    return normalized.padEnd(16, '0');
}
/** Matches SKILLs/metabot-omni-caster/scripts/omni-caster.js (AES-128-CBC, iv 000...) */
function encryptSimpleGroupChatContent(message, groupId) {
    const secretKey = groupIdToSecretKey(groupId);
    const cipher = (0, crypto_1.createCipheriv)('aes-128-cbc', Buffer.from(secretKey, 'utf8'), Buffer.from('0000000000000000', 'utf8'));
    const encrypted = Buffer.concat([cipher.update(String(message ?? ''), 'utf8'), cipher.final()]);
    return encrypted.toString('hex');
}
function parsePayload() {
    const { values } = (0, util_1.parseArgs)({
        options: { payload: { type: 'string', short: 'p' } },
        allowPositionals: true,
    });
    const payload = values.payload;
    if (payload != null && payload.trim() !== '') {
        return payload.trim();
    }
    if (process.stdin.isTTY) {
        console.error('Error: pass --payload "<JSON>" or pipe JSON to stdin');
        process.exit(1);
    }
    return fs.readFileSync(0, 'utf-8').trim();
}
async function resolveMetabot(base, name) {
    const url = `${base}${RESOLVE_PATH}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
    });
    const result = (await res.json());
    if (!res.ok || !result.success || result.metabot_id == null) {
        console.error(result.error ?? 'MetaBot not found');
        process.exit(1);
    }
    return {
        metabot_id: result.metabot_id,
        display_name: result.display_name?.trim() || name.trim(),
    };
}
async function runCreatePin(base, metabotId, path, payloadObj, network) {
    const url = `${base}${CREATE_PIN_PATH}`;
    const metaidData = {
        operation: 'create',
        path,
        encryption: '0',
        version: '1.0',
        contentType: 'application/json',
        payload: JSON.stringify(payloadObj),
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metabot_id: metabotId, network, metaidData }),
    });
    const json = (await res.json());
    if (!json.success) {
        console.error('Request failed:', json.error ?? 'Unknown error');
        process.exit(1);
    }
    const txid = json.txid ?? json.txids?.[0] ?? '';
    const pinId = json.pinId ?? `${txid}i0`;
    console.log(JSON.stringify({ txid, pinId }));
    if (typeof json.totalCost === 'number') {
        console.error(`Cost: ${json.totalCost} satoshis`);
    }
}
async function main() {
    const raw = parsePayload();
    let params;
    try {
        params = JSON.parse(raw);
    }
    catch (e) {
        console.error('Error: invalid JSON', e instanceof Error ? e.message : e);
        process.exit(1);
    }
    if (!params.target_metabot_name?.trim()) {
        console.error('Error: target_metabot_name is required');
        process.exit(1);
    }
    if (!params.group_id?.trim()) {
        console.error('Error: group_id is required');
        process.exit(1);
    }
    const base = RPC_URL.replace(/\/$/, '');
    const action = params.action ?? 'orchestrate';
    const networkRaw = params.network?.toLowerCase?.()?.trim() ?? '';
    const network = networkRaw === 'doge' || networkRaw === 'btc' ? networkRaw : 'mvc';
    if (action === 'orchestrate') {
        const url = `${base}${ASSIGN_PATH}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
        });
        const result = (await res.json());
        if (!res.ok) {
            console.error('RPC error:', result.error ?? res.statusText);
            process.exit(1);
        }
        if (!result.success) {
            console.error(result.error ?? 'Unknown error');
            process.exit(1);
        }
        console.log(result.message ?? 'Success! Task assigned.');
        return;
    }
    const { metabot_id: metabotId, display_name: displayName } = await resolveMetabot(base, params.target_metabot_name);
    const groupId = params.group_id.trim();
    if (action === 'join_group') {
        const p = params;
        const joinPayload = {
            groupId,
            state: 1,
        };
        const ref = p.referrer?.trim();
        if (ref)
            joinPayload.referrer = ref;
        const k = p.k?.trim();
        if (k)
            joinPayload.k = k;
        await runCreatePin(base, metabotId, '/protocols/simplegroupjoin', joinPayload, network);
        return;
    }
    if (action === 'send_group_message') {
        const p = params;
        const plain = p.message_plaintext;
        if (plain == null || String(plain).trim() === '') {
            console.error('Error: message_plaintext is required for send_group_message');
            process.exit(1);
        }
        const nickName = p.nick_name?.trim() || displayName;
        const encryptedContent = encryptSimpleGroupChatContent(String(plain), groupId);
        const chatPayload = {
            groupId,
            nickName,
            content: encryptedContent,
            contentType: 'text/plain',
            encryption: 'aes',
            timestamp: Date.now(),
        };
        if (p.reply_pin?.trim())
            chatPayload.replyPin = p.reply_pin.trim();
        if (p.channel_id?.trim())
            chatPayload.channelId = p.channel_id.trim();
        if (Array.isArray(p.mention) && p.mention.length)
            chatPayload.mention = p.mention;
        await runCreatePin(base, metabotId, '/protocols/simplegroupchat', chatPayload, network);
        return;
    }
    console.error('Error: unknown action');
    process.exit(1);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
