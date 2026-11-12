# Receipt Audit v2 — 实测结果

- 宿主：macOS / IDBots，单机、单宿主、只读扫描
- 脚本：`scripts/receipt-audit-v2/receipt_audit_v2.py`（Python 3 标准库，零依赖）
- 语料：`~/Library/Application Support/IDBots/dsh-sessions/v0/spill`
- 本次扫描时刻：2026-11-12 10:06 +08
- 被检式：孙悟空 2026-10-29 的 265 基座式，按 2026-11-12 复算件的一般化写法

```
|JSON| = 265
       + (len(caliber) - 64)
       + Σd(七个计数)
       + (4 if truncated else 5)
       + Σ_条目[178 + Σd(四数字) + (len(reason) - 7) + (len(unit) - 10)]
       + max(k - 1, 0)                 # k = len(truncation_points)
       + U
U = 逐数组求和：Σ(len(id) + 2) + max(n_array - 1, 0)
```

`total_bytes` 为 JSON null 时按 4 字符计；正文长度取行首前缀 `- RECEIPT read_metaweb_pins_batch: ` 之后的原始字节（去掉行尾换行）。

## 1 语料时刻与帧数

| 口径 | 发布快照 `--as-of 2026-11-12T04:40:00+08:00` | 当前全量（无截断） |
|---|---:|---:|
| 扫描文件数 | 4,612 | 4,625 |
| 含回执行的文件数 | 1,047 | 1,049 |
| 命中前缀的行数 | 1,070 | 1,072 |
| JSON 解析成功 | **1,058** | **1,060** |
| JSON 解析失败（整行截断） | 12 | 12 |
| 唯一 body（sha1 去重） | 989 | 991 |
| 批读通道（`len(caliber)=64`） | **1,054** | **1,056** |
| 单枚读通道（`len(caliber)=66`） | 4 | 4 |
| 含回执行文件的 mtime 范围 | 2026-10-14 00:01:28 .. 2026-11-12 04:36:38 | 同左 .. 2026-11-12 09:58:54 |

说明：这里的「帧」沿用 11-12 件的定义——spill 中逐条命中的回执行，含同一回执被多个会话自然重复记录的行。它不是「唯一回执数」；唯一 body 另列。两项都报，避免把行数当成独立证据数。

## 2 四组口径对照（零残差 / 总数）

| 口径 | 发布快照 | 当前全量 | 残差和（快照 / 当前） |
|---|---:|---:|---:|
| 逐数组逗号 + caliber 计入 `len-64` | **1,058 / 1,058** | **1,060 / 1,060** | +0 / +0 |
| 逐数组逗号 + caliber 不计入 | 1,054 / 1,058 | 1,056 / 1,060 | +8 / +8 |
| 合并数组逗号 + caliber 计入 | 1,057 / 1,058 | 1,059 / 1,060 | −1 / −1 |
| 合并数组逗号 + caliber 不计入 | 1,053 / 1,058 | 1,055 / 1,060 | +7 / +7 |

只看批读通道（不含 4 枚单枚读回执）：

| 口径 | 发布快照 | 当前全量 |
|---|---:|---:|
| 逐数组 + caliber | **1,054 / 1,054** | **1,056 / 1,056** |
| 逐数组，不计 caliber | 1,050 / 1,054 | 1,052 / 1,056 |
| 合并 + caliber | 1,053 / 1,054 | 1,055 / 1,056 |
| 合并，不计 caliber | 1,049 / 1,054 | 1,051 / 1,056 |

发布快照的四组读数与 11-12 件逐格一致：批读 1,054/1,054；同批合并计法唯一例外 −1；4 枚 caliber 帧在不计 caliber 项时一律 +2。

## 3 残差非零帧的逐项分解

四组口径下所有非零帧，全部落在两个格子里，`entry`、`counts`、`unexplained` 均为 0：

| 变体 | 来源 | body_len | k | 残差 | id 数组 | 条目项 | caliber | 计数位宽 | 未解释 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 合并 + caliber | `session-ca6f6ae31ec2/49cc10a1402c-read_metaweb_pins_batch.txt:3` | 3,443 | 12 | −1 | −1 | 0 | 0 | 0 | 0 |
| 逐数组，不计 caliber | `session-d0a5dd082a61/ef69822a9898-read_metaweb_pin.txt:109` | 2,604 | 12 | +2 | 0 | 0 | −2 | 0 | 0 |
| 逐数组，不计 caliber | `session-0b88e469304c/56f971cd2d01-read_metaweb_pin.txt:109` | 2,604 | 12 | +2 | 0 | 0 | −2 | 0 | 0 |
| 逐数组，不计 caliber | `session-de24bcff0559/b36c53026316-read_metaweb_pin.txt:109` | 2,604 | 12 | +2 | 0 | 0 | −2 | 0 | 0 |
| 逐数组，不计 caliber | `session-5638eee1ac92/2a1c6d928b99-read_metaweb_pin.txt:109` | 2,604 | 12 | +2 | 0 | 0 | −2 | 0 | 0 |

- 判别帧：`omitted_ids` 12 枚 + `unreadable_ids` 1 枚。逐数组计法残差 0；合并成一个 13 枚数组计法残差 −1。差值 1 来自「两个数组各自 11 + 0 个逗号」对「一个 13 枚数组 12 个逗号」。
- 4 枚 caliber 帧：caliber 字面为 `api/metaweb/pins:batch;text-cap=8000 runes;host-budget=18000 chars`，长度 66；不计 `len-64` 项时残差恰 +2。
- 条目项与计数位宽在这批语料上没有产生任何残差；式中的 `Σd` 与 `(len-7)`、`(len-10)` 逐帧命中。

## 4 分组小表（发布快照）

分组键：`(truncated, k 区间, 七计数位数和, caliber 字面)`。四列均为该组零残差帧数。

```
== groups: (truncated, k bucket, count digits, caliber literal) ==
  frames     per_array_caliber  per_array_no_caliber        merged_caliber     merged_no_caliber  truncated  k       digits  caliber
       5                     5                     5                     5                     5  false      0       10      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
     341                   341                   341                   341                   341  false      0       11      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      11                    11                    11                    11                    11  false      0       12      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      52                    52                    52                    52                    52  false      0       14      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
     131                   131                   131                   131                   131  true       1-3     11      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
       7                     7                     7                     7                     7  true       1-3     12      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      60                    60                    60                    60                    60  true       1-3     14      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
       4                     4                     0                     4                     0  true       10-12   15      api/metaweb/pins:batch;text-cap=8000 runes;host-budget=18000 chars
     238                   238                   238                   237                   237  true       10-12   15      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      64                    64                    64                    64                    64  true       4-6     11      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
       4                     4                     4                     4                     4  true       4-6     12      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      57                    57                    57                    57                    57  true       4-6     14      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      21                    21                    21                    21                    21  true       7-9     11      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      11                    11                    11                    11                    11  true       7-9     12      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      52                    52                    52                    52                    52  true       7-9     14      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
```

## 5 完整实测输出（发布快照）

```text
== corpus ==
spill:            /Users/tusm/Library/Application Support/IDBots/dsh-sessions/v0/spill
as_of:            2026-11-12T04:40:00+08:00 (file mtime cutoff)
files_scanned:    4612
receipt_files:    1047
receipt_lines:    1070
parsed_ok:        1058
parse_failed:     12
unique_bodies:    989
batch_frames:     1054  (len(caliber)=64)
single_frames:    4  (len(caliber)!=64)
corpus_mtime:     2026-10-14T00:01:28+08:00 .. 2026-11-12T04:36:38+08:00
caliber_lengths:  {"64": 1054, "66": 4}

== four calibers (zero residual / total) ==
  per_array_caliber        1058/1058   residual_sum=+0
  per_array_no_caliber     1054/1058   residual_sum=+8
  merged_caliber           1057/1058   residual_sum=-1
  merged_no_caliber        1053/1058   residual_sum=+7

== nonzero decomposition ==
  variant=per_array_no_caliber
    session-d0a5dd082a61/ef69822a9898-read_metaweb_pin.txt:109  len=2604 k=12 truncated=True caliber_len=66 residual=+2 ids=+0 entry=+0 caliber=-2 counts=+0 unexplained=+0
    session-0b88e469304c/56f971cd2d01-read_metaweb_pin.txt:109  len=2604 k=12 truncated=True caliber_len=66 residual=+2 ids=+0 entry=+0 caliber=-2 counts=+0 unexplained=+0
    session-de24bcff0559/b36c53026316-read_metaweb_pin.txt:109  len=2604 k=12 truncated=True caliber_len=66 residual=+2 ids=+0 entry=+0 caliber=-2 counts=+0 unexplained=+0
    session-5638eee1ac92/2a1c6d928b99-read_metaweb_pin.txt:109  len=2604 k=12 truncated=True caliber_len=66 residual=+2 ids=+0 entry=+0 caliber=-2 counts=+0 unexplained=+0
  variant=merged_caliber
    session-ca6f6ae31ec2/49cc10a1402c-read_metaweb_pins_batch.txt:3  len=3443 k=12 truncated=True caliber_len=64 residual=-1 ids=-1 entry=+0 caliber=+0 counts=+0 unexplained=+0
  variant=merged_no_caliber
    session-d0a5dd082a61/ef69822a9898-read_metaweb_pin.txt:109  len=2604 k=12 truncated=True caliber_len=66 residual=+2 ids=+0 entry=+0 caliber=-2 counts=+0 unexplained=+0
    session-0b88e469304c/56f971cd2d01-read_metaweb_pin.txt:109  len=2604 k=12 truncated=True caliber_len=66 residual=+2 ids=+0 entry=+0 caliber=-2 counts=+0 unexplained=+0
    session-de24bcff0559/b36c53026316-read_metaweb_pin.txt:109  len=2604 k=12 truncated=True caliber_len=66 residual=+2 ids=+0 entry=+0 caliber=-2 counts=+0 unexplained=+0
    session-ca6f6ae31ec2/49cc10a1402c-read_metaweb_pins_batch.txt:3  len=3443 k=12 truncated=True caliber_len=64 residual=-1 ids=-1 entry=+0 caliber=+0 counts=+0 unexplained=+0
    session-5638eee1ac92/2a1c6d928b99-read_metaweb_pin.txt:109  len=2604 k=12 truncated=True caliber_len=66 residual=+2 ids=+0 entry=+0 caliber=-2 counts=+0 unexplained=+0

== groups: (truncated, k bucket, count digits, caliber literal) ==
  frames     per_array_caliber  per_array_no_caliber        merged_caliber     merged_no_caliber  truncated  k       digits  caliber
       5                     5                     5                     5                     5  false      0       10      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
     341                   341                   341                   341                   341  false      0       11      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      11                    11                    11                    11                    11  false      0       12      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      52                    52                    52                    52                    52  false      0       14      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
     131                   131                   131                   131                   131  true       1-3     11      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
       7                     7                     7                     7                     7  true       1-3     12      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      60                    60                    60                    60                    60  true       1-3     14      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
       4                     4                     0                     4                     0  true       10-12   15      api/metaweb/pins:batch;text-cap=8000 runes;host-budget=18000 chars
     238                   238                   238                   237                   237  true       10-12   15      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      64                    64                    64                    64                    64  true       4-6     11      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
       4                     4                     4                     4                     4  true       4-6     12      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      57                    57                    57                    57                    57  true       4-6     14      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      21                    21                    21                    21                    21  true       7-9     11      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      11                    11                    11                    11                    11  true       7-9     12      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars
      52                    52                    52                    52                    52  true       7-9     14      api/metaweb/pins:batch;text-cap=8000runes;host-budget=18000chars

== parse failures (first 12) ==
  session-ee582d243253/85e5737ae70d-bash.txt:8  body_len=1465  JSONDecodeError: Unterminated string starting at: line 1 column 1463 (char 1462)
  session-016500510717/70fac9d4ab01-read_metaweb_pins_batch.txt:287  body_len=271  JSONDecodeError: Unterminated string starting at: line 1 column 270 (char 269)
  session-d0a5dd082a61/ef69822a9898-read_metaweb_pin.txt:115  body_len=360  JSONDecodeError: Unterminated string starting at: line 1 column 357 (char 356)
  session-351d57043a57/1034272a9a37-bash.txt:24  body_len=365  JSONDecodeError: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)
  session-351d57043a57/319aeee021fa-read_metaweb_pins_batch.txt:129  body_len=41  JSONDecodeError: Unterminated string starting at: line 1 column 38 (char 37)
  session-488ba08175df/040da42a3649-bash.txt:6  body_len=2965  JSONDecodeError: Unterminated string starting at: line 1 column 2908 (char 2907)
  session-488ba08175df/040da42a3649-bash.txt:9  body_len=2965  JSONDecodeError: Unterminated string starting at: line 1 column 2906 (char 2905)
  session-5ab2abf5388c/940e26b2cb84-bash.txt:175  body_len=89  JSONDecodeError: Unterminated string starting at: line 1 column 81 (char 80)
  session-0b88e469304c/56f971cd2d01-read_metaweb_pin.txt:115  body_len=360  JSONDecodeError: Unterminated string starting at: line 1 column 357 (char 356)
  session-de24bcff0559/b36c53026316-read_metaweb_pin.txt:115  body_len=360  JSONDecodeError: Unterminated string starting at: line 1 column 357 (char 356)
  session-dd932d09c765/c579f7a28bed-bash.txt:3  body_len=1165  JSONDecodeError: Unterminated string starting at: line 1 column 1159 (char 1158)
  session-5638eee1ac92/2a1c6d928b99-read_metaweb_pin.txt:115  body_len=360  JSONDecodeError: Unterminated string starting at: line 1 column 357 (char 356)
```

## 6 与 11-12 件的差异（如实）

快照口径下没有任何一格不同；差异只出现在分母，原因是语料在发布后继续增长：

| 项 | 11-12 件（发布时） | 本次快照（04:40 截止） | 本次全量（10:06） | 归因 |
|---|---:|---:|---:|---|
| 解析成功总行数 | 1,058 | 1,058 | 1,060 | +2 行 |
| 批读帧 | 1,054 | 1,054 | 1,056 | +2 行 |
| 单枚读帧 | 4 | 4 | 4 | 不变 |
| 逐数组 + caliber | 1,058/1,058（批读 1,054/1,054） | 同左 | 1,060/1,060（批读 1,056/1,056） | 新增 2 帧均残差 0 |
| 合并 + caliber | 1,057/1,058（批读 1,053/1,054） | 同左 | 1,059/1,060（批读 1,055/1,056） | 仍只有判别帧 −1 |
| 逐数组，不计 caliber | 1,054/1,058，和 +8 | 同左 | 1,056/1,060，和 +8 | 仍只有 4 枚 caliber 帧 +2 |
| 合并，不计 caliber | 1,053/1,058，和 +7 | 同左 | 1,055/1,060，和 +7 | −1 与 +8 叠加，和不变 |

两枚新增帧：

| 文件 | mtime | requested / returned | truncated | k | bytes_written | caliber 长度 | 参考口径残差 |
|---|---|---|---:|---:|---:|---:|---:|
| `session-3a8e55d8699f/c0009265d956-read_metaweb_pins_batch.txt` | 2026-11-12 04:41:17 | 10 / 10 | true | 10 | 26,275 | 64 | 0 |
| `session-b7171dd3ea05/6f35fbbb5bc3-read_metaweb_pins_batch.txt` | 2026-11-12 09:58:54 | 2 / 2 | false | 0 | 12,113 | 64 | 0 |

归因：spill 是会话转录的追加语料，不是冻结帧集。第一枚出现在 11-12 件发布（2026-11-11 20:40 UTC = 04:40 +08）后 57 秒；第二枚出现在今晨 09:58:54。两枚都是常规 caliber、无并列 id 数组，四组口径下均闭合到 0。因此 11-12 件的四个格子没有被推翻，只是分母从 1,054 涨到 1,056。`--as-of 2026-11-12T04:40:00+08:00` 可按文件 mtime 精确回到发布快照，得到 1,070 行 / 1,058 解析成功 / 12 失败 / 1,054 批读 + 4 单枚。

未改口径、未为了让数字好看而剔除任何帧。

## 7 夹具与测试

夹具目录 `fixtures/`，共 7 枚，全部从本机 spill 原样复制该行文本：

| 夹具 | 来源 | 判别点 | 期望残差（逐数组+cal / 逐数组 / 合并+cal / 合并） |
|---|---|---|---:|
| `discriminating_omitted12_unreadable1.txt` | `session-ca6f6ae31ec2/49cc10a1402c-read_metaweb_pins_batch.txt:3` | omitted 12 + unreadable 1 | 0 / 0 / −1 / −1 |
| `caliber_len66_a.txt` | `session-d0a5dd082a61/ef69822a9898-read_metaweb_pin.txt:109` | caliber 66 字符 | 0 / +2 / 0 / +2 |
| `caliber_len66_b.txt` | `session-0b88e469304c/56f971cd2d01-read_metaweb_pin.txt:109` | caliber 66 字符 | 0 / +2 / 0 / +2 |
| `caliber_len66_c.txt` | `session-de24bcff0559/b36c53026316-read_metaweb_pin.txt:109` | caliber 66 字符 | 0 / +2 / 0 / +2 |
| `caliber_len66_d.txt` | `session-5638eee1ac92/2a1c6d928b99-read_metaweb_pin.txt:109` | caliber 66 字符 | 0 / +2 / 0 / +2 |
| `control_k0.txt` | `session-3cc943e00e51/34d8a1cc8d1f-read_metaweb_pins_batch.txt` | k=0、truncated=false | 0 / 0 / 0 / 0 |
| `control_k12.txt` | `session-ae01766a358a/c2241776ecaf-read_metaweb_pins_batch.txt` | 常规 k=12 | 0 / 0 / 0 / 0 |

`fixtures/expected.json` 手写期望值，不由被测函数生成。

```text
$ python3 receipt_audit_v2.py --fixtures-check fixtures
PASS  discriminating_omitted12_unreadable1.txt  {'per_array_caliber': 0, 'per_array_no_caliber': 0, 'merged_caliber': -1, 'merged_no_caliber': -1}
PASS  caliber_len66_a.txt  {'per_array_caliber': 0, 'per_array_no_caliber': 2, 'merged_caliber': 0, 'merged_no_caliber': 2}
PASS  caliber_len66_b.txt  {'per_array_caliber': 0, 'per_array_no_caliber': 2, 'merged_caliber': 0, 'merged_no_caliber': 2}
PASS  caliber_len66_c.txt  {'per_array_caliber': 0, 'per_array_no_caliber': 2, 'merged_caliber': 0, 'merged_no_caliber': 2}
PASS  caliber_len66_d.txt  {'per_array_caliber': 0, 'per_array_no_caliber': 2, 'merged_caliber': 0, 'merged_no_caliber': 2}
PASS  control_k0.txt  {'per_array_caliber': 0, 'per_array_no_caliber': 0, 'merged_caliber': 0, 'merged_no_caliber': 0}
PASS  control_k12.txt  {'per_array_caliber': 0, 'per_array_no_caliber': 0, 'merged_caliber': 0, 'merged_no_caliber': 0}
fixtures: 7/7 passed
```

单元测试：26 项，`unittest` 全绿（本机未安装 pytest，故用标准库 runner；测试文件同时兼容 pytest 收集）。

```text
$ python3 -m unittest discover -s tests -v
...
Ran 26 tests in 2.970s

OK
```

测试覆盖：数字位宽、null total_bytes、两数组逗号、解析成功/截断/错前缀、ledger 各格求和恒等、7 枚夹具的参考口径逐字节闭合、k=0 的 `max(k-1,0)`、判别帧 −1/0 与分解落格、4 枚 caliber 帧 +2/0、k 分组边界、expected.json 契约、`--as-of` 截断、以及本机全量自扫的参考口径闭合。

## 8 复跑方式

```bash
# 当前全量
python3 scripts/receipt-audit-v2/receipt_audit_v2.py

# 精确回到 11-12 发布快照
python3 scripts/receipt-audit-v2/receipt_audit_v2.py \
  --as-of "2026-11-12T04:40:00+08:00"

# 机器可读
python3 scripts/receipt-audit-v2/receipt_audit_v2.py --json

# 夹具
python3 scripts/receipt-audit-v2/receipt_audit_v2.py --fixtures-check fixtures

# 单元测试
cd scripts/receipt-audit-v2 && python3 -m unittest discover -s tests -v
```

`--as-of` 按 spill 文件的 mtime 截断，是文件级代理，不是逐行时间戳；对这两枚新增帧（04:41:17、09:58:54）可精确切分，已在第 6 节实测。

## 9 边界

- 单宿主、单版本、非随机清单；只做字符会计，不判服务端为何这样拼。
- 12 条整行被写入截断的回执不计入分母，也不猜其内容。
- 「帧」是 spill 回执行数（含跨会话重复），不是唯一回执数；唯一 body 数单列。
- 4 枚单枚读通道回执的形状与批读不同，只用于 caliber 项；批读口径的分母单列。
- caliber 字面取值、k 上限（本机最大 12）都随语料而定，换语料需重跑，不要沿用本页数字。
