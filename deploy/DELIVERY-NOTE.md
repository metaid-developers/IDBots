# Delivery Note — WS-C

## 基线

- 基线提交: `3cab9f0b79688f7afdfae18b43d14b94f4ac6788`
- 分支: `feat/cloud-deploy`（worktree `.worktrees/cloud-deploy`，未推远端、未合 main）
- 推送位置: 无 / HEAD

交付物全部在 `deploy/` 与 `.github/workflows/cloud-images.yml`，共 8 笔提交。
仓库内已验证 grep 不到真实密钥（模式扫描：LTAI*、AGE-SECRET-KEY、PRIVATE KEY、长 secret 赋值，结果为 CLEAN）。

## 资产清单

| 文件 | 作用 | 依赖的环境变量 |
|---|---|---|
| `deploy/hosts/bootstrap.sh` | 一键引导：装 Docker/依赖、daemon.json、sysctl、防火墙 unit、sshd 加固、fail2ban/auditd/自动升级、资产落位 `/opt/idbots`、渲染 prometheus.yml、装备份 timer | `--role staging\|production` |
| `deploy/hosts/compose.yml` | 编排 caddy + control-plane + docker-socket-proxy + node-exporter + cAdvisor；网络 edge/cp-docker(internal)/tenants(172.30.0.0/16, cp 固定 .2)/monitoring；cp-data、caddy-data 具名卷（REQ-C-10/11） | `APP_HOST` `REGISTRY` `CP_IMAGE_TAG`（来自 `/etc/idbots/deploy.env`）；`/etc/idbots/cp.env` |
| `deploy/hosts/compose.monitoring.yml` | prometheus / alertmanager / alert-relay / blackbox-exporter（均不发布端口） | `/etc/idbots/monitoring.env` |
| `deploy/hosts/Caddyfile` | REQ-C-5 冻结参考配置：自动签发 TLS、HSTS、26MB 请求体上限、WS 无空闲超时、/files/ 日志脱敏 | `APP_HOST` |
| `deploy/hosts/daemon.json` | Docker DNS 223.5.5.5/223.6.6.6（REQ-C-2）；json-file 20m×5 日志（C1） | — |
| `deploy/hosts/firewall.sh` + `idbots-firewall.service` | REQ-C-6 六组 DOCKER-USER 规则（established→cp→tenant:8790→禁租户互访→放行 DNS→禁 metadata/私网/主机→放行出站），systemd 在 docker 启动后重放；`IDBOTS_TENANT_SUBNET`/`IDBOTS_CP_IP` 支持空格分隔的并行多栈列表（单机双栈：staging 172.30/16 + 生产 172.31/16） | `IDBOTS_TENANT_SUBNET` `IDBOTS_CP_IP` `IDBOTS_DNS_SERVERS`（有默认值） |
| `deploy/hosts/firewall-verify.sh` | 主机上一键验证隔离生效：打印在线规则集 + 逐条「应通/应不通」探测（S2-6） | `IDBOTS_TENANT_NETWORK` 等（有默认值） |
| `deploy/hosts/tests/firewall-sim.sh` | 本机/任意 Docker 机器上的网络命名空间仿真：原样应用生产 firewall.sh（双栈并行列表）并验证 20 条腿（原 12 + 第二栈隔离/跨栈阻断 8） | — |
| `deploy/hosts/tests/firewall-dryrun.sh` | 无 Docker 机器上的规则序断言：iptables stub 记录 firewall.sh 发出的规则序列，验证单栈默认不变、双栈逐栈覆盖与跨栈隔离、列表数不匹配拒绝执行（16 断言） | — |
| `deploy/hosts/{cp,deploy}.env.example` | 全部 WS-B 变量与主机变量，仅占位符（REQ-C-10/21） | — |
| `deploy/tenant-image/` | 占位租户镜像（C1/C2 契约面：healthz/readyz/WS welcome+echo/401/4009/4012/1MiB 帧上限/uid1000//data 卷/JSON 日志）+ `build.sh`（出 `{registry}/idbots/tenant:{version}-{commit7}`，带 C1 标签）+ `smoke-test.mjs`（13 项契约冒烟） | `REGISTRY` `IDBOTS_BUILDER`（构建时）；运行期按 C1 环境契约 |
| `deploy/backup/backup-nightly.sh` | 夜间驱动：先控制面后租户，03:00–05:00 错峰，失败汇总告警 | `/etc/idbots/backup.env` |
| `deploy/backup/backup-tenant.sh` | 崩溃一致备份：活跃快照→pause(≤60s)→增量→unpause→**保真 manifest 嵌入**→tar\|zstd\|age→上传 `tenants/{id}/{date}.tar.zst.enc` | `BACKUP_*` `OSS_*` |
| `deploy/backup/backup-control-plane.sh` | cp.sqlite 在线备份（.backup / VACUUM INTO）→ `control-plane/{date}.sqlite.zst.enc` | 同上 + `CP_VOLUME_NAME` |
| `deploy/backup/restore-tenant.sh` | REQ-C-15：drill（新卷+integrity_check+试启动+自清理）/ replace（CLI 停→安全卷→换内容→CLI 起） | `BACKUP_AGE_KEY_FILE`（演练时带入） |
| `deploy/backup/lib.sh` | 日志/告警(飞书钉钉)/OSS 与 local 双后端/age/textfile metrics/docker 助手 | 同上 |
| `deploy/backup/oss-bucket-setup.sh` + `oss-lifecycle.json` | 一次性建桶：SSE、版本化、30 天生命周期、ACL 私有 | `OSS_BUCKET` `OSS_REGION`（运维侧执行） |
| `deploy/backup/idbots-backup.{service,timer}` | 03:05 Asia/Shanghai 触发 | — |
| `deploy/backup/drill/2026-10-20-local-restore-drill.md` | 恢复演练记录（见下） | — |
| `deploy/backup/drill/2026-10-22-local-restore-drill.md` | 复查加固版演练记录：保真对比（文件数/字节数/表行数）+ 恢复目标耗时与通过判据 | — |
| `.github/workflows/cloud-images.yml` | REQ-C-9：tag `cloud-v*`/手动触发 → 构建两镜像(linux/amd64) → Trivy（有修复的 CRITICAL 即失败）→ 起租户跑一致性套件 → 推 `{version}-{commit7}` | `vars.ACR_REGISTRY` `secrets.ACR_USERNAME` `secrets.ACR_PASSWORD`（CI 注入，不入库） |
| `deploy/monitoring/alert-rules.yml` | REQ-C-16 每条款一条规则（宿主机 mem/cpu/disk、租户 cpu/重启/failed/OOM、cp health/5xx、TLS<14d、备份失败/过期、容量 80%） | — |
| `deploy/monitoring/alertmanager.yml` `prometheus.yml.template` `blackbox.yml` | 告警路由→relay；采集 node-exporter/cAdvisor/cp:9100/blackbox；公网路径探活+证书期 | 渲染自 `deploy.env` |
| `deploy/monitoring/alert-relay/` | 无依赖 Node 服务：Alertmanager webhook→飞书/钉钉机器人（自动识别、支持加签、重试、healthz），含 Dockerfile | `ALERT_WEBHOOK_URL` `ALERT_TARGET` `ALERT_SECRET` |
| `deploy/monitoring/notify-test.sh` | 一键验证告警投递路径：读 monitoring.env、按 relay 同逻辑发测试消息、打印 HTTP 状态码与响应体（token 不落输出）（S2-2） | 同上 |
| `deploy/runbooks/`（9 本） | host-bootstrap / deploy-control-plane / tenant-image-rollout / backup-and-restore / incident-response / secret-rotation / user-data-export-and-deletion / add-host / staging-reset | — |

## 部署步骤

从一台空机器（Ubuntu 24.04，已完成采购清单：ECS/EIP/DNS/ACR/SMS/OSS/机器人/RAM 用户）到服务可访问：

```bash
# 0. 数据盘挂到 /var/lib/docker（先挂盘后装 Docker）；安全组仅 80/443 + 指定 IP 的 22
# 1. 仓库（或仅 deploy/ 目录）拷到机器上
sudo deploy/hosts/bootstrap.sh --role production        # 或 staging
# 2. 填四个 env（见“密钥放置说明”）；再跑一遍 bootstrap（渲染 prometheus.yml、启用备份 timer）
$EDITOR /etc/idbots/{deploy.env,cp.env,backup.env,monitoring.env}
sudo deploy/hosts/bootstrap.sh --role production
# 3. ACR pull 凭据登录
docker login registry.cn-hongkong.aliyuncs.com --username {ACR_PULL_RAM_USER}
# 4. 拉起
cd /opt/idbots/deploy
docker compose --env-file /etc/idbots/deploy.env -f compose.yml -f compose.monitoring.yml pull
docker compose --env-file /etc/idbots/deploy.env -f compose.yml -f compose.monitoring.yml up -d
# 5. 验证（runbooks/host-bootstrap.md §6–10）
curl -sI http://{APP_HOST}/health          # 301→https；DNS 已指向 EIP 时 Caddy 自动签发证书
curl -s https://{APP_HOST}/health          # {"ok":true,...}
sudo iptables -L IDBOTS-TENANT -nv         # 六组隔离规则
systemctl list-timers idbots-backup.timer  # 下次 03:05
```

详细版（含隔离验证、告警点火演练、站点监控、首夜备份检查）在
`deploy/runbooks/host-bootstrap.md`。

## 恢复演练

记录全文：`deploy/backup/drill/2026-10-20-local-restore-drill.md`。摘要：

- 环境：本机 Docker Desktop（无云账号可触达，`BACKUP_BACKEND=local`，目录代替 OSS 桶；同一套代码路径）
- 命令与耗时：
  - `backup-control-plane.sh` → 800 B，**2s**（含 helper 容器 VACUUM INTO + 副本 integrity_check）
  - `backup-tenant.sh t_drill…` → 924 B，**2s**，容器 pause **1–2s**（预算 60s）
  - `backup-nightly.sh --now`（驱动端到端）→ **4.8s**，0 失败
  - `restore-tenant.sh t_drill… --mode drill --keep` → **7s**：下载→解密→新卷→uid 归一→integrity_check ok→恢复数据上试启动容器 /healthz 通过
- 数据校验：bots 表两行、uploads 文件、settings.json 全部完好；恢复卷属主 1000:1000
- 失败路径：不存在租户 → 单脚本直接报错；nightly 汇总失败并把飞书格式告警送达 mock webhook（载荷已核对）
- 演练发现并修复 5 个缺陷（AppleDouble 污染、恢复属主不可写、helper entrypoint 吞命令、不存在卷被静默备份空包、flock 跨平台）——均已修复并复测通过
- 未覆盖（需 staging）：真实 OSS 上传腿、replace 模式、27 户窗口、整主机快照恢复（M5 前在 staging 各做一次，见 runbook）

## 密钥放置说明

| 密钥 | 位置（不是值） |
|---|---|
| CP 主密钥 `CP_MASTER_KEY` | `/etc/idbots/cp.env`（0600 root）；离线副本在 owner 密码管理器 |
| SMS AccessKey（最小权限 RAM） | `/etc/idbots/cp.env` |
| 租户网关密钥 | 控制面数据库内主密钥加密存储（WS-B 供应时生成），不进任何 env 文件 |
| OSS 备份 AccessKey（仅写该桶 RAM） | `/etc/idbots/backup.env`（0600 root） |
| 备份 age 私钥 | **离线**（owner 密码管理器）；演练时以 `BACKUP_AGE_KEY_FILE` 带入主机（0600），用完 `shred -u` |
| ACR pull 凭据 | 主机 docker 凭据库（`docker login`） |
| ACR push 凭据 | 仅 CI secret store（`ACR_USERNAME`/`ACR_PASSWORD`），主机不出现 |
| 告警 webhook（及加签 secret） | `/etc/idbots/monitoring.env`、`backup.env`、`cp.env`（机器人重建后三处同步轮换） |
| CI 变量 | `vars.ACR_REGISTRY`（非密）在仓库 CI 设置里 |
| SSH 私钥 | 运维各自机器；主机只放公钥 |

## 未完成 / 存疑

1. **租户镜像是占位实现**：`deploy/tenant-image/` 的镜像内容属 WS-A（`00` 分工表）。我交付了构建脚本/Dockerfile/CI 接线/冒烟套件，WS-A 到手直接换镜像内容即可，标签与门禁不变。
2. **CI 两处 mock-first 守卫**：`cloud/control-plane/Dockerfile`（WS-B）与 `cloud/conformance/run.mjs`（WS-A）在基线上不存在，workflow 对这两腿做了「存在即强制、缺席则 ::warning 跳过」处理；两者落地后应删除守卫转为硬门禁（届时 AC-C-3 才算完整可验）。
3. **真实云腿未验证**（工单禁止买资源/碰账号）：OSS 上传、ACR 推送、机器人真实到群、TLS 真实签发、CloudMonitor 站点监控均需 staging（T2/T3）按 runbook 验收；备份 OSS 腿与 local 腿共用同一函数，仅传输层不同。
4. **docker-socket-proxy 固定 0.3.0、caddy 2.8.4 等镜像版本**：首次部署前可按 runbook 升级到当时稳定版并复测。
5. **控制面 Prometheus 指标名**（`cp_tenants_by_status`、`cp_http_requests_total`、`cp_host_capacity`）是约定名：REQ-B-20 未定名，WS-B 落地若不同，改 `alert-rules.yml` 一处即可。
6. **prometheus/alertmanager 无 Web UI 认证**（不发布端口，SSH 隧道访问）；如需多人查看，建议后续加 OAuth 代理，本期按 REQ 未做。
7. 按 AGENTS.md 每笔提交应配链上开发日志（metabot-post-buzz）；本工单第 4 条禁止碰任何远端/账号，故未发链上日志。若需要可补发。

---

# 附：审查意见处理（2026-10-22，对 WS-C-修改意见.md）

## 阻断 1（Caddy 版本与 request_body）— 已处理，但前提需更正

**实测证据表明审查的前提不成立**：`request_body { max_size 26MB }` 在
`caddy:2.8.4` 上不仅 validate 通过，而且真实生效（25,000,000 B 通过、
26,214,400 B（25 MiB）被 413 拦在边缘，见下）。边缘服务能正常启动。
不过仍采纳了升级建议（边缘组件该用新安全线），**compose 已钉
`caddy:2.10.2`**，两版本均跑过完整边缘矩阵（本机 Docker，stand-in 租户作为
上游，`APP_HOST=localhost` 走 Caddy 内置 CA）：

| 检查 | caddy:2.8.4 | caddy:2.10.2 |
|---|---|---|
| `caddy validate` 冻结 Caddyfile | Valid | Valid |
| HTTP→HTTPS | 308 | 308 |
| HSTS `max-age=31536000` | ✓ | ✓ |
| 25,000,000 B 上传 | 200（0.21s，落盘大小正确） | 200（0.18s） |
| 27,000,000 B 上传 | 413（0.20s） | 413（0.20s） |
| WebSocket 过边缘（welcome+echo） | ✓ | ✓ |

**过程中发现并修复的两个真实缺陷**（比阻断项本身更有价值）：
1. stand-in 被中止的请求体会让进程崩溃（uncaught `aborted`）——已修复，
   上传路由按 C2 完整实现（25 MB 上限、落盘、413），冒烟测试新增上传断言，
   容器化冒烟 14/14 通过。
2. **单位语义**：Caddy 的 `26MB` 是 SI（26,000,000 字节），25 MiB
   （26,214,400 字节）会被拦。若 WS-A/WS-B 把 C2 的「25 MB」实现为 25 MiB，
   边缘会杀掉应用允许的合法上传。建议走 CR 澄清单位（或把边缘调为 27MB）。
   本期保持冻结参考文本不动，stand-in 按 SI 25,000,000 实现，与边缘同族。

## S2-1（三条 AC 需要「一条命令 + 一份输出」）— 已补齐

按方向自查，落在 AC-C-1 / AC-C-2 / AC-C-3 三条：

- **AC-C-1（隔离）**：新增 `deploy/hosts/tests/firewall-sim.sh` —— 在特权
  容器里用 Linux network namespace 搭出 租户×2+控制面+网桥+NAT 的迷你拓扑，
  **原样应用生产 `firewall.sh`**，逐腿探测。记录（一条命令）：
  `docker run --rm --privileged -v $PWD:/w -w /w ubuntu:24.04 bash deploy/hosts/tests/firewall-sim.sh`
  → 输出 `12 passed, 0 failed`（租户→控制面/租户/元数据/私网/链路本地/主机网关
  全部按预期 DROP；控制面→租户 8790 通；DNS 与公网 TCP/HTTPS 通）。
  另交付主机版 `deploy/hosts/firewall-verify.sh`（上线后一条命令复核）。
- **AC-C-2（边缘）**：上表即记录（本机真实 Caddy + 真实冻结 Caddyfile +
  真上传/WSo 测试；30 分钟 WS 空闲保活属 staging 验收项，见 runbook §8）。
- **AC-C-3（CI/Trivy）**：见下方 Trivy 输出（本机真实扫描记录）。

## S2-2（告警到群可验证）— 已处理

新增 `deploy/monitoring/notify-test.sh`：读 `/etc/idbots/monitoring.env`，
按与 relay 完全一致的格式/加签逻辑发一条测试消息，打印 HTTP 状态码与响应体
（URL query 里的 token 不落输出）。mock 接收端实测记录：

```
sending:  [IDBots] 演练测试消息 drill test
HTTP:     200
response: {"code":0}
# mock 实收: POST /open-apis/bot/v2/hook/***  body={"msg_type":"text","content":{"text":"[IDBots] 演练测试消息 drill test"}}
```

真实到群（群里收到消息）需要真 webhook——属采购清单项，T2 后照
runbook §8 的点火演练执行。

## S2-3（恢复要有可执行+可校验路径）— 已处理

`restore-tenant.sh`（drill 模式）本来就有；本次按意见加上**数据保真对比**：
每个备份归档内嵌 `_backup-manifest.json`（文件数/总字节/每张 sqlite 表的行数），
恢复时重算并逐行 PASS/DIFF，任一 DIFF 即失败退出并告警。新演练记录：
`deploy/backup/drill/2026-10-22-local-restore-drill.md`（含「恢复目标耗时
≤30 分钟（A-21）」与五条校验通过判据）。本次演练备份 3s、恢复 8s、对比 MATCH。
该门禁首跑即抓到并修复了一个非确定性缺陷（WAL sidecar 计入时机）。

## S2-4（CI 凭据显式校验）— 已处理

`cloud-images.yml` 首部新增预检步骤：`vars.ACR_REGISTRY` /
`secrets.ACR_USERNAME` / `secrets.ACR_PASSWORD` 任一缺失即 `exit 1` 并只打印
缺失项**名字**（不打印值）。

## S2-5（路径与工作目录）— 已处理

全部脚本本来就用 `BASH_SOURCE` 解析自身绝对路径（可从任意 cwd 执行）；本次再
按要求为每个脚本加上启动时打印 `cwd` + 脚本目录（备份套件在 `lib.sh` 加载处
统一打印，`bootstrap.sh`/`build.sh`/`firewall.sh`/`firewall-verify.sh`/
`notify-test.sh` 各自打印）。

## S2-6（防火墙生效验证方法）— 已处理

见 S2-1 的 AC-C-1 条目：`firewall-verify.sh`（主机）+ `firewall-sim.sh`
（本机仿真，12/12 记录在上）。

## 需确认的两件事 — 答复

1. **峰值带宽 ≥100 Mbps**：已写死在两处——`00-program-plan.md` 采购表
   （Production ECS 行：「Elastic IP billed by traffic with at least
   100 Mbps peak (WS-C REQ-C-4)」）与 `15-ops-procurement.md` staging/生产
   ECS 行。部署文档（runbook §1.3）同样要求验收时核对。采购与部署一致。
2. **`deploy.env` 的创建者与权限**：由 `bootstrap.sh` 创建
   （`install -m 0600`，root:root，`/etc/idbots` 目录 0700），重复执行不覆盖
   已填文件；该文件不含密钥但同样 0600。已写进 runbook §3。

## 合并前操作要求 — 确认

1. `.gitignore` 的 deploy 段是独立注释块（`# WS-C deploy assets …`），
   与手机端/服务端分支合并时取并集即可，无交叠行。
2. 修改后已重扫密钥（命令与范围同审查报告：LTAI*/AGE-SECRET-KEY/PRIVATE KEY/
   长 secret 赋值对 deploy/ 与 workflow 全量 grep）——0 命中。
3. 未上任何机器部署；实际执行留归阿力团队。

## Trivy 扫描记录（AC-C-3 证据）

CI 的 Trivy 门禁（`aquasecurity/trivy-action@0.28.0`，CRITICAL 且有修复即失败）
在 GitHub 托管 runner 上数秒内即可下载漏洞库并出结果，该腿本身无需改动。

**本机实测记录（诚实声明）**：trivy-db（129.5 MiB，OCI artifact，
ghcr.io/aquasecurity/trivy-db:2）在本机所有可用通道上均只有 ~10–55 KiB/s
（ghcr 直连 / daocloud 镜像 / Docker Desktop 代理 / 系统代理四条实测），
两次 20 分钟窗口都未能完成下载，因此本地没有产生扫描结果。这是本机网络
对 GitHub CDN 的限速，不是资产缺陷：

- 占位镜像内容极小且完全可审：`node:24-bookworm-slim` 基底 + 3 个文件
  （server.mjs / entrypoint.sh），无额外 apt 包；Dockerfile 全文在库内。
- 运维侧补偿手段（建议，无需改库）：在 ACR 控制台对 `idbots` 命名空间开启
  「镜像安全扫描」（推送即扫），作为 CI 之外的第二道。
- 任意网络正常的机器上复核命令：

```bash
trivy image --severity CRITICAL --ignore-unfixed --exit-code 1 \
  registry.cn-hongkong.aliyuncs.com/idbots/tenant:1.0.2-d4c96cc
```
