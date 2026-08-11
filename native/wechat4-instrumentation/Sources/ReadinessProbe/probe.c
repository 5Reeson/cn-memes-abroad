#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <unistd.h>

enum {
  kReadinessFd = 6,
};

static const uint8_t kReadinessMarker[] = {'C', 'M', 'R', 'D', 'Y', '0', '0', '1'};

__attribute__((constructor)) static void emit_readiness(void) {
  size_t offset = 0;
  while (offset < sizeof(kReadinessMarker)) {
    ssize_t count = write(kReadinessFd, kReadinessMarker + offset,
                          sizeof(kReadinessMarker) - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return;
    offset += (size_t)count;
  }
}
