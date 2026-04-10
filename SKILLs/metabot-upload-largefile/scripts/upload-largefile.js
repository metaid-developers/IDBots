#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const util_1 = require("util");
const RPC_BASE = (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/+$/, '');
const UPLOAD_URL = `${RPC_BASE}/api/idbots/files/upload-largefile`;
function writeStderr(message) {
    process.stderr.write(`${message}\n`);
}
const USAGE = 'Usage: node upload-largefile.js --file <path> [--content-type <mime>] [--network mvc|doge|btc]';
async function main() {
    const { values, positionals } = (0, util_1.parseArgs)({
        options: {
            file: { type: 'string' },
            'content-type': { type: 'string' },
            network: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: true,
    });
    if (values.help) {
        writeStderr('metabot-upload-largefile: upload one local file to MetaID via IDBots local RPC.\n\n' +
            `${USAGE}\n\n` +
            'Options:\n' +
            '  --file <path>            (required) Local file path.\n' +
            '  --content-type <mime>    (optional) Override MIME type.\n' +
            '  --network <network>      (optional) mvc (default), doge, btc.\n' +
            '  -h, --help               Show this message.\n' +
            '\nEnv: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional).\n');
        process.exit(0);
    }
    for (const positional of positionals) {
        if (positional.startsWith('-')) {
            writeStderr(`Unknown option: ${positional}`);
            process.exit(1);
        }
    }
    const filePath = String(values.file || '').trim();
    if (!filePath) {
        writeStderr('Error: --file is required.');
        writeStderr(USAGE);
        process.exit(1);
    }
    const metabotIdStr = String(process.env.IDBOTS_METABOT_ID || '').trim();
    if (!metabotIdStr) {
        writeStderr('Error: IDBOTS_METABOT_ID is required.');
        process.exit(1);
    }
    const metabotId = Number.parseInt(metabotIdStr, 10);
    if (!Number.isInteger(metabotId) || metabotId <= 0) {
        writeStderr('Error: IDBOTS_METABOT_ID must be a positive integer.');
        process.exit(1);
    }
    const response = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            metabot_id: metabotId,
            file_path: filePath,
            content_type: values['content-type'] || undefined,
            network: values.network || undefined,
        }),
    });
    const rawText = await response.text();
    let parsed = null;
    if (rawText.trim()) {
        try {
            parsed = JSON.parse(rawText);
        }
        catch {
            parsed = null;
        }
    }
    if (!response.ok) {
        throw new Error(parsed?.error || rawText || `HTTP ${response.status}`);
    }
    if (!parsed || parsed.success === false) {
        throw new Error(parsed?.error || 'Upload failed');
    }
    process.stdout.write(`${JSON.stringify(parsed)}\n`);
}
main().catch((err) => {
    writeStderr(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
