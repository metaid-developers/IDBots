---
name: weather
description: Get current weather and forecasts (no API key required).
homepage: https://wttr.in/:help
metadata: {"clawdbot":{"emoji":"🌤️","requires":{"bins":["node"]}}}
official: true
---

# Weather

Cross-platform weather queries (no API keys required).

## Preferred command (cross-platform)

```bash
node "$SKILLS_ROOT/weather/scripts/index.js" --city "London"
```

No city provided (auto-detect by wttr.in, network permitting):

```bash
node "$SKILLS_ROOT/weather/scripts/index.js"
```

## Common examples

```bash
node "$SKILLS_ROOT/weather/scripts/index.js" --city "New York" --format compact
```

```bash
node "$SKILLS_ROOT/weather/scripts/index.js" --city "Tokyo" --format forecast
```

```bash
node "$SKILLS_ROOT/weather/scripts/index.js" --lat 51.5 --lon -0.12
```

```bash
node "$SKILLS_ROOT/weather/scripts/index.js" --city "San Francisco" --provider open-meteo --units us
```

## Notes

- Default provider is `wttr` and it auto-falls back to Open-Meteo if wttr.in is unreachable.
- `--format` supports `current` (default), `compact`, and `forecast`.
- `--units` supports `metric` (default) and `us`.
- Use `--help` for all options.
- If location is missing, command fails with explicit guidance.

## Raw curl fallback (optional)

If you need direct curl calls:

```bash
curl -s "https://wttr.in/London?format=3&m"
curl -s "https://wttr.in/London?format=%l:+%c+%t+%h+%w&m"
curl -s "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&current=temperature_2m,weather_code"
```

Docs: https://open-meteo.com/en/docs
