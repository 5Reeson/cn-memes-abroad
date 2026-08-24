# WeChat 4 official sticker-pack research

Date: 2026-08-22  
Observed client: macOS WeChat 4.1.11 (build 269136)  
Scope: read-only official-sticker catalog/cache research plus three explicitly authorized Gate 8
temporary-copy sessions

## Decision

**GO for a local-only decoder prototype.** The current account's local official-pack catalog and
encrypted media can both be read without StickerHub or another remote service.

The decisive offline validation used the current session's bounded `kvcomm` filename metadata and
the account directory name to derive a candidate 16-byte container key. Exactly one candidate
decrypted an image header. The same key then decrypted all 19 installed `PersistStore` containers,
and all 368 declared member ranges matched their database MD5 values.

The local product path now includes account-isolated Keychain storage, bounded one-container-at-a-
time decryption, full member-MD5 validation, stale-key invalidation, and shared image decoding. The
remaining work is renderer design plus coverage on a second current account/client version.

## What the reference project's UI proves

The left-side official-album list in
[liusheng22/export-wechat-emoji](https://github.com/liusheng22/export-wechat-emoji) is built from the
local decrypted `emoticon.db`: active package IDs, package names, ordered members, and counts come
from the local store tables. The 19 albums visible in the supplied screenshot match the 19 packages
found in the current local account.

The reference project has three separate boundaries which can look like one login flow in the UI:

1. Its macOS “去授权” action opens a native folder picker for WeChat's data directory and stores a
   security-scoped bookmark. This is filesystem access authorization, not QR authentication.
2. A logged-in temporary WeChat copy/key-dumper path is used when the encrypted database key must be
   acquired. This is the closest analogue to this project's verified Gate G/Gate 8 experiments.
3. After the catalog is local, StickerHub supplies preview/download URLs for official members that
   the reference project does not decrypt from `PersistStore` itself.

Therefore the reference helps by confirming the local catalog schema and the correct separation of
permissions, database-key acquisition, and media resolution. It does not show that QR login returns
the user's installed official packs from a public WeChat API.

## Confirmed storage model

Official installed packs are separate from personal favorite/custom stickers:

- `kStoreEmoticonPackageTable` contains package metadata and install state.
- `kStoreEmoticonFilesTable` contains members, order, and full/thumbnail byte ranges.
- `kStoreEmoticonCaptionsTable` contains localized member captions.
- `PersistStore/<shard>/<md5(package_id)>` is one encrypted full-size container per installed pack.
- `ThumbStore/<shard>/<md5(package_id)>` is the corresponding encrypted thumbnail container.

The existing product reader intentionally queries only favorite/custom order tables joined to
`kNonStoreEmoticonTable`, so installed official packs are correctly absent from the current library.

## Real read-only catalog result

The catalog probe reused the app's Keychain-backed database candidates. It did not run a login gate,
send messages, modify WeChat files, or persist media. Database snapshots were deleted and candidate
buffers were zeroed after use.

| Anonymous account | Installed packages | Members | Container files | Valid full ranges | Valid thumb ranges |
| ----------------- | -----------------: | ------: | --------------: | ----------------: | -----------------: |
| 1                 |                  2 |      24 |               2 |                24 |                 24 |
| 2                 |                 19 |     368 |              19 |               368 |                368 |

All 392 rows mapped to local container files and all declared offsets/sizes were in bounds. Adjacent
member offsets advance by the declared plaintext member size, not by an AES-padded per-member size.
All 21 whole `PersistStore` files are AES-block aligned. These facts identify encryption at the
whole-container boundary: decrypt the container first, then apply database ranges.

## Confirmed local container-key derivation

The recent Windows 4.1.x implementation in
[CN-Grace/Wechat-Emoticon-Parser](https://github.com/CN-Grace/Wechat-Emoticon-Parser) uses whole-file
AES-128-CBC with PKCS#7 padding and `key == IV`, deriving the raw 16-byte key as:

```text
MD5(seed + wxid + "EMOTICON")
```

The macOS implementation in [CipherTalk](https://github.com/ILoveBingLu/CipherTalk) provided the
missing location clue: current-session numeric identifiers appear in filenames under
`Documents/app_data/net/kvcomm`.

The successful offline probe:

1. read only decimal candidates from bounded filenames matching `key_<number>_*.statistic`;
2. tried the full and suffix-trimmed account directory names as `wxid` candidates;
3. derived the raw MD5 above;
4. decrypted one first block with AES-128-CBC, `key == IV`, and no padding, accepting only a known
   image signature;
5. decrypted every full container with PKCS#7 and required each database member range to match its
   declared MD5.

For anonymous account 2, two numeric candidates times two account-name candidates produced exactly
one header hit, 19/19 fully verified containers, and 368/368 verified members. No numeric value,
account name, derived key, URL, or media payload was printed or persisted. Keys, first blocks,
encrypted buffers, and decrypted buffers were cleared after use.

Anonymous account 1 did not match the current `kvcomm` candidates, which is expected if those files
belong to the currently logged-in account. A production implementation must associate or derive a
store key only while the corresponding account is current, then cache the validated key per
anonymous account in Keychain.

Static analysis of the current arm64 client independently located `DecryptEmoticonData`,
`EncryptEmoticonData`, `DecryptEmoticonFile`, and `EncryptEmoticonFile`; the reached primitive is
consistent with AES-CBC/PKCS#7 and a 16-byte IV equal to the key.

## Gate 8 experiment and why it is no longer required for this key

Gate 8 was kept separate from the verified Phase 7 Gate G PBKDF instrumentation:

- a private, session-scoped copy of `/Applications/WeChat.app` was ad-hoc signed and launched;
- fd 4 supplied at most 16 encrypted first blocks from the selected 19-pack account;
- the interposer observed only `CCCryptorCreate` parameters;
- fd 3 could emit one bounded candidate only after it decrypted a supplied block to a known image
  header;
- the parent required complete-container decryption and every in-bounds member MD5 before accepting
  a key;
- candidate/target buffers were cleared, temporary processes/files were removed, and the original
  app signature was rechecked.

The final authorized run, after the user opened and sent an official sticker, observed CommonCrypto
AES-256/CBC calls but none of the bounded candidate forms decrypted an official container. This was
valid negative evidence: those calls were not the official container-key boundary. The later
offline `kvcomm` derivation makes an internal container-key hook unnecessary.

## StickerHub and remote metadata comparison

The reference project uses StickerHub only after it has read local package/member IDs. It requests a
matching album document and uses its preview/download URLs. That explains why the screenshot can
show a complete album list while an individual album says it has not yet been collected by
StickerHub.

StickerHub's public frontend and API shape do not reveal its backend ingestion implementation. The
most likely model is a separately collected WeChat store catalog/detail corpus, not extraction from
the current user's local containers. We do not propose integrating or calling StickerHub.

A bounded local database inspection after one official sticker was sent found that one member of the
current pack also had a Tencent CDN record in `kNonStoreEmoticonTable`. Without retaining the actual
URL or identifiers, its structural properties were:

- the URL's `m` parameter equaled the member MD5;
- the hexadecimal `filekey` contained the same raw MD5 bytes;
- the record's product ID matched the local package ID.

This helps explain how catalog crawlers can seed remote official-pack data. It does not prove that
changing only `m` reconstructs URLs for all members, because `filekey` appears bound to the original
member. No request using local identifiers was sent to Tencent during this experiment.

## Implemented product boundary

- Native helper method `storeEmoticonsFd` reuses the validated fd-3 database-candidate frame.
- Minimum catalog records travel only over bounded anonymous fd 4; package descriptions, URLs, and
  remote AES fields stay in SQLite.
- TypeScript validates identifiers, safe integer ranges, order, duplicates, and stream limits.
- `scripts/probe-wechat4-store.ts` is a developer-only anonymous diagnostic and writes no media.
- It reads only matching `kvcomm` filenames, validates a candidate before full decryption, and never
  logs the seed, account directory name, derived key, or media.
- `Wechat4StoreKeyStore` keeps a fully validated 16-byte container key in the existing
  account-isolated `safeStorage`/Keychain directory and clears stale keys on validation failure.
- `LocalWechat4OfficialEmoticonStager` decrypts one bounded container at a time, validates every
  declared member MD5 before accepting the key, stages only validated slices with mode `0600`, and
  clears encrypted/decrypted/key buffers after use.
- `Wechat4StickerSource` merges staged official members with personal favorite/custom inputs before
  the shared local importer, preserving the existing SHA-256 de-duplication, persistence, image
  decoding, animation detection, and cancellation cleanup boundaries.
- Failure of the optional official-pack path produces one sanitized import failure and does not
  block personal favorite/custom imports.
- `native/wechat4-store-instrumentation` and `scripts/run-wechat4-store-gate-8.ts` remain experimental;
  they are not wired into product runtime or packaging.

## Product-path smoke result

The retained `phase8:official:smoke` command uses the real product catalog reader and stager with an
in-memory-only store-key cache. It creates a private temporary staging directory, passes every
staged member through the existing image decoder, deletes all staged media, clears all keys, and
exits without launching WeChat or making network requests.

| Anonymous account | Catalog members | Packages | Containers | Staged | Existing decoder passed |
| ----------------- | --------------: | -------: | ---------: | -----: | ----------------------: |
| 1                 |              24 |        2 |          2 |      0 |                       0 |
| 2 (current)       |             368 |       19 |         19 |    368 |                     368 |

The non-current account is intentionally rejected because the current-session `kvcomm` metadata
does not derive its key. This confirms that the product path does not cross account boundaries.

## Remaining work

1. Redesign the renderer around official-pack hierarchy: account summaries, pack groups, pack/member
   selection, preview sampling, and pack-scoped failures should be handled as a separate UI pass.
2. Log into the second test account once to generate its current `kvcomm` metadata and require the
   same all-container/all-member validation before broad rollout.
3. Recheck derivation and fail-closed behavior after supported WeChat client upgrades.

This path is now materially simpler and more private than a StickerHub dependency. Gate 8 is not
needed for the current account unless a future WeChat version removes or changes the `kvcomm`
derivation inputs.
