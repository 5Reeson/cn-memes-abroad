#include <CommonCrypto/CommonCryptor.h>
#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

enum {
  kCandidateFd = 3,
  kTargetFd = 4,
  kMarkerFd = 7,
  kAesBlockBytes = 16,
  kMaxTargetBlocks = 16,
  kTargetFrameBytes = 8 + (kAesBlockBytes * kMaxTargetBlocks),
  kCandidateFrameBytes = 48,
  kMarkerBytes = 8,
};

static const char kMarkerLoaded[kMarkerBytes] = {'C', 'M', 'S', '8', 'L', 'O', 'A', 'D'};
static const char kMarkerTargetOk[kMarkerBytes] = {'C', 'M', 'S', '8', 'T', 'G', 'O', 'K'};
static const char kMarkerTargetNo[kMarkerBytes] = {'C', 'M', 'S', '8', 'T', 'G', 'N', 'O'};
static const char kMarkerCallHit[kMarkerBytes] = {'C', 'M', 'S', '8', 'C', 'A', 'L', 'L'};
static const char kMarkerAlgorithmAes[kMarkerBytes] = {'C', 'M', 'S', '8', 'A', 'L', 'G', 'O'};
static const char kMarkerKey16[kMarkerBytes] = {'C', 'M', 'S', '8', 'K', 'E', 'Y', '1'};
static const char kMarkerKey24[kMarkerBytes] = {'C', 'M', 'S', '8', 'K', 'E', 'Y', '3'};
static const char kMarkerKey32[kMarkerBytes] = {'C', 'M', 'S', '8', 'K', 'E', 'Y', '2'};
static const char kMarkerCbc[kMarkerBytes] = {'C', 'M', 'S', '8', 'C', 'B', 'C', 'M'};
static const char kMarkerEcb[kMarkerBytes] = {'C', 'M', 'S', '8', 'E', 'C', 'B', 'M'};
static const char kMarkerEligible[kMarkerBytes] = {'C', 'M', 'S', '8', 'A', 'E', 'S', '1'};
static const char kMarkerValidated[kMarkerBytes] = {'C', 'M', 'S', '8', 'G', 'O', 'O', 'D'};
static const char kMarkerSent[kMarkerBytes] = {'C', 'M', 'S', '8', 'S', 'E', 'N', 'T'};

static uint8_t g_target_blocks[kMaxTargetBlocks][kAesBlockBytes];
static uint8_t g_target_count = 0;
static atomic_bool g_target_ready = false;
static atomic_bool g_candidate_sent = false;
static atomic_bool g_marked_call = false;
static atomic_bool g_marked_algorithm = false;
static atomic_bool g_marked_key16 = false;
static atomic_bool g_marked_key24 = false;
static atomic_bool g_marked_key32 = false;
static atomic_bool g_marked_cbc = false;
static atomic_bool g_marked_ecb = false;
static atomic_bool g_marked_eligible = false;

static void secure_clear(void *buffer, size_t length) {
  volatile uint8_t *bytes = (volatile uint8_t *)buffer;
  while (length-- > 0) *bytes++ = 0;
}

static bool read_exact(int descriptor, uint8_t *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(descriptor, buffer + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    offset += (size_t)count;
  }
  return true;
}

static bool write_exact(int descriptor, const uint8_t *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(descriptor, buffer + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    offset += (size_t)count;
  }
  return true;
}

static void emit_marker(const char marker[static kMarkerBytes]) {
  (void)write_exact(kMarkerFd, (const uint8_t *)marker, kMarkerBytes);
}

static void emit_marker_once(atomic_bool *flag, const char marker[static kMarkerBytes]) {
  if (!atomic_exchange_explicit(flag, true, memory_order_acq_rel)) emit_marker(marker);
}

static bool known_image_header(const uint8_t plaintext[static kAesBlockBytes]) {
  static const uint8_t png[] = {0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};
  static const uint8_t jpeg[] = {0xff, 0xd8, 0xff};
  if (memcmp(plaintext, png, sizeof(png)) == 0) return true;
  if (memcmp(plaintext, "GIF87a", 6) == 0 || memcmp(plaintext, "GIF89a", 6) == 0) return true;
  if (memcmp(plaintext, jpeg, sizeof(jpeg)) == 0) return true;
  if (memcmp(plaintext, "RIFF", 4) == 0 && memcmp(plaintext + 8, "WEBP", 4) == 0) return true;
  if (memcmp(plaintext, "wxgf", 4) == 0) return true;
  return false;
}

static int matching_target_index(const uint8_t *key, size_t key_length) {
  uint8_t plaintext[kAesBlockBytes] = {0};
  size_t moved = 0;
  int matched = -1;
  for (uint8_t index = 0; index < g_target_count; index++) {
    CCCryptorStatus status = CCCrypt(kCCDecrypt, kCCAlgorithmAES, 0, key, key_length, key,
                                     g_target_blocks[index], kAesBlockBytes, plaintext,
                                     sizeof(plaintext), &moved);
    if (status == kCCSuccess && moved == kAesBlockBytes && known_image_header(plaintext)) {
      matched = index;
      break;
    }
    secure_clear(plaintext, sizeof(plaintext));
    moved = 0;
  }
  secure_clear(plaintext, sizeof(plaintext));
  return matched;
}

static int hex_nibble(uint8_t byte) {
  if (byte >= '0' && byte <= '9') return byte - '0';
  if (byte >= 'a' && byte <= 'f') return byte - 'a' + 10;
  if (byte >= 'A' && byte <= 'F') return byte - 'A' + 10;
  return -1;
}

static bool decode_hex_key(const uint8_t source[static 32], uint8_t output[static 16]) {
  for (size_t index = 0; index < 16; index++) {
    int high = hex_nibble(source[index * 2]);
    int low = hex_nibble(source[index * 2 + 1]);
    if (high < 0 || low < 0) {
      secure_clear(output, 16);
      return false;
    }
    output[index] = (uint8_t)((high << 4) | low);
  }
  return true;
}

__attribute__((constructor)) static void initialize_targets(void) {
  uint8_t frame[kTargetFrameBytes] = {0};
  (void)fcntl(kCandidateFd, F_SETNOSIGPIPE, 1);
  (void)fcntl(kMarkerFd, F_SETNOSIGPIPE, 1);
  (void)fcntl(kMarkerFd, F_SETFL, O_NONBLOCK);
  emit_marker(kMarkerLoaded);

  bool received = read_exact(kTargetFd, frame, sizeof(frame));
  bool valid = received && memcmp(frame, "CMS1", 4) == 0 && frame[4] == 1 && frame[5] > 0 &&
               frame[5] <= kMaxTargetBlocks && frame[6] == 0 && frame[7] == 0;
  if (valid) {
    g_target_count = frame[5];
    memcpy(g_target_blocks, frame + 8, (size_t)g_target_count * kAesBlockBytes);
    atomic_store_explicit(&g_target_ready, true, memory_order_release);
    emit_marker(kMarkerTargetOk);
  } else {
    emit_marker(kMarkerTargetNo);
  }
  secure_clear(frame, sizeof(frame));
  (void)close(kTargetFd);
}

__attribute__((destructor)) static void clear_store_probe_state(void) {
  secure_clear(g_target_blocks, sizeof(g_target_blocks));
  g_target_count = 0;
  atomic_store_explicit(&g_target_ready, false, memory_order_release);
  (void)close(kCandidateFd);
}

static CCCryptorStatus intercepted_CCCryptorCreate(CCOperation operation, CCAlgorithm algorithm,
                                                    CCOptions options, const void *key,
                                                    size_t key_length, const void *iv,
                                                    CCCryptorRef *cryptor_ref) {
  emit_marker_once(&g_marked_call, kMarkerCallHit);
  if (algorithm == kCCAlgorithmAES) {
    emit_marker_once(&g_marked_algorithm, kMarkerAlgorithmAes);
  }
  if (key != NULL && key_length == kAesBlockBytes) {
    emit_marker_once(&g_marked_key16, kMarkerKey16);
  }
  if (key != NULL && key_length == 24) emit_marker_once(&g_marked_key24, kMarkerKey24);
  if (key != NULL && key_length == 32) emit_marker_once(&g_marked_key32, kMarkerKey32);
  bool supported_key_length = key_length == 16 || key_length == 24 || key_length == 32;
  if (algorithm == kCCAlgorithmAES && key != NULL && supported_key_length) {
    emit_marker_once((options & kCCOptionECBMode) != 0 ? &g_marked_ecb : &g_marked_cbc,
                     (options & kCCOptionECBMode) != 0 ? kMarkerEcb : kMarkerCbc);
  }
  CCCryptorStatus status =
      CCCryptorCreate(operation, algorithm, options, key, key_length, iv, cryptor_ref);
  if (status != kCCSuccess) return status;

  bool eligible = algorithm == kCCAlgorithmAES && key != NULL && supported_key_length &&
                  atomic_load_explicit(&g_target_ready, memory_order_acquire) &&
                  !atomic_load_explicit(&g_candidate_sent, memory_order_acquire);
  if (!eligible) return status;
  emit_marker_once(&g_marked_eligible, kMarkerEligible);

  const uint8_t *candidate = (const uint8_t *)key;
  size_t candidate_length = key_length;
  uint8_t source_mode = 1;
  int target_index = matching_target_index(candidate, candidate_length);
  uint8_t transformed[16] = {0};
  if (target_index < 0 && key_length > 16) {
    memcpy(transformed, candidate, 16);
    target_index = matching_target_index(transformed, 16);
    candidate = transformed;
    candidate_length = 16;
    source_mode = 2;
  }
  if (target_index < 0 && key_length > 16) {
    memcpy(transformed, ((const uint8_t *)key) + key_length - 16, 16);
    target_index = matching_target_index(transformed, 16);
    candidate = transformed;
    candidate_length = 16;
    source_mode = 3;
  }
  if (target_index < 0 && key_length == 32 && decode_hex_key((const uint8_t *)key, transformed)) {
    target_index = matching_target_index(transformed, 16);
    candidate = transformed;
    candidate_length = 16;
    source_mode = 4;
  }
  if (target_index < 0) {
    secure_clear(transformed, sizeof(transformed));
    return status;
  }
  emit_marker(kMarkerValidated);
  if (atomic_exchange_explicit(&g_candidate_sent, true, memory_order_acq_rel)) return status;

  uint8_t frame[kCandidateFrameBytes] = {0};
  memcpy(frame, "CMK8", 4);
  frame[4] = 1;
  frame[5] = (uint8_t)target_index;
  frame[6] = (uint8_t)candidate_length;
  frame[7] = source_mode;
  memcpy(frame + 8, candidate, candidate_length);
  if (write_exact(kCandidateFd, frame, sizeof(frame))) emit_marker(kMarkerSent);
  secure_clear(frame, sizeof(frame));
  secure_clear(transformed, sizeof(transformed));
  secure_clear(g_target_blocks, sizeof(g_target_blocks));
  g_target_count = 0;
  atomic_store_explicit(&g_target_ready, false, memory_order_release);
  (void)close(kCandidateFd);
  return status;
}

#define DYLD_INTERPOSE(replacement, replacee)                                              \
  __attribute__((used)) static struct {                                                    \
    const void *replacement;                                                               \
    const void *replacee;                                                                  \
  } _interpose_##replacee __attribute__((section("__DATA,__interpose"))) = {                \
      (const void *)(uintptr_t)&replacement, (const void *)(uintptr_t)&replacee};

DYLD_INTERPOSE(intercepted_CCCryptorCreate, CCCryptorCreate)
