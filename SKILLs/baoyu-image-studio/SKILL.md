---
name: baoyu-image-studio
description: 为 IDBots 提供统一的图片生成工作室。支持 generate、cover、infographic、comic 四种模式，输出本地图片文件，便于后续上链或二次分发。
official: true
---

# Baoyu Image Studio

使用这个技能统一处理图片创作需求。它会根据用户意图选择合适的工作模式，组织 prompt、风格和尺寸参数，并把结果保存为本地图片文件。

## Supported Modes

- `generate`: 通用文生图、参考图改图、风格化创作
- `cover`: 文章封面、海报、头图
- `infographic`: 单张知识卡片、信息图、图文卡
- `comic`: 漫画风配图、轻量分镜、故事图

## Provider Strategy

- 优先复用当前 MetaBot 对应的图片 provider
- 若当前 MetaBot 不支持，则自动回退到已配置的 bridge provider
- 若 bridge provider 也不可用，则尝试环境变量 provider
- 若仍不可用，应明确告知当前 LLM 不支持该技能，并提示补充支持的 provider 凭证

## Output Contract

- 输出目标是本地图片文件，不负责 Web2 发布
- 生成结果需要返回最终文件路径、所选 provider、工作模式和关键参数摘要
- 当用户没有显式指定模式时，应根据请求自动选择最合适的模式

## Script Entry

- 主执行入口：`scripts/index.js`
- 直接调用时使用 `--payload` 传入 JSON，例如：

```bash
node "$SKILLS_ROOT/baoyu-image-studio/scripts/index.js" --payload '{
  "mode": "cover",
  "title": "Orange Space Cat",
  "prompt": "An orange cat floating in space, cinematic poster style"
}'
```

- 主进程会在可用时注入 `BAOYU_IMAGE_PROVIDER` 和对应 provider 凭证环境变量

## Routing Guidance

- 用户说“生成图片”“做图”“画封面”“做信息图”“做漫画图”时优先使用本技能
- 若用户只给主题和风格，自动推断模式并补齐缺省参数
- 若用户已经给了明确模式，严格按该模式执行
