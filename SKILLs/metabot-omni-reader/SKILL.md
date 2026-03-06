---
name: metabot-omni-reader
description: MetaBot's omni chain data reader (Omni-Reader). When users ask for latest tweets (Buzz), protocol data, group chat info, or specific post status, use this tool to fetch on-chain real-time data.
official: true
---
# MetaBot Omni-Reader (Omni Chain Data Reader)

This is MetaBot's "eyes" for perceiving the on-chain world. You can run the underlying reader script to fetch various real-time data from the MetaID ecosystem.

## 🧠 Execution Logic (Agent Workflow)

When you need on-chain data to answer the user, follow these steps:

1. **Discover APIs**: If you are unsure which query types are supported, **run the `--list` command first**. The script will return all available `query-type` keys and their descriptions.
2. **Run the command**: Based on the user's request and the `--list` output, call `omni-reader.ts` with the appropriate `--query-type`.
3. **Summarize**: Read the script's JSON output and answer the user in natural language. Never dump raw JSON to the user.

## 💻 Command Syntax

**1. List available APIs (Discovery):**
```bash
npx ts-node "$SKILLS_ROOT/metabot-omni-reader/scripts/omni-reader.ts" --list
```

**2. Fetch on-chain data:**
```bash
npx ts-node "$SKILLS_ROOT/metabot-omni-reader/scripts/omni-reader.ts" \
  --query-type "<key from --list>" \
  [--size <count>] \
  [--path "<protocol path>"] \
  [--target-id "<target ID>"]
```

**Parameters:**

| Parameter       | Description                                                                 | Default |
| --------------- | --------------------------------------------------------------------------- | ------- |
| `--list`        | Print all supported query types and their descriptions.                     | —       |
| `--query-type`  | Query type; must be one of the keys returned by `--list`.                   | —       |
| `--size`        | *(Optional)* Number of items to fetch (1–100).                              | 10      |
| `--path`        | *(Optional)* Required when type is `protocol_list`. e.g. `/protocols/metabot-skill`. | —       |

## ⚠️ AI Behavior Rules

1. Never guess `--query-type`; if unsure, run `--list` first.
2. When using `--path`, spell it correctly and include the leading slash (e.g. `/protocols/simplegroupchat`).
