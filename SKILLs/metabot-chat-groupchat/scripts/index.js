#!/usr/bin/env node
"use strict";
/**
 * metabot-chat skill: submit parsed task params to main process via RPC.
 * Usage: node index.js --payload '<JSON>'
 * Or:    echo '<JSON>' | node index.js
 * JSON must include target_metabot_name and group_id; other fields optional.
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
const RPC_URL = process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200';
const ASSIGN_PATH = '/api/idbots/assign-group-chat-task';
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
    const url = `${RPC_URL.replace(/\/$/, '')}${ASSIGN_PATH}`;
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
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
