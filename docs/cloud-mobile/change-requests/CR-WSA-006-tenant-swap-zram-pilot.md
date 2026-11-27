# CR-WSA-006 · Tenant swap through zram (pilot)

- Status: pilot approved by the owner on 2026-11-28 and running on the tenant
  host since 2026-11-28 00:55 CST (§7, pilot log). The C1 amendment is
  deferred until the pilot has been evaluated (§8).
- Date: 2026-11-28
- Related: `docs/cloud-mobile/01-interface-contracts.md` C1 "Resources"
  (frozen), `docs/cloud-mobile/10-ws-a-idbots-server-mode.md` REQ-A-31,
  `deploy/hosts/`

## 1. What this changes

C1 fixes `--memory` and `--memory-swap` at `2304m` — "no swap". This CR lets
tenant containers use **zram-backed swap** (compressed RAM; the disk is never
touched).

| Setting | C1 today | Pilot |
|---|---|---|
| `--memory` (cgroup `memory.max`) | `2304m` | unchanged |
| `--memory-swap` (cgroup `memory.swap.max`) | `2304m` → no swap | 2304 MB of swap per container, inside the host's single zram device |
| Host swap | none; `vm.swappiness = 0` | one zram device (zstd, 6 GiB before compression); `vm.swappiness = 150`; `vm.page-cluster = 0` |
| earlyoom | `-m 8,6` | `-m 8,6 -s 100` |

`--cpus`, `--pids-limit`, `--shm-size`, `--cap-drop`, `--security-opt` and the
restart policy do not change. A container still cannot use more than 2304 MB of
RAM.

## 2. Why

Measured on the tenant host on 2026-11-27 (17 tenants, 4 vCPU / 15.2 GiB, no
swap):

- An idle tenant holds about 235 MiB of **anonymous** memory (Electron main
  process, plus a leaked warm-up kernel in some tenants). Anonymous memory
  cannot be reclaimed without swap, so it stays resident for as long as the
  tenant exists, however long the user has been away.
- With anonymous memory pinned, memory pressure can only evict page-cache
  pages. The 2026-11-27 livelock had exactly that signature: 233 MB/s of
  constant file reads and zero writes, CPU 96 %, host unreachable until a
  forced reboot.
- With swap available the kernel compresses cold anonymous pages into zram
  instead, so page cache survives and idle tenants cost a fraction of RAM.

The owner's requirement is that an idle cloud tenant should not hold memory.
Container hibernation (stopping the container) meets it at the cost of a cold
start and of stopping the user's bots; zram meets it with no wake-up delay and
no product change, so it is tried first.

## 3. Host-level changes

All files are in `deploy/hosts/` and installed by hand for the pilot
(bootstrap.sh is not changed until the pilot is adopted).

| File | Installed as |
|---|---|
| `zram-swap.sh` | `/opt/idbots/zram-swap.sh` (0755) |
| `idbots-zram-swap.service` | `/etc/systemd/system/idbots-zram-swap.service` |
| `sysctl.d/99-idbots-zram.conf` | `/etc/sysctl.d/99-idbots-zram.conf` |

```bash
install -m 0755 zram-swap.sh /opt/idbots/zram-swap.sh
install -m 0644 idbots-zram-swap.service /etc/systemd/system/idbots-zram-swap.service
install -m 0644 sysctl.d/99-idbots-zram.conf /etc/sysctl.d/99-idbots-zram.conf
systemctl daemon-reload
systemctl enable --now idbots-zram-swap.service
sysctl --system
swapon --show            # NAME /dev/zram0, SIZE 6G, USED 0, PRI 100
sysctl vm.swappiness vm.page-cluster
```

`99-idbots-zram.conf` sorts after the cloud image's `99-apsara-sysctl.conf`
(`vm.swappiness = 0`), so it wins.

### earlyoom

earlyoom 1.7 kills only when memory **and** swap are both below their
thresholds (swap default 10 %). With a zram device present it would stand by
while zram fills, including with data that does not compress. `-s 100` makes
it ignore swap, so the RAM rule stays exactly what it is today:

```bash
cp -a /etc/default/earlyoom "/etc/default/earlyoom.bak.$(date +%Y%m%d-%H%M%S)"
sed -i 's/^EARLYOOM_ARGS="-m 8,6 /EARLYOOM_ARGS="-m 8,6 -s 100 /' /etc/default/earlyoom
systemctl restart earlyoom
```

### Tenant cgroups

The control plane sends `MemorySwap: memoryBytes` both when it provisions a
tenant (`services/provisioning.ts`) and when it recreates one during an
upgrade (`services/upgrade.ts`), so a container starts with
`memory.swap.max = 0`. That limit is not durable, as a probe container on the
host showed:

| Step | `memory.swap.max` |
|---|---|
| container created with `--memory-swap = --memory` | `0` |
| after `systemctl daemon-reload` | `max` |
| after `docker update --memory-swap <2 × memory>` | `<memory>`, and it survives reloads and restarts |

Docker runs with the systemd cgroup driver; a daemon reload makes systemd
re-realise each container scope from its own unit properties and drops the
value runc had written. The C1 "no swap" rule has therefore never been
enforced for long on this host — it was invisible because the host had no
swap device.

For the pilot each existing tenant gets a bounded, durable allowance:

```bash
for c in $(docker ps --filter name=idb-t_ --format '{{.Names}}'); do
  docker update --memory-swap 4831838208 "$c"    # 2304 MB RAM + 2304 MB swap
done
```

`docker update` changes `HostConfig`, so it holds across restarts and
reloads, but not across the container re-creation an upgrade performs: a
tenant created or upgraded during the pilot starts with swap disabled until
the command is repeated (§9).

## 4. Sizing

`IDBOTS_ZRAM_SIZE` (default `6G`) is the capacity **before** compression, so
it is also the worst case of RAM the device can occupy. 6 GiB is 39 % of the
host's memory and covers the anonymous memory of roughly 25 idle tenants at a
3:1 ratio (about 2 GiB of RAM). The ratio measured on the host is 4.58:1 on
one idle tenant (§7, pilot log); 3:1 is kept here as the planning figure
because the sample was small.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Pages that do not compress fill zram with RAM-sized data | earlyoom keeps its RAM-only rule (`-s 100`); device size is bounded (§4) |
| Reclaim spends CPU on compression | zstd level 1, per-CPU streams; the host is memory-bound, CPU is idle at 20 tenants and below |
| A tenant touches cold pages after a long idle | faults are served from RAM (decompression per 4 KiB page); far below the 88–133 s cold start of a stopped container |
| One tenant fills the device | each container is capped at 2304 MB of swap (§3) |
| `stop` while memory is tight | `swapoff` pulls every page back into RAM; rollback below avoids it |

## 6. Rollback

```bash
systemctl disable idbots-zram-swap.service     # removed on the next reboot
rm /etc/sysctl.d/99-idbots-zram.conf && sysctl --system   # restores vm.swappiness = 0
cp /etc/default/earlyoom.bak.<stamp> /etc/default/earlyoom && systemctl restart earlyoom
systemctl stop idbots-zram-swap.service        # only when MemAvailable exceeds the zram USED figure
for c in $(docker ps --filter name=idb-t_ --format '{{.Names}}'); do
  docker update --memory-swap 2415919104 "$c"  # back to the C1 value (no swap)
done
```

## 7. Pilot validation

Recorded in the pilot log below as it is measured.

1. No regression: both control planes healthy, every tenant `ready`, gateway
   latency unchanged, no earlyoom or kernel OOM kills.
2. Compression ratio and reclaim behaviour, measured on one idle **staging**
   tenant by lowering its cgroup `memory.high` below its anonymous memory so
   the kernel has to reclaim inside that cgroup only. `memory.high` is restored
   to `max` afterwards; the tenant keeps running throughout.
3. Under real pressure (tenant count or a burst): `MemAvailable` stays above
   the earlyoom line while swap usage rises, and there is no page-cache
   livelock. This can only be observed over time.

### Pilot log

**2026-11-28, 00:52–01:05 CST — applied on the tenant host.**

- The first `systemctl enable --now` failed: on util-linux 2.39 `zramctl
  --reset` removes a zram device that was never sized, so the script's
  defensive pre-reset deleted the device. Fixed in the follow-up commit
  (`zramctl --find`). Nothing else had been applied when it failed.
- Final state: `idbots-zram-swap.service` enabled and active; `/dev/zram0`,
  zstd, 6 GiB, priority 100; `vm.swappiness = 150`, `vm.page-cluster = 0`;
  earlyoom `-m 8,6 -s 100 -r 60 --avoid …`; all 17 tenants at
  `memory.max = 2304M`, `memory.swap.max = 2304M` through `docker update`.
- §7.1: both control planes `healthy`, 17/17 tenants `ready`, `/health` on
  the production and staging origins 200 in about 6 ms, no earlyoom or kernel
  OOM kill.
- §7.2, on staging tenant `idb-t_fhatxl6qngjggc4cys6a` (idle since 2026-11-20,
  `memory.high = 150M` for 25 seconds):

  | | before | after 10 s | after restoring `memory.high` |
  |---|---|---|---|
  | cgroup `memory.current` | 474 MiB | 149 MiB | 148 MiB |
  | anonymous | 240 MiB | 109 MiB | 110 MiB (97 MiB in swap) |
  | file cache | 203 MiB | 23 MiB | 20 MiB |

  zram held 92 MiB of data as 20 MiB (4.58:1), 34 MiB of RAM including
  metadata, peak 42 MiB. `memory.events`: `oom 0`. Gateway `/healthz` on that
  tenant answered in 0.3–0.5 ms, the same as a tenant with nothing swapped.
- §7.3: not yet observed; the host had about 9.5 GiB available throughout.

## 8. Acceptance

The pilot is adopted, and C1 §Resources is amended, when all of these hold:

- §7.1 and §7.2 are green and the measured compression ratio is at least 2:1.
- §7.3 has been observed at least once, or the host has run for two weeks with
  swap enabled and no livelock or earlyoom kill at a tenant count that used to
  reach the earlyoom line.

Otherwise the pilot is reverted with §6.

## 9. Follow-ups if adopted

1. Control plane: set `MemorySwap` explicitly (for example `memoryBytes * 2`)
   in `provisioning.ts` and `upgrade.ts`, with a test. Until then, repeat the
   `docker update` in §3 for every tenant created or upgraded during the
   pilot.
2. `deploy/hosts/bootstrap.sh`: install the three files and the earlyoom
   argument; add them to `runbooks/host-bootstrap.md`.
3. Amend the C1 `--memory` / `--memory-swap` row in `01-interface-contracts.md`
   and the `--memory-swap` statement in `deploy/README.md`.
4. Monitoring: alert on zram usage and on `memory.swap.events` per tenant.
