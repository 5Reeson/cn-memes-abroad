# cn-memes-abroad

让中文互联网的表情包跟着留子们一起出海 - 支持从微信提取、整理并转换表情包，迁移到 WhatsApp 及更多聊天平台的开源桌面端应用

Helping Chinese memes travel abroad with their people - an open-source desktop app for extracting, organizing, converting, and moving stickers from WeChat to WhatsApp and beyond.

## 当前状态

- Phase 0：WhatsApp 原生 sticker pack 技术验证已通过。
- Phase 1：Electron + React + TypeScript、安全 IPC、本地 manifest 原子读写。
- Phase 2：本地图片/目录导入、复制、去重、预览、多选和拖拽排序。
- 微信提取和桌面端 WhatsApp 发送仍在后续阶段。

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

Phase 0 CLI 仍可独立运行：

```bash
npm run phase0
```

## 本地数据

桌面应用默认把 collection 放在 Electron `userData` 目录下。导入的图片会复制到应用管理的 `library`，源文件不会被修改。manifest 使用临时文件、`fsync` 和同目录 rename 原子保存，并保留最近一个备份。

WhatsApp 测试 session 位于仓库内的 `.phase0/`，已被 Git 忽略。不要提交 session、二维码、日志或用户素材。
