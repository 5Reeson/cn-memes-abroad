# WeChat 4 helper JSONL protocol v1

The helper reads one UTF-8 JSON object per line from stdin and writes exactly one JSON object per
request to stdout. Lines are limited to 64 KiB. Secrets are never accepted through argv or the
environment, and stdout never returns a key.

## Envelope

Request:

```json
{ "v": 1, "id": "opaque-request-id", "method": "probe", "params": {} }
```

Success:

```json
{ "v": 1, "id": "opaque-request-id", "ok": true, "result": {} }
```

Failure:

```json
{
  "v": 1,
  "id": "opaque-request-id",
  "ok": false,
  "error": { "code": "INVALID_REQUEST", "message": "fixed safe message", "retryable": false }
}
```

Implemented spike methods:

- `probe`: returns architecture, minimum macOS version, SQLCipher version, and capabilities.
- `selfTest`: creates only synthetic encrypted fixtures in a mode-`0700` temporary directory and
  verifies the correct key, wrong-key rejection, tamper rejection, and a live WAL snapshot.
- `validateKey`: accepts `databasePath` and `keyHex` in `params`. `keyHex` must be exactly 64 hex
  characters. The helper opens the caller-controlled snapshot read-only, performs SQLCipher page
  HMAC validation, queries `sqlite_schema`, then runs `quick_check`. A matching string alone is never
  treated as proof.
- `validateCandidateFd`: one-shot native-boundary validation for real acquisition. The JSON request
  contains only `databasePath`; fd 3 carries one fixed 56-byte binary frame (magic/version/role,
  16-byte database salt, and 32 candidate bytes). The helper compares the frame salt with the
  snapshot header, zeroes frame/key buffers, and returns only fixed validation booleans. Candidate
  bytes and database query results never enter JSON, argv, the environment, stdout, or stderr.
- `schemaOverviewFd`: sanitized schema inspection for the post-validation stage. The JSON request
  contains only `databasePath`; the key arrives only through the same fd 3 candidate frame and is
  zeroed after use. The candidate must pass the full validation gate (salt match,
  `cipher_integrity_check`, `sqlite_schema`, `quick_check`) before any schema query runs. The result
  carries only structural metadata — table/view names, column names/types/flags, aggregate row
  counts, and index/trigger counts. Row content is never queried or returned.
- `personalEmoticonsFd`: minimum-scope product read after the same full validation gate. The JSON
  request contains only `databasePath`; fd 3 carries the candidate frame. The helper joins
  `kFavEmoticonOrderTable` and `kCustomEmoticonOrderTable` to `kNonStoreEmoticonTable`, de-duplicates
  by MD5 while preserving favorite-then-custom row order, and writes only those selected records as
  bounded JSONL to anonymous fd 4. URL/auth/AES fields never enter stdout, stderr, argv, the
  environment, or logs. Stdout returns fixed validation booleans and aggregate counts only.
- `storeEmoticonsFd`: read-only product boundary for installed official sticker packs after the
  same full validation gate. It joins `kStoreEmoticonPackageTable` to
  `kStoreEmoticonFilesTable` and streams the user-facing package name, package/member identifiers, ordering/status,
  `PersistStore`/`ThumbStore` byte ranges, plus boolean remote-metadata availability over bounded
  fd 4 JSONL. Package descriptions, URLs, AES values, and row content outside that minimum catalog
  never cross the helper boundary; stdout contains only aggregate package/member counts.
- `acquireKey`: currently returns `KEY_ACQUISITION_FAILED`. It intentionally does not attach to,
  inject into, copy/re-sign, or launch WeChat.

Production integration must combine acquisition and validation inside the helper so the key never
crosses Electron IPC. The explicit `validateKey` key input exists only to unblock this technical
spike and manual validation.

The TypeScript product boundary may cache a successfully revalidated candidate only through
Electron `safeStorage` on macOS (Keychain-backed). A cache miss or validation failure returns to the
existing Gate G acquisition flow; plaintext candidate bytes are cleared after each attempt.
The separate 16-byte official-container key follows the same account-isolated `safeStorage`
boundary, is accepted only after every local container/member MD5 validates, and is cleared and
re-derived when validation fails.

## Error codes

- `PERMISSION_DENIED`
- `DATABASE_NOT_FOUND`
- `SNAPSHOT_CHANGED`
- `KEY_FORMAT_INVALID`
- `KEY_ACQUISITION_FAILED`
- `KEY_VALIDATION_FAILED`
- `UNSUPPORTED_WECHAT_VERSION`
- `INVALID_REQUEST`
- `INTERNAL`

## Process exit codes

- `0`: clean EOF/shutdown; request-level failures are represented in JSON.
- `2`: fatal protocol/framing error.
- `3`: unsupported platform or architecture (reserved).
- `4`: startup permission failure (reserved).
- `5`: database not found (reserved for one-shot mode).
- `6`: key acquisition failure (reserved for one-shot mode).
- `7`: key validation failure (reserved for one-shot mode).
- `8`: internal startup failure.
