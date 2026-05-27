---
name: metabot-create-wiki
description: 问答式创建一对一的本地 Wiki 技能。Use when the user wants to turn a specific raw documents directory into a dedicated skill with its own name, description, absorb/index/query, HTML wiki build, and ZIP-first publish workflow, or when updating a dedicated wiki skill after the source docs change.
---

# metabot-create-wiki

把一个固定的资料目录变成一个专属 Wiki 技能。

## 你要做的事

1. 先问清楚必要信息，再动手创建。
2. 默认一次只问一个问题，别猜路径、别脑补描述。
3. 收集齐后，创建一个新的 skill 目录到当前 `SKILLS_ROOT`。
4. 让新 skill 具备和 `metabot-llm-wiki` 相同的核心能力：
   - 吸收/索引 `raw` 资料
   - 支持 `pdf`、`docx`、`md`、`txt`、`csv`、`json`
   - raw 更新后可重新吸收、重新索引
   - 生成本地 HTML wiki
   - ZIP-first 发布与快照发布
5. 新 skill 要是“一对一”的：名字、描述、资料源都要专属。

## 先收集这些信息

按这个顺序问：

1. `skillName`
2. `rawSourceDir`
3. `title` 或对外展示名
4. `description`
5. `aliases`（如果有）
6. `workspaceRoot` / `registryHome`（可选，默认放在新 skill 自己目录下）
7. `siteTitle`（可选）

如果用户没给全，继续追问，不要默认补值，除非是很明确的安全默认。

## 生成方式

收集完成后，调用：

```bash
node "$SKILLS_ROOT/metabot-create-wiki/scripts/scaffold-wiki-skill.js" --payload '<JSON>'
```

payload 至少包含：

```json
{
  "skillName": "metaid-wiki",
  "title": "MetaID Wiki",
  "description": "面向 MetaID 资料的一对一本地 Wiki 技能。",
  "rawSourceDir": "/absolute/path/to/raw"
}
```

## 生成结果

新 skill 目录里至少要有：

- `SKILL.md`
- `wiki.config.json`
- `scripts/index.js`
- `references/payload-schema-v1.json`

其中 `scripts/index.js` 要自动把 `rawSourceDir` 镜像到内部工作区，再调用 `metabot-llm-wiki` 的现有运行时完成 `init`、`absorb`、`query`、`wiki_build`、`publish_all` 等动作。

## 运行约定

- 新 skill 默认使用自己的私有 registry。
- raw 目录更新后，重新跑 `absorb` 就行。
- 日常 `query` 默认不复制 raw、不重建索引，会使用本地 persistent lexical/vector/hybrid 索引快速查询。
- 用户把新资料放进 `rawSourceDir` 后，先运行 `absorb` 刷新索引，再运行 `query`。
- 如果用户明确要求“边更新边查”，`query` 可传 `autoAbsorb:true` 或 `refresh:true`。
- `wiki_build`、`publish_*` 应该在需要时先刷新 raw，再用最新数据工作。
- 默认检索后端是 `hybrid`：组合本地 lexical 索引、向量索引与短语加权；可按需改成 `portable`、`sqlite-fts`、`vector` 或 `scan`。
- 如果 PDF/DOCX 解析依赖缺失，保留和 `metabot-llm-wiki` 一样的提示。

## 结束时

把新 skill 的绝对路径、它绑定的 raw 目录、以及它能直接执行的动作列表告诉用户。
