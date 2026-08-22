# WeChat 4 official-store key instrumentation (experimental)

This is a separate Phase 8 research probe. It does not modify or replace the validated Phase 7
Gate G PBKDF interposer.

- fd 4 receives a fixed 264-byte frame containing 1-16 encrypted first blocks from one account's
  official `PersistStore` containers.
- The interposer observes `CCCryptorCreate` but only considers AES calls with a 16-byte key. Both
  CommonCrypto CBC and ECB setup are accepted because clients may build CBC from the ECB primitive;
  the supplied official container block is still always validated as AES-CBC with `key == IV`.
- A candidate is emitted only when AES-CBC decryption with `key == IV` turns a supplied block into
  a known image header.
- fd 3 emits one fixed 48-byte frame containing the validated 16/24/32-byte key. It also records
  whether a 32-byte ASCII-hex value was decoded to the 16-byte raw key. The parent must still
  validate the full container and member MD5 values before accepting it.
- fd 7 carries only fixed eight-byte state markers. No account identifier, path, ciphertext,
  plaintext, or key is written to stdout/stderr.
- The real experiment must use a private session-scoped app copy and clear the key immediately.

Build with:

```sh
sh native/wechat4-store-instrumentation/build.sh
```
