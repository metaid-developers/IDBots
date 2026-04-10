---
name: metabot-chat-privatechat
description: Use when an agent needs to send one private MetaWeb message to a remote globalMetaId while preserving the existing simplemsg encryption semantics
---

# MetaBot Private Chat

Send one encrypted private message over MetaWeb without changing the current IDBots `simplemsg` contract.

## Host Adapter

{{HOST_SKILLPACK_METADATA}}

## Routing

{{SYSTEM_ROUTING}}

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
{{METABOT_CLI}} chat private --request-file request.json
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

- CLI path: `{{METABOT_CLI}}`
- Compatibility manifest: `{{COMPATIBILITY_MANIFEST}}`
