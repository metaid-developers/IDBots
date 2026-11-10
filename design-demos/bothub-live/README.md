# BotHub Live Stage direction demos

Open `index.html` for the comparison gallery, or open any direction directly:

- `living-core.html`
- `signal-atlas.html`
- `quiet-presence.html`

The selected A+B prototype uses HTML, CSS, Canvas2D, JavaScript, and a vendored WebGPU/WGSL liquid-glass shader. No npm package or remote runtime asset is required. `living-core.html` uses the active local `AI_Sunny` Avatar with `assets/twinbot.png` as the failure fallback. Structured events expand the orb into a relationship graph, then settle back into presence mode. See `direction-approved.md`.

The prototypes can be opened directly from disk. For local HTTP verification:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then visit `http://127.0.0.1:8765/`.

## Controls

- Scenario selector: decision follow-up, BP projection, or simple greeting.
- Play/Pause, Previous/Next, and event dots inspect the continuous process.
- Live stage switch demonstrates the future feature gate.
- Motion button switches between full and reduced motion.
- Open report appears at the final event. Back to live trace restores the frozen process.

Useful deterministic URLs:

```text
/living-core.html?scenario=decision&step=4&play=0
/living-core.html?scenario=decision&step=4&play=0&orb=canvas
/signal-atlas.html?scenario=decision&step=4&play=0
/quiet-presence.html?scenario=decision&step=4&play=0
/living-core.html?scenario=decision&step=5&play=0&report=1
```

## Scope

These are visual direction prototypes only. They do not modify the BotHub product, invoke an LLM, or measure token usage. `architecture.md` defines the proposed production mechanism and the cost targets that an instrumented MVP must verify.
