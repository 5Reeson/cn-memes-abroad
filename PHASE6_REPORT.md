# Phase 6 report: Legacy `fav.archive` adapter

Date: 2026-08-10

Status: GO

## Development-machine evidence

- Installed WeChat version: `3.4.1` (`CFBundleVersion` `21939`)
- Bundle identifier: `com.tencent.xinWeChat`
- The version was read directly from the installed application's `Info.plist`; WeChat was not
  opened, clicked, or automated.
- Read-only discovery found two valid Legacy account archives. Sanitized inspection reported 122 and
  928 unique HTTP(S) sticker URLs, with no archive parse failure. No URL, complete account directory,
  or sticker content was logged or committed.

## Private migration backup record

Before upgrading WeChat, the two complete Legacy `Stickers` directories were copied to a private
desktop backup on 2026-08-10. Full 32-character account directory names are deliberately redacted
from this open-source report.

- Installed version at backup time: WeChat `3.4.1` (`CFBundleVersion` `21939`).
- Planned upgrade after Phase 6 acceptance: WeChat `4.1.11` from the Mac App Store. This was the
  planned target, not the installed version at backup time.
- Original account A (122 archive URLs):
  `~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9/<redacted-account-A>/Stickers`
- Original account B (928 archive URLs):
  `~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9/<redacted-account-B>/Stickers`
- Backup root: `~/Desktop/0810微信3.x版本数据表情包数据备份`
- Private full-path map (outside Git):
  `~/Desktop/0810微信3.x版本数据表情包数据备份/Phase6备份路径与版本说明.txt`
- Backup account A: `~/Desktop/0810微信3.x版本数据表情包数据备份/微信账号-A-122张/Stickers`
- Backup account B: `~/Desktop/0810微信3.x版本数据表情包数据备份/微信账号-B-928张/Stickers`

The backup contains 665 files for account A and 10,750 files for account B. Both source trees had no
symbolic links. Recursive byte comparison passed after copying, and the two backup account
directories are mode `0700`. This backup contains private user data and must never be added to Git or
distributed with the application.

## Implemented flow

- Discover 32-character account directories below the standard WeChat 3.x macOS container and look
  only for regular `Stickers/fav.archive` files. Symlinks are not followed.
- Convert the binary NSKeyedArchive plist to XML with the macOS system `plutil` executable. JSON is
  deliberately not used because the UID objects in the archive are not JSON-compatible.
- Independently extract HTTP(S) strings in archive order, decode XML entities, reject embedded URL
  credentials, and remove exact duplicate URLs while preserving the first occurrence.
- Return only a stable hashed account ID, a short local label, sticker count, and archive byte size to
  the renderer. Archive paths and URLs never cross the preload boundary.
- Provide `npm run phase6:inspect -- --root <path>` as a read-only, sanitized JSON diagnostic entry.
  It shares the same discovery/parser implementation as Electron and is not a separate product CLI.
- Offer three explicit download policies: Default uses one worker with a random 0.5-1.5 second gap,
  Fast uses four workers without an added gap, and Safe uses one worker with a random 1.5-3.5 second
  gap. Every policy keeps the 20-second request timeout, three bounded attempts, redirects enabled,
  and a 20MB per-image safety limit. Errors never contain the original signed sticker URL.
- Show download and image-validation as separate progress phases, each using the real sticker count.
  Closing the Legacy panel during an import aborts active requests and waits, removes temporary files
  and any managed originals created by the canceled transaction, and leaves the manifest unchanged.
- Write downloads to a mode-`0700` temporary directory with mode-`0600` files, decode by actual image
  content using the existing local importer, copy valid originals into the managed library, and
  always remove the temporary directory.
- Attribute imported assets as `wechat-legacy` with the stable source account ID. Hash duplicate
  detection, manifest persistence, selection, preview, sorting, conversion, packing, and WhatsApp
  delivery reuse the existing application pipeline.
- Enable a minimal **Legacy Beta** Electron panel. Account discovery is read-only; network download
  starts only after the user clicks **导入这个账号**.

## Automated verification

- Parser tests cover URL order, XML entity decoding, exact URL deduplication, invalid URL handling,
  and rejection of embedded credentials.
- Adapter tests cover account-directory filtering, absence of archive paths in renderer-facing data,
  static and animated image decoding, content-hash deduplication, corrupt image failure, source
  attribution, staged progress, request cancellation, and rollback of uncommitted originals.
- Existing manifest, local import, pack preparation, WhatsApp auth/receipt, and native pack tests
  remain green.
- The Electron UI was opened against the real development profile and visually checked. It displayed
  the two sanitized account choices and their 122/928 counts. No real import button was clicked.

## Manual acceptance result

The user completed the real-account acceptance flow with the 122-item account on 2026-08-10:

- Discovery showed the expected 122- and 928-item accounts.
- Default-speed import displayed the real `x / 122` download count rather than combined internal
  work units.
- Closing the panel during download stopped the task, displayed the five-second dismissal notice,
  and did not continue progressing after the panel was reopened.
- A subsequent full import moved from the download phase to image validation and produced real
  imported, duplicate, and failed counts.
- The download-rate information and revised Default/Safe ranges were visible and behaved as
  specified.

## Known limitations

- Automatic discovery currently targets the standard `2.0b4.0.9` WeChat 3.x container. A manual
  archive picker can be added if a real Legacy installation uses a different layout.
- Import operates on the complete selected account. Per-sticker preview/selection before download and
  resumable partial imports are not part of this first vertical slice.
- Sticker URLs are maintained by WeChat and may expire. The app reports bounded download failures but
  cannot renew a stale URL.
- WeChat does not publish a rate limit for these archive URLs. The Default and Safe policies reduce
  request bursts but cannot guarantee that server-side throttling will never occur.
- The current parser intentionally uses the macOS system `plutil`; the application is macOS-only.
- Phase 7's WeChat 4.x encrypted database and key helper are separate and are not implemented here.

## Conclusion

Phase 6 is GO. Read-only discovery and archive parsing passed on the installed WeChat 3.4.1 data,
and the user completed a real CDN download, cancellation, reopened import, validation, and library
import flow. The adapter reuses the already verified manifest, conversion, packing, and WhatsApp
delivery pipeline rather than introducing a parallel implementation.
