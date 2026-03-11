---
name: metabot-omni-reader
description: MetaBot's omni chain data reader (Omni-Reader). When users ask for latest tweets (Buzz), protocol data, group chat info, specific post status, or any on-chain MetaID/MetaWeb data (user info by metaId or address, Pins by path or user, notifications, files, search), use this tool to fetch real-time data from manapi.metaid.io and file.metaid.io/metafile-indexer.
official: true
---
# MetaBot Omni-Reader (Omni Chain Data Reader)

This is MetaBot's "eyes" for the on-chain (MetaWeb) world. It fetches real-time data from two backend APIs: **manapi.metaid.io** (pins, metaids, blocks, notifications, content) and **file.metaid.io/metafile-indexer** (user info, file metadata, search). Use it whenever the user asks for information that lives on chain (e.g. a metaID's name/address, latest Buzz, protocol data, group chat, pin content, or file index).

## Execution Logic (Agent Workflow)

1. **Discover APIs**: If unsure which query type fits the user's question, run with `--list` to see all supported `--query-type` keys and their descriptions.
2. **Choose query type and parameters**: Match the user intent to a query type (e.g. "user's address/name" → `info_metaid` or `info_address`; "latest Buzz" → `pin_list_by_metaid` with `path=/protocols/simplebuzz`).
3. **Run the command**: Call `omni-reader.js` with `--query-type <key>` and the required/optional parameters as `--param value`.
4. **Summarize**: Read the script's JSON output and answer in natural language. Do not dump raw JSON to the user.

## Command Syntax

**1. List available query types (discovery):**
```bash
node "$SKILLS_ROOT/metabot-omni-reader/scripts/omni-reader.js" --list
```

**2. Fetch on-chain data (with parameters):**
```bash
node "$SKILLS_ROOT/metabot-omni-reader/scripts/omni-reader.js" \
  --query-type "<key from --list>" \
  [--metaid "<metaId>"] \
  [--address "<address>"] \
  [--path "<path>"] \
  [--pinId "<pinId>"] \
  [--size <number>] \
  [--cursor "<cursor>"] \
  [--page <number>] \
  [--keyword "<keyword>"] \
  [--keytype "metaid"|"name"] \
  [--limit <number>] \
  [--extension "<.ext>"] \
  [--timestamp "<ts>"] \
  [--id "<content id>"] \
  [--pinid "<pinId>"] \
  [--ver <version>] \
  [--lastId "<id>"] \
  [--globalMetaID "<globalMetaID>"] \
  [--firstPinId "<firstPinId>"]
```

Parameters are passed as `--paramName value`. Which params are required depends on the `--query-type` (see table below). Pass only the params that the chosen query type needs.

## Query Types and Parameters (Summary)

| Query type | Description | Typical params |
| ---------- | ----------- | -------------- |
| `info_metaid` | MetaID user info by metaId (name, address, avatar, chatpubkey) | `--metaid` |
| `info_address` | MetaID user info by wallet address | `--address` |
| `pin_detail` | Pin detail by Pin number or Pin Id | `--pinId` |
| `pin_version` | Pin content at a specific version | `--pinid`, `--ver` |
| `pin_list_global` | Global Pin list (paginated) | `--page`, `--size` |
| `pin_list_by_path` | Pins by protocol path (e.g. Buzz, group chat) | `--path`; optional `--size`, `--cursor` |
| `pin_list_by_metaid` | Pins by MetaID (optionally filtered by path) | `--metaid`; optional `--path`, `--size`, `--cursor` |
| `pin_list_by_address` | Pins by address and path | `--address`, `--path`; optional `--size`, `--cursor` |
| `metaid_list` | Paginated MetaID list | `--page`, `--size` |
| `block_list` | Blocks with Pins | `--page`, `--size` |
| `mempool_list` | Mempool Pins | `--page`, `--size` |
| `notification_list` | Notifications for an address | `--address`; optional `--lastId`, `--size` |
| `debug_count` | Global counts (pin, block, metaId, app) | (none) |
| `content_by_id` | Raw Pin content by PinId (text/image/video) | `--id` |
| `indexer_info_metaid` | MetaID info from metafile-indexer | `--metaid` |
| `indexer_info_address` | MetaID info by address (indexer) | `--address` |
| `indexer_info_globalmetaid` | MetaID info by globalMetaID | `--globalMetaID` |
| `indexer_info_search` | Search users by keyword (metaid or name) | `--keyword`; optional `--keytype`, `--limit` |
| `indexer_file_by_pin` | File metadata by PinId | `--pinId` |
| `indexer_file_latest` | Latest file by firstPinId | `--firstPinId` |
| `indexer_files_list` | List indexed files | `--cursor`, `--size` |
| `indexer_files_by_creator` | Files by creator address | `--address`; optional `--cursor`, `--size` |
| `indexer_files_by_metaid` | Files by metaId | `--metaid`; optional `--cursor`, `--size` |
| `indexer_files_by_extension` | Files by extension | `--extension`; optional `--timestamp`, `--size` |
| `indexer_files_metaid_extension` | Files by metaId + extension | `--metaid`, `--extension`; optional `--timestamp`, `--size` |
| `indexer_user_by_metaid` | User by MetaID (indexer) | `--metaId` |
| `indexer_user_by_address` | User by address (indexer) | `--address` |
| `indexer_users_list` | List users | `--cursor`, `--size` |
| `indexer_pin_by_id` | Pin info by PinId (indexer) | `--pinId` |
| `indexer_status` | Indexer sync status | (none) |
| `indexer_stats` | Indexer stats | (none) |

## Example Commands (do not hardcode these in prompts; use as reference)

- User asks for a metaID's name/address:  
  `--query-type info_metaid --metaid "<metaId>"`  
  or by address:  
  `--query-type info_address --address "<address>"`

- User asks for a metaID's latest Buzz (simplebuzz):  
  `--query-type pin_list_by_metaid --metaid "<metaId>" --path "/protocols/simplebuzz" --size 10`

- User asks for latest posts under a protocol:  
  `--query-type pin_list_by_path --path "/protocols/simplebuzz" --size 20`

- User asks for a specific Pin's content or detail:  
  `--query-type pin_detail --pinId "<pinId>"`  
  or raw content:  
  `--query-type content_by_id --id "<pinId>"`

- User asks for notifications:  
  `--query-type notification_list --address "<address>" --size 20`

- Search users by name or metaId:  
  `--query-type indexer_info_search --keyword "<keyword>" --keytype name --limit 10`

## AI Behavior Rules

1. **Do not guess `--query-type`**: If unsure, run with `--list` first and pick the type that matches the user's question.
2. **Path format**: When using `--path`, use the correct protocol path with leading slash (e.g. `/protocols/simplebuzz`, `/protocols/simplegroupchat`, `/protocols/metaapp`).
3. **Required params**: Each query type requires specific parameters (e.g. `info_metaid` needs `--metaid`). Omitting required params will produce invalid URLs and errors.
4. **Optional params**: You may omit optional params (e.g. `--size`, `--cursor`); the backend may apply defaults (e.g. size 20).
5. **Summarize output**: Always interpret the script's JSON and answer in natural language; never show raw JSON unless the user explicitly asks for it.
