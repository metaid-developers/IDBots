#!/usr/bin/env node
"use strict";
/**
 * MetaBot Omni-Reader: Configuration-driven chain data reader.
 * Loads api_registry.json, fetches from registered endpoints, and sanitizes output for the agent.
 *
 * Usage (list APIs):
 *   node omni-reader.js --list
 *
 * Usage (fetch data):
 *   node omni-reader.js --query-type buzz_newest --size 10
 *   node omni-reader.js --query-type protocol_list --path "/protocols/metabot-skill" --size 5
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const util_1 = require("util");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});
/** Safe deep get: get value at dot-separated path, e.g. get(obj, 'data.list') */
function get(obj, pathStr, defaultValue = null) {
    if (obj == null || typeof pathStr !== 'string' || pathStr === '')
        return defaultValue;
    const keys = pathStr.split('.');
    let current = obj;
    for (const key of keys) {
        if (current == null || typeof current !== 'object')
            return defaultValue;
        current = current[key];
    }
    return current === undefined ? defaultValue : current;
}
function loadRegistry() {
    const registryPath = path_1.default.join(__dirname, '../api_registry.json');
    const raw = fs_1.default.readFileSync(registryPath, 'utf-8');
    return JSON.parse(raw);
}
function parseSize(val) {
    if (val == null)
        return 10;
    const n = parseInt(val, 10);
    if (Number.isNaN(n) || n < 1 || n > 100)
        return 10;
    return n;
}
function sanitizeItem(item, mapping) {
    const clean = {};
    for (const [targetKey, sourcePath] of Object.entries(mapping)) {
        let val = get(item, sourcePath, null);
        if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
            try {
                val = JSON.parse(val);
            }
            catch {
                // keep as string
            }
        }
        clean[targetKey] = val;
    }
    return clean;
}
function outputError(message) {
    console.log(JSON.stringify({ error: message }));
    process.exit(1);
}
async function main() {
    const { values } = (0, util_1.parseArgs)({
        options: {
            list: { type: 'boolean', short: 'l' },
            'query-type': { type: 'string' },
            size: { type: 'string' },
            path: { type: 'string' },
            'target-id': { type: 'string' },
        },
        allowPositionals: true,
    });
    const args = values;
    const registry = loadRegistry();
    if (args.list) {
        const lines = Object.entries(registry).map(([k, v]) => `- ${k}: ${v.description}`);
        console.log('Available query types:\n' + lines.join('\n'));
        process.exit(0);
    }
    const queryType = args['query-type'];
    if (!queryType || !registry[queryType]) {
        outputError('Invalid query-type. Run with --list to see available options.');
    }
    const config = registry[queryType];
    const size = parseSize(typeof args.size === 'string' ? args.size : undefined);
    let url = `${config.baseUrl}?size=${size}`;
    if (args.path != null && args.path !== '') {
        url += `&path=${encodeURIComponent(args.path)}`;
    }
    if (args['target-id'] != null && args['target-id'] !== '') {
        url += `&targetId=${encodeURIComponent(args['target-id'])}`;
    }
    try {
        const response = await fetch(url);
        if (!response.ok) {
            outputError(`Request failed: ${response.status} ${response.statusText} for ${url}`);
        }
        const data = (await response.json());
        const rawList = get(data, config.response_list_path, []);
        const list = Array.isArray(rawList) ? rawList : [];
        const sanitizedData = list.map((item) => sanitizeItem(item, config.sanitization_mapping));
        console.log(JSON.stringify({ status: 'success', count: sanitizedData.length, data: sanitizedData }, null, 2));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        outputError(`Request error: ${message}`);
    }
}
main();
