# WeChat 4 read-only helper spike

This is a thin macOS helper for Phase 7. It links a pinned, checksum-verified universal static build
of SQLCipher Community and communicates over versioned JSON Lines on stdin/stdout. The generated C
amalgamation is not stored in this repository; the prebuilt archive's complete lock and reproducible
build procedure live under `prebuilt/sqlcipher/macos-universal/`.

The spike deliberately does not attach to WeChat, inject code, use `sudo`, modify or re-sign
`WeChat.app`, or return a database key. A caller-supplied 64-hex key is accepted only by the
`validateKey` PoC method over stdin so the independent database-verification path can be tested.
The production-shaped `validateCandidateFd` method instead accepts one binary candidate frame only
through anonymous fd 3; its JSON request contains the controlled snapshot path but no key material.
`schemaOverviewFd` reuses the same fd 3 candidate frame for the post-validation stage: after the
candidate passes the full validation gate it returns only sanitized structural metadata (table/view
names, column names/types, aggregate row counts); row content is never queried or returned.
`personalEmoticonsFd` applies that same validation gate, then streams only the minimum personal
favorite/custom rows over anonymous fd 4. Sensitive row fields never use stdout/stderr, argv, the
environment, or logs; stdout contains aggregate counts and fixed validation booleans only.
`storeEmoticonsFd` is the corresponding read-only product boundary for installed official packs:
it returns only identifiers, ordering/status, container byte ranges, and remote-metadata presence
over fd 4. It does not decrypt or export `PersistStore`/`ThumbStore` payloads; the main process uses
those bounded ranges to validate an account-scoped local container key before staging images.

Build and test:

```sh
npm run phase7:helper:build
npm run phase7:helper:test
npm run phase7:lifecycle:test
```

`wechat4-fixture-maker` is a test-only companion binary. It creates a synthetic SQLCipher database
only beneath a private temporary directory, is never packaged with the Electron product, and never
opens WeChat data. The lifecycle test passes a generated key through an anonymous pipe and exercises
success, malformed-frame failure, cancellation, and timeout cleanup of a detached process group,
including the case where the group leader exits before a descendant that ignores `SIGTERM`.
The arm64 and x86_64 helper slices also validate a correct synthetic fd candidate and reject wrong
salt/key frames. The TypeScript runner zeroes the caller's frame after success, failure, and timeout.

Generated binaries and object files stay under `build/` and are ignored by Git.
