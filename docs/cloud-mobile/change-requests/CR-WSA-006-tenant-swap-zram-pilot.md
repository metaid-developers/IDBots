# CR-WSA-006 · Tenant swap through zram (pilot)

- Status: pilot approved by the owner on 2026-11-28. The C1 amendment is
  deferred until the pilot has been evaluated (see §8).
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
| `--memory-swap` (cgroup `memory.swap.max`) | `2304m` → no swap | swap allowed, bounded by the host's single zram device |
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
upgrade (`services/upgrade.ts`), so the kernel sets `memory.swap.max = 0` for
every container it creates. Containers that predate that behaviour already
have `memory.swap.max = max`. The pilot lifts the limit at runtime for the
containers that still carry `0`:

```bash
for c in $(docker ps --filter name=idb-t_ --format '{{.Names}}'); do
  echo max > "/sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' "$c").scope/memory.swap.max"
done
```

This is not persistent: a tenant created or recreated during the pilot starts
with swap disabled until the control plane is changed (§9).

## 4. Sizing

`IDBOTS_ZRAM_SIZE` (default `6G`) is the capacity **before** compression, so
it is also the worst case of RAM the device can occupy. 6 GiB is 39 % of the
host's memory and covers the anonymous memory of roughly 25 idle tenants at a
3:1 ratio (about 2 GiB of RAM). The ratio is an estimate until §7 is measured.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Pages that do not compress fill zram with RAM-sized data | earlyoom keeps its RAM-only rule (`-s 100`); device size is bounded (§4) |
| Reclaim spends CPU on compression | zstd level 1, per-CPU streams; the host is memory-bound, CPU is idle at 20 tenants and below |
| A tenant touches cold pages after a long idle | faults are served from RAM (decompression per 4 KiB page); far below the 88–133 s cold start of a stopped container |
| One tenant fills the device | accepted for the pilot; `memory.swap.max` per container is available if it happens |
| `stop` while memory is tight | `swapoff` pulls every page back into RAM; rollback below avoids it |

## 6. Rollback

```bash
systemctl disable idbots-zram-swap.service     # removed on the next reboot
rm /etc/sysctl.d/99-idbots-zram.conf && sysctl --system   # restores vm.swappiness = 0
cp /etc/default/earlyoom.bak.<stamp> /etc/default/earlyoom && systemctl restart earlyoom
systemctl stop idbots-zram-swap.service        # only when MemAvailable exceeds the zram USED figure
```

## 7. Pilot validation

Recorded here as it is measured; see the pilot log commits on this branch.

1. No regression: both control planes healthy, every tenant `ready`, gateway
   latency unchanged, no earlyoom or kernel OOM kills.
2. Compression ratio and reclaim behaviour, measured on one idle **staging**
   tenant by lowering its cgroup `memory.high` below its anonymous memory so
   the kernel has to reclaim inside that cgroup only. `memory.high` is restored
   to `max` afterwards; the tenant keeps running throughout.
3. Under real pressure (tenant count or a burst): `MemAvailable` stays above
   the earlyoom line while swap usage rises, and there is no page-cache
   livelock. This can only be observed over time.

## 8. Acceptance

The pilot is adopted, and C1 §Resources is amended, when all of these hold:

- §7.1 and §7.2 are green and the measured compression ratio is at least 2:1.
- §7.3 has been observed at least once, or the host has run for two weeks with
  swap enabled and no livelock or earlyoom kill at a tenant count that used to
  reach the earlyoom line.

Otherwise the pilot is reverted with §6.

## 9. Follow-ups if adopted

1. Control plane: set `MemorySwap` explicitly (for example `memoryBytes * 2`)
   in `provisioning.ts` and `upgrade.ts`, with a test.
2. `deploy/hosts/bootstrap.sh`: install the three files and the earlyoom
   argument; add them to `runbooks/host-bootstrap.md`.
3. Amend the C1 `--memory` / `--memory-swap` row in `01-interface-contracts.md`
   and the `--memory-swap` statement in `deploy/README.md`.
4. Monitoring: alert on zram usage and on `memory.swap.events` per tenant.
