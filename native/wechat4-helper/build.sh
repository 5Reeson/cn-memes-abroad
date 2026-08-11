#!/bin/sh
set -eu

helper_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
build_root="$helper_root/build"
source_file="$helper_root/Sources/Wechat4Helper/main.swift"
fixture_maker_source="$helper_root/Sources/FixtureMaker/main.swift"
module_directory="$helper_root/Sources/CSQLCipher"
prebuilt_directory="$helper_root/prebuilt/sqlcipher/macos-universal"
sqlcipher_library="$prebuilt_directory/libsqlcipher.a"
sqlcipher_lock="$prebuilt_directory/LOCK.env"
sqlcipher_header="$module_directory/include/sqlite3.h"

lock_value() {
  key="$1"
  /usr/bin/awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2) }' "$sqlcipher_lock"
}

fail_prebuilt() {
  echo "SQLCipher prebuilt validation failed: $1" >&2
  exit 9
}

[ -f "$sqlcipher_library" ] || fail_prebuilt "universal static library is missing"
[ -f "$sqlcipher_lock" ] || fail_prebuilt "lock file is missing"
[ -f "$sqlcipher_header" ] || fail_prebuilt "matching sqlite3.h is missing"
[ -f "$module_directory/module.modulemap" ] || fail_prebuilt "module map is missing"

expected_library_sha=$(lock_value LIBSQLCIPHER_SHA256)
expected_header_sha=$(lock_value SQLITE3_HEADER_SHA256)
case "$expected_library_sha" in
  ''|*[!0-9a-f]*) fail_prebuilt "library checksum is absent or malformed in LOCK.env" ;;
esac
case "$expected_header_sha" in
  ''|*[!0-9a-f]*) fail_prebuilt "header checksum is absent or malformed in LOCK.env" ;;
esac
[ "${#expected_library_sha}" = "64" ] || fail_prebuilt "library checksum length is invalid"
[ "${#expected_header_sha}" = "64" ] || fail_prebuilt "header checksum length is invalid"

actual_library_sha=$(/usr/bin/shasum -a 256 "$sqlcipher_library" | /usr/bin/awk '{ print $1 }')
actual_header_sha=$(/usr/bin/shasum -a 256 "$sqlcipher_header" | /usr/bin/awk '{ print $1 }')
[ "$actual_library_sha" = "$expected_library_sha" ] || fail_prebuilt "library checksum mismatch"
[ "$actual_header_sha" = "$expected_header_sha" ] || fail_prebuilt "header checksum mismatch"

library_architectures=$(xcrun lipo -archs "$sqlcipher_library" 2>/dev/null) || \
  fail_prebuilt "library is not a valid Mach-O universal archive"
case " $library_architectures " in
  *" arm64 "*) ;;
  *) fail_prebuilt "library is missing arm64" ;;
esac
case " $library_architectures " in
  *" x86_64 "*) ;;
  *) fail_prebuilt "library is missing x86_64" ;;
esac
architecture_count=$(printf '%s\n' "$library_architectures" | /usr/bin/awk '{ print NF }')
[ "$architecture_count" = "2" ] || fail_prebuilt "library contains unexpected architectures"

case "$build_root" in
  "$helper_root"/build) ;;
  *) echo "Refusing to clean an unexpected build directory" >&2; exit 8 ;;
esac

rm -rf "$build_root"
mkdir -p "$build_root"
module_cache="$build_root/module-cache"
mkdir -p "$module_cache"
export CLANG_MODULE_CACHE_PATH="$module_cache"
export SWIFT_MODULECACHE_PATH="$module_cache"

for architecture in arm64 x86_64; do
  architecture_directory="$build_root/$architecture"
  mkdir -p "$architecture_directory"

  xcrun swiftc \
    -target "$architecture-apple-macosx12.0" \
    -O \
    -module-cache-path "$module_cache" \
    -I "$module_directory" \
    -Xcc -DSQLITE_HAS_CODEC \
    "$source_file" \
    "$sqlcipher_library" \
    -framework Foundation \
    -framework Security \
    -lz \
    -o "$architecture_directory/wechat4-helper"

  xcrun swiftc \
    -target "$architecture-apple-macosx12.0" \
    -O \
    -module-cache-path "$module_cache" \
    -I "$module_directory" \
    -Xcc -DSQLITE_HAS_CODEC \
    "$fixture_maker_source" \
    "$sqlcipher_library" \
    -framework Foundation \
    -framework Security \
    -lz \
    -o "$architecture_directory/wechat4-fixture-maker"
done

mkdir -p "$build_root/universal"
xcrun lipo -create \
  "$build_root/arm64/wechat4-helper" \
  "$build_root/x86_64/wechat4-helper" \
  -output "$build_root/universal/wechat4-helper"
xcrun lipo -create \
  "$build_root/arm64/wechat4-fixture-maker" \
  "$build_root/x86_64/wechat4-fixture-maker" \
  -output "$build_root/universal/wechat4-fixture-maker"

chmod 755 "$build_root/arm64/wechat4-helper" \
  "$build_root/x86_64/wechat4-helper" \
  "$build_root/universal/wechat4-helper" \
  "$build_root/arm64/wechat4-fixture-maker" \
  "$build_root/x86_64/wechat4-fixture-maker" \
  "$build_root/universal/wechat4-fixture-maker"

for executable in \
  "$build_root/universal/wechat4-helper" \
  "$build_root/universal/wechat4-fixture-maker"; do
  /usr/bin/codesign --force --sign - --timestamp=none "$executable"
  /usr/bin/codesign --verify --strict "$executable"
done

file "$build_root/universal/wechat4-helper"
xcrun lipo -archs "$build_root/universal/wechat4-helper"
