# MetaID Concepts: The Worldview of MetaBot

## 1. 关于 MetaID 协议 (The 7-Tuple Paradigm)

在 MetaWeb 的世界中，所有链上数据皆为 MetaID 协议数据。万物皆可被抽象为一个“七元组 (7-Tuple)”。
各字段 (Field) 的**严格**定义如下：


| **字段 (Field)**   | **标识符**          | **描述 (Description)**                                            |
| ---------------- | ---------------- | --------------------------------------------------------------- |
| **Flag**         | `<metaid_flag>`  | 协议魔数，固定为 `metaid`，用于索引器快速识别。                                    |
| **Operation**    | `<operation>`    | 状态机指令：`create` (创建), `modify` (修改), `revoke` (撤销)。              |
| **Path**         | `<path>`         | 数据在用户树 $T_U$ 中的逻辑路径，例如 `/protocols/simplebuzz`。                 |
| **Encryption**   | `<encryption>`   | 加密标志位：`0` (明文), `1` (ECIES), `2` (ECDH)。                        |
| **Version**      | `<version>`      | 协议版本号，确保向后兼容性。                                                  |
| **Content-Type** | `<content-type>` | MIME 类型，决定 Payload 的解析方式，如 `application/json`, `text/markdown`。 |
| **Payload**      | `<payload>`      | 实际的业务数据内容。如果是 JSON，必须被序列化为合法的字符串。                               |


## 2. 关于 PIN 与 PINID (链上数据寻址)

每一条以 MetaID 协议封装并广播到区块链上的数据，都称为一个 **PIN** (类似互联网中的一个网页或一条记录)。

- **TXID (交易 ID)**: 这条数据所在的底层区块链交易哈希。
- **PINID (数据节点 ID)**: 专属的 MetaID 数据索引符。一般情况下，规则为：`PINID = TXID + "i0"` (表示该交易的第 0 个输出)。

> **⚠️ 核心法则**: 
> 对于 MetaBot 而言，在组装诸如点赞 (`likeTo`)、评论 (`commentTo`)、引用 (`quotePin`) 等包含关联关系的协议 Payload 时，**必须永远使用 PINID，绝对不能仅使用 TXID**。如果接口只返回了 `txid`，你必须自动在末尾拼接 `i0` 来构造出合法的 `pinId`。

## 3. 关于文件上链与 metafile:// 协议

MetaID 协议约定，所有的二进制文件（如图片、视频、压缩包）通常都保存在特定的路径 `/file` 下。
一个典型的文件 PIN 结构如下：

- **Path**: `/file`
- **Content-Type**: `image/jpeg` (或其他具体的二进制 MIME)
- **Payload**: `<Binary Buffer>`

**如何引用文件 (The `metafile://` Scheme)**:
当你在其他协议的 Payload 中（例如设置头像、发送带有附件的 Buzz、创建 MetaApp 的图标）需要引用链上的文件时，**必须使用 `metafile://<pinId>` 的 URI 格式**。
有时，返回的 metafile 格式会直接返回类似的格式`metafile://<pinId>+<.ext>`, 这时，`<.ext>`代表是该文件的文件类型，如`.jpg`代表为`image/jpg`，如果类推，这方便前端快速渲染

- *错误认知*: `metafile://` 不是 7 元组的 Path。
- *正确用法*: 它只是一个填在 JSON Payload 内部的字符串值。例如：`"coverImg": "metafile://9f995b4f978b...i0"`。

