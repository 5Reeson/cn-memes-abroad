# cn-memes-abroad

让中文互联网的表情包跟着留子们一起出海 - 支持从微信提取、整理并转换表情包，迁移到 WhatsApp 及更多聊天平台的开源桌面端应用

Helping Chinese memes travel abroad with their people - an open-source desktop app for extracting, organizing, converting, and moving stickers from WeChat to WhatsApp and beyond.

## 当前状态

- Phase 0：WhatsApp 原生 sticker pack 技术验证已通过。
- Phase 1：Electron + React + TypeScript、安全 IPC、本地 manifest 原子读写。
- Phase 2：本地图片/目录导入、复制、去重、预览、多选和拖拽排序。
- Phase 3：静态/动态分包预览、合规 WebP 转换、tray icon、缓存和发送前校验。
- Phase 4：桌面端 WhatsApp QR/配对登录、加密 session、按需群聊选择和逐包发送。
- Phase 5：arm64 DMG/ZIP 与 x64 Beta 实验构建已通过内部验证；当前产物尚未签名或公证。
- Phase 6：微信 3.x `fav.archive` Legacy Beta 适配器已通过真实账号手工验收。
- Phase 7：微信 4.x Gate A–G 已完成。两个真实账号分别通过扫码取得候选并完成
  HMAC/schema/quick_check；真实产品已验证本地缓存、CDN/AES 回退、账号隔离安全缓存、跨账号
  去重和微信到 WhatsApp 的最小完整链路。详见 `PHASE7_REPORT.md`。
- Phase 8：四步导出流程、独立素材库、共享挑选器、来源筛选、拖拽/框选、单图预览、分包预览、
  WhatsApp 两种凭证模式和“关于与安全”页面已完成；正式发布前仍需使用最终候选包完成手工回归。

## 系统要求

- macOS 13 Ventura 或更高版本。
- Apple Silicon 为主要支持架构；Intel 构建已在 2017 MacBook Pro + macOS Ventura 上完成真实流程验证，首发仍标记为 Beta。
- 安装后的 App 已包含 Electron、Node.js 运行时和所需原生依赖，普通用户不需要另外安装 Node.js。
- 当前实验包未使用 Developer ID 签名或 Apple 公证，仅供内部测试；公开下载前需明确提供 Gatekeeper 安装说明。

### 打开未签名的内部测试包

只从本项目的 GitHub Releases 或维护者直接提供的可信链接下载安装包。将 App 拖入“应用程序”后，
先尝试打开一次；如果 macOS 阻止启动：

1. 打开“系统设置” → “隐私与安全性”。
2. 滚动到“安全性”，找到刚刚被阻止的 CN Memes Abroad。
3. 点击“仍要打开”，在再次出现的确认框中选择“打开”。

这个例外只针对当前 App。不要关闭系统 Gatekeeper，也不要执行来源不明、要求移除整个系统安全
限制的脚本。如果系统提示 App 包已被修改、包含恶意内容或证书已撤销，请停止运行并重新核对下载
来源与校验值。

## 本地开发

源码开发要求 Node.js 20.9 或更高版本。

```bash
npm install
npm run dev
```

如果 Electron 二进制因网络原因没有在安装时下载，可重试：

```bash
node node_modules/electron/install.js
```

常用检查：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

实验 macOS 打包：

```bash
npm run package:mac:arm64
npm run package:mac:x64
```

产物写入 `dist/`。x64 构建脚本会在 Apple Silicon 主机上临时切换 Sharp 的架构相关包，
并在构建结束后恢复宿主机的 arm64 依赖。Phase 5 产物明确不签名、不公证，仅供内部验证。

Phase 0 CLI 仍可独立运行：

```bash
npm run phase0
```

Phase 6 Legacy 只读诊断入口：

```bash
npm run phase6:inspect
```

该命令只输出脱敏账号、贴纸数量与解析失败摘要，不下载贴纸，也不修改微信或应用 library。

Phase 7 WeChat 4 只读探测与 native helper 自建 fixture 验证：

```bash
npm run phase7:helper:build
npm run phase7:helper:test
npm run phase7:instrumentation:test
npm run phase7:lifecycle:test
npm run phase7:app-copy:test
npm run phase7:inspect
```

`phase7:inspect` 只输出脱敏账号、数据库/sidecar 是否存在和 helper 自检结果，不读取表情记录，
也不获取或输出真实 key。`phase7:instrumentation:test` 和 `phase7:lifecycle:test` 只使用项目
自建 host、dylib 与加密库；`phase7:app-copy:test` 只复制并清理临时 App，不签名、不启动、
不注入微信。真实 key acquisition 已有一次用户授权成功证据，但 synthetic 数据适配器测试不
代表真实缓存/CDN 导入或完整产品 UI 已验收。

`npm run phase7:load-gate:test` 是单独的真实 App 生命周期 dry run：它会正常终止并最终重启
原微信，只对私有 session 内的临时副本做 ad-hoc 签名，加载一个仅向 fd 6 写固定 readiness
标记、完全不 hook 函数的 probe，然后清理完整进程组、按临时副本 executable 路径验证的
逸出进程和整个 session。该命令不读取数据库，也不获取 key，不应作为普通 synthetic 测试
自动运行。

## 本地数据

桌面应用默认把 collection 放在 Electron `userData` 目录下。导入的图片会复制到应用管理的 `library`，源文件不会被修改。manifest 使用临时文件、`fsync` 和同目录 rename 原子保存，并保留最近一个备份。

Phase 0 CLI 的测试 session 位于仓库内的 `.phase0/`，已被 Git 忽略。桌面应用不会复制
这份测试凭据；它把自己的 WhatsApp session 放在 Electron `userData/whatsapp/session.enc`，
并使用 macOS Keychain-backed `safeStorage` 加密。不要提交 session、二维码、日志或用户素材。

Phase 3 转换输出位于 collection 的 `converted/whatsapp` 和 `tray` 目录。它们是可重建的
派生缓存；应用不会修改导入的 originals。

桌面端默认发送目标是用户自己的聊天。只有用户点击“读取其他群聊”后才会请求群聊列表。
成功发送的 pack receipt 会以目标 JID 的 SHA-256 摘要保存，避免重启后误发重复 pack；记录中
不保存完整手机号或群聊 JID。
