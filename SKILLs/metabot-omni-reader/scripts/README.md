# Omni-Reader Scripts (Deprecated)

This skill no longer uses a Node.js script or `api_registry.json` for querying chain data.

**Current behavior**: The agent reads the interface docs under `references/` (e.g. `00-user.md`, `01-social.md`, `02-PIN.md`, `03-file.md`) and calls the APIs directly with **curl**. See the root `SKILL.md` for the workflow.

If you need to add a small utility script here in the future (e.g. for URL building or batch curl), you can add it alongside this README.
