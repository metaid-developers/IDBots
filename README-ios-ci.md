# IDBots iOS 打包：GitHub 云端流水线 · 主人操作手册

> 目标：不用懂代码，也不碰本机钥匙串，让 GitHub 免费服务器替我们打包出
> 可上传 App Store Connect 的 .ipa。
> 对应流水线文件：`.github/workflows/ios-release.yml`，分支 `ci/ios-cloud-build`。

---

## 一句话原理

我们本机的签名钥匙串坏了（已折腾一整天确认不可修），所以换思路：
把「签名的两样材料」塞进 GitHub 仓库的密码保险箱（Secrets），
每次点一下按钮，GitHub 的免费 Mac 电脑就会：取仓库 → 装依赖 →
还原证书 → 打包 → 自动签名 → 产出一个 .ipa 供下载。
材料只在保险箱里贬值不出门，明文永远不会出现在仓库任何文件里。

---

## 第一步：准备 4 个值（一次性）

你只需要准备 **4 个值**。下面逐条说每个值从哪来、怎么得到。

### ① BUILD_CERTIFICATE_BASE64（分发证书的 base64）

来源是已有的分发包 p12 文件（文件名形如 `DistCert_*.p12`，存放于
本机移动端证书文件夹；原始文件不要提交进仓库、也不要发聊天群）。

在 Mac 的终端里跑这两行（把 `你的文件夹` 和 `文件名` 换成实际值）：

```bash
cd 你的证书文件夹
base64 -i 你的文件名.p12 | pbcopy
```

跑完，base64 那一大串字符已经**自动躺在剪贴板里了**（几页那么长，正常）。

> 如果你以后没有现成 p12 了：登录 [developer.apple.com](https://developer.apple.com)
> → Certificates → 下载 Distribution 证书 → 双击装进钥匙串 →
> 打开「钥匙串访问」→ 左侧选「登录」→ 分类选「我的证书」→
> 右键证书「导出…」，格式选 .p12，设一个密码 → 再用上面的 base64 命令。

### ② P12_PASSWORD（导出证书时设的密码）

就是导出/打开这个 p12 时设的密码。它记录在本机与证书同目录的
`DistCertCredentials_*.md` 说明文件里，打开照抄即可。

### ③ PROVISIONING_PROFILE_BASE64（描述文件的 base64）

来源文件：`idbots-appstore.mobileprovision`
（名称为「IDBots App Store (com.idbots.world)」，有效期到 2026-12-09）。

终端里跑：

```bash
base64 -i 你的描述文件路径.mobileprovision | pbcopy
```

同样已复制到剪贴板。就用现在这个文件即可，无需自己重新生成新的证书或描述文件。

> 以后如果描述文件过期了：登录 developer.apple.com → Certificates/Profiles →
> Provisioning Profiles → 重新下载同名文件 → 重复上一条命令 → 更新对应 Secret。

### ④ KEYCHAIN_PASSWORD（临时钥匙串密码）

这个不需要你去任何地方找——是我们给 GitHub 那台「临时钥匙串」自定的密码。
**随手定一个好记的任意字符串即可**，例如 `Idbots-Cloud-99`。
没有别的用处，只在流水线内部用。

---

## 第二步：把 4 个值填进 GitHub Secrets（5 分钟，一处一处来）

打开 GitHub 仓库页面：https://github.com/WuFenG-Hu/IDBots

1. 点仓库右上角 **Settings**
2. 左侧栏最底下，点 **Secrets and variables** → **Actions**（不是 Variables）
3. 点绿色按钮 **New repository secret**，逐个填 4 次：

| 逐条填法 | 变量写这里（精确照抄） | 值来源 |
| --- | --- | --- |
| 第 1 次填 | `BUILD_CERTIFICATE_BASE64` | 第一步① 的剪贴板直接 ⌘V |
| 第 2 次填 | `P12_PASSWORD` | 第一步② 那个密码 |
| 第 3 次填 | `PROVISIONING_PROFILE_BASE64` | 第一步③ 的剪贴板直接 ⌘V |
| 第 4 次填 | `KEYCHAIN_PASSWORD` | 第一步④ 定的字符串 |

每一行的填写方法都一样：
Name 栏**逐字符**照抄上表变量（区分大小写，前后不能有空格），
Secret 栏粘贴对应的值，点 **Add secret**。共 4 条，
填完页面上会出现这 4 个名字。

⚠️ 高度注意：
- Name 中不能多空格也不能少下划线，否则找到位置时流水线会报
  "environment variable not found"。
- 填错了想改？点该条目右侧修改按钮即可，随时可改。
- Secret 一旦保存就看不见内容（只能改不能看），这是正常的安全设计。

---

## 第三步：触发一次构建（30 秒）

1. 打开 https://github.com/WuFenG-Hu/IDBots/actions
2. 左侧列表点 **iOS Release (cloud-signed)**
3. 点右侧灰色按钮 **Run workflow**
4. 弹出框里：
   - **Use workflow from**：选分支 `ci/ios-cloud-build`（等以后这条分支合进
     main 后，选 main）
   - **Marketing version**：填本次版本号，比如 `1.0.0`
5. 点绿色 **Run workflow**

从此时到出结果大约 **20–40 分钟**（免费服务器要装整整一遍 Xcode 环境）。
进度可以点进那条正在转圈的任务看实时日志。

---

## 第四步：下载 .ipa

构建成功（绿色勾）后：

1. 点进那次运行
2. 页面**底部**有一个 **Artifacts** 区域
3. 点 **`IDBots-ios-ipa-run-<编号>`** 下载并解压，里面：
   - `IDBots-a<编号>.ipa` —— 这就是可上传 App Store Connect 的成品
   - `SHA256SUMS.txt` —— 校验文件
   - `Info.plist` —— 版本号回执（用于核对 version 是否生效）

拿到 .ipa 后走既有的 App Store Connect 上传渠道（Xcode 或 Transporter 拖入，
或 `altool` 命令行）变成提交审核。

**失败了呢？** 页面出现红色 ✕ 时点进运行日志找第一个红色的步骤名
（通常是 secret 名字打错或密码不对），把那个截图发我就行。

---

## 常见失败速查

| 现象 | 十之八九的原因 | 怎么办 |
| --- | --- | --- |
| 找不到 secret 报错 | Name 有空格/拼写错 | 回第二步核对 |
| "no matching provisioning profile" | 描述文件过期或换成新的没更新 | 重新下载并更新 Secret ③ |
| "no signing certificate for ... " | 密码（Secret ②）不对、或 base64 少了尾巴 | 检查②，重跑①命令 |
| 跑到一半超时 | 少见，服务器偶发拥堵 | 重新 Run 一次 |

---

## 附：隐私与安全

- 4 个值全部保存在 GitHub 加密 Secret 里，**仓库里任何提交都不会出现明文值**
  ——流水线代码只引用名字。
- Secret 内容一旦提交，谁也无法再查看（包括我），只能替换。
- 证书/描述文件的原始文件与密码文件**不要**另发到群聊或聊天记录里。

---

*维护：这条流水线由 `ci/ios-cloud-build` 分支提交， merge 到 main 前只在
`Run workflow` 时手动触发，不会自动打包，不会误发版本。*
