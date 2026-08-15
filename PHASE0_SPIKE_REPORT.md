# Phase 0 — WhatsApp 原生 Sticker Pack Spike

**结论：GO（2026-08-08）**

已用真实 WhatsApp 账号和手机验证完整最小链路。测试目标为账号自身聊天（本 Phase 的授权范围允许“群聊或自己聊天”）；未访问、复制或依赖旧研究目录的任何代码、session、日志或用户数据。

## 已验证流程

1. `npm run phase0` 首次运行显示 WhatsApp Web QR；手机在“设置 → 已关联设备”完成关联。
2. session 写入 `.phase0/session/`；目录权限为 `0700`、文件权限为 `0600`，整个 `.phase0/` 已被 `.gitignore` 排除。
3. CLI 列出自身 JID（实际值不写入仓库）和可用群聊，并选择自身聊天作为测试目标。
4. CLI 生成并校验 3 个 512×512、单帧静态 WebP，上传一个 ZIP sticker-pack、96×96 PNG tray icon 及 252×252 JPEG thumbnail；随后发送 protobuf `StickerPackMessage`，不是逐张 sticker。
5. 手机 WhatsApp 能打开消息中的 pack、显示 3 张贴纸，并成功添加到 sticker tray；用户已确认下表顺序正确。
6. 退出后再次运行 CLI：无需 QR 即复用 session，第二次原生 pack 发送成功。

## Pack 元数据与顺序

| 顺序 | 文件            | 文案 / emoji | 颜色   |
| ---- | --------------- | ------------ | ------ |
| 1    | `phase0-1.webp` | 好耶 / 🎉    | 黄色   |
| 2    | `phase0-2.webp` | 收到 / 👌    | 青绿色 |
| 3    | `phase0-3.webp` | 冲鸭 / 🚀    | 粉色   |

实际生成大小：8,234 B、8,102 B、7,526 B；tray icon 2,213 B。三张均低于静态 sticker 的 100 KB 上限。

## 锁定依赖

- Node.js `22.15.0`
- `@whiskeysockets/baileys` `7.0.0-rc14`
- `sharp` `0.34.5`
- `fflate` `0.8.2`
- `qrcode-terminal` `0.12.0`
- `qrcode` `1.5.4`

Baileys 当前公开包没有原生 sticker-pack 的完整 helper。spike 在启动时仅补充两个媒体路由（`/mms/sticker-pack`、`/mms/thumbnail-sticker-pack`）和对应 HKDF labels；另以受版本锁定的 `patch-package` 补上 `stickerPackMessage → sticker_pack` 的消息媒体属性。pack payload 则由本项目最小代码构造、加密、上传和 relay。

## 观测与风险

- 本次成功的 target JID 形式为 `<phone>@s.whatsapp.net`；群聊 JID 应为 `…@g.us`。实际账号标识、QR、session、日志均不写入仓库。
- 观测到的正常网络路径是 WhatsApp Web 长连接，以及媒体上传路由 `/mms/sticker-pack`、`/mms/thumbnail-sticker-pack`。本次没有阻断性错误。
- 这是未公开、可能随服务端变化的 WhatsApp Web 协议；升级 Baileys 前必须重新跑本 Phase 手工验证，尤其是 patch 是否仍可应用、pack 是否仍可添加。
- 测试 session 等同已关联设备凭据；仅限本机测试，保持 `.phase0/` 忽略、权限收紧，使用非重要账号进行早期频繁实验。
- 本轮按用户确认接受 GPL 依赖；在公开发布、分发或重新评估许可证时需要单独完成 license review。

## 下一步

进入 Phase 1 前不扩大 WhatsApp 功能。下一阶段是最小 Electron + React + TypeScript 骨架、安全 preload/IPC、版本化 JSON manifest 与两个来源入口；微信入口保持禁用占位。
