# Runbook: tenant image rollout

New tenant images come from CI (`cloud-v*` tags →
`{REGISTRY}/idbots/tenant:{version}-{commit7}`, Trivy-clean, conformance-passed).
Rollout is canary-first, then fleet. The control plane drives upgrades
(WS-B REQ-B-12): stop → recreate on the same volume with the same secret →
wait ready → auto-rollback to `previous_image` when the new image never
becomes ready and `org.idbots.rollback-safe-to` allows it.

## 0. Preconditions

- The tag exists: `docker buildx imagetools inspect {REGISTRY}/idbots/tenant:{tag}`
- The image's `org.idbots.rollback-safe-to` label tells you how far back a
  rollback may go:

  ```bash
  docker buildx imagetools inspect {REGISTRY}/idbots/tenant:{tag} \
    --format '{{ json .Image.Config.Labels }}'
  ```

## 0b. Pull the image on the host first (mandatory)

The upgrade CLI verifies the image exists **locally on the host** and marks a
tenant `failed` when it does not (incident 2026-11-21: a fleet upgrade with an
unpulled image flagged all 18 staging tenants failed in one pass; containers
kept running but had to be status-restored before the retry). Always:

```bash
docker pull {REGISTRY}/idbots/tenant:{tag}
docker images | grep {tag}     # confirm present before any upgrade
```

## 1. Canary on one staging tenant

```bash
CP="docker exec idbots-control-plane-1 node dist/cli.js"
$CP tenant upgrade {t_canary} --image {REGISTRY}/idbots/tenant:{tag} --as admin:{you}
$CP tenant show {t_canary}          # status ready|degraded, new image, appVersion bumped
```

Then exercise the canary like a user for at least 30 minutes (chat, a
document skill, a scheduled task, file upload/download). Watch
`docker logs idb-{t_canary}` and the tenant CPU/memory panels.

If the canary never becomes ready, the control plane rolls it back
automatically and alerts (AC-B-6). If it becomes ready but misbehaves, roll
it back by hand:

```bash
$CP tenant show {t_canary}          # note previous_image
$CP tenant upgrade {t_canary} --image {previous_image} --as admin:{you}
```

## 2. Fleet rollout

Staging first (all fake + test tenants), soak 24 h, then production:

```bash
$CP tenant upgrade --all --image {REGISTRY}/idbots/tenant:{tag} --as admin:{you}
# default one tenant at a time; --batch N raises concurrency (staging only)
# --all selects only ready/degraded tenants not already on the target.
# Optional: --digest sha256:... --kind customer --cohort stable --environment production
```

Upgrades close phone WebSockets with `4012`; clients reconnect on their
backoff and see an "updating" state. No data lives in the container — only
in the volume — so an upgrade must never lose user data (A-22). Classify
synthetic/internal/demo/customer tenants and their canary/early/stable cohort
with `tenant classify ID --kind KIND --cohort COHORT --as admin:{you}`. Repeating
an explicit upgrade already on the target image or digest is a no-op.

## 3. Rollback rules (from C1)

- Downgrades are only allowed to versions **at or above** the running data's
  `org.idbots.rollback-safe-to`; the control plane refuses anything older
  (its database migrations cannot go backwards).
- Fleet rollback:

  ```bash
  $CP tenant upgrade --all --image {previous_good_tag} --as admin:{you}
  ```

  This is also the M5 emergency control for "bad tenant image"
  (`60-acceptance-and-go-live.md`).
- If the bad image also corrupted on-disk data, restore the affected tenants
  from last night's backups (`backup-and-restore.md`) AFTER rolling the image
  back.

## 4. Registry hygiene (REQ-C-8)

Keep the last 20 tags plus every tag currently deployed. List what is
deployed before pruning:

```bash
$CP tenant list | awk '{print $NF}' | sort -u     # images in use
```

Never delete a tag that is any tenant's `image` or `previous_image`.
