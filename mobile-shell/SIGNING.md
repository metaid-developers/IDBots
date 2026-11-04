# IDBots Android 生产签名（Signing Identity）

> 本文件记录 Android 正式发布签名身份与构建方式。密钥本体与密码**永不进 git 仓库**。

## 生产签名密钥（正式身份）

| 项 | 值 |
|---|---|
| 归档位置（权威） | `/Users/tusm/idbots/keys/idbots-release/` |
| keystore 文件 | `idbots-release.keystore`（PKCS12，600 权限） |
| 密码文件 | `idbots-release.password`（600 权限，**不进 git/链上/任何消息正文**） |
| 配置文件 | `signing.properties`（storeFile/storeType/keyAlias，无密码） |
| alias | `idbots-rc`（历史沿用自 RC 期，改名不改变证书身份，保持不动） |
| 证书 SHA-256 指纹 | `6ca798b84fe4cfb6a66c260a863d734f741491932b45ec65965f424308e4168f` |
| 证书 SHA-1 指纹 | `f7a1fac3b3b17fc6d043613212d099d5a9bc0816` |
| 主体 DN | `CN=IDBots Release RC, OU=IDBots Mobile, O=IDBots, L=Hong Kong, ST=Hong Kong, C=HK` |
| 算法/有效期 | RSA 2048，有效期至 2054-03-18 |
| keystore sha256 | `a43d01499347eee03d6b2a15a3ac3277ef8928c18f71c1f32b81bdee29ec3e6b` |

## 来历（为什么 DN 里有 "RC"）

- 2026-10-31：为验证分发生成 RC 签名密钥，同日经模拟器安装→登录→收回复端到端验证（v2 签名方案，apksigner verify 通过）。
- 2026-11-02：owner 拍板方案 A（团队自管），该密钥**直接转正**为生产签名密钥——证书指纹即官方签名身份，内部已装 RC 签名包的设备可无缝升级（同指纹覆盖安装）。DN 中的 "RC" 字样不改变证书身份，保留不改（重发证书无收益且有换签成本）。

## 正式版 APK 构建命令（production flavor）

```bash
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/mobile-shell
node scripts/select-flavor.mjs production
node node_modules/@capacitor/cli/bin/capacitor sync android
cd android && \
  JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
  ./gradlew -I <prod-signing-init.gradle 绝对路径> assembleProductionRelease
# 产物: app/build/outputs/apk/production/release/app-production-release.apk
# 验签: $ANDROID_SDK/build-tools/36.0.0/apksigner verify --print-certs <apk>
#   （apksigner 亦需 JAVA_HOME 指向 openjdk@21）

# 注意: 构建后 capacitor.config.json 会指向 production，提交/切回日常开发前
# git checkout -- capacitor.config.json 还原为默认 staging。
```

签名注入用独立 gradle init-script（密钥与密码路径全在仓库外，仓库零改动），当前版本：
`/Users/tusm/idbots/project/bots/15/2026-11-02/prod-signing/prod-signing-init.gradle`（读取上述归档位置）。

## Owner 备份提醒

以下**两个文件**需要 owner 冷备一份到私人存储（丢失则无法再对已发布设备出升级包）：
1. `/Users/tusm/idbots/keys/idbots-release/idbots-release.keystore`
2. `/Users/tusm/idbots/keys/idbots-release/idbots-release.password`
