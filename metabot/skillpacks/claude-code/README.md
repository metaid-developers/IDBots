# MetaBot Skill Pack for Claude Code

Thin host adapter for the MetaBot open-source research pack. These skills keep business logic in the shared `metabot` CLI and MetaWeb runtime instead of the host adapter.

## Included Skills

- `metabot-chat-privatechat`
- `metabot-post-skillservice`
- `metabot-omni-reader`
- `metabot-bootstrap`
- `metabot-network-directory`
- `metabot-call-remote-service`
- `metabot-trace-inspector`

## Install

```bash
./install.sh
```

Override the destination with `METABOT_SKILL_DEST` if this host uses a custom skill root.
Override the CLI shim directory with `METABOT_BIN_DIR` if `$HOME/.metabot/bin` is not on PATH.
If you are installing from a source checkout, set `METABOT_SOURCE_ROOT` to the metabot package root or the repo root.

## Shared Runtime Contract

- CLI path: `metabot`
- Compatibility manifest: `metabot/release/compatibility.json`
- Bundled compatibility copy: `runtime/compatibility.json`
- Package version: `0.1.0`
- Host pack id: `claude-code`
