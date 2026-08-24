# 微信表情迁移到 WhatsApp：开发交接文档

> 状态：开发前方案已确认，尚未在新目录创建正式项目  
> 更新时间：2026-08-08  
> 文档用途：将本文件复制到一个全新的项目目录，让新的 Codex 对话直接按本文开始开发。

## 1. 项目目标

开发一个面向 macOS 的开源桌面应用，把微信收藏/自定义表情整理并导入 WhatsApp。

第一条需要尽快验证的完整链路是：

```text
本地图片目录
  → 桌面端预览、选择、排序
  → 按 WhatsApp 规则转换并分包
  → 登录 WhatsApp
  → 将原生 sticker pack 发送到指定群聊
  → 用户在手机 WhatsApp 中逐包添加
```

微信提取与上述链路解耦。前期允许用户先用 `export-wechat-emoji` 等外部工具导出自己的表情，再通过“从已有图片直接导入”测试本产品。等桌面端和 WhatsApp 导入闭环稳定后，再实现本项目自己的微信提取器。

这份文档聚焦开发，不包含市场调研。

## 2. 已确认的产品和技术决策

### 2.1 平台与发布

- 第一版只支持 macOS。
- 最低系统版本：macOS 13。
- Apple Silicon arm64：正式支持。
- Intel x64：第一版标记 Beta；需要能构建 x64 包，但由于缺少 Intel 实机，不承诺与 arm64 同等级验证。
- 项目将开源。
- 正式项目许可证尚未最终确认；建议 Apache-2.0。引入依赖前必须逐项核对许可证。
- 第一版通过签名/notarized DMG 分发，不以 Mac App Store 为目标。

### 2.2 桌面端技术

- Electron + React + TypeScript。
- 建议使用 Vite/electron-vite 类工具搭建，但以简单、可维护、能稳定打包为优先。
- 主应用不预先绑定 Rust。
- 微信 4.x 如果需要读取 macOS 原生进程/内存 API，可以增加独立的 native helper；helper 的语言在技术 spike 后，从 Rust、Swift + C 等方案中选择。
- 不使用 Python 作为桌面应用主运行时；Python 可以用于一次性研究，但不要成为发布包的必要依赖。

### 2.3 微信范围

- v1 只处理用户收藏/自定义表情。
- 微信商店下载的完整表情系列不在 v1 范围。
- 微信 4.x 的 `xwechat_files/.../emoticon.db` 是正式支持目标。
- 旧版 `fav.archive` 同时实现，但标记为 Legacy Beta。
- 必须支持分微信账号发现、选择和独立导入。
- 不依赖微信 App 版本号选择 extractor；通过数据布局探测：
  - 找到 `emoticon.db`：走 WeChat 4 adapter。
  - 找到 `fav.archive`：走 Legacy adapter。
  - App 版本号仅用于诊断信息。
- 永远不修改或替换用户原始 `/Applications/WeChat.app`。
- 先验证非侵入式 key 获取；如果未来需要“临时副本 + 临时签名”，必须先展示技术验证结果并再次取得用户确认。
- 允许把经过验证的微信数据库 key 缓存到 macOS Keychain；不得明文保存、记录或上传。

### 2.4 WhatsApp 范围

- v1 只实现“原生 sticker pack”模式。
- 目标体验：把 sticker pack 消息发送到用户选择的 WhatsApp 群聊；用户在手机端打开并添加。
- “逐张发送，再通过 WhatsApp Web DOM 自动收藏”移到 v1.1 Experimental，不得阻塞 v1。
- 不使用 pyppeteer/Playwright 控制 WhatsApp Web 作为 v1 主路径。
- 默认每包 30 张；允许用户配置 3–30 张。
- 官方规则要求每包 3–30 张，且静态与动态 sticker 不能混在同一包。详见：
  - https://github.com/WhatsApp/stickers/blob/main/Android/README.md
- WhatsApp 没有找到公开的 account-wide sticker pack 总数限制，因此产品不要宣传“无限”；开发测试中记录添加 10/30/50/100 包时的实际表现。

### 2.5 术语映射：session ↔ 登录凭证

- 内部代码、存储路径、协议层继续使用英文 `session`（如 `hasSession`、`sessionToken`、`session.enc`、`.phase0/session`），不需要改动。
- **用户可见文案（前端 UI、主进程错误/状态消息、CLI）统一把 `session` 表达为「登录凭证」**，不要直接向用户暴露 `session` 一词。
- 理由：`session` 对非技术用户难以理解；产品已有的「登出并清除登录凭证」「复用已保存的登录」等说法已使用该表述，统一后术语收敛。语义上 WhatsApp session 即扫码关联后的设备登录凭证。
- 示例映射：
  - `已有 session 时不能直接切换；如需更改，请先登出 WhatsApp。` → `已有登录凭证时不能直接切换；如需更改，请先登出 WhatsApp。`
  - `使用系统安全存储加密 session。` → `使用系统安全存储加密登录凭证。`
  - `确认登出 WhatsApp 并删除本机 session？…` → `确认登出 WhatsApp 并删除本机登录凭证？…`
- 新增用户可见文案时遵循同一规则；代码注释和内部文档仍可保留 `session`。
- 权限码等技术细节（如目录 `0700`、文件 `0600`）不得出现在用户可见文案中；需要表达时改用平实描述（如“以受限权限保存”）或直接省略。

## 3. 本次确认的开发顺序

先做相对独立、能快速验证价值的两部分：

1. WhatsApp sticker pack 上传技术验证。
2. 桌面端本地图片工作流：预览、选取、排序、分包、发送。

微信提取器后做。正式 UI 首页仍需为两种来源预留入口：

- “从微信提取并导入”：前期显示 Coming soon/尚未实现；之后接入 WeChat adapters。
- “从已有图片直接导入”：第一个可用入口。

不得为了等待微信 4.x key 方案而延迟本地图片到 WhatsApp 的里程碑。

## 4. v1 范围

### 4.1 必须包含

- 从一个或多个本地文件/目录导入图片。
- 导入时把素材复制到应用管理的 library，避免原路径移动后项目失效。
- 支持 PNG、JPEG、WebP、GIF；APNG 等格式根据解码能力逐步加入。
- 通过 magic bytes/实际解码识别格式，不只相信扩展名。
- 网格预览静态和动态图片。
- 多选、全选、反选、删除出当前 collection。
- 拖拽排序；重启应用后顺序保持。
- 设置 pack 名、publisher/author、每包大小；默认 30，合法范围 3–30。
- 预览自动分包结果，并显示每包静态/动态类型和数量。
- 转为 WhatsApp 兼容 WebP。
- WhatsApp QR code 或 pairing code 登录。
- 保存并安全复用 WhatsApp session。
- 获取并搜索群聊列表，选择发送目标。
- 逐包转换、发送、显示进度；失败可重试，不重复发送已经成功的包。
- 用户在手机端能打开收到的 pack 并添加，且 pack 内顺序和桌面端预览一致。
- arm64 安装包；x64 Beta 安装包或至少稳定的 x64 CI 构建产物。

### 4.2 明确不包含

- Instagram 批量导入。
- 微信完整商店表情系列（暂不包含）
- Windows。
- WhatsApp Web DOM 自动收藏 （暂不包含）
- 自动把所有 pack 一次性加入用户 sticker tray；WhatsApp 要求用户逐包确认。
- 云同步、账号体系、服务端上传。
- 表情编辑器、复杂裁剪、OCR/自动标签。
- Mac App Store 发布。

## 5. 推荐架构

保持单仓库、单 Electron 应用，不要一开始建立复杂 monorepo。

```text
src/
  main/
    library/             # 文件导入、manifest、原子写入
    media/               # 图片识别、转换任务调度
    whatsapp/            # WhatsApp adapter 与 session 管理
    sources/             # StickerSource adapters
      local/
      wechat-legacy/     # 后续
      wechat4/           # 后续
    security/            # Keychain/safeStorage、日志脱敏
  preload/
    index.ts             # 有限、带类型的 IPC API
  renderer/
    pages/
    components/
    state/
  shared/
    domain.ts
    ipc.ts
    errors.ts
native/
  wechat-key-helper/     # 后续；语言待 spike
tests/
  fixtures/
  unit/
  integration/
```

进程边界：

- Renderer 只负责 UI；启用 `contextIsolation`，关闭 `nodeIntegration`。
- 文件系统、密钥、WhatsApp session 只在 Main 侧访问。
- WhatsApp adapter 先以最简单方式接入 Main；只有实际出现阻塞、崩溃或隔离需求时才移到 `utilityProcess`/child process。
- 媒体转换先使用简单的有限并发队列；只有 UI 被阻塞时才增加 worker。
- 未来 native helper 用简单 JSON/JSONL 通信，不直接耦合 React。

### 5.1 Source adapter

从第一天定义统一接口，让本地图片和微信提取共享后续流程：

```ts
type StickerSourceKind = 'local' | 'wechat4' | 'wechat-legacy'

interface StickerSource {
  kind: StickerSourceKind
  discover(): Promise<SourceAccount[]>
  import(input: ImportRequest, onProgress: ProgressHandler): Promise<ImportedAsset[]>
}
```

- `LocalStickerSource` 第一阶段实现。
- WeChat adapters 只负责把素材和元数据导入统一 library。
- 预览、排序、转换、分包和 WhatsApp 发送不得知道素材来自哪个 source。

### 5.2 WhatsApp adapter

定义业务层接口，不让 UI 直接依赖 Baileys/InfiniteAPI 等具体库：

```ts
interface WhatsAppAdapter {
  connect(onAuth: AuthEventHandler): Promise<ConnectionState>
  disconnect(): Promise<void>
  listGroups(): Promise<WhatsAppTarget[]>
  sendStickerPack(targetId: string, pack: PreparedStickerPack): Promise<SendReceipt>
}
```

优先研究一个维护中的、许可证兼容的 Baileys-based 实现，验证是否真的能发送原生 pack message。`sticker-convert` 只作为行为参考，不直接 import：它是 GPL-2.0；其 WhatsApp bridge 的许可证和维护状态也必须单独核对。

第一阶段的 WhatsApp 技术 spike 是 go/no-go gate：在开始完整 UI 前，必须用 3 张测试图片把一个原生 pack 发送到测试群聊，并在手机上成功添加。

如果当前库只能发送单张 sticker、不能发送可添加的 pack，立即暂停 UI 扩张，记录协议/库差距并重新选择 adapter。

## 6. Library 与数据模型

### 6.1 存储原则

- 用户可以选择 library 根目录；未选择时使用一个清晰的默认目录。
- 应用设置、WhatsApp auth/session 和缓存密钥放在 Electron `userData`，敏感内容使用 macOS Keychain-backed 加密。
- 导入素材复制到 library；不要修改源图片。
- 第一版使用带 `schemaVersion` 的 JSON manifest，暂不引入数据库。
- manifest 使用临时文件 + rename 原子写入；保留最近一个可恢复备份。
- 转换输出是可删除/可重建的 cache，不是原始资产。

建议目录：

```text
<libraryRoot>/
  collections/<collectionId>/
    manifest.json
    originals/<assetId>.<ext>
    converted/whatsapp/<conversionKey>.webp
    tray/<packId>.png
```

### 6.2 核心对象

```ts
interface StickerAsset {
  id: string
  sourceKind: StickerSourceKind
  sourceAccountId?: string
  originalPath: string
  sha256: string
  mimeType: string
  animated: boolean
  width: number
  height: number
  durationMs?: number
  importedAt: string
  sourceOrder: number
  userOrder: number
}

interface StickerCollection {
  schemaVersion: number
  id: string
  title: string
  publisher: string
  packSize: number
  assets: StickerAsset[]
  createdAt: string
  updatedAt: string
}

interface PreparedStickerPack {
  id: string
  name: string
  publisher: string
  animated: boolean
  stickerIds: string[]
  trayIconPath: string
  status: 'draft' | 'prepared' | 'sent' | 'failed'
}
```

ID、文件名和 pack identifier 必须稳定，不能因为 UI 重开或重试而变化，否则可能导致重复 pack 或发送状态无法恢复。

## 7. WhatsApp 分包与媒体规则

官方当前公开要求：

- 每包 3–30 张。
- 静态和动态不能混包。
- sticker 为 512×512 WebP。
- 静态 sticker ≤100 KB。
- 动态 sticker ≤500 KB，总时长 ≤10 秒，单帧至少 8 ms。
- tray icon 为静态 96×96，≤50 KB。

来源：https://github.com/WhatsApp/stickers/blob/main/Android/README.md

实现要求：

- 静态图优先用 Sharp 处理尺寸、透明背景和 WebP 压缩。
- 动图需要单独验证 FFmpeg/libwebp 方案；选择能同时打包 arm64/x64、保留透明度且许可证可接受的实现。
- 不强制添加白色描边；可在未来提供可选项。
- 转换参数和源文件 hash 一起构成 `conversionKey`，方便缓存复用。
- 压缩必须有上限迭代；达不到文件大小要求时给出明确错误，不无限循环或无限降低画质。

### 7.1 分包算法边界

- 先按静态/动态分流，再在每类内部保持用户相对顺序。
- 用户设置 `packSize`，范围 3–30。
- 如果最后一包只有 1–2 张，要从前一包重新分配，使最后一包至少 3 张。
  - 示例：31 张、每包 30 → 28 + 3，而不是 30 + 1。
  - 示例：32 张、每包 30 → 29 + 3，而不是 30 + 2。
- 某一媒体类型总数只有 1–2 张时，不允许作为 pack 发送；UI 清晰提示用户增加同类型素材或取消选择。
- 混合静态/动态选择后，UI 必须提前展示会被拆为不同 packs，不能在发送时才提示。
- 为分包函数写纯函数单元测试，至少覆盖 0、1、2、3、29、30、31、32、33、59、60、61 张以及混合媒体类型。

## 8. 关键用户流程

### 8.1 本地图片入口

1. 首页点击“从已有图片直接导入”。
2. 选择目录或多个文件。
3. 显示导入进度、成功数、重复数、失败原因。
4. 进入 collection 网格预览。
5. 选择素材并拖拽排序。
6. 配置 pack 名、publisher、pack size。
7. 查看 packs 预览与校验错误。
8. 点击“连接 WhatsApp”并扫码/配对。
9. 选择目标群聊。
10. 转换并发送；显示逐包状态。
11. 提示用户回到手机 WhatsApp，逐包点击添加。

### 8.2 失败恢复

- 导入失败：保留已成功素材，列出失败文件。
- 转换失败：精确到素材；允许取消选中后继续。
- WhatsApp 断线：保留 prepared packs，重连后继续。
- 部分发送成功：根据稳定 pack ID 和 receipt 只重试失败包。
- session 失效：删除旧 auth、重新扫码，不删除 library。
- 应用崩溃/重启：collection、排序、选择和发送状态可恢复。

## 9. 安全与隐私要求

- 所有微信与图片处理默认在本机完成。
- 不上传图片、微信数据库、数据库 key、WhatsApp session。
- 微信数据库只读；处理副本，不改源文件。
- 微信 key 使用 macOS Keychain-backed 存储；使用前验证，失效后重新获取。
- WhatsApp auth/session 同样视作高敏感凭据并加密保存。
- 日志自动脱敏：不得包含 key、token、QR payload、完整电话号码、完整本地路径或 sticker URL 查询参数。
- 提供“退出 WhatsApp/清除 session”和“清除微信 key”。
- 错误报告导出前展示内容，让用户确认。
- UI 解释这是非官方 WhatsApp 集成，协议变化可能导致临时不可用；不要暗示 Meta/Tencent 官方背书。

## 10. 第三方代码与旧目录边界

当前仓库之外的旧研究目录是两年前的研究草稿集合，不是正式项目起点。它包含多个拉取的第三方项目、历史 session/log 和实验代码。

新项目必须在全新目录从零搭建，并遵守：

- 不复制当前目录中的 `export-wechat-emoji` 源码。该仓库截至调研时没有 LICENSE，公开可见不等于允许复制/修改/再分发。
- 不直接 import/copy `sticker-convert`；它是 GPL-2.0。只可作为功能行为和测试思路参考，除非未来明确决定整个项目接受 GPL。
- 可评估 MIT/Apache 等兼容依赖，但每个包按具体仓库和具体版本重新核对许可证。
- 不把旧目录里的 `session.json`、`baileys_store_multi.json`、日志、`fav.archive.plist`、单张用户表情或其他本地数据复制/提交到新仓库。
- 新仓库第一天就配置 `.gitignore`，覆盖 auth/session、Keychain 导出、日志、library、测试真实图片和构建产物。
- README 可鸣谢 `export-wechat-emoji` 的启发，但不能把鸣谢当成代码复用授权。

建议 README 鸣谢文字：

> 本项目为独立实现。微信表情导出部分的前期调研受到 `liusheng22/export-wechat-emoji` 启发和帮助；本项目不包含或复制该仓库的源代码。

## 11. 分阶段开发计划

目标是在 8 月底前得到可发布版本。计划只表达依赖关系和完成顺序，不做人工开发时间估算；执行时优先使用 AI 快速形成可运行的纵向闭环。

开发原则：

- 每个 Phase 都先做最薄、可运行、可手工验证的版本，再补体验。
- 不建立 monorepo、插件系统、通用工作流引擎或尚无实际调用方的抽象层。
- 不提前实现云同步、自动更新、完整 i18n、复杂数据库迁移或全面测试平台。
- 只有已经出现重复实现或确定存在第二个调用方时才抽象。
- 遇到 WhatsApp 或微信的技术不确定性时，用最小 spike 验证，不先搭外围系统。

### Phase 0：WhatsApp 原生 pack 技术 spike（go/no-go）

目标：不做完整 UI，先证明最关键的私有协议路径可用。

任务：

- 调研并选一个当前维护、许可证兼容的 WhatsApp Web/Baileys adapter。
- 写最小 TypeScript CLI：扫码/配对、保存测试 session、列出群聊。
- 准备 3 张满足规则的静态 WebP。
- 向测试群聊发送一个原生 sticker pack。
- 在手机端打开消息并成功添加到 sticker tray。
- 退出、重启 CLI，验证 session 复用和重连。
- 记录网络调用、错误类型、pack metadata、目标 ID 格式和依赖版本。
- 明确测试账号风险；不要使用重要账号作为早期高频实验账号。

验收：

- 真实账号、真实手机、真实群聊完成一次端到端添加。
- pack 内 3 张图片顺序正确。
- 重启后能复用 session，再发送一次或明确记录重连问题。
- 用简短 spike report 给出 GO / BLOCKED 结论。

如果不能发送“可添加的 pack”，不要假装用逐张 sticker 发送完成验收；应停止并重新评估 adapter。

### Phase 1：最小 Electron 骨架

- Electron + React + TypeScript scaffold。
- 配置最基本的 lint、format 和单元测试命令；不搭建复杂 CI。
- 安全 preload/IPC；Renderer 禁止直接 Node 访问。
- 只建立当前流程需要的 domain types 和 IPC。
- 实现带 `schemaVersion` 的 JSON manifest 读取与原子保存；没有真实版本变化前不写通用迁移框架。
- 实现首页两个来源入口；微信入口暂时禁用并说明后续支持。

验收：应用可启动、打包、重启后加载测试 collection；无敏感文件进入 Git。

### Phase 2：本地图片 library、预览、选择、排序

- `LocalStickerSource`。
- 文件/目录选择与复制导入。
- hash 去重、格式识别、元数据提取。
- 图片网格和动画预览；只有真实素材量出现性能问题时才加入虚拟化。
- 多选与拖拽排序。
- collection/排序持久化。
- 导入进度和失败文件列表；取消能力可在核心流程可用后补。

验收：使用一批真实微信表情导出图片完成导入、预览、选择和排序；重启后顺序一致；移动源目录不影响 library。

### Phase 3：WhatsApp 转换与分包

- pack 配置 UI；默认 30，范围 3–30。
- 实现并测试分包纯函数。
- 静态 WebP 转换与大小收敛。
- 动态 WebP 转换技术 spike，然后接入正式 pipeline。
- tray icon 自动生成。
- 使用简单转换 cache 和有限并发；复杂任务调度与取消机制后补。
- pack preview 与发送前校验。

验收：静态/动态分别满足 WhatsApp 当前公开规则；31/32 张等尾包情况正确；不生成 1–2 张的非法 pack。

### Phase 4：把 WhatsApp spike 接入桌面端

- 先用最简单且稳定的方式接入 adapter；只有观察到阻塞或崩溃风险时再移入 utilityProcess/child process。
- QR/pairing UI、连接状态、session 安全存储。
- 群聊搜索/选择。
- 逐包发送、进度和失败重试；先不实现复杂队列系统。
- 手机端逐包添加说明。
- 对真实账号进行端到端回归。

Milestone A 验收：

> 用户能从已有图片导入、预览、选择、排序、配置 30 张/包，将所有合法 packs 发到指定 WhatsApp 群聊，并在手机端按预览顺序添加。

完成 Milestone A 后可以开始实验打包，但还不公开发布；随后进入微信提取，不提前扩大其他平台范围。

### Phase 5：实验打包与内部验证（不公开发布）

- 生成 arm64 测试 DMG/ZIP，确认应用能脱离开发环境启动。
- 尝试生成 x64 Beta 构建产物，尽早发现 native dependency 架构问题。
- 在另一台 Mac 或干净用户账号下进行最小安装验证。
- 验证 session、library 路径和动态媒体二进制能随包工作。
- 暂不投入自动更新、正式发布页和完整发布自动化。

### Phase 6：Legacy `fav.archive` adapter

- 按数据布局发现 32 字符账号目录及 `Stickers/fav.archive`。
- 自己实现 plist 解析和 URL/顺序提取，不复制无许可证项目代码。
- 显示多个账号；无法取得昵称时用脱敏目录后缀区分。
- 提供默认、快速和安全三档下载速率；默认使用单并发随机间隔，另保留失败重试和 magic byte 格式识别。关闭导入面板必须真正取消任务、清理本次临时文件并保持 manifest 不变，不能只隐藏 UI。
- 导入统一 library；后续流程完全复用 Milestone A。
- 标注 Legacy Beta，并使用自建 fixtures 测试。
- plist 转换仅使用 macOS 自带的 `/usr/bin/plutil -convert xml1 -o -`，再由项目自己的解析器提取并验证 URL。`plutil` 自 macOS 10.2 起随系统提供；本项目不依赖 macOS 12 才加入的 `raw` 格式等较新能力，因此与最低支持版本 macOS 13 兼容。

### Phase 7：微信 4.x 提取与接入

> 实时状态：**Phase 7 已完成**。Gate A–G 全部通过；2026-08-11 已完成数据侧、显式授权产品接线和 checksum-locked universal 预编译 SQLCipher。最新打包产品在删除本应用加密 candidate 缓存并清空 library 后，从 cache miss 完整走过临时微信、用户扫码、收藏 readiness、HMAC/schema/quick_check、Gate 后快照与清理，最终导入 928/928，识别 286 张动图并准备 72 个 pack；验证后账号隔离的安全缓存重新创建，临时进程无残留。微信来源素材的最小 WhatsApp pack 已通过产品发送并在手机端成功添加。第二真实账号也走独立扫码 Gate G：两个脱敏账号正确列出，加密缓存从 1 增至 2，跨账号去重后 library 从 928 增至 930 且大号素材保持完整。真实 stale-key 故障注入降级为发布后 Phase 11.1 的非阻塞可靠性 TODO，现有 synthetic 回归已覆盖正确控制流。最新证据见 [`PHASE7_REPORT.md`](PHASE7_REPORT.md) 与 [`PHASE7_HANDOFF.md`](PHASE7_HANDOFF.md)。下文为本阶段的原始规划，仍然有效。

先完成最小 technical spike：

- 探测 `xwechat_files` 和多账号 `emoticon.db`。
- 只读复制目标数据库。
- 研究非侵入式获取 64 hex/32-byte SQLCipher key 的可行性。
- 评估 Rust 与 Swift/C helper；语言选择必须由 PoC 证据决定。
- 用数据库首页/HMAC/只读查询验证 key。
- 定义 helper JSONL 协议、退出码、权限和错误分类。
- 验证 macOS 13+ arm64；尝试 x64 构建。
- 不修改原始 WeChat.app。
- 简短记录成功率、需要的权限、用户是否必须退出微信和已验证的微信版本。

spike 可行后直接完成最小产品接入：

- 把验证过的 native helper 打包进应用。
- 多账号 UI、key Keychain 缓存、失效检测和重新获取。
- 解析收藏/自定义表情记录、URL/hash、下载回退。
- 权限引导与可理解的错误诊断。
- 接入统一 library，完成微信 → WhatsApp 的最终主流程。

若非侵入式方案不可行，或者必须使用临时 WeChat 副本/临时签名，要先回到用户处确认，不能自行加入。不要在得到决定前搭建复杂 fallback。

### Phase 8：产品前端优化与素材分组管理

> 实时状态：**Phase 8 的产品功能实现已基本完成，等待最终候选包手工回归后关闭**。当前产品采用
> 四步流程，素材库与流程共用挑选器，WhatsApp 凭证模式、安全说明和可选择的分包预览均已接入。
> 原计划中的动态贴纸短帧修复已经实现并有自动测试。后续 UI 微调可以继续，但不得破坏已经验证
> 的微信 Gate G、WhatsApp 凭证、加密安全缓存、素材持久化和动画转换边界。

#### 右侧主页的四步主流程

右侧主内容区使用固定竖向步骤导航和独立工作区。步骤之间可以返回修改；页面切换重置滚动位置，
但不得清空导入结果、素材选择、顺序、目的地、WhatsApp session 或已准备的任务状态。

主流程为四步：

1. **选择素材来源**：本步骤不可跳过，用户必须从以下三个入口中选择一个：
   - **从微信导入**：选择新版微信 4.x 或旧版微信 3.x，选择脱敏账号并导入收藏素材。
   - **从本机导入**：同一入口允许选择单张、多张图片或整个文件夹。
   - **使用我的表情库**：不重新导入，直接使用 App 已管理素材；素材库为空时必须提示先导入。
2. **选择目的地**：首发支持 WhatsApp 与本地文件夹。WhatsApp 在此完成凭证模式、连接、恢复和
   登出；本地导出路径与“设置”中的默认路径保持独立，默认路径只作为首次选择的建议位置。
3. **挑选传输表情**：复用素材库的 `StickerPicker`，支持来源/媒体筛选、搜索、默认/倒序排序、
   全选当前结果、取消选择、拖拽框选、自动滚动、拖拽调整自定义顺序和渐进加载。单击缩略图打开
   大图预览；预览支持复制和从素材库删除，`Esc` 可关闭。
4. **检查并传输**：准备并显示静态/动态分包、可折叠失败明细、短帧自动修复汇总和准备进度。
   WhatsApp 分包允许默认全选并取消部分包，包卡片可展开查看全部内容；只发送用户勾选的包。
   本地文件夹目标在此检查并执行导出。

每个步骤底部使用同一紧凑 footer 组件表达当前状态和下一步；条件不满足时按钮必须禁用并说明原因。

#### 素材库、来源分组与筛选

- 在侧边栏增加一个专门的素材库 tab，用于浏览已经由本 App 管理的全部图片。
- 素材库支持预览、选择、删除和排序，与第三步共用挑选器交互，但管理选择与当前传输任务选择互不覆盖。
- 支持查看全部素材，以及按来源 App、具体微信账号和手工导入来源筛选；账号继续使用脱敏标签。
- 优先用 manifest 来源元数据形成虚拟分组，不为 UI 分类移动或复制底层文件。
- 审核 `sourceKind` / `sourceAccountId`，处理同一内容来自多个账号时的多来源归属，不能因哈希去重丢失来源记录。
- 筛选只改变视图，不得破坏全局排序、选择、去重结果或 manifest 的向后兼容读取。

#### WhatsApp 凭证存储与登出

首次建立 WhatsApp session 前提供两个 radio 选项：

- **使用本地文件**：把明文凭证文件保存在 App 的 Application Support 数据目录，使用 `0700` 目录和 `0600` 文件权限，不依赖 macOS 钥匙串。必须提示其安全性较低；不得写入源码项目目录或 Git。
- **使用 macOS 钥匙串（推荐）**：使用 macOS 钥匙串保护加密密钥，并把加密 session 保存在 App 数据目录。说明此方式更安全，但首次访问或系统策略变化时可能弹出授权提示。

默认选择钥匙串。已有 session 时，用户必须先登出才能切换存储方式，首版不实现复杂的双向迁移。界面需区分“断开连接”和“登出”：登出按钮必须二次确认，明确说明会删除内存及所选存储方式中的 WhatsApp session，下次需要重新扫码或配对；登出不能删除素材库。

#### 动态贴纸转换韧性

- 已完成：转换阶段自动处理源动画中 `<8ms` 的帧，不让单条素材阻塞整个 pack。优先把每帧
  delay 规范化到至少 8ms，并从其他有余量的帧确定性回收增加的时长，尽量保持原总时长与节奏；
  若无法同时满足单帧下限和 10 秒总时长，则合并/丢弃不可感知的短帧后再编码。
- 只修改发送缓存中的派生 WebP，不修改 library 原素材；升级 conversion cache version，避免
  复用旧转换产物。
- 编码后重新读取 WebP metadata，强制验证每帧 `>=8ms`、总时长 `<=10s`、尺寸和 500KB 上限。
  自动修复应产生非阻塞的汇总提示；只有规范化后仍不合规的单条素材才进入失败列表，其余 pack
  继续准备。
- 增加 `<8ms`、恰好 8ms、接近 10 秒上限、缓存失效和“一个异常素材不阻塞其余素材”的回归
  测试。

#### 关于与安全 FAQ

应用内增加“关于与安全”页面或侧边栏 tab；Phase 9 官网必须提供对应的 FAQ 页面或区块，至少解释：

- **权限**：Phase 6/7 为什么需要读取用户选择的文件夹或微信数据目录、读取范围、如何撤销权限，以及拒绝后只有对应导入功能无法继续，其他不依赖该权限的功能仍可使用。
- **凭证与数据**：两种 WhatsApp session 存储方式的差异；凭证只在本机用于建立连接和执行用户主动发起的操作，绝不上传到项目服务器、出售、分析或用于无关用途。微信 key、账号数据和用户素材采用同样的最小使用原则。
- **开源审查**：产品源码、构建配置和依赖信息公开，任何人都可检查；正式发布前还要执行 Phase 9.2 的许可证、代码来源、安全和隐私审查。

Phase 8 最终验收至少包括：四步流程可完整往返且任务状态不丢失；三个素材来源入口可用；素材库
可预览、复制、删除、框选、排序并按账号/来源筛选；第三步与素材库共享交互但选择状态隔离；
第四步可以查看全部分包并只发送勾选的包；本地默认路径与单次导出路径互不污染；两种 WhatsApp
凭证模式分别完成首次登录和重启复用；登出后 session 确实删除并要求重新扫码；应用内安全 FAQ
可访问，官网文案已准备供 Phase 9 复用。

### Phase 9：初版官网与发布前审查

#### Phase 9.1：初版官网（GitHub Pages）

Phase 7 主流程通过后，可以建立一个最小静态官网作为项目的初始公开入口：

- 使用 GitHub Pages，不引入服务端、账号系统或复杂 CMS。
- 说明产品用途、当前支持范围、隐私原则、非官方 WhatsApp/微信集成声明和已知限制。
- 展示本地图片与微信提取到 WhatsApp 的核心流程，并链接 GitHub 仓库和使用文档。
- 下载入口只指向已经完成签名、公证和发布验收的正式产物；不得公开分发 Phase 5 的未签名内部包。
- 初版不接入行为追踪或第三方分析；如以后需要统计，先明确隐私策略。
- 页面视觉沿用桌面端简洁风格，但不为官网建立独立设计系统或复杂前端框架。

#### Phase 9.2：发布前审查

- 复核直接依赖、传递依赖、补丁和随包资源的许可证，生成第三方 notices，并明确 GPL 等许可证的披露与分发义务。
- 对曾调研或参考的外部项目进行代码相似性与提交历史抽查，重点区分不可避免的数据格式/行为事实和受版权保护的具体代码表达；不得复制无许可证或许可证不兼容的源码。
- 保留 clean-room 实现依据和来源记录；必要的致谢不能代替许可证授权。
- 检查 README、项目许可证、商标及“非官方 WhatsApp/微信集成”声明、隐私说明和发布文案。
- 扫描仓库与最终产物，确认不包含真实 WhatsApp session、微信 key、用户素材、账号标识、日志、测试 profile 或其他开发机数据。
- 记录并关闭审查发现，或由维护者明确接受剩余风险后，才进入正式发布阶段。

### Phase 10：正式发布

只有 Phase 6 和 Phase 7 完成后才进入本阶段：

- 完成 arm64 正式包的签名与 notarization。
- 生成 x64 Beta 安装包并记录已知限制；尽量寻找 Intel 测试者。
- 使用非开发机器做安装和主流程验证。
- 补齐隐私说明、免责声明、第三方 notices 和开源许可证。
- 确认日志脱敏、清除 WhatsApp session、清除微信 key 可用。
- 建立最简发布页和下载说明。
- 自动更新不是首发条件，可以发布后再做。

### Phase 11（发布后可选）：可靠性回归与 native refactoring

#### Phase 11.1：真实 stale-key 故障注入

TODO（非阻塞）：增加一个只在本地测试构建启用、默认关闭且不能进入正式包的一次性故障注入。
对用户在 UI 中选中的账号，从 safeStorage 正常加载候选后只在内存中翻转一个 key byte，再交给
helper；不得读取、输出或持久化真实 key，也不得修改微信数据库。

验收应确认 helper 返回 `KEY_VALIDATION_FAILED`，产品只清除所选账号的加密缓存、保留另一账号，
随后进入显式授权 Gate G；用户重新扫码并验证成功后，缓存数量恢复，两个账号都仍能使用自己的
候选。测试完成后移除或编译期禁用故障入口。直接破坏 `.keychain` 文件属于 safeStorage 损坏，
不是 stale-key 路径，不得用它代替该验收。现有 synthetic 测试已覆盖这套控制流，因此本项不阻塞
Phase 7、Phase 8 或首次发布。

#### Phase 11.2：Potential refactoring — Swift to Rust

TODO：在首个稳定版本发布、Phase 7 真实主流程已经验证并积累足够运行证据后，评估是否把
WeChat 4 native helper 从 Swift 渐进迁移到 Rust。该重构不是 Phase 7 或首次发布的阻塞项，
不得为了换语言延迟可用版本。

- 保持现有 JSONL、匿名 FD candidate frame、错误码和安全/隐私边界兼容，优先替换实现而非重做协议。
- 让 Swift 与 Rust 实现先共同运行同一套 synthetic SQLCipher golden tests，再逐步切换默认 helper。
- 重点评估 secret buffer 清零、RAII 清理、arm64/x64 universal 构建、SQLCipher FFI、CommonCrypto
  链接、签名/公证和 Electron 打包成本。
- 极小的 macOS instrumentation dylib 可以继续使用独立 C 实现；除非 Rust `cdylib` 能明显降低
  维护或安全成本，否则不要求把所有 native 代码统一为一种语言。
- 迁移完成前保留可回退的 Swift helper；不得降低 HMAC、`sqlite_schema`、`quick_check` 或失败清理标准。

## 12. 最小必要测试

目标是尽快交付可用版本，而不是首发前建立完整测试体系。除下列高风险点外，其余自动化测试、完整 fixture 矩阵、mock 平台和端到端测试框架均可在首个可用版本之后补充。

### 首发前保留的核心自动测试

- 分包纯函数：至少覆盖 1、2、3、30、31、32 张，以及静态/动态拆包，防止生成 WhatsApp 不接受的 pack。
- manifest 保存与重载：确认用户选择和排序不会在重启后丢失。
- 媒体转换结果校验：用一张静态和一张动态 fixture 检查尺寸、格式和文件大小限制。

### 每个里程碑必须完成的手工测试

- 用真实账号扫码/配对，将一个 pack 发到真实群聊，并在手机端成功添加。
- 用 30、31、32 张素材确认默认分包和尾包重分配。
- 重启应用，确认 library、排序和 WhatsApp session 仍可用。
- 正式发布前，用 arm64 安装包完整走一次“微信 4.x 提取 → 排序 → 分包 → WhatsApp 添加”，并另行确认本地图片入口仍可用。
- x64 保持 Beta；有 Intel 实机时再做同一条主流程。

真实 WhatsApp 协议测试不能放进公共 CI，也不能提交真实 auth/session。不要为了追求覆盖率阻塞可用版本；发现真实缺陷时，再为该缺陷补回归测试。

## 13. 当前主要风险与应对

1. **WhatsApp 私有协议变化**  
   应对：Phase 0 先做真实端到端 gate；adapter 隔离；锁定已验证版本；提供清晰的“暂时不兼容”错误。

2. **所谓 pack 上传实际只是逐张发送**  
   应对：验收必须是手机端能打开一个 pack 并加入 sticker tray；不能用视觉上类似的消息代替。

3. **WhatsApp 账号风控/条款风险**  
   应对：低频、明确由用户触发；不群发、不后台自动化；README 声明非官方集成；测试账号与重要账号分离。

4. **动图压缩复杂、构建包膨胀**  
   应对：独立 spike；优先选择可合法分发的 arm64/x64 二进制；转换失败可定位到单个素材。

5. **微信 4.x key 获取受 macOS/微信更新影响**  
   应对：后置且独立；native helper 可替换；key 先验证再缓存；不修改原始微信。

6. **第三方许可证污染**  
   应对：新仓库独立实现；依赖审计；不复制无许可证或 GPL 项目代码到拟采用 permissive license 的项目。

7. **Intel 无实机**  
   应对：标 Beta；保证 CI 构建；发布前寻找真实 Intel 测试者。

## 14. 仍待确认但不阻塞 Phase 0 的事项

- 正式项目名称、bundle ID。
- 许可证最终采用 Apache-2.0 还是 MIT；建议 Apache-2.0。
- 默认 publisher 文案。
- library 默认路径和是否允许用户更换。
- 第一版 UI 使用中文；不要求首发前搭建完整 i18n 系统，英文可在可用版本完成后补。
- WhatsApp 目标是否除群聊外同时支持“发给自己”；由 adapter spike 的能力决定。
- 临时 WeChat 副本/临时签名是否允许；必须等 Phase 7 结果后再次询问。

## 15. 给下一段开发对话的直接指令

1. 不要从当前旧目录复制代码；在用户提供的全新目录初始化项目。
2. 先读完本文件，检查新目录是否存在额外 `AGENTS.md` 或用户改动。
3. 先执行 Phase 0，不要立即做完整 React UI。
4. 核对候选 WhatsApp adapter 的当前维护状态、许可证和是否支持“可添加的原生 sticker pack”。
5. 创建最小 TypeScript spike，完成 3 张静态 sticker → 测试群聊 → 手机端添加。
6. 把 spike 证据、失败点和 GO/BLOCKED 结论写入仓库文档。
7. 只有 Phase 0 为 GO，才进入 Electron scaffold 和 Phase 1–4。
8. 每个阶段完成后按本文验收标准验证，不自行扩大 Instagram、Windows、DOM 自动收藏或微信完整表情系列范围。
9. 优先交付最薄的可用纵向流程；不要为了未来可能出现的需求搭建 monorepo、插件系统、通用框架、全面测试平台或复杂状态机。只有真实问题出现后再增加复杂度。

第一条可执行任务建议写成：

> 在这个全新目录中完成 Phase 0 WhatsApp 原生 sticker pack 技术 spike。先调研并选择许可证兼容、当前可维护的 TypeScript/Node adapter，然后实现最小 CLI：扫码或配对登录、列出群聊、把 3 张已满足 WhatsApp 规则的静态 WebP 作为一个可添加的原生 sticker pack 发送到测试群聊、保存 session 并验证重启重连。不得用逐张 sticker 发送冒充 pack。完成后提交 spike report 和 GO/BLOCKED 结论；暂不开发完整 UI。

## 16. 关键参考

- WhatsApp 官方 sticker 规范：  
  https://github.com/WhatsApp/stickers/blob/main/Android/README.md
- `sticker-convert` 行为参考（GPL-2.0，不直接集成）：  
  https://github.com/laggykiller/sticker-convert
- `export-wechat-emoji` 行为参考（截至调研时无 LICENSE，不复制源码）：  
  https://github.com/liusheng22/export-wechat-emoji
- GitHub 对“无许可证”的说明：  
  https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository
- SQLCipher key/API 基础：  
  https://www.zetetic.net/sqlcipher/sqlcipher-api/
- Apple 调试/跨进程访问权限背景：  
  https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.cs.debugger
