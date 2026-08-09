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
- Phase 6：微信 3.x `fav.archive` Legacy Beta 适配器已进入真实账号手工验收。
- 微信 4.x 提取仍在后续阶段。

## 本地开发

要求 Node.js 20 或更高版本。

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
