#!/usr/bin/env node
"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendPrivateChat = sendPrivateChat;
const util_1 = require("util");
const nodeCrypto = __importStar(require("crypto"));
const crypto_js_1 = __importDefault(require("crypto-js"));
const utxo_wallet_service_1 = require("@metalet/utxo-wallet-service");
const meta_contract_1 = require("meta-contract");
const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const DEFAULT_RPC_URL = 'http://127.0.0.1:31200';
const METAID_USER_API_BASE = 'https://file.metaid.io/metafile-indexer/api';
function logInfo(message) {
    process.stderr.write(`[metabot-chat-privatechat] ${message}\n`);
}
function fail(message) {
    process.stderr.write(`[metabot-chat-privatechat] Error: ${message}\n`);
    process.exit(1);
}
function parseAddressIndexFromPath(pathStr) {
    const m = pathStr.match(/\/0\/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
}
function pickChatPubkey(user) {
    if (!user || typeof user !== 'object')
        return '';
    const u = user;
    const candidates = [
        u.chatPublicKey,
        u.chatpubkey,
        u.chatPubkey,
        u.pubkey,
        u.ecdhPubKey,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim())
            return candidate.trim();
    }
    return '';
}
function unwrapData(payload) {
    if (!payload || typeof payload !== 'object')
        return {};
    const root = payload;
    if (root.data && typeof root.data === 'object') {
        return root.data;
    }
    return root;
}
async function fetchUserInfoByGlobalMetaId(globalMetaId) {
    const encoded = encodeURIComponent(globalMetaId);
    const candidates = [
        `${METAID_USER_API_BASE}/v1/info/globalmetaid/${encoded}`,
        `${METAID_USER_API_BASE}/info/metaid/${encoded}`,
        `${METAID_USER_API_BASE}/v1/users/global-metaid/${encoded}`,
    ];
    let lastError = '';
    for (const url of candidates) {
        try {
            logInfo(`fetch user info endpoint: ${url}`);
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/json, text/plain, */*',
                    Origin: 'https://www.idchat.io',
                    Referer: 'https://www.idchat.io/',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                },
            });
            if (!res.ok) {
                lastError = `HTTP ${res.status}`;
                continue;
            }
            const json = (await res.json());
            const data = unwrapData(json);
            if (Object.keys(data).length > 0) {
                return data;
            }
            lastError = 'empty data';
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    throw new Error(`fetch user info failed for ${globalMetaId}: ${lastError || 'unknown error'}`);
}
async function derivePrivateKeyBufferForEcdh(mnemonic, pathStr) {
    const addressIndex = parseAddressIndexFromPath(pathStr);
    const wallet = new utxo_wallet_service_1.MvcWallet({
        coinType: utxo_wallet_service_1.CoinType.MVC,
        addressType: utxo_wallet_service_1.AddressType.LegacyMvc,
        addressIndex,
        network: 'livenet',
        mnemonic,
    });
    const privateKeyWIF = wallet.getPrivateKey();
    const privKey = meta_contract_1.mvc.PrivateKey.fromWIF(privateKeyWIF);
    return Buffer.from(privKey.bn.toArray('be', 32));
}
function computeSharedSecretSha256(privateKey32, peerPublicKeyHex) {
    const ecdh = nodeCrypto.createECDH('prime256v1');
    ecdh.setPrivateKey(privateKey32);
    const rawSecret = ecdh.computeSecret(Buffer.from(peerPublicKeyHex, 'hex'));
    return nodeCrypto.createHash('sha256').update(rawSecret).digest('hex');
}
function encryptPrivateContent(plaintext, sharedSecret) {
    return crypto_js_1.default.AES.encrypt(String(plaintext), String(sharedSecret)).toString();
}
function buildSimpleMsgBody(toGlobalMetaId, encryptedContent, replyPin) {
    return {
        to: toGlobalMetaId,
        timestamp: Math.floor(Date.now() / 1000),
        content: encryptedContent,
        contentType: 'text/plain',
        encrypt: 'ecdh',
        replyPin: replyPin || '',
    };
}
async function submitCreatePin(rpcUrl, metabotId, payloadBody) {
    const url = `${rpcUrl.replace(/\/+$/, '')}/api/metaid/create-pin`;
    const body = {
        metabot_id: metabotId,
        metaidData: {
            operation: 'create',
            path: '/protocols/simplemsg',
            encryption: '0',
            version: '1.0.0',
            contentType: 'application/json',
            payload: JSON.stringify(payloadBody),
        },
    };
    logInfo(`create-pin payload tuple: path=/protocols/simplemsg encryption=0 version=1.0.0 contentType=application/json payloadLen=${JSON.stringify(payloadBody).length}`);
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = (await res.json());
    if (!res.ok || !json.success) {
        throw new Error(json.error || `create-pin failed: HTTP ${res.status}`);
    }
    const txid = json.txid ?? json.txids?.[0] ?? '';
    if (!txid) {
        throw new Error('create-pin success but txid missing');
    }
    return {
        txid,
        pinId: json.pinId ?? `${txid}i0`,
        totalCost: json.totalCost,
    };
}
async function sendPrivateChat(params) {
    const toGlobalMetaId = params.toGlobalMetaId.trim();
    const content = params.content;
    const replyPin = (params.replyPin ?? '').trim();
    const mnemonic = params.mnemonic.trim();
    const walletPath = (params.path || DEFAULT_PATH).trim() || DEFAULT_PATH;
    const rpcUrl = (params.rpcUrl || DEFAULT_RPC_URL).trim() || DEFAULT_RPC_URL;
    if (!toGlobalMetaId)
        throw new Error('toGlobalMetaId is required');
    if (!content.trim())
        throw new Error('content is required');
    if (!mnemonic)
        throw new Error('mnemonic is required');
    logInfo(`target globalMetaId: ${toGlobalMetaId}`);
    const userInfo = await fetchUserInfoByGlobalMetaId(toGlobalMetaId);
    const peerChatPubkey = pickChatPubkey(userInfo);
    if (!peerChatPubkey) {
        throw new Error('target has no chatPublicKey on chain (/info/chatpubkey missing)');
    }
    logInfo(`peer chatPublicKey len=${peerChatPubkey.length}, first/last16=${peerChatPubkey.slice(0, 16)}...${peerChatPubkey.slice(-16)}`);
    const privateKey32 = await derivePrivateKeyBufferForEcdh(mnemonic, walletPath);
    const sharedSecret = computeSharedSecretSha256(privateKey32, peerChatPubkey);
    logInfo(`sharedSecret(sha256) len=${sharedSecret.length}, first/last16=${sharedSecret.slice(0, 16)}...${sharedSecret.slice(-16)}`);
    const encryptedContent = encryptPrivateContent(content, sharedSecret);
    logInfo(`encrypted content len=${encryptedContent.length}, prefix=${encryptedContent.slice(0, 48)}${encryptedContent.length > 48 ? '...' : ''}`);
    const payloadBody = buildSimpleMsgBody(toGlobalMetaId, encryptedContent, replyPin);
    const pinResult = await submitCreatePin(rpcUrl, params.metabotId, payloadBody);
    return {
        txid: pinResult.txid,
        pinId: pinResult.pinId,
        totalCost: pinResult.totalCost,
        sharedSecretPrefix: `${sharedSecret.slice(0, 8)}...${sharedSecret.slice(-8)}`,
        encryptedPrefix: encryptedContent.slice(0, 24),
    };
}
function parseCli() {
    const { values, positionals } = (0, util_1.parseArgs)({
        options: {
            to: { type: 'string' },
            content: { type: 'string' },
            'reply-pin': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: true,
    });
    if (values.help) {
        process.stderr.write('Usage: node send-privatechat.js --to "<globalMetaId>" --content "<message>" [--reply-pin "<pinId>"]\n');
        process.exit(0);
    }
    for (const positional of positionals) {
        if (positional.startsWith('-'))
            fail(`unknown option: ${positional}`);
    }
    const metabotIdStr = process.env.IDBOTS_METABOT_ID;
    if (!metabotIdStr || !metabotIdStr.trim()) {
        fail('IDBOTS_METABOT_ID is required');
    }
    const metabotId = parseInt(metabotIdStr.trim(), 10);
    if (!Number.isFinite(metabotId) || metabotId < 1) {
        fail('IDBOTS_METABOT_ID must be a positive integer');
    }
    const mnemonic = (process.env.IDBOTS_METABOT_MNEMONIC || '').trim();
    if (!mnemonic) {
        fail('IDBOTS_METABOT_MNEMONIC is required (wallet env not injected)');
    }
    const toGlobalMetaId = (values.to || '').trim();
    const content = values.content || '';
    const replyPin = (values['reply-pin'] || '').trim();
    if (!toGlobalMetaId)
        fail('--to is required');
    if (!content.trim())
        fail('--content is required');
    return {
        toGlobalMetaId,
        content,
        replyPin,
        metabotId,
        mnemonic,
        path: (process.env.IDBOTS_METABOT_PATH || DEFAULT_PATH).trim() || DEFAULT_PATH,
        rpcUrl: (process.env.IDBOTS_RPC_URL || DEFAULT_RPC_URL).trim() || DEFAULT_RPC_URL,
    };
}
async function main() {
    const cli = parseCli();
    const result = await sendPrivateChat({
        toGlobalMetaId: cli.toGlobalMetaId,
        content: cli.content,
        replyPin: cli.replyPin,
        metabotId: cli.metabotId,
        mnemonic: cli.mnemonic,
        path: cli.path,
        rpcUrl: cli.rpcUrl,
    });
    logInfo(`broadcast success: txid=${result.txid}, pinId=${result.pinId}, totalCost=${result.totalCost ?? 0}`);
    process.stdout.write(JSON.stringify({
        success: true,
        txid: result.txid,
        pinId: result.pinId,
        totalCost: result.totalCost ?? 0,
    }) + '\n');
}
if (require.main === module) {
    main().catch((error) => {
        fail(error instanceof Error ? error.message : String(error));
    });
}
