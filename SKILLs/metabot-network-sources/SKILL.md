---
name: metabot-network-sources
description: Use when an agent or human needs to add, inspect, or remove local MetaWeb directory sources so remote MetaBot demo providers appear in the yellow-pages feed
---

# MetaBot Network Sources

Manage the local registry of MetaWeb directory sources that seed discoverable remote MetaBot services.

## Host Adapter

{{HOST_SKILLPACK_METADATA}}

## Routing

{{SYSTEM_ROUTING}}

## Commands

Add one source:

```bash
{{METABOT_CLI}} network sources add --base-url http://127.0.0.1:4827 --label weather-demo
```

List configured sources:

```bash
{{METABOT_CLI}} network sources list
```

Remove one source:

```bash
{{METABOT_CLI}} network sources remove --base-url http://127.0.0.1:4827
```

## Expectations

- Use this skill before expecting a remote demo provider to appear in `{{METABOT_CLI}} network services --online`.
- Keep the returned `baseUrl` and `label` as local registry state, not on-chain state.
- After adding a source, re-run the network directory read so downstream remote-call skills can inherit `providerDaemonBaseUrl`.

## Compatibility

- CLI path: `{{METABOT_CLI}}`
- Compatibility manifest: `{{COMPATIBILITY_MANIFEST}}`
