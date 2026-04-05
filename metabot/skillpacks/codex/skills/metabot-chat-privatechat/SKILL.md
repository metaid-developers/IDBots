---
name: metabot-chat-privatechat
description: Use when an agent needs to send one private MetaWeb message to a remote globalMetaId while preserving the existing simplemsg encryption semantics
---

# MetaBot Private Chat

Send one encrypted private message over MetaWeb without changing the current IDBots `simplemsg` contract.

## Host Adapter

Generated for Codex.

- Default skill root: `${CODEX_HOME:-$HOME/.codex}/skills`
- Host pack id: `codex`
- CLI path: `metabot`

## Routing

Route natural-language intent through `metabot`, then reason over the returned JSON envelope.

- Prefer JSON and local daemon routes for agent workflows.
- Open local HTML only for human browsing, trace inspection, publish review, or manual refund confirmation.
- Treat MetaWeb as the network layer and the local host as a thin adapter.


## Command

Prepare a request JSON file:

```json
{
  "to": "gm-target",
  "content": "hello from MetaBot",
  "replyPin": "optional-pin-id"
}
```

Then call:

```bash
metabot chat private --request-file request.json
```

## Required Semantics

- Use `/protocols/simplemsg` as the outer MetaWeb path.
- Resolve the peer chat public key before encryption.
- Encrypt the content with the shared ECDH secret.
- Stop with an error if `to`, `content`, or the remote chat public key is missing.

## Result Handling

- `success`: report the returned pin or tx identifiers and continue the conversation.
- `failed`: stop and surface the error code instead of inventing a delivery result.
- `manual_action_required`: open the returned local UI only if the runtime explicitly asks for it.

## Compatibility

- CLI path: `metabot`
- Compatibility manifest: `metabot/release/compatibility.json`
