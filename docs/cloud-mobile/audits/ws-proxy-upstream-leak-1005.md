# 缺陷：ws-proxy upstream 泄漏 → 租户 gateway 池满拒连（open 即 4009，无 welcome）

- 状态：已定位、待修复（2026-10-25 05:0x，Twin 验收途中发现并止血）
- 严重级：**P0 · 上线阻塞**。真实用户手机锁屏/切网即触发；池满后该租户所有新连接永久被拒，用户表现为「永远连不上」，且自愈途径只有重启租户容器。
- 归属：WS-B（control-plane / wsProxy.ts）。租户侧 gateway 行为正确，无需改动。

## 现象（一手复测）

1. `wss://staging.idbots.world/ws` 能 open，但 25 秒内收不到 `welcome`，随后被 close（控制面日志 `code:4009, direction:"tenant"`）。
2. 同一账号前一晚 00:29 同路径可正常收到 welcome。租户容器 healthy，控制面 ws-proxy 日志 `socket open→closed` 表面正常。

## 根因链（每一环已实测/实读验证）

1. **gateway 拒连逻辑**：`dist-electron/main/gateway/server.js` L514 `if (closing || sockets.size >= MAX_CLIENT_SOCKETS) { ws.close(CLOSE_TOO_MANY_CLIENTS /*4009*/); return; }`——池满直接 4009、不发 welcome。`MAX_CLIENT_SOCKETS = 3`（L69）。日志中 4009 即来自此分支（wsProxy 的 `upstream.on('close')` 原样转发 code 与 `direction:"tenant"`）。
2. **占池的是僵尸 upstream**：异常时租户容器与控制面容器的 `/proc/net/tcp` 各有**恰好 3 条** ESTABLISHED 指向 `gateway:8790`（端口一一对应），而 ws-proxy 日志显示该用户 `openSockets:0`——phone 全部已断，upstream 却全部存活。
3. **泄漏触发点（确定性，每次连接 +1）**：phone 断开码为 **1005**（对端未携带状态码——浏览器 `close()` 不带码、TCP 异常断开等极常见）时：
   - `src/services/wsProxy.ts` cleanup 把 1005 原样传给 `upstream.close(1005, reason)`（特判了 1006 走 `terminate()`，**1005 漏了**）；
   - ws 库 `Sender.close()`（node_modules/ws/lib/sender.js L184）对 `isValidStatusCode(1005)` 返回 false（validation.js 显式排除 1005/1006——RFC 保留码不得上线）**同步 throw TypeError**；
   - 该 throw 被 cleanup 循环里的空 `catch { /* already closing */ }` **静默吞掉**；
   - 结果：upstream 的 close 帧从未发出，TCP 永久 ESTABLISHED，gateway 侧 `sockets.delete`（close 事件）永不发生。
4. **实验证实确定性**：租户重启清池后，3 轮「open → 收 welcome → 主动 close」探测（约 200ms/轮，全部成功），结束后两侧 ESTABLISHED 精确回到 3 条——**正常关闭同样泄漏**，3 次连接即打满池。
   - 证据：`welcome-probe-8613900000002.jsonl`（3/3 welcome）+ 探测后双端 `/proc/net/tcp` 复查（3 条，端口号 9BA4/9BAE/9BBA 两侧一致）。

## 影响面

- 上线即触发：用户锁屏（移动端 WebView 常见无码断开）→ 泄漏 +1。MAX_CLIENT_SOCKETS=3，少数几次交互后该租户永久拒连。
- staging 时间线佐证：00:29 可用 → 之后全部 4009，与验证期间连接次数 >3 完全吻合。

## 顺带发现（UX）

前端 `src/mobile/bridge/gatewayClient.ts` L65 把 close code 4009 映射为「连接设备过多…请在其他设备上退出登录后重试」（GatewayTerminalScreens.tsx）。语义错误：4009 实际是 gateway socket 槽位耗尽（本缺陷），与登录设备数无关；按文案操作（退出设备）无法解除，用户会陷入死局。修复时建议一并改为准确文案或区分两种 code。

## 临时止血（已执行，非修复）

- `docker restart idb-t_j27nw743bl2zrgzvlvub`（清 gateway sockets）。重启后 3/3 轮探测收到 welcome（`ready:true`）。**每次池满需人工重启，不可作为方案。**

## 修复建议（供实现参考，非指令）

1. cleanup 中 `code === 1005 || code === 1006` 都走 `terminate()`（或先 normalize 保留码再 close）；空 catch 至少改为记日志——「already closing」的注释与真实失败模式不符，这类静默正是本缺陷被掩盖到验收期才暴露的原因。
2. 回归测试两条硬判据：① phone 无码断开后，upstream 必须在 1s 内关闭（无 ESTABLISHED 残留）；② 连续 ≥4 次 connect/close 后，gateway `sockets.size` 必须回到 0、第 5 次连接必须收到 welcome。
3. 顺带评估 `MAX_CLIENT_SOCKETS = 3` 对真实移动用户的合理性（断线重连风暴下的余量），以及 gateway 是否需要把 sockets 视图暴露到健康检查。

## 复现步骤（可重放）

```bash
# 在租户容器与控制面容器各数一次 ESTABLISHED（修改 PORT 视需要）：
docker exec idb-t_j27nw743bl2zrgzvlvub sh -c "awk 'NR>1 && \$4==\"01\"' /proc/net/tcp | grep -c ':2256'"
# 用不带状态码的 ws 客户端 close() 连接 4 次（探测脚本见 twin 工作目录 welcome-probe.mjs）
# 第 4 次连接将收到 close 4009 且无 welcome；两侧 ESTABLISHED 仍为 3。
```
