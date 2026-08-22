#!/bin/sh
set -eu

instrumentation_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
build_root="$instrumentation_root/build"
interposer_source="$instrumentation_root/Sources/Interposer/interposer.c"
host_source="$instrumentation_root/Sources/SyntheticHost/main.c"

case "$build_root" in
  "$instrumentation_root"/build) ;;
  *) echo "Refusing to clean an unexpected store-instrumentation build directory" >&2; exit 8 ;;
esac

rm -rf "$build_root"
mkdir -p "$build_root"

for architecture in arm64 x86_64; do
  architecture_directory="$build_root/$architecture"
  mkdir -p "$architecture_directory"

  xcrun clang \
    -arch "$architecture" \
    -mmacosx-version-min=13.0 \
    -Os \
    -fvisibility=hidden \
    -Wall -Wextra -Werror \
    -dynamiclib \
    -Wl,-install_name,@rpath/libwechat4-store-key-interposer.dylib \
    "$interposer_source" \
    -o "$architecture_directory/libwechat4-store-key-interposer.dylib"

  xcrun clang \
    -arch "$architecture" \
    -mmacosx-version-min=13.0 \
    -Os \
    -Wall -Wextra -Werror \
    "$host_source" \
    -o "$architecture_directory/wechat4-store-synthetic-host"
done

mkdir -p "$build_root/universal"
xcrun lipo -create \
  "$build_root/arm64/libwechat4-store-key-interposer.dylib" \
  "$build_root/x86_64/libwechat4-store-key-interposer.dylib" \
  -output "$build_root/universal/libwechat4-store-key-interposer.dylib"
xcrun lipo -create \
  "$build_root/arm64/wechat4-store-synthetic-host" \
  "$build_root/x86_64/wechat4-store-synthetic-host" \
  -output "$build_root/universal/wechat4-store-synthetic-host"

chmod 755 \
  "$build_root/universal/libwechat4-store-key-interposer.dylib" \
  "$build_root/universal/wechat4-store-synthetic-host"

for executable in \
  "$build_root/universal/libwechat4-store-key-interposer.dylib" \
  "$build_root/universal/wechat4-store-synthetic-host"; do
  /usr/bin/codesign --force --sign - --timestamp=none "$executable"
  /usr/bin/codesign --verify --strict "$executable"
done

file "$build_root/universal/libwechat4-store-key-interposer.dylib"
xcrun lipo -archs "$build_root/universal/libwechat4-store-key-interposer.dylib"
file "$build_root/universal/wechat4-store-synthetic-host"
xcrun lipo -archs "$build_root/universal/wechat4-store-synthetic-host"
