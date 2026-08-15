# Phase 4 report: desktop WhatsApp delivery

Date: 2026-08-08

Status: READY FOR MANUAL ACCEPTANCE

## Implemented flow

- Connect WhatsApp from the Electron renderer using either an on-screen QR code or a phone pairing
  code. Connection events stay in the Main process and the renderer receives a small typed status
  view over preload IPC.
- Keep the desktop session separate from the Phase 0 CLI. The desktop auth state is serialized into
  one `session.enc` file under Electron `userData`, encrypted with Electron `safeStorage` backed by
  macOS Keychain. The directory uses mode `0700` and the file uses `0600`.
- Do not make a WhatsApp network connection automatically on app launch. A saved session is reused
  only after the user clicks Connect.
- Select the user's own chat by default after connection. Group metadata is not requested until the
  user explicitly clicks **读取其他群聊**. Loaded groups can then be searched and selected.
- Re-prepare packs from the stable Phase 3 plan and cache before sending. Packs are uploaded and
  relayed sequentially as native `StickerPackMessage` messages, preserving preview order; individual
  sticker messages are not used.
- Show per-pack uploading, sent, skipped, and failed status. A retry sends only failed pack IDs.
- Persist successful receipts across restarts. Receipt keys hash the target JID with SHA-256, so the
  receipt file does not contain a full phone number or group JID. Already successful target/pack
  pairs are skipped instead of duplicated.
- Allow disconnecting while retaining the encrypted session, or explicitly logging out and clearing
  only the WhatsApp session without deleting the sticker library.

## Locked dependencies

- Electron `43.3.0`
- `@whiskeysockets/baileys` `7.0.0-rc14`
- `libsignal` `6.0.0` (Baileys dependency)
- `fflate` `0.8.2`
- `qrcode` `1.5.4`
- `sharp` `0.34.5`

No new runtime dependency was added in Phase 4. This reuses the exact adapter and native pack media
path that passed the Phase 0 phone test. As recorded in the Phase 0 report, the current Baileys
dependency graph includes GPL `libsignal`; the user accepted mainstream open-source licenses for the
technical stack, and distribution licensing still requires a dedicated review before public release.

## Automated and local verification

- Encrypted auth tests cover credential and signal-key round-trip, absence of plaintext credential
  markers on disk, `0600` permissions, session clearing, and Baileys QR-linked credentials where
  `me` plus `account` are present even though `registered` remains false.
- Receipt tests cover restart persistence, target-JID hashing, and `0600` permissions.
- Native payload tests cover ordered ZIP entries, tray inclusion, and the 252×252 thumbnail.
- Existing manifest, local import, splitter, static/animated converter, and cache tests remain green.
- The local Electron UI was inspected without connecting an account: the WhatsApp panel appears only
  after a legal pack plan, the default privacy explanation is visible, pairing input is opt-in, and
  prepared static/animated packs keep their ready state.
- After the first real-account acceptance run, the packaged app was fully quit and relaunched against
  the saved encrypted QR session. It correctly showed **复用已保存的登录** instead of asking to display
  another QR code. A phone-side reconnect remains part of user acceptance.

## Manual acceptance still required

1. Connect a real test account by QR or pairing code and confirm the UI reaches **已连接**.
2. Confirm **给自己发** is selected before any group list is loaded.
3. Click **读取其他群聊**, search, and select one test group.
4. Send prepared packs first to self and confirm every phone message opens as one addable native pack
   with the same order as the desktop preview.
5. Send to the selected test group and perform the same phone-side check.
6. Restart the desktop app, reconnect without QR, and confirm a successful target/pack pair is skipped
   rather than sent twice.
7. If a pack fails, use **重试失败的包** and confirm successful packs are not repeated.

## Known boundaries

- This is an unofficial WhatsApp Web integration over a private protocol. A future protocol or
  adapter update can break login, upload, or message relay and requires another real-phone test.
- The POC exposes self-chat and joined groups, not every one-to-one contact.
- Sending is deliberately sequential and user-triggered. There is no background queue, scheduler, or
  bulk-broadcast mode.
- A receipt means WhatsApp accepted the relay call; the app cannot verify that the recipient later
  added the pack to the phone sticker tray.
- The build remains unsigned and uses the default Electron icon. Signing, notarization, and release
  packaging belong to later phases.

## Conclusion

The desktop implementation is ready for a real-account Phase 4 acceptance pass. Final GO remains
pending until the user confirms QR/session reuse, opt-in group loading, native pack addability, order,
and retry behavior on a phone.
