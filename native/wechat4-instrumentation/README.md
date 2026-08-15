# WeChat 4 synthetic instrumentation gate

This directory contains only a project-controlled C dylib and synthetic host. It must never read,
copy, launch, sign, modify, or inject a real application or user database. Passing this gate is a
**synthetic-only GO** and is not evidence that real WeChat key acquisition works.

## Design

- The dylib uses dyld interposing for `CCKeyDerivationPBKDF` only. It does not intercept any other
  cryptographic, Keychain, network, or file API.
- fd 4 carries the 16-byte target salt from the TypeScript parent to the dylib.
- fd 5 carries the 16-byte per-call test salt from the TypeScript parent to the synthetic host.
- fd 3 carries at most one 56-byte `CMK1` candidate frame from the dylib to the parent.
- fd 7 carries fixed 8-byte non-secret state markers from the dylib to the parent (see below).
- A frame is emitted only after the real system PBKDF succeeds, the salt is exactly 16 bytes and
  matches fd 4, and the derived output is exactly 32 bytes. The hook never copies the password.
- The frame, hook salt state, host password/output, parent-side write buffers, and candidate objects
  are zero-filled when their owners finish using them.

### State markers (fd 7)

The marker channel exists so a single run can distinguish dylib-not-loaded, salt-not-delivered,
no-KDF-call, salt-never-matches, wrong-length, and fd-3-write failure without any sensitive
channel. Every marker is a constant 8-byte ASCII word; none carries key, salt, password,
candidate, account, URL, or database content. Marker writes are best-effort on an `O_NONBLOCK`
descriptor, so a full or closed marker pipe can never stall the cryptographic pass-through path.
The four candidate filters (KDF success, 16-byte salt equality with fd 4, 32-byte derived length,
emit-once) are unchanged by the marker channel.

| Marker     | Meaning                                                      |
| ---------- | ------------------------------------------------------------ |
| `CMIPLOAD` | dylib constructor ran (image loaded into the process)        |
| `CMSALTOK` | fd 4 target salt received                                    |
| `CMSALTNO` | fd 4 delivered no salt                                       |
| `CMIPHIT0` | a `CCKeyDerivationPBKDF` call was intercepted                |
| `CMIPMTCH` | intercepted call salt matched the fd 4 target (boolean only) |
| `CMIPMISS` | intercepted call salt did not match                          |
| `CMIPSZ32` | observed derived length was 32 bytes                         |
| `CMIPSZOT` | observed derived length was not 32 bytes                     |
| `CMIPSENT` | one candidate frame was emitted on fd 3                      |

The host matrix covers `correct`, `wrong-salt`, `wrong-length`, `kdf-failure`, and `mixed`. The
positive candidate is checked against a project-created SQLCipher fixture by the existing Swift
`validateCandidateFd` path, including salt equality, `cipher_integrity_check`, a minimal
`sqlite_schema` query, and `quick_check`. Cancellation, operation timeout, and an ignored SIGTERM
exercise the bounded TERM-to-KILL cleanup path. Every mode also asserts its exact fd 7 marker
sequence, including a salt-not-delivered variant that exercises `CMSALTNO`.

`Sources/ReadinessProbe/probe.c` is a separate Gate F artifact. It has no interpose section and does
not call any cryptographic, file, Keychain, or network API. Its constructor only writes the fixed,
non-secret `CMRDY001` marker to anonymous fd 6. The real-copy dry run is deliberately a separate
command because it quits/restarts the original app and ad-hoc signs only a session-scoped copy:

```sh
npm run phase7:load-gate:test
```

That command is not part of the synthetic baseline and must never be treated as key acquisition.

Build:

```sh
sh native/wechat4-instrumentation/build.sh
```

Or build and run the full synthetic gate:

```sh
npm run phase7:instrumentation:test
```

The build compiles arm64 and x86_64 slices separately, then combines universal dylib and host
binaries with `lipo`. Generated binaries stay under `build/` and are ignored by Git. Each test run
copies the required thin binaries and fixture into a private session directory, then removes the
fixture, dylib, host, sidecars, and session directory after success or failure.
