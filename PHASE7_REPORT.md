# Phase 7 report: WeChat 4.x read-only technical spike

Date: 2026-08-10

Overall status: **Gate G PASSED — real `emoticon.db` key acquired and validated (`verified=true`)
on the second real run; sanitized schema inspection and product integration are now unblocked**

## Scope and clean-room boundary

This spike covers WeChat 4.x layout discovery, a controlled read-only database snapshot, a thin
native helper protocol, strong SQLCipher key validation, arm64/x64 build evidence, and the
session-scoped lifecycle foundation for a possible temporary-app acquisition PoC. It does not start
Phase 8 and does not yet add Electron product UI or Keychain caching because a real key has not been
acquired and verified.

No old research directory, historical session, log, database, key, URL, account identifier, or user
sticker was copied into the repository. The real database was never opened for writing. Temporary
real-data snapshots were mode `0700`/`0600` and were removed after the copy checks.

After the user explicitly permitted a source review, the public
[`liusheng22/export-wechat-emoji`](https://github.com/liusheng22/export-wechat-emoji) repository was
reviewed only for architectural facts. Its source was not copied. The repository had no visible
license at review time, so this project keeps an independent implementation and records materially
different security and lifecycle choices below.

## Actual development-machine evidence

- macOS: `15.6.1`, Apple Silicon arm64.
- Installed WeChat: `4.1.11`, build `269136`, bundle identifier `com.tencent.xinWeChat`.
- The installed WeChat executable is universal (`arm64` + `x86_64`).
- Standard root detected:
  `~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files`.
- One account-shaped directory was found by the fixed `db_storage` layout check. No account name was
  written to this report.
- `db_storage/emoticon/emoticon.db` exists and is 2,990,080 bytes. Its first 16 bytes are not the
  plaintext SQLite header. Matching `emoticon.db-wal` and `emoticon.db-shm` files were present.
- A sanitized metadata-only probe found the local `key_info.db` schema and one opaque 180-byte blob.
  The blob did not contain a plaintext 64-hex key. No blob bytes or hashes were logged or committed.
- No permission denial occurred on this development profile.

These findings are real WeChat 4.x layout evidence. They are not evidence that the database can yet
be decrypted.

## Read-only discovery and snapshot

`src/main/sources/wechat4/wechat4-layout.ts` independently implements:

- fixed-depth discovery of regular `emoticon.db` files without following symlinks;
- stable hashed account IDs and short local labels, with no source path in the public view;
- explicit WAL/SHM and key-metadata presence flags;
- `PERMISSION_DENIED` versus no-data discovery states;
- mode-`0700` temporary snapshot directories and mode-`0600` files;
- copying the main DB plus any `-wal`/`-shm` sidecars;
- before/after inode, size, mtime, and ctime fingerprints with three bounded retries;
- cancellation and explicit recursive cleanup of only the helper-created temporary directory.

The real running WeChat 4.1.11 database and both sidecars were copied through this implementation,
the fingerprints remained stable for that attempt, and the snapshot was immediately removed. This
proves the safe copy path, not a transactionally frozen snapshot under every workload. Production UI
should still ask the user to quit WeChat normally before acquisition/copy. It must never checkpoint,
vacuum, or otherwise modify the original database.

## Session-scoped app and secret transport lifecycle

The next acquisition boundary was implemented and tested without signing, launching, or injecting
WeChat and without reading a real database key:

- a source app bundle is validated without following a top-level symlink, then copied into a fresh
  mode-`0700` session directory;
- cleanup is idempotent and refuses to recursively remove paths outside the generated session-name
  and expected parent boundary;
- a detached POSIX process group is launched with a minimal environment and a dedicated anonymous
  file-descriptor pipe for one fixed-size candidate frame;
- the frame carries only a database role, the 16-byte database salt, and 32 candidate key bytes;
- malformed, oversized, canceled, and timed-out reads are rejected, and collected/candidate buffers
  are explicitly zero-filled;
- termination addresses the complete process group with `SIGTERM`, waits a bounded grace period,
  then uses `SIGKILL` if necessary before destroying every parent-side pipe.

The composed synthetic lifecycle test creates its own SQLCipher database in a private temporary
directory, sends a generated candidate over the anonymous pipe, and validates it with the production
helper. It passed the success, malformed-frame failure, cancellation, and timeout/SIGKILL paths,
including a regression case where the leader exits on `SIGTERM` while its in-group descendant
ignores it. Each path verified that both synthetic PIDs were gone. The database, key buffers, and
session directory were then removed. Fixture creation also proved that invalid-key failure removes a
partial output and that an atomically detected pre-existing file is neither opened nor removed.

A separate smoke test copied the installed `/Applications/WeChat.app`, compared the copy's code
directory hash and signature-verification outcome with the original, rechecked that the original
hash was unchanged, and removed the temporary copy. Both original and copy currently produce the
same `CSSMERR_TP_NOT_TRUSTED` trust-chain diagnostic under strict verification; this is baseline
environment behavior, not a difference introduced by copying. No copied app was signed or started.

## Helper technology choice

The spike selected **Swift + a pinned SQLCipher Community static library**:

- macOS is the only target and Swift directly supports Foundation, Security.framework, process
  control, future Keychain work, and typed JSON without a large framework.
- SQLCipher provides the actual page HMAC and SQLite query semantics. Reimplementing its crypto in
  application code would create avoidable compatibility and security risk.
- Rust would not provide additional permissions or avoid the Apple-native process/signing APIs. It
  remains a valid future choice only if a broader cross-platform helper becomes a real requirement.

The SQLCipher version is `4.17.0 community`, tag commit
`810db22f575ee7cf94ea96a3e91622b5fcece3dc`, under its BSD-style license. The repository stores only
the checksum-verified macOS `arm64 + x86_64` static archive and its matching public header, not the
large generated C amalgamation. Toolchain, flags, checksums, license, and exact reproduction commands
are stored under `native/wechat4-helper/prebuilt/sqlcipher/macos-universal/`.

## Key validation

The helper accepts a caller-supplied key in the legacy synthetic `validateKey` JSONL request. It is
passed on stdin, never argv or the environment, and is never returned. The production-shaped
`validateCandidateFd` path keeps the JSON request key-free and receives one fixed 56-byte binary
candidate frame only through anonymous fd 3.

A candidate is accepted only after all of the following:

1. exactly 64 hexadecimal characters are checked and passed to SQLCipher with raw-key blob-literal
   semantics;
2. the snapshot is opened read-only;
3. `query_only` and in-memory temporary storage are enabled;
4. `PRAGMA cipher_integrity_check` returns no HMAC failures;
5. `sqlite_schema` is queried successfully;
6. `PRAGMA quick_check` returns `ok`.

Receiving or intercepting a 64-hex string alone is never success.

The synthetic self-test uses only generated data and passed for both architectures:

- correct key accepted;
- wrong key rejected;
- modified encrypted page rejected;
- live WAL database validated.
- fd candidate with the correct database salt/key accepted;
- fd candidates with a wrong salt or wrong key rejected;
- caller frame cleared after success, helper failure, and forced timeout cleanup.

The real WeChat database has not passed these checks because no real key was obtained.

## Synthetic PBKDF instrumentation gate

A clean-room C gate now proves the transport and interception mechanics only against project-owned
components. It consists of a minimal `CCKeyDerivationPBKDF` dyld interposer and a synthetic C host;
both are compiled as separate arm64/x86_64 slices and combined into universal binaries. The dylib
does not hook `CCCrypt`, Keychain, network, file-reading, or any other cryptographic function.

The binary-only channels are:

- fd 4: parent to dylib, exactly 16 target-salt bytes;
- fd 5: parent to synthetic host, exactly 16 per-test salt bytes;
- fd 3: dylib to parent, at most one fixed 56-byte candidate frame.

The interposer first calls the real system PBKDF without changing any argument or result. It emits
only when that call succeeds, the call salt is exactly 16 bytes and equals fd 4, and the derived
output is exactly 32 bytes. It never copies the password. Its target salt and frame, the host's
clearly synthetic password/output, parent-side salt writes, helper frame, and returned candidate
objects are zero-filled after use.

The `correct`, `wrong-salt`, `wrong-length`, `kdf-failure`, and `mixed` modes passed on native arm64
and Rosetta x86_64. `mixed` runs rejected calls before two valid calls and still emits only once. A
test-only SQLCipher fixture uses the same explicit PBKDF2-HMAC-SHA512/256000 parameters. The emitted
candidate passed the existing Swift salt, HMAC, schema, and quick-check validation; wrong salt,
wrong key, and malformed frame returned only fixed safe errors. External cancellation, operation
timeout, and a host that ignores SIGTERM all ended with the process gone, including SIGKILL
escalation where required. The private fixture, copied host/dylib, sidecars, and session directory
were removed.

This is **synthetic GO only**. It does not prove that a copied WeChat process can be safely launched,
that its PBKDF call has these parameters, that injection is permitted, or that a real `emoticon.db`
candidate can be acquired and validated.

## Gate F: real temporary-copy readiness dry run

Gate F was executed against the locally installed app without opening a WeChat database or loading
the PBKDF interposer. A separate universal readiness dylib contains no `__interpose` section and its
constructor only writes the fixed non-secret `CMRDY001` marker to anonymous fd 6.

The first attempt stopped before creating a copy because the AppleScript quit request failed. Its
finally path verified the original signature and restarted the original app. To avoid Automation
permission prompts, the successful attempt sent standard SIGTERM only to the PID whose executable
path exactly matched the original app's validated main executable, then confirmed common WeChat
processes had ended.

The successful attempt then:

- created a private mode-`0700` session and copied the app inside it;
- proved the operated app and probe paths were inside that session and distinct from the original;
- ad-hoc signed and verified only the probe and temporary app copy;
- launched the copied main executable in an independent POSIX process group with only the
  non-secret probe path in `DYLD_INSERT_LIBRARIES`;
- received the fd 6 readiness marker and immediately began cleanup;
- observed at least one copied-app process outside the initial PGID, identified it only after its
  executable resolved inside the validated temporary app bundle, and removed all such processes;
- removed the temporary copy, probe, and session; verified the original app code-directory hash was
  unchanged; and restarted the original app successfully.

No password, Keychain, login, or system-permission prompt was observed or operated. Gate F is
**readiness/load/cleanup GO only**. It did not hook a KDF, inspect any database, or acquire or validate
a real key.

## Gate G: real candidate acquisition attempt (single run, fail-closed)

A single real Gate G run was executed against the locally installed app under the documented safeguards.
It stopped at candidate acquisition and did not reach key validation. No key, salt value, account
identifier, URL, database row, or asset was logged or committed.

Observed outcome:

- unique `emoticon.db`: confirmed (`uniqueEmoticonDatabase=true`).
- WAL and SHM sidecars snapshotted read-only into a private mode-`0700`/`0600` session
  (`walSnapshotted=true`, `shmSnapshotted=true`).
- temporary app copy created inside the session and ad-hoc signed; signature verified
  (`temporarySignatureVerified=true`).
- target salt delivered to the temporary copy over anonymous fd 4; parent-side buffer zeroed.
- no candidate frame received on fd 3 within the 45 s operation window.
- `candidateFrameValid=false`; `cipher_integrity_check`, `sqlite_schema`, and `quick_check` were **not
  run** (validation never started).
- `verified=false`; `errorCode=CANDIDATE_TIMEOUT`.
- no escaped temporary process observed; full process-group and session cleanup completed
  (`cleanupComplete=true`).
- original `/Applications/WeChat.app` code-directory hash unchanged (`originalAppUnchanged=true`);
  original app restarted (`originalAppRestarted=true`).
- real execution: arm64 only; x64 not executed.

This is a candidate-acquisition timeout, **not** a key-validation failure. Validation never began.

### Static and synthetic root-cause diagnosis (no real re-run)

The timeout was diagnosed without re-running Gate G, without launching, signing, or modifying the
original app, and without reading chat, contact, credential, or other databases. Two independent,
non-exclusive causes were identified; both must be resolved before a real candidate can be acquired.

**Cause 1 — login session not restored (confirmed by observation and signing analysis).** The ad-hoc
re-sign path (`scripts/run-wechat4-gate-g.ts` `signTemporaryArtifacts`) uses
`codesign --force --sign - --timestamp=none` without `--options runtime` and without `--entitlements`.
This removes hardened runtime (so `DYLD_INSERT_LIBRARIES` is not stripped from the main process —
consistent with Gate F receiving the `CMRDY001` readiness marker over anonymous fd 6) but also strips
the original entitlements, including `com.apple.security.app-sandbox`, the
`5A4RE8SF68.com.tencent.xinWeChat` application group, and the Team-identifier-bound
`application-identifier`. The copy therefore cannot restore the original Keychain-backed login session
and boots to the QR login surface. The user confirmed the temporary copy showed the QR login surface
during the run. While the app remains at login, `emoticon.db` is never opened, its PBKDF2 is never
called, and the interposer correctly emits nothing. The 45 s window is also far shorter than a human
scan plus account sync plus database open would require.

**Cause 2 — the hooked symbol is not referenced by the installed bundle (static). REFUTED by a
corrected read-only re-audit the same day; see "Cause 2 correction" below.** The interposer hooks
CommonCrypto `CCKeyDerivationPBKDF` only. An initial read-only `nm -u` and `strings` audit of the installed
`/Applications/WeChat.app` bundle (universal main executable plus 125 framework Mach-O images, both
arm64 and x86_64 slices) found **no reference to `CCKeyDerivationPBKDF`** anywhere — not as an
undefined import and not as a `dlsym` lookup string. The main executable instead contains
OpenSSL/BoringSSL-style PBKDF2 symbols (`PKCS5_v2_PBKDF2_keyivgen`, `PKCS5_pbkdf2_set`,
`PBKDF2PARAM`, `pbkdf2 error`). This indicates WeChat 4.1.11 derives its SQLCipher keys through a
statically-linked OpenSSL/BoringSSL PBKDF2 path rather than the system `CCKeyDerivationPBKDF` symbol
the interposer replaces. Even after login and database open, the current hook would not fire.
`dlsym`-based dynamic resolution is also ruled out because the symbol name is absent from the bundle
strings. That reading was wrong: the audit scope missed every image under `Contents/Resources/`.

**Cause 2 correction (read-only re-audit, 2026-08-10): the hooked symbol IS referenced by the
bundle.** A bundle-wide `nm -u` sweep (387 files; only unrelated VLC media plugins excluded) found
`CCKeyDerivationPBKDF` imported as an undefined — therefore dyld-interposable — symbol by exactly
three images, all under `Contents/Resources/` and all missed by the initial audit:

- `Resources/wechat.dylib` (317 MB, the core logic image);
- `Resources/roam_server.framework/Versions/A/roam_server`;
- `Resources/roam_migration.framework/Versions/A/roam_migration`.

`Resources/wechat.dylib` additionally imports `CCCryptorCreate/Update/Final/Release`,
`CCHmacInit/Update/Final`, and `CC_SHA256_*` — precisely the API surface of SQLCipher's CommonCrypto
crypto provider — and contains `PRAGMA kdf_iter`, `cipher_hmac`, `cipher_settings`,
`rekey_kdf_iter`, and `sqlcipher_export` strings. The main executable is stripped (423 symbols, all
but one undefined) and imports only `CCCrypt`/`CCRandomGenerateBytes` plus SecCode self-check APIs;
the OpenSSL/BoringSSL PBKDF2 strings that misled the initial audit belong to the statically linked
network stack (`mmcronet`). The main executable loads `WCDY.framework`, a runtime `dlopen` loader
(`WCDY::open`, `DylibInfo`), which is how `Resources/wechat.dylib` enters the main process; dyld
interposing applies to dlopen-loaded images as well. Consequence: the interposer's target symbol was
correct all along, no re-targeting is needed, and the Gate G timeout is explained by Cause 1 alone
(the copy stopped at the QR login surface, so `emoticon.db` was never opened and the KDF was never
called). The remaining open question is only whether the `emoticon.db` KDF executes in the main
process (expected) or in a separate `roam_server`-style service process; the state-marker run below
is designed to settle this empirically.

The installed app signature was inspected read-only (`codesign -dvvv` and `--entitlements`): the main
executable carries `flags=0x10000(runtime)` (hardened runtime) and links `Security.framework`; it does
**not** carry `com.apple.security.cs.allow-dyld-environment-variables`. The original app was not
signed, modified, or launched during this diagnosis.

### Required next-step conditions (not started)

Resolving either cause requires changes that must be explicitly authorized and must not widen the
cryptographic filters (16-byte salt equality, `kCCSuccess`, 32-byte derived length, emit-once):

1. The interposer target must match the KDF symbol WeChat 4.1.11 actually calls. **Resolved** by the
   Cause 2 correction above: `Resources/wechat.dylib` imports `CCKeyDerivationPBKDF`, which the
   existing interposer already hooks. The salt/length/success filters stay.
2. The temporary copy must either restore the original login context (requires preserving the original
   entitlements under a valid code identity, which ad-hoc signing cannot provide) or be explicitly
   logged into by the user — but logging into a copy that shares the original bundle identifier risks
   touching the original account's container/Keychain, so session data-container isolation must be
   proven first.

### Recommended fixed, non-secret state markers (synthetic-validated before any real run)

The current interposer has no observability into why no frame was emitted. A future diagnostic should
add a separate fixed-status fd (reusing the Gate F readiness-fd pattern) carrying only non-secret
markers, validated on the synthetic host first:

- `CMIPLOAD` — constructor ran (dylib loaded).
- `CMSALTOK` / `CMSALTNO` — fd 4 target salt received or not.
- `CMIPHIT` — a `CCKeyDerivationPBKDF` (or corrected target symbol) call was intercepted.
- `CMIPSALT_MATCH` / `CMIPSALT_MISS` — call salt matched the target (boolean only; no salt bytes).
- `CMIPLENG32` / `CMIPLENG_OTHER` — observed derived length class.
- `CMIPSENT` — one frame emitted.

These carry no key, salt, password, candidate, account, URL, or database content. They let a single
real run distinguish dylib-not-loaded, salt-not-delivered, no-KDF-call, salt-never-matches,
wrong-length, and fd-3-write failure without any sensitive channel.

### State-marker instrumentation implemented (synthetic GO, 2026-08-10)

The marker channel above was implemented and validated without touching the real app:

- the interposer emits nine fixed 8-byte markers over anonymous fd 7 (non-blocking, best-effort,
  no secret material): `CMIPLOAD`, `CMSALTOK`/`CMSALTNO`, `CMIPHIT0`, `CMIPMTCH`/`CMIPMISS`,
  `CMIPSZ32`/`CMIPSZOT`, `CMIPSENT`. The four candidate filters are unchanged;
- the synthetic host matrix asserts the exact marker sequence for `correct`, `wrong-salt`,
  `wrong-length`, `kdf-failure`, and `mixed` on native arm64 and Rosetta x86_64, plus a
  salt-not-delivered variant covering `CMSALTNO`. The `mixed` expectation encodes the secure-wipe
  behavior: after the single frame is emitted, the target salt is zeroed and `target_ready` is
  cleared, so later calls report `CMIPMISS`;
- the Gate G runner now collects fd 7 into the run report (`markerSequence`,
  `markerInvalidObserved`, `markerLimitReached`) and accepts an extended operational window via
  `WECHAT4_GATE_G_CANDIDATE_TIMEOUT_MS` (window only; cryptographic filters unchanged);
- full baseline re-passed: `phase7:instrumentation:test`, `phase7:helper:test`,
  `phase7:lifecycle:test`, `npm test` (17 files / 73 tests), `format:check`, `typecheck`, `lint`,
  `build`, `phase0:check`, and `git diff --check`.

### Minimum authorization for the next real diagnostic

(Superseded — the steps below were collapsed with the user's explicit in-conversation approval:
state-marker synthetic validation was completed, and the user authorized a single real run in which
they scanned the QR code themselves. Result recorded below.)

### Second real run (2026-08-10): candidate acquired and validated — verified=true

A second real Gate G run was executed with the state-marker dylib, a 10-minute operational window
(`WECHAT4_GATE_G_CANDIDATE_TIMEOUT_MS=600000`), and the user present to scan the QR code on the
temporary copy and open the personal-sticker surface. The run exited 0 with:

- `uniqueEmoticonDatabase=true`, `walSnapshotted=true`, `shmSnapshotted=true`,
  `temporarySignatureVerified=true` — as in the first run.
- Marker journey: `CMIPLOAD` → `CMSALTOK` → many `CMIPHIT0`/`CMIPMISS`/`CMIPSZ32` triples during
  login/sync (WeChat derives keys for many other databases, consistent with per-database keys; some
  calls also fail the KDF itself and emit only `CMIPHIT0`) → one
  `CMIPHIT0`/`CMIPMTCH`/`CMIPSZ32` → exactly one `CMIPSENT`. Every later call reports `CMIPMISS`
  because the target salt is zeroed and `target_ready` is cleared after emit, as designed.
- The candidate passed the helper's salt-equality check, `cipher_integrity_check`, `sqlite_schema`
  query, and `quick_check`: `candidateFrameValid=true`, `cipherIntegrityValidated=true`,
  `schemaQueryValidated=true`, `quickCheckValidated=true`, **`verified=true`**.
- `escapedTemporaryProcessObserved=false`; `cleanupComplete=true`; `originalAppUnchanged=true`;
  `originalAppRestarted=true`; arm64 only. A post-run check found no residual session directories
  and the original app's normal process tree running.
- The marker stream shows a small number of dropped `CMIPHIT0` words (best-effort `O_NONBLOCK`
  channel under call bursts); the channel reported `markerInvalidObserved=false`,
  `markerLimitReached=false`, and the drops never touched the candidate path.

This empirically confirms: the `emoticon.db` KDF executes in the main process (fd 3/4 inheritance
intact), Cause 1 was the sole blocker, and the hook symbol corrected by the Cause 2 re-audit works
on the real bundle. The acquired key was zeroed after validation and never persisted; the snapshot
and the temporary copy were removed. Remaining product-side acquisition facts to record later: the
user must quit WeChat for the copy run, must scan the QR code on the copy, and the original app's
Mac session can be displaced by the copy's login (re-login on the original app restores it).

### Data-side implementation (2026-08-11; synthetic baseline before product acceptance)

The post-Gate-G data path is now implemented and synthetic-tested without re-running WeChat,
touching the network, reading real row content, or persisting a real key:

- a filename/count-only scan found the account-local cache layout
  `business/emoticon/Persist/<first-two-md5>/<md5>` (948 files) and
  `business/emoticon/Thumb/<first-two-md5>/<md5>.thumb` (950 files). All 948 persistent entries had
  a paired thumb and every observed entry matched the two-character shard rule. Account directory
  names and individual MD5 values were not output; file contents were not read during this probe;
- `personalEmoticonsFd` applies the existing salt/HMAC/schema/quick-check validation gate, joins
  `kFavEmoticonOrderTable` and `kCustomEmoticonOrderTable` to `kNonStoreEmoticonTable`, preserves
  favorite-then-custom row order, and de-duplicates by MD5. It does not query any `kStore*` table;
- selected row data uses bounded anonymous fd 4 JSONL only. stdout contains fixed validation flags
  and aggregate counts; stderr, argv, the environment, logs, renderer IPC, and this report never
  receive URL/auth/AES fields or row content;
- `Wechat4StickerSource` snapshots the selected account DB, obtains a candidate through an injected
  Gate G acquisition boundary, validates/reads through the helper, resolves the persistent cache
  first and the thumbnail cache second, then tries HTTPS CDN fields. Encrypted CDN fixtures use
  AES-128-CBC with the key reused as IV and no cipher padding, then validate the recovered image and
  plaintext MD5 before the shared local importer accepts it;
- the adapter reuses `LocalStickerSource`, so SHA-256 de-duplication, image decoding, atomic library
  originals, preview, ordering, pack preparation, and send stages remain source-agnostic. Progress
  and failures use generic numbered labels rather than source paths or URLs;
- `Wechat4KeyStore` stores a successfully revalidated candidate only through Electron `safeStorage`
  (macOS Keychain-backed), mode `0600` beneath a mode `0700` directory. A cached candidate is checked
  against the current snapshot; `KEY_VALIDATION_FAILED` clears it and returns to the injected Gate G
  acquisition callback. Candidate/frame/catalog buffers are cleared after use.

This was the pre-acceptance baseline; the real result is recorded below.

### Real product-UI import acceptance (2026-08-11)

The user explicitly authorized a packaged Electron Gate G/import run. The first product attempt
validated the candidate and read all 928 personal favorites, but resolved no assets. Sanitized
aggregate diagnosis found two independent causes:

- Gate G stopped the temporary WeChat immediately after the candidate appeared, before the user
  could open and finish loading the favorites panel; the adapter then read the snapshot created
  before Gate G, whose personal rows had no usable remote metadata;
- the initial fallback assumed AES-128-ECB. Comparison with an independent implementation and the
  real response behavior established AES-128-CBC, IV equal to the 16-byte key, and no cipher
  padding. The independent project was used only as protocol evidence; its source was not copied,
  and its key/URL file logging design was explicitly not adopted.

The product flow now pauses after candidate validation and requires the user to confirm that the
favorites thumbnails are visible. It then cleans the temporary process group, restores the original
WeChat, creates a fresh DB/WAL/SHM snapshot, and revalidates the cached candidate before importing.
Remote metadata supports multiple URLs per field, HTTPS normalization, `stodownload` filename and
host variants, AES-CBC recovery, plaintext MD5, size limits, and real image decoding. No key, salt,
URL, row, account identifier, or asset bytes entered logs or this report.

The successful packaged run read 928 ordered personal records and added **884** WeChat 4 assets to
the unified library. The collection increased from 155 to 1039 assets and its animated-image count
from 106 to 371. Preview generation, static/animated detection, ordering, selection, manifest save,
and the common library path therefore passed against the real account. The remaining 44 records
were failed or de-duplicated without corrupting the existing collection; per-item content remains
intentionally unreported.

The run also exposed a performance defect: resolution was serial, deterministic HTTP failures were
retried, and one record could spend the timeout budget independently on every URL variant. The
adapter now uses six bounded workers while storing results by database order, does not retry
deterministic HTTP failures, limits transient retries to two, applies a 45-second total record
budget, and reports the resolving phase accurately. Synthetic regression covers out-of-order worker
completion while preserving source order. This optimized build has not needed another real Gate G
run because the successful run already established data compatibility.

## JSONL protocol and errors

`native/wechat4-helper/PROTOCOL.md` defines protocol v1. Stdout contains JSONL only, input/output lines
are limited to 64 KiB, stderr is discarded by the TypeScript runner, and native errors are mapped to
fixed safe messages.

Implemented methods are `probe`, `selfTest`, `validateKey`, `validateCandidateFd`,
`schemaOverviewFd`, `personalEmoticonsFd`, and an explicit blocked `acquireKey`. Error codes include
permission denial, database absence, snapshot
changes, invalid key format, acquisition failure, validation failure, unsupported versions, invalid
requests, and internal errors. Request-level failures remain JSON responses; documented exit codes
are reserved for fatal process states.

## arm64 and x64 evidence

- The helper builds as separate arm64 and x86_64 Mach-O executables and a universal binary.
- Both slices link their matching architecture from the pinned universal SQLCipher static archive.
- Native arm64 and Rosetta x86_64 executions both passed the full synthetic SQLCipher self-test.
- The helper binary is built with a macOS 12 deployment target by the installed Xcode 13.4.1
  toolchain; the product minimum remains macOS 13, so this does not widen product support.
- x64 is still Beta: Rosetta proves build/runtime compatibility on Apple Silicon, not Intel hardware
  behavior or an x64 WeChat key-acquisition flow.

The helper is not yet added to `electron-builder` resources because product integration is gated on
real key acquisition and verification.

## Key acquisition investigation

Reasonable non-invasive alternatives were checked before stopping:

1. The local 4.x `key_info.db` exists, but its key metadata is an opaque high-entropy blob rather
   than a usable raw database key.
2. Static application metadata and entitlements did not reveal a compatible shared Keychain access
   group. Normal Keychain APIs cannot make an independently signed app join WeChat's identity.
3. Public material indicates that 4.1.x may use per-database keys, so the design does not assume one
   account-wide key.
4. Direct LLDB/Mach memory attach would require debugger/process privileges and is inside the
   explicitly prohibited-without-confirmation boundary.

The user-provided reference uses another route: wait for the original WeChat to exit, copy
`WeChat.app`, ad-hoc sign the copy, enable DYLD environment loading, inject a small library into the
copy, and intercept SQLCipher key/KDF calls at startup. This avoids modifying the original app and can
avoid `sudo`/SIP changes, but it is still temporary signing plus process injection.

This project will not inherit the reference implementation's unsafe details. An independent version,
if approved, would instead:

- use a session-scoped copy and delete it after the attempt;
- send candidate key bytes over an anonymous pipe, never a file, stdout, argv, environment, or log;
- never log account IDs, database keys, database paths, or URLs;
- validate the candidate against the controlled snapshot before any success response or cache write;
- terminate the entire copy process group, not just one PID;
- preserve and never sign or edit `/Applications/WeChat.app`;
- default to no key persistence; Keychain caching comes only after real verification.

## Permissions and user actions

The current safe spike required only read access already available to the standard WeChat container.
A distributed Electron build may need the user to select `xwechat_files` or grant the corresponding
file access. `EACCES`/`EPERM` must result in understandable permission guidance; Full Disk Access must
never be granted programmatically.

The proposed copy/injection acquisition route may require:

- the user to quit WeChat normally and confirm no WeChat processes remain;
- a temporary copy of the app in a project-controlled private directory;
- ad-hoc signing of that copy with a narrowly scoped entitlement that permits DYLD environment
  variables;
- launching that copy long enough to initialize the target encrypted DB;
- possible macOS file-access, Keychain, login, or TCC prompts because the copy has a different code
  identity.

It would not require modifying the original app, disabling SIP, or using `sudo` in the reference
route, but this must be proven independently. The user has authorized a future narrowly bounded
temporary-copy PoC, including ad-hoc signing and minimal local runtime instrumentation if
non-instrumented alternatives remain unavailable. The current requested stage intentionally stopped
after synthetic instrumentation and before any real signing, injection, launch, database read, or
key access. The real execution should remain a distinct, explicitly confirmed step.

## Known risks

- WeChat updates can change initialization symbols, SQLCipher settings, per-database key behavior,
  code-signing behavior, or the `emoticon.db` schema.
- A copied/ad-hoc-signed app can trigger new authorization prompts or fail to reuse the normal login
  context.
- The lifecycle guarantee currently covers every process that remains in the launched POSIX process
  group. A future real-copy test must detect whether WeChat creates detached, launchd, or XPC helper
  processes and add explicit PID-lineage/session-marker cleanup before claiming a complete app
  process-tree guarantee.
- This sandbox denied negative-PGID signals for the DYLD-injected, childless synthetic host. That
  test alone uses an explicit leader-only fallback, where leader and complete group are identical;
  the separate descendant lifecycle fixture still verifies normal full-group TERM-to-KILL cleanup.
  A real app flow must not enable the fallback and remains blocked until complete process-tree
  cleanup is demonstrated.
- Injection can fail under hardened runtime, SIP, or future DYLD restrictions even when the original
  app is untouched.
- Running DB copies can change between file copies; bounded fingerprint retries reduce but cannot
  make three independent copies atomic.
- Real CDN field behavior and encrypted-asset compatibility still need user-authorized manual
  acceptance. Official sticker packs/StickerHub remain outside this Phase 7 vertical slice.
- Global library hash deduplication currently retains the first source attribution; multi-source
  provenance is still a Phase 8 manifest concern.

## Conclusion

- Real WeChat 4.x layout discovery: **GO**.
- Controlled DB + WAL/SHM snapshot and cleanup: **GO**.
- Session-scoped app copy and complete cleanup: **GO (copy only; no signing or launch)**.
- Independent process group and anonymous candidate pipe: **GO on synthetic fixtures**.
- Independent SQLCipher helper protocol and strong synthetic validation: **GO**.
- Binary fd candidate validation without JSON/argv/env key material: **GO on synthetic fixtures**.
- Universal C PBKDF instrumentation and synthetic host matrix: **GO on synthetic fixtures only**.
- Real temporary-copy readiness/signing/load/cleanup Gate F: **GO without key acquisition**.
- Real candidate acquisition Gate G, first run: **CANDIDATE_TIMEOUT** (Cause 1: entitlement
  stripping blocks login restore). The initial Cause 2 (hooked `CCKeyDerivationPBKDF` not referenced
  by the installed bundle) was **refuted** by a corrected read-only re-audit:
  `Resources/wechat.dylib` imports the symbol; no hook re-targeting was needed.
- State-marker dylib (fd 7) and synthetic sequence matrix: **GO on synthetic fixtures**.
- Real candidate acquisition Gate G, second run (marker dylib + user QR login): **GO — one candidate
  frame acquired and validated; `verified=true`**.
- arm64 build/runtime: **GO**.
- x64 build and Rosetta fixture runtime: **GO for Beta build compatibility**.
- Real non-invasive key acquisition: **GO (single successful real run; key zeroed after
  validation, not persisted)**.
- Real `emoticon.db` HMAC/query validation: **GO**.
- Phase 7 product integration: **GO on one real packaged single-account import**; the explicit-consent renderer flow is
  wired to the main-process Gate G acquirer, account-isolated safeStorage caching and stale-key
  reacquisition are covered, and the universal helper/interposer are present in a generated macOS
  directory package. The real run added 884 validated WeChat 4 assets from 928 ordered records.
- Overall Phase 7 spike: **GO**.

The current automated application baseline is 22 test files / 87 tests. The additional native
instrumentation gate passes outside the Vitest count. After the Gate G run, the full regression was
re-run and passed: `format:check`, `typecheck`, `lint`, `git diff --check`,
`phase7:instrumentation:test`, `phase7:helper:test`, `phase7:lifecycle:test`, `npm test` (22/87),
and `npm run build`. A 2026-08-11 `package:mac` directory build also completed; its packaged helper
and interposer are executable universal `arm64 + x86_64` files under
`Contents/Resources/wechat4-native/`, and both pass strict ad-hoc code-signature verification.
Developer ID signing/notarization remains a release-stage task. The previously recorded copy-only
smoke remains separate and was not run during the Gate G diagnosis.

## Manual verification still required

Safe checks available now:

```bash
npm run phase7:helper:build
npm run phase7:helper:test
npm run phase7:instrumentation:test
npm run phase7:lifecycle:test
npm run phase7:app-copy:test
npm run phase7:inspect
```

Expected synthetic results: both helper architectures pass correct/wrong/tamper/WAL checks; the C
host/dylib matrix filters calls and validates its positive candidate through Swift; cancellation and
timeout remove the synthetic process and fixture session; and all temporary secret-bearing buffers
are cleared. The app-copy and sanitized real-layout checks are intentionally outside this command.

The user chose option 1 in-conversation (2026-08-10): proceed with the bounded independent
temporary-copy + ad-hoc signing + minimal instrumentation PoC. The second real run validated the
real database (`verified=true`), so the remaining manual acceptance is:

- verify the installed WeChat/macOS version shown to the user;
- verify normal quit/relaunch behavior and all authorization prompts (partially observed across the
  two runs: SIGTERM quit, relaunch, and full cleanup succeeded; a displaced original-app session
  re-logs in normally);
- verify one or more real accounts without exposing IDs (account isolation and stale-key eviction
  are covered with synthetic regression tests);
- verify a stale/wrong real key is detected;
- import personal favorites into the unified library (**verified for one real account: 884 added**);
- inspect preview, duplicates, and ordering (**verified**); pack preparation and WhatsApp delivery
  remain outside the data-side acceptance;
- verify the temporary copy, injected library, key buffers, DB snapshot, and complete process group
  are removed after success, failure, cancellation, and timeout (success-path cleanup verified in
  the real run; failure/cancellation/timeout paths verified on synthetic fixtures only).
