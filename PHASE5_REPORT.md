# Phase 5 report: experimental macOS packaging

Date: 2026-08-10

Status: GO FOR INTERNAL USE

## Packaging flow

- Keep the existing `package:mac` directory build and add explicit `package:mac:arm64` and
  `package:mac:x64` commands for experimental DMG and ZIP artifacts.
- Disable signing for this internal phase with `identity: null`. Signing and notarization remain a
  Phase 8 release task.
- Name artifacts with the app version and target architecture so arm64 and x64 outputs cannot be
  confused.
- Before an x64 build on Apple Silicon, temporarily move the host arm64 Sharp optional packages out
  of `node_modules`, install the pinned x64 Sharp packages without changing the manifest or lockfile,
  and restore the arm64 packages in a `finally` block after the build.

## Toolchain and locked runtime dependencies

- Node.js `22.15.0`
- Electron `43.3.0`
- electron-builder `26.15.3`
- Sharp `0.34.5`
- `@whiskeysockets/baileys` `7.0.0-rc14`

## Artifacts

Artifacts are generated under `dist/` and remain ignored by Git.

| Artifact                          |       Bytes | SHA-256                                                            |
| --------------------------------- | ----------: | ------------------------------------------------------------------ |
| `cn-memes-abroad-0.0.0-arm64.dmg` | 136,569,831 | `b3c44025adf9544c01631f57cbc49eeb88c7f3ab3ac8b6f75407e8bdc78efb2d` |
| `cn-memes-abroad-0.0.0-arm64.zip` | 136,717,006 | `962585e1cf7a99adcb404e3eb984ba2b49a05cda5f209e4f1c4ca0ec3f50353a` |
| `cn-memes-abroad-0.0.0-x64.dmg`   | 139,382,998 | `1cbb90050569d392a6f8ad6894943b7b4f9453720a83e0cf016c493e3e131e00` |
| `cn-memes-abroad-0.0.0-x64.zip`   | 139,569,652 | `c5504795b5e8e1f730bd1a9c5c71eec0b7959ef06ae22087df66a173fdd6cc07` |

## Verification completed

- `format:check`, `typecheck`, `lint`, all 9 test files / 44 tests, `build`, and
  `phase0:check` pass after the cross-architecture build cycle.
- The arm64 app executable, Sharp addon, and libvips library are arm64 Mach-O files. The x64
  equivalents are x86_64 Mach-O files.
- The rebuilt x64 ZIP contains only `sharp-darwin-x64` and `sharp-libvips-darwin-x64`; it contains no
  arm64 Sharp package. The arm64 ZIP contains only the matching arm64 packages.
- Both packaged executables loaded their bundled Sharp runtime and converted a generated three-frame
  GIF into a 512 x 512, three-frame animated WebP with delays `[80, 120, 160]`.
- The application ASAR has only the expected top-level `out`, `node_modules`, and `package.json`
  entries. It contains no application session, library, logs, `.phase0` data, or user sticker files.
- The packaged Baileys patch still maps `StickerPackMessage` to `sticker_pack`, and the production
  Main bundle still contains the `/mms/sticker-pack` upload path and native `StickerPackMessage`
  construction.
- A fresh arm64 launch with an isolated temporary profile created an empty schema-v1 collection and
  no WhatsApp session. SHA-256 snapshots of the real `library` and `whatsapp` directories were
  identical immediately before and after this test.
- The user manually opened the arm64 package and confirmed that it starts and loads the existing
  collection. The user also launched the x64 Beta package under Rosetta.

## Session and Keychain behavior

The development app and packaged app currently share the same bundle/app identity and therefore the
same Electron `userData` directory. Seeing an existing collection and WhatsApp login in the packaged
arm64 app is expected. The session was not copied into the installer: an isolated profile starts
empty, and archive inspection found no user data.

The WhatsApp auth state is stored as an encrypted file under `userData`. Electron `safeStorage`
keeps the encryption key in macOS Keychain; it does not put the entire changing Baileys session in
Keychain. An unsigned or differently identified build can trigger a macOS Keychain authorization
prompt when it tries to reuse that key. Stable Developer ID signing is expected to make upgrades
retain a consistent code identity and avoid repeated prompts in the normal path.

## Known limitations

- These packages are unsigned and not notarized. Gatekeeper and Keychain prompts are expected and
  are not representative of the final distribution experience.
- The default Electron icon is still used.
- x64 is Beta and has only been smoke-tested under Rosetta on an Apple Silicon Mac; no Intel hardware
  test has been performed.
- ASAR currently includes some browser-only dependency files that can be pruned later. Package size
  optimization is not a Phase 5 release gate.
- Group-target native pack delivery remains the outstanding Phase 4 phone-side acceptance item; it
  is not a packaging defect and does not block starting Phase 6.
- Public distribution still requires signing, notarization, privacy/third-party notices, and a final
  dependency-license decision.

## Conclusion

Phase 5 is GO for internal testing. Both architecture artifacts are reproducible, architecture-clean,
free of user data, able to run the packaged native media dependency, and have passed the available
Mac launch smoke tests. Formal public release remains intentionally deferred to Phase 8.
