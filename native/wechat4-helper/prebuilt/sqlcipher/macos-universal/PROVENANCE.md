# SQLCipher macOS universal static library lock

- Upstream: <https://github.com/sqlcipher/sqlcipher.git>
- Release tag: `v4.17.0`
- Commit: `810db22f575ee7cf94ea96a3e91622b5fcece3dc`
- Generated: 2026-08-11
- macOS deployment target: `12.0`
- Architectures: `arm64`, `x86_64`
- Xcode: `13.4.1` (`13F100`)
- Compiler: `Apple clang version 13.1.6 (clang-1316.0.21.2.5)`
- License: BSD-3-Clause-style SQLCipher Community license; see `LICENSE.md`.

The exact end-to-end reproduction command is:

```sh
git clone https://github.com/sqlcipher/sqlcipher.git /path/to/sqlcipher
git -C /path/to/sqlcipher checkout --detach 810db22f575ee7cf94ea96a3e91622b5fcece3dc
native/wechat4-helper/prebuilt/sqlcipher/macos-universal/rebuild-macos-universal.sh \
  /path/to/sqlcipher
```

The rebuild script archives the fixed commit into a private temporary directory and generates the
amalgamation there with this command:

```sh
make -s -C /temporary/source -f Makefile.linux-generic sqlite3.c
```

The generated `sqlite3.c` SHA-256 is
`8adaff6b464052a74e7adaa3cfa2725400f48eca68f47856fa806eaf30bdf2c9`. The generated header is kept
at `Sources/CSQLCipher/include/sqlite3.h`; its SHA-256 is
`e564d0492e7556a8ad2f30c8ec645b5a6abb89f32f7b40465a3032d937596401`.

Each architecture was compiled with exactly these clang flags:

```text
-arch <arm64|x86_64>
-mmacosx-version-min=12.0
-Os
-fvisibility=hidden
-DNDEBUG
-DSQLITE_HAS_CODEC
-DSQLCIPHER_CRYPTO_CC
-DSQLITE_TEMP_STORE=2
-DSQLITE_THREADSAFE=1
-DSQLITE_EXTRA_INIT=sqlcipher_extra_init
-DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown
-c sqlite3.c
```

The source is compiled from its checkout directory so the stable relative input name `sqlite3.c`
is recorded instead of a temporary absolute path. The per-architecture objects were archived with
`ZERO_AR_DATE=1 xcrun libtool -static`. Because Apple libtool still records the invoking user's
numeric uid and gid, `normalize-archive-metadata.pl` sets only those archive metadata fields (and
the already-zero timestamp) to zero. Object bytes and the symbol table are unchanged. The two
archives were then combined with `xcrun lipo -create`. The committed `libsqlcipher.a`:

- contains exactly `arm64` and `x86_64`;
- is 2,421,632 bytes;
- has SHA-256 `1b4ff471c25eed8c04ba3d6000d2b308749b17dd6328e8a582f9f07c9e8dd55d`.

To reproduce it from a checkout containing the fixed commit, run:

```sh
native/wechat4-helper/prebuilt/sqlcipher/macos-universal/rebuild-macos-universal.sh \
  /path/to/sqlcipher
```

The script verifies the commit, toolchain, generated amalgamation, header, architectures, and final
archive checksum. `LOCK.env` is the machine-readable checksum source used by both the rebuild script
and the normal helper build. The large generated `sqlite3.c` is deliberately not stored in this
repository.
