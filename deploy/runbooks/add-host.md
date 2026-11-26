# Runbook: add a host

Add capacity before `TenantsNearCapacity` stays firing. Production and staging
must use separate hosts and separate control-plane databases. Never move a
staging database onto the production host to recreate the old shared-host
layout.

## 1. Buy and baseline (owner's team)

Same shape as the existing production host (`ecs.g8i.2xlarge`-class,
8 vCPU / 32 GB, encrypted ESSD, EIP ≥ 100 Mbps peak, Ubuntu 24.04,
`cn-hongkong`). Publish the new egress IP to WS-D when the partner policy
requires it. Run `host-bootstrap.md` and the isolation checks.

## 2. Enable the control-plane agent listener

On the control-plane host, issue a server certificate and a CA for host agents.
Configure `/etc/idbots/cp.env`:

```bash
CP_AGENT_LISTEN=0.0.0.0:9101
CP_AGENT_TLS_CERT_FILE=/etc/idbots/agent-tls/server.crt
CP_AGENT_TLS_KEY_FILE=/etc/idbots/agent-tls/server.key
CP_AGENT_TLS_CA_FILE=/etc/idbots/agent-tls/ca.crt
```

Apply `compose.agent-listener.yml` with `AGENT_BIND_IP` set to the VPC address,
not the EIP. Only agent ports on the VPC are allowed by the security group;
there is no public Docker API or agent port. Client certificates are mandatory.

## 3. Register the host

```bash
CP="docker exec idbots-control-plane-1 node dist/cli.js"
$CP host register h_prod_02 --environment production --capacity 58 --as admin:operator
# OR, with the client certificate's SHA-256 fingerprint instead of a token:
$CP host register h_prod_02 --environment production --capacity 58 \
  --fingerprint SHA256_COLON_SEPARATED_FINGERPRINT --as admin:operator
```

Token mode prints the agent token once. Store it in the password manager.
`host list` shows the environment, capacity, fingerprint, and last agent
connection. Do not reuse a host ID or credential across environments.

## 4. Start the host agent

Install `/etc/idbots/agent.env` from `deploy/hosts/agent.env.example` and the
client certificate/key/CA under `/etc/idbots/agent-tls` (0600 for the key).
`AGENT_URL` points to the control plane's VPC listener. Apply
`compose.host-agent.yml` on the tenant host:

```bash
docker compose --env-file /etc/idbots/deploy.env \
  -f compose.yml -f compose.host-agent.yml up -d host-agent
```

The agent mounts Docker through the existing socket path but publishes no
port. It accepts only control-plane requests over its authenticated outbound
connection. Tenant gateway secrets are used only for the in-memory upgrade
transaction and are not written to agent logs or an agent database.

## 5. Verify

- `host list` updates `agent_last_seen_at` after connection.
- Create a small staged rollout containing one synthetic tenant on the new host.
  The manager must preflight through the agent, recreate the remote container,
  and write back ready status, image digest, and app version.
- Repeat with a bad image: the job pauses, the remote tenant rolls back, and no
  other host expands the rollout.
- Stop the agent while a job is queued: no new work is scheduled on that host.
  Restart it and confirm lease recovery without duplicate container recreation.
- Complete real mTLS verification on staging; the token-only fake-Docker test
  path is not production authentication evidence.

## Scope boundary

Remote rollout execution is implemented. New-user placement, tenant migration,
and proxy routing across hosts still require their own acceptance before
putting new-user traffic on additional hosts. Do not exceed the current serving
host's accepted capacity merely because an agent is connected. Those flows must
be load-tested end to end before commercial placement is enabled.
