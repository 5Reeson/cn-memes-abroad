# Phase 7 续作 hand-over 提示词

> 用法：把本文件全文（或本节以下内容）作为新对话的第一条消息发给下一个 agent。它已自包含全部必要上下文。

## 0. 你的身份与本轮任务

你是 `cn-memes-abroad` 项目的接手 agent。这是项目所有者本人在自己 Mac、自己微信账号、自己表情数据上的**数据可携带性研究**。最终目标：通过开启一个微信 4.x 副本（或其他等价方式），**只读**拿到 `emoticon.db` 里存储的用户**个人收藏/自定义表情**相关信息，并接入本地素材库。

- 项目路径：`/Users/reason/Desktop/projects/cn-memes-abroad`
- 分支 `dev`，HEAD `19eae8f`。
- 工作区含大量用户已有、未提交的 Phase 7 修改。**禁止 reset / checkout / 覆盖 / 丢弃 / 清理 / 自行 commit。**
- 环境：macOS 15.6.1 arm64；已装 WeChat `4.1.11` build `269136`，bundle id `com.tencent.xinWeChat`，主可执行文件 universal (arm64+x86_64)。
- 数据根：`~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files`。

~~本轮先做静态与 synthetic 诊断/开发，不重跑真实 Gate G~~ **已过期**：用户在本对话明确授权了真实 marker run 并亲自扫码。该 run（2026-08-10）已执行成功：**`verified=true`**，真实 `emoticon.db` key 被捕获并通过 HMAC/schema/quick_check 三重验证（key 验证后即清零、未持久化）。后续如需再次真实执行，仍须用户在对话中明确授权。

## 1. 必须先完整阅读的文件（按顺序）

1. `DEVELOPMENT_HANDOFF.md` — 项目总规划，尤其 Phase 7 节。
2. `PHASE7_REPORT.md` — Gate A–G 全程状态；**Gate G 节**含上一会话得出的两条根因（Cause 1 / Cause 2），不可忽略。
3. `PHASE7_HANDOFF.md` — 本文件。
4. `native/wechat4-instrumentation/README.md`
5. `scripts/run-wechat4-gate-g.ts`
6. `src/main/sources/wechat4/load-gate.ts`
7. `src/main/sources/wechat4/process-group.ts`
8. `src/main/sources/wechat4/wechat4-layout.ts`
9. `src/main/sources/wechat4/candidate-key-pipe.ts`
10. `src/main/sources/wechat4/temporary-app-copy.ts`
11. `native/wechat4-instrumentation/Sources/Interposer/interposer.c`
12. `native/wechat4-helper/Sources/Wechat4Helper/main.swift`

## 2. 当前进度（Gate A–G）

- Gate A–E（synthetic instrumentation 全套）：**通过**。
- Gate F（真实临时副本 readiness / 签名 / 清理 / 原应用重启）：**复验通过**。
- Gate G（真实 candidate 获取）：第一次真实执行卡在候选获取（`CANDIDATE_TIMEOUT`，Cause 1 登录阻塞）；**第二次真实执行（2026-08-10，marker dylib + 用户扫码，10 分钟窗口）成功：`verified=true`**。
  - 候选帧经 fd 3 送达 helper，通过 salt 匹配 + `cipher_integrity_check` + `sqlite_schema` + `quick_check` 全部验证。
  - marker 序列证实：dylib 加载、salt 送达、登录/同步期间多个其它库的 KDF（per-database keys）、目标 salt 命中一次、恰好发一帧、发帧后盐状态按设计清零。
  - 清理完整、无逃逸进程、原 App 未修改、原微信已重启、仅 arm64 执行。key 验证后清零，未做任何持久化。
- 自动基线（2026-08-10 本会话复验）：17 文件 / 73 测试全绿；format/typecheck/lint/build/phase0/helper/instrumentation/lifecycle 全通过；`git diff --check` 通过。
- state-marker dylib（2026-08-10 本会话）：fd 7 marker 通道已实现并在全 synthetic 矩阵（双架构 + `CMSALTNO` 场景）断言通过；Cause 2 被证伪（见第 3 节），Cause 1 为唯一坐实阻塞。

## 3. 关键诊断结论（上一会话得出，新对话必须继承，勿重做无谓试错）

Gate G timeout 有**两条互相独立、都必须解决**的根因：

**Cause 1 — 登录会话无法恢复（观察+签名分析已证实）**
临时副本 ad-hoc 重签（`scripts/run-wechat4-gate-g.ts` 的 `signTemporaryArtifacts`，162–181 行）用 `codesign --force --sign - --timestamp=none`，**不带 `--options runtime`、不带 `--entitlements`**。这去掉了 hardened runtime（所以 `DYLD_INSERT_LIBRARIES` 不被剥离——与 Gate F 经 readiness probe 在 fd 6 拿到 `CMRDY001` 互相印证，**interposer 能加载进副本主进程**），但**也剥离了全部 entitlements**（`app-sandbox`、`5A4RE8SF68.com.tencent.xinWeChat` app-group、TeamID 绑定的 `application-identifier`）。副本因此拿不到原 App Keychain 里的登录会话 → 落到扫码界面 → `emoticon.db` 从不打开 → 永无匹配 PBKDF → interposer 正确地不发帧。45s 也远不够"扫码+同步+开库"。

**Cause 2 — 已证伪（2026-08-10 只读复审，审计范围纠错）**
上一会话的 bundle 审计只覆盖主可执行文件 + `Frameworks/` 下 125 个镜像，**漏掉了 `Contents/Resources/` 下的镜像**。全 bundle `nm -u` sweep（387 文件，仅排除无关的 VLC 插件）证实：`Contents/Resources/wechat.dylib`（317MB 核心逻辑镜像）、`roam_server.framework`、`roam_migration.framework` 三者都以 **undefined import** 引用 `CCKeyDerivationPBKDF`（可被 dyld interpose）。`Resources/wechat.dylib` 还导入 `CCCryptorCreate/Update/Final/Release` + `CCHmacInit/Update/Final` + `CC_SHA256_*` —— 正是 **SQLCipher CommonCrypto provider** 的完整 API 面 —— 并含 `PRAGMA kdf_iter`、`cipher_hmac`、`cipher_settings`、`sqlcipher_export` 串。主程序已 strip（423 符号几乎全为 undefined），只导入 `CCCrypt`/`CCRandomGenerateBytes` 与 SecCode 自检；上一会话看到的 OpenSSL/BoringSSL PBKDF2 串来自静态链接的网络栈（`mmcronet`），是红鲱鱼。主程序经 `WCDY.framework`（运行时 dlopen 加载器，`WCDY::open`）加载 `Resources/wechat.dylib`；**dyld interpose 对 dlopen 加载的镜像同样生效**。**结论：现有 hook 符号正确，无需更换；Gate G 超时只需 Cause 1 即可解释。** 剩余待经验性确认：`emoticon.db` 的 KDF 是否在主进程执行（预期是；若在 `roam_server` 类独立服务进程则涉及 fd 继承问题）——由 state-marker 真实 run 裁决。

**已知排除**：H2（dylib 不加载）对主进程已被 Gate F 证据排除。
**未验证的次要风险**（若 KDF 真在 XPC/launchd 子进程跑）：fd 3/4 不会被子进程继承，且 launchd 拉起的 XPC 不继承 `DYLD_INSERT_LIBRARIES`——但这是 Cause 1/2 解决后才需要面对的。

## 4. 目标与下一阶段

最终目标：**只读**拿到 `emoticon.db` 里用户**个人收藏/自定义表情**的相关信息（表/字段/URL/顺序等），接入现有下载、去重、预览、manifest、library 流程。**不碰**聊天、联系人、登录凭证或其他数据库；不碰官方表情专辑、StickerHub。

达成 `verified=true` 前，下一阶段只允许：

- `emoticon.db` 脱敏 schema 结构检查；
- 识别个人收藏表情所需的最小表和字段；
- 接入现有 library 流程。

## 5. 执行顺序（循序渐进，每个 gate 验证通过再进下一个；2026-08-10 更新状态）

1. ✅ **state-marker dylib（synthetic）已完成**：interposer 经 fd 7 发 9 种固定 8 字节 marker：
   `CMIPLOAD`/`CMSALTOK`/`CMSALTNO`/`CMIPHIT0`/`CMIPMTCH`/`CMIPMISS`/`CMIPSZ32`/`CMIPSZOT`/`CMIPSENT`
   （`O_NONBLOCK` best-effort，不含任何 key/salt/password/candidate/account/URL/库内容）。synthetic host 全矩阵（correct/wrong-salt/wrong-length/kdf-failure/mixed + `CMSALTNO` 场景，arm64 + Rosetta x86_64）带精确序列断言通过。**候选四过滤一字未改。**
2. ✅ **真实 marker run 已成功（2026-08-10）**：`WECHAT4_GATE_G_CANDIDATE_TIMEOUT_MS=600000 npm run phase7:gate-g`，用户扫码登录 + 打开收藏表情面板，一次 run 完成捕获 + 三重验证，`verified=true`。marker 序列同时证实 KDF 在主进程执行（fd 继承无问题）、4.x 为 per-database keys（大量其它盐的 MISS）。
3. ~~**定位真实 KDF 符号**~~ **取消**：只读复审已确认 hook 目标就是 `CCKeyDerivationPBKDF`（导入方为 `Resources/wechat.dylib`，经 `WCDY.framework` dlopen 进主进程，interpose 适用）。
4. ✅ **登录会话**：扫码路径一次通过。注意产品层面要告知用户：副本登录会把原 Mac 会话顶下线（原微信重新登录即可恢复，无数据损失）。
5. **下一步（gate 已满足）**：schema 结构检查 + 最小表/字段识别 + library 接入。建议路径：给 helper 增加 `schemaOverviewFd`（复用 fd 候选帧 + 只读脱敏：表名/列名/类型/行数，**不输出行内容**），并在 Gate G 脚本验证通过后同 run 内执行（key 在验证后即清零，不做持久化则必须同 run 完成）；随后按 DEVELOPMENT_HANDOFF Phase 7 做 key 的 Keychain 缓存与产品接入。

## 6. 红线（继承，违反即停）

- 不重跑真实 Gate G，除非用户在本对话中再次明确授权。
- 不读聊天、联系人、登录凭证或其他数据库。
- 不碰网络、Keychain、远程服务。
- 不修改或签名原始 `/Applications/WeChat.app`（只读 `codesign -d` 允许）。
- 不使用 sudo、不关 SIP、不改系统安全设置。
- 不输出 key、salt、账号、URL、数据库内容或素材。
- 不放宽 salt 完全匹配 / KDF 成功 / 32-byte 派生长度 三道过滤。
- 不加 key 的日志/文件/argv/env/stdout 通道；新增诊断只允许固定、非秘密状态 marker，且先在 synthetic host 验证。
- 不开始 schema 检查或产品接入，除非 `verified=true`。
- 不自行 commit。

## 7. 需要你验证的清单

- ✅ 自动基线全绿（2026-08-10 复验）：`format:check`、`typecheck`、`lint`、`git diff --check`、`phase7:instrumentation:test`、`phase7:helper:test`、`phase7:lifecycle:test`、`npm test`（17/73）、`npm run build`、`npm run phase0:check`。
- ✅ state-marker dylib synthetic 矩阵：correct/wrong-salt/wrong-length/kdf-failure/mixed + `CMSALTNO` 场景，双架构精确序列断言。
- ✅ 真实 marker run（2026-08-10）：`markerSequence` 走到 `CMIPMTCH`+`CMIPSZ32`+`CMIPSENT`，候选通过三重验证，`verified=true`。
- ✅ KDF 在主进程执行（`CMIPHIT0` 出现在注入了 dylib 的主进程 marker 流中）。
- ✅ `verified=true` 已达成——schema/接入 gate 开启。
- 待办：`schemaOverviewFd` 脱敏结构检查；最小表/字段识别；key 的 Keychain 缓存；library 接入；真实多账号/失效 key 手工验收（见 PHASE7_REPORT 尾部清单）。

## 8. 建议的第一条任务（给新对话的第一句话）

> 先完整读 `PHASE7_REPORT.md` 的 Gate G 节（含 "Second real run (2026-08-10): candidate acquired and validated" 小节），确认 `verified=true` 已达成；然后实现脱敏 schema 结构检查：给 helper 加 `schemaOverviewFd` 方法（fd 候选帧 + 只读，仅输出表名/列名/类型/行数，不输出行内容），在 synthetic fixture 上补测试，并在 Gate G 脚本验证通过后同 run 内执行（key 验证后即清零）。**任何新的真实 Gate G 执行必须先取得用户本对话内的明确授权。** 全程遵守 `PHASE7_HANDOFF.md` 第 6 节红线；密码学三过滤绝不放宽；不自行 commit。

## 9. 关键命令速查

```bash
# 只读 git 诊断
git status --short && git diff --stat && git diff --name-only && git diff --check

# 自动基线
npm run phase7:instrumentation:test
npm run phase7:helper:test
npm run phase7:lifecycle:test
npm test
npm run format:check && npm run typecheck && npm run lint && npm run build && npm run phase0:check

# 真实 Gate G（仅当用户在本对话明确授权；env 只加长操作窗口，不改任何过滤）
WECHAT4_GATE_G_CANDIDATE_TIMEOUT_MS=600000 npm run phase7:gate-g

# 只读原 App 签名/符号审计（不改原 App）
/usr/bin/codesign -dvvv /Applications/WeChat.app
/usr/bin/codesign -d --entitlements - /Applications/WeChat.app
/usr/bin/nm -arch arm64 -u /Applications/WeChat.app/Contents/MacOS/WeChat
/usr/bin/strings -a /Applications/WeChat.app/Contents/MacOS/WeChat | grep -i pbkdf
```

## 10. 数据侧续作更新（2026-08-11）

- 已只读确认本地缓存布局：`business/emoticon/Persist/<md5前两位>/<md5>` 948 个，
  `business/emoticon/Thumb/<md5前两位>/<md5>.thumb` 950 个，配对 948 个；探测只看文件名和
  数量，未读文件内容，未输出账号目录或单条 MD5。
- helper 已新增 `personalEmoticonsFd`：完整校验后仅联表读取
  `kFavEmoticonOrderTable` / `kCustomEmoticonOrderTable` / `kNonStoreEmoticonTable`，不查询
  `kStore*`；敏感行通过匿名 fd 4 传给 Main，stdout 只有固定布尔值和聚合计数。
- 已实现 `Wechat4StickerSource`：快照 → Gate G candidate provider → Keychain-backed
  `safeStorage` 缓存及失效重取 → 本地 Persist/Thumb → HTTPS CDN/AES 回退 →
  `LocalStickerSource` 统一 library。
- 产品层已接通 `AcquireWechat4Candidate`：主进程只在 UI 明确确认后运行临时副本流程，状态经
  固定消息发送到 renderer；成功校验后 adapter 才缓存 candidate 并继续导入；取消/失败路径
  清理进程组、副本、快照和未提交的 library 文件。UI 支持脱敏多账号选择、影响说明、扫码提示
  和取消。
- macOS 打包会先构建 universal helper/interposer，再通过 `extraResources` 放入
  `Contents/Resources/wechat4-native/`；2026-08-11 已实际生成 arm64 目录包，包内两者均验证为
  `arm64 + x86_64` 普通可执行文件，并通过 ad-hoc `codesign --verify --strict`。运行时不再依赖
  仓库路径；正式 Developer ID 签名/公证仍属于发布阶段。
- synthetic 基线更新为 22 文件 / 87 测试；新增打包路径/权限/拒绝 symlink、多账号缓存隔离，
  以及旧 key 被 helper 拒绝后只清除所选账号并重新获取的回归。helper arm64/x86_64 的正确
  key、错误 key、目录顺序和 fd 隔离均通过。
- 用户随后明确授权并完成真实产品 UI Gate G/导入：新确认步骤会等收藏缩略图显示后再清理副本，
  再取新快照；928 条个人收藏中 884 张成功进入统一 library，素材库由 155 增至 1039，动态图
  由 106 增至 371。真实 CDN、AES-128-CBC（IV=key、NoPadding）、MD5、图片解码、预览、
  顺序和 manifest 保存均已验收；44 条失败或去重未新增，未输出单条内容。
- 首次真实产品尝试的 928 条全失败根因是 Gate 捕获 candidate 后过早杀掉副本并继续读取 Gate
  前旧快照；现已由 UI 明确确认 + Gate 后新快照修复。速度问题也已收敛为 6 个限流 worker、
  确定性 HTTP 失败不重试、瞬时失败最多两次、单条总预算 45 秒，且保持数据库顺序。
- 下一步仅剩真实多账号/失效 key 手工验收，以及分包/WhatsApp 发送的产品全链路；它们不再
  阻塞 Phase 7 单账号数据侧完成。
