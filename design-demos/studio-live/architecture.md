# Studio live stage architecture proposal

## Recommendation

Keep the existing primary LLM and left transcript unchanged. Add a read-only visual director in the main process and one persistent Live Stage document per Studio session. The director receives bounded semantic events, not the primary model's full context. It returns constrained scene patches, not executable HTML or JavaScript. The host owns factual state; the visualization model owns composition, wording within factual limits, motion parameters, and variation.

This is the smallest architecture that supports continuous motion, creative variation, predictable cost, and graceful failure without repeatedly reloading the right browser.

## Event taxonomy from the inspected sessions

The host should normalize provider-specific events into these semantic families:

| Family | Typical source signals | Visual meaning |
| --- | --- | --- |
| Received | user submission, instant acknowledgment | The Twin receives the request |
| Reasoning | reasoning block start/end, request status | Deliberation, without exposing raw chain-of-thought |
| Speaking | visible assistant delta, owner update | A caption or utterance changes |
| Local recall | conversation search, session reads, task-board reads, memory, file search | Local context gathers around the Twin |
| Web2 research | web search or fetch tools | Public web sources are being explored |
| MetaWeb research | omni read, pin read, MetaApp search, chain history | On-chain sources arrive from MetaWeb |
| Making | read, write, edit, bash, document or artifact operations | An artifact is taking shape |
| Delegation | local worker delegate, cross-session dispatch | A task moves to a named worker |
| Waiting | pending worker, permission, long-running tool | An honest wait with no fake percentage |
| Worker report | orchestration notification, dispatch report | A result returns to the Twin |
| Verification | screenshot, browser read, independent calculation, evidence checks | Claims and proof are compared |
| Browser action | preview, click, tab, screenshot | The big screen or a web page is being operated |
| Owner needed | ask user question, decision milestone, approval | Attention shifts to the owner |
| Problem or recovery | tool error, retry, interrupted tracking, reassignment | A visible detour and recovery, not false success |
| Report ready | successful projection receipt | The process resolves into the result page |
| Complete or idle | turn end, session idle | Motion settles |

Web2 was not required in the three inspected sessions, so the prototypes do not pretend it occurred there. It remains in the shared protocol for existing tools.

## Runtime flow

1. Submission synchronously opens or reveals the Live Stage and renders a deterministic Received scene. No model round trip blocks the first visible response.
2. A host-side event tap observes the same normalized DSH or SDK signals that already drive messages. It never scrapes rendered bubbles.
3. A reducer maintains a small factual run model: current family, active tools, named participants, pending calls, artifacts, visible milestones, problems, and projection receipt.
4. A coalescer requests a visual patch on meaningful transitions. Routine bursts are merged over roughly 800 to 1500 ms. Owner-needed, problem, worker-report, and report-ready transitions jump the queue.
5. The visual director receives the fixed style grammar, current compact scene, selected visual direction, and a bounded event window. It has no tools and no side-effect capability.
6. The director returns one schema-validated scene patch. Invalid, late, duplicate, or over-budget patches are rejected. The deterministic reducer still updates the stage's factual caption.
7. The persistent renderer applies the patch through transforms, opacity, Canvas parameters, and shared-element movement. It does not navigate or replace the document.
8. When the primary LLM calls the existing projection tool, the current projector pipeline stores the report and its history entry. The Live Stage shows Report ready with an Open report action. Opening replaces the stage with the report through the existing projector. Back displays the frozen final live scene.

## Suggested scene patch contract

```json
{
  "protocol": "idbots.live-stage.v1",
  "sessionId": "session-id",
  "turnId": "submission-id",
  "revision": 7,
  "baseRevision": 6,
  "eventId": "normalized-event-id",
  "scene": {
    "family": "verification",
    "headline": "Checking the evidence",
    "caption": "The worker's report is being compared with original records.",
    "composition": "converge",
    "motif": "proof-loop",
    "participants": ["Twin", "Worker", "Evidence"],
    "motion": {
      "preset": "orbital-crosscheck",
      "seed": 18427,
      "durationMs": 760,
      "easing": "emphasized-decelerate",
      "energy": 0.55,
      "density": 0.35
    }
  }
}
```

The host validates identifiers, revision order, allowed composition and motion presets, text lengths, participant references, and numeric ranges. Facts such as participant names, event family, completion, and errors come from the reducer and cannot be upgraded by the model. The model may choose among compositions and tune motion, but it cannot claim that a pending task completed.

## Controlled novelty

The style system fixes brand tokens, typography, accessibility, stage geometry, scene families, and motion safety. The model varies composition, spatial arrangement, motif, seed, rhythm, easing, density, and concise narrative wording. A later version can add a small declarative keyframe DSL with allowlisted properties and easing names. It should still reject arbitrary script, network resources, `eval`, and unbounded particle counts.

This creates variation inside a recognizable product language. It avoids both a fixed template and unconstrained generated HTML whose quality and safety vary unpredictably.

## Privacy and trust

Do not send the primary model's raw reasoning to the visual director. Reasoning start/end and owner-visible milestones communicate enough to animate deliberation. Do not mirror full transcripts, full tool results, access tokens, contact details, invitation codes, absolute paths, or arbitrary tool arguments. Use a per-tool sanitizer that emits semantic labels, allowlisted entity names, result status, and short redacted summaries.

The visual director is a presentation process. It receives no wallet, browser-control, filesystem, chain-write, delegation, or session-write tools.

## Cost model and budgets

These are design targets, not measured results. The scripted demos make zero LLM calls.

| Turn shape | Director calls | Uncached input target | Output target |
| --- | ---: | ---: | ---: |
| Greeting or quick answer | 1 | 1.5k to 3k tokens | 0.2k to 0.6k tokens |
| Typical multi-tool turn | 4 to 7 | 6k to 18k tokens | 1.5k to 4k tokens |
| Complex delegation turn | 8 to 12 | 16k to 40k tokens | 3k to 8k tokens |

For comparison, the inspected BP session's primary turn recorded 230,397 uncached input tokens and 12,898 output tokens. A bounded visual director should remain small relative to that primary context. It should not inherit the primary session's accumulating context window.

Recommended MVP guardrails: a cheaper model route, a stable cached grammar, at most eight director calls per turn by default, a per-turn token cap, patch timeouts, and deterministic fallback after the cap. Instrument call count, input and output tokens by cache bucket, patch latency, rejected patches, fallback rate, and time from primary event to visible patch. Then replace these estimates with distributions from real sessions.

## MVP boundaries

The first implementation should prove one visual direction with six high-value families: Received, Reasoning or Speaking, Local or MetaWeb research, Delegation and Worker report, Verification, and Report ready. Browser action and Owner needed are included because the inspected sessions demonstrate them. Web2 uses the same research renderer with a different source label.

Do not begin with voice, a general-purpose animation DSL, free-form generated JavaScript, per-token director calls, or three production themes. The three prototypes are for selecting one direction or hybrid. After selection, implement the event reducer and persistent stage with deterministic scenes first, then enable the visual director behind a default-off setting and compare quality, latency, and measured cost.

## Selected hybrid iteration

The owner selected A+B. The renderer therefore needs a topology dimension in addition to the event family:

```json
{
  "family": "delegation",
  "topology": {
    "mode": "structured",
    "nodes": ["twin", "worker:s9", "evidence:anchor-proof"],
    "edges": [["twin", "worker:s9"], ["worker:s9", "evidence:anchor-proof"]]
  }
}
```

`topology.mode: structured` triggers the B-like expansion. Suitable triggers include a delegation, a multi-agent orchestration, a long-term plan with dependency steps, or verification that joins multiple evidence nodes. Ordinary conversation and unstructured research keep the A-like orb. The orb shrinks and shifts to become the Twin node in the graph rather than being replaced. When the graph resolves, it collapses back into the orb.

The host derives topology from actual task state, not from a visual-model guess. The visual director may choose layout and motion, but cannot create workers, dependencies, or evidence that do not exist.

The selected A treatment uses the MIT-licensed WebGPU/WGSL liquid-glass shader from `LerSent001/orb`, adapted to IDBots brand tokens. The current conversation Bot's Avatar sits inside the orb as its identity. Unsupported WebGPU, device loss, shader failure, or reduced-resource mode falls back to the existing Canvas2D presence. Reduced motion renders a stable frame.
