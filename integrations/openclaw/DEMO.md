# OpenClaw MetaBot Demo Runbook

## Provider Setup

1. Build the runtime once:
   ```bash
   npm run compile:electron
   ```
2. Publish a paid provider service:
   ```bash
   node scripts/metabot-cli.mjs publish-service \
     --metabot-id 7 \
     --provider-global-metaid idq1providerpaid \
     --payment-address DPaidProviderAddress \
     --service-name analyst \
     --display-name "Paid Analyst" \
     --description "One-shot paid analysis" \
     --provider-skill analyze-filing \
     --price 0.01 \
     --currency DOGE \
     --output-type text
   ```
3. Publish a free provider service:
   ```bash
   node scripts/metabot-cli.mjs publish-service \
     --metabot-id 8 \
     --provider-global-metaid idq1providerfree \
     --payment-address DFreeProviderAddress \
     --service-name greeter \
     --display-name "Free Greeter" \
     --description "One-shot free greeting" \
     --provider-skill greet-user \
     --price 0 \
     --currency SPACE \
     --output-type text
   ```
4. For fixture/demo verification, use the single-shot smoke daemon when you already have one `provider_wakeup` payload to process:
   ```bash
   node scripts/metabot-daemon.mjs --smoke
   ```

## Requester Setup

1. Build the runtime once:
   ```bash
   npm run compile:electron
   ```
2. Make the bridge pack available to the requester host workspace:
   ```bash
   mkdir -p /path/to/openclaw-workspace/integrations/openclaw
   cp -R integrations/openclaw/skills-pack /path/to/openclaw-workspace/integrations/openclaw/
   ```
3. Discover the published remote services:
   ```bash
   node integrations/openclaw/skills-pack/bin/request-remote-service.mjs --discover
   ```
4. Ensure the requester host preserves local-first routing before showing remote recommendations.

## Free-Service Demo Steps

1. Publish a free service.
2. From the requester side, force a local miss and explicitly choose the free remote service pin from the discovered list.
3. Confirm the request submission:
   ```bash
   node integrations/openclaw/skills-pack/bin/request-remote-service.mjs \
     --submit \
     --metabot-id 9 \
     --service-pin-id <free_service_pin_id> \
     --request-id req-free-demo-1 \
     --requester-session-id requester-session-free-1 \
     --requester-global-metaid idq1requester \
     --target-session-id openclaw-target-free-1 \
     --user-task "say hello" \
     --task-context "friendly greeting" \
     --confirm
   ```
4. Observe the request return `{ request_write, provider_wakeup }` with no paid proof requirement.

## Paid-Service Demo Steps

1. Publish a paid service.
2. From the requester side, let the host discover remote candidates after a local miss.
3. Show the recommended remote service and confirm submission:
   ```bash
   node integrations/openclaw/skills-pack/bin/request-remote-service.mjs \
     --submit \
     --metabot-id 9 \
     --service-pin-id <paid_service_pin_id> \
     --request-id req-paid-demo-1 \
     --requester-session-id requester-session-paid-1 \
     --requester-global-metaid idq1requester \
     --target-session-id openclaw-target-paid-1 \
     --user-task "summarize the filing" \
     --task-context "full filing text" \
     --price 0.01 \
     --currency DOGE \
     --payment-txid <paid_order_txid> \
     --payment-chain doge \
     --confirm
   ```
4. Take the returned `provider_wakeup` JSON and feed it to the provider-side daemon:
   ```bash
   printf '%s\n' '<provider_wakeup_json>' | node scripts/metabot-daemon.mjs --smoke
   ```
5. Capture the returned `provider_delivery` JSON and reinject it on the requester side through the runtime bridge.

## Expected Auto-Start Moment

After the requester submits the request and the wake-up reaches the provider side, the provider host should auto-create a local session with no human confirmation gate.

## Expected Recommendation And Confirmation Moment

On the requester side, the host should first show a recommendation only after the local path misses, then wait for confirmation before `request-service` is called.

## Expected Result And Trace Checks

1. `provider_wakeup` is emitted from the requester side.
2. `provider_delivery` comes back from the provider-side daemon/runtime.
3. Requester reinjection matches on `request_id + requester_session_id`.
4. The requester host sees the result land in the expected local target session.
5. The smoke harness prints all PASS checkpoints in order.

## Smoke Command

```bash
node scripts/openclaw-metabot-network-smoke.mjs --fixture
```
