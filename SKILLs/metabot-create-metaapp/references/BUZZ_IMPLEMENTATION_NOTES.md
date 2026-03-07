# Buzz 列表实现说明与待确认项

## 已完成内容

- 新增命令：
  - `idframework/commands/FetchBuzzCommand.js`
  - `templates/commands/FetchBuzzCommand.js`
- 新增组件：
  - `idframework/idcomponents/id-buzz-list.js`
  - `templates/idcomponents/id-buzz-list.js`
- 新增配置：
  - `idframework/idconfig.js` 增加 `BUZZ_PATH`、`BUZZ_PAGE_SIZE`、`METAFS_USER_BY_ADDRESS_PATH`
  - `templates/idconfig.js` 同步增加以上配置
- 应用命令注册：
  - `templates/app.js` 增加 `fetchBuzz` 命令注册
- 测试页：
  - `test/index.html`，用于直接查看 `id-buzz-list` 渲染与下拉分页效果

## 架构说明

- `id-buzz-list` 只负责渲染和分页触发（`IntersectionObserver`）。
- Buzz 数据获取和用户资料补全都放在 `FetchBuzzCommand` 中，符合 IDFramework Command 业务分层。
- 用户信息缓存使用 IndexedDB：
  - DB: `idframework-buzz-user-db`
  - Store: `BuzzUser`
  - 主键：`metaId`
  - 辅助索引：`address`（用于按地址查缓存）

## 与 shownow 功能对齐情况

- 已对齐：
  - Buzz 列表分页加载
  - 通过地址获取用户 name/avatar/metaId
  - 下拉触底自动翻页
  - 翻页 loading 动画
- 未完全对齐（需要更多业务细节）：
  - `contentSummary` 中更复杂附件类型（图片/视频/加密内容）的完整渲染策略
  - 转发/引用/回复等复杂 Buzz 卡片样式与行为
  - 多语言、富文本、解密内容流程

## 待你确认的问题

- 是否需要把 `id-buzz-list` 的视觉风格进一步完全贴近 `shownow-frontend`（当前是轻量版样式）？
- `contentSummary.attachments` 是否需要在列表中直接渲染缩略图/媒体播放器，而不只显示数量？
- `quotePin` 是否要变成可点击并拉取对应 Pin 详情卡片？
- 是否需要在测试页接入 `id-connect-button`，基于登录态做更多交互联动？
