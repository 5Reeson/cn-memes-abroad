#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
helper_root=$(CDPATH= cd -- "$script_directory/../../.." && pwd)
lock_file="$script_directory/LOCK.env"
header_file="$helper_root/Sources/CSQLCipher/include/sqlite3.h"
output_file="$script_directory/libsqlcipher.a"
archive_normalizer="$script_directory/normalize-archive-metadata.pl"
source_checkout=${1:-}

fail() {
  echo "SQLCipher reproducible build failed: $1" >&2
  exit 9
}

lock_value() {
  key="$1"
  /usr/bin/awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2) }' "$lock_file"
}

[ -n "$source_checkout" ] || fail "pass a checkout containing the pinned upstream commit"
[ -d "$source_checkout/.git" ] || fail "the supplied path is not a Git checkout"
[ -f "$lock_file" ] || fail "LOCK.env is missing"
[ -f "$header_file" ] || fail "the matching sqlite3.h is missing"
[ -f "$archive_normalizer" ] || fail "archive metadata normalizer is missing"

expected_commit=$(lock_value SQLCIPHER_COMMIT)
expected_source_sha=$(lock_value SQLCIPHER_AMALGAMATION_SHA256)
expected_header_sha=$(lock_value SQLITE3_HEADER_SHA256)
expected_library_sha=$(lock_value LIBSQLCIPHER_SHA256)
expected_clang=$(lock_value APPLE_CLANG_VERSION)
expected_xcode=$(lock_value XCODE_VERSION)
expected_xcode_build=$(lock_value XCODE_BUILD)

actual_commit=$(git -C "$source_checkout" rev-parse HEAD)
[ "$actual_commit" = "$expected_commit" ] || fail "checkout is not at the pinned commit"
actual_clang=$(xcrun clang --version | /usr/bin/sed -n '1p')
[ "$actual_clang" = "$expected_clang" ] || fail "Apple clang version differs from the lock"
actual_xcode=$(xcodebuild -version | /usr/bin/awk 'NR == 1 { print $2 }')
actual_xcode_build=$(xcodebuild -version | /usr/bin/awk 'NR == 2 { print $3 }')
[ "$actual_xcode" = "$expected_xcode" ] || fail "Xcode version differs from the lock"
[ "$actual_xcode_build" = "$expected_xcode_build" ] || fail "Xcode build differs from the lock"

temporary_parent=${TMPDIR:-/tmp}
temporary_parent=${temporary_parent%/}
temporary_root=$(mktemp -d "$temporary_parent/cn-memes-sqlcipher-prebuilt.XXXXXX")
case "$temporary_root" in
  "$temporary_parent"/cn-memes-sqlcipher-prebuilt.*) ;;
  *) fail "unexpected temporary directory" ;;
esac
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT HUP INT TERM

source_root="$temporary_root/source"
mkdir -p "$source_root"
git -C "$source_checkout" archive "$expected_commit" | /usr/bin/tar -xf - -C "$source_root"
/usr/bin/make -s -C "$source_root" -f Makefile.linux-generic sqlite3.c

actual_source_sha=$(/usr/bin/shasum -a 256 "$source_root/sqlite3.c" | /usr/bin/awk '{ print $1 }')
generated_header_sha=$(/usr/bin/shasum -a 256 "$source_root/sqlite3.h" | /usr/bin/awk '{ print $1 }')
actual_header_sha=$(/usr/bin/shasum -a 256 "$header_file" | /usr/bin/awk '{ print $1 }')
[ "$actual_source_sha" = "$expected_source_sha" ] || fail "generated amalgamation checksum mismatch"
[ "$generated_header_sha" = "$expected_header_sha" ] || fail "generated sqlite3.h checksum mismatch"
[ "$actual_header_sha" = "$expected_header_sha" ] || fail "sqlite3.h checksum mismatch"

for architecture in arm64 x86_64; do
  architecture_root="$temporary_root/$architecture"
  mkdir -p "$architecture_root"
  # Compile from the source directory so the object records the stable relative
  # input name instead of the random temporary checkout path.
  (
    cd "$source_root"
    xcrun clang \
      -arch "$architecture" \
      -mmacosx-version-min=12.0 \
      -Os \
      -fvisibility=hidden \
      -DNDEBUG \
      -DSQLITE_HAS_CODEC \
      -DSQLCIPHER_CRYPTO_CC \
      -DSQLITE_TEMP_STORE=2 \
      -DSQLITE_THREADSAFE=1 \
      -DSQLITE_EXTRA_INIT=sqlcipher_extra_init \
      -DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown \
      -c sqlite3.c \
      -o "$architecture_root/sqlite3.o"
  )
  ZERO_AR_DATE=1 xcrun libtool -static \
    -o "$architecture_root/libsqlcipher.a" \
    "$architecture_root/sqlite3.o"
  /usr/bin/perl "$archive_normalizer" "$architecture_root/libsqlcipher.a"
done

rebuilt_library="$temporary_root/libsqlcipher.a"
xcrun lipo -create \
  "$temporary_root/arm64/libsqlcipher.a" \
  "$temporary_root/x86_64/libsqlcipher.a" \
  -output "$rebuilt_library"

architectures=$(xcrun lipo -archs "$rebuilt_library")
case " $architectures " in *" arm64 "*) ;; *) fail "rebuilt library is missing arm64" ;; esac
case " $architectures " in *" x86_64 "*) ;; *) fail "rebuilt library is missing x86_64" ;; esac
actual_library_sha=$(/usr/bin/shasum -a 256 "$rebuilt_library" | /usr/bin/awk '{ print $1 }')
[ "$actual_library_sha" = "$expected_library_sha" ] || fail "rebuilt library checksum mismatch"

/bin/cp "$rebuilt_library" "$output_file"
/bin/chmod 0644 "$output_file"
echo "SQLCipher universal static library reproduced and verified"
