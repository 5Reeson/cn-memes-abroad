#include <CommonCrypto/CommonKeyDerivation.h>
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
  kTargetSaltFd = 4,
  kMarkerFd = 7,
  kSaltBytes = 16,
  kCandidateBytes = 32,
  kFrameBytes = 56,
  kMarkerBytes = 8,
};

// Fixed, non-secret state markers (fd 7, dylib -> parent). They carry no key,
// salt, password, candidate, account, URL, or database content; each is a
// constant 8-byte ASCII word so a single run can distinguish dylib-not-loaded,
// salt-not-delivered, no-KDF-call, salt-never-matches, wrong-length, and
// fd-3-write failure without any sensitive channel.
static const char kMarkerLoaded[kMarkerBytes] = {'C', 'M', 'I', 'P', 'L', 'O', 'A', 'D'};
static const char kMarkerSaltReceived[kMarkerBytes] = {'C', 'M', 'S', 'A', 'L', 'T', 'O', 'K'};
static const char kMarkerSaltMissing[kMarkerBytes] = {'C', 'M', 'S', 'A', 'L', 'T', 'N', 'O'};
static const char kMarkerCallHit[kMarkerBytes] = {'C', 'M', 'I', 'P', 'H', 'I', 'T', '0'};
static const char kMarkerSaltMatch[kMarkerBytes] = {'C', 'M', 'I', 'P', 'M', 'T', 'C', 'H'};
static const char kMarkerSaltMiss[kMarkerBytes] = {'C', 'M', 'I', 'P', 'M', 'I', 'S', 'S'};
static const char kMarkerLengthMatch[kMarkerBytes] = {'C', 'M', 'I', 'P', 'S', 'Z', '3', '2'};
static const char kMarkerLengthOther[kMarkerBytes] = {'C', 'M', 'I', 'P', 'S', 'Z', 'O', 'T'};
static const char kMarkerFrameSent[kMarkerBytes] = {'C', 'M', 'I', 'P', 'S', 'E', 'N', 'T'};

static uint8_t g_target_salt[kSaltBytes];
static atomic_bool g_target_ready = false;
static atomic_bool g_candidate_sent = false;

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
  // Diagnostic only. fd 7 is O_NONBLOCK, so a full or closed marker pipe can
  // never stall the cryptographic pass-through path; a dropped marker is
  // acceptable, a stalled KDF call is not.
  (void)write_exact(kMarkerFd, (const uint8_t *)marker, kMarkerBytes);
}

__attribute__((constructor)) static void initialize_target_salt(void) {
  uint8_t incoming[kSaltBytes] = {0};
  (void)fcntl(kCandidateFd, F_SETNOSIGPIPE, 1);
  (void)fcntl(kMarkerFd, F_SETNOSIGPIPE, 1);
  (void)fcntl(kMarkerFd, F_SETFL, O_NONBLOCK);
  emit_marker(kMarkerLoaded);
  if (read_exact(kTargetSaltFd, incoming, sizeof(incoming))) {
    memcpy(g_target_salt, incoming, sizeof(g_target_salt));
    atomic_store_explicit(&g_target_ready, true, memory_order_release);
    emit_marker(kMarkerSaltReceived);
  } else {
    emit_marker(kMarkerSaltMissing);
  }
  secure_clear(incoming, sizeof(incoming));
  (void)close(kTargetSaltFd);
}

__attribute__((destructor)) static void clear_interposer_state(void) {
  secure_clear(g_target_salt, sizeof(g_target_salt));
  atomic_store_explicit(&g_target_ready, false, memory_order_release);
  (void)close(kCandidateFd);
}

static int intercepted_CCKeyDerivationPBKDF(
    CCPBKDFAlgorithm algorithm, const char *password, size_t password_length,
    const uint8_t *salt, size_t salt_length, CCPseudoRandomAlgorithm pseudo_random_algorithm,
    uint rounds, uint8_t *derived_key, size_t derived_key_length) {
  emit_marker(kMarkerCallHit);

  // Calls originating in the interposing image remain bound to the system implementation.
  // This is the standard dyld interpose pattern and avoids a second symbol lookup channel.
  int status = CCKeyDerivationPBKDF(algorithm, password, password_length, salt, salt_length,
                                    pseudo_random_algorithm, rounds, derived_key,
                                    derived_key_length);
  if (status != kCCSuccess) {
    return status;
  }

  bool salt_matches = salt != NULL && salt_length == kSaltBytes &&
                      atomic_load_explicit(&g_target_ready, memory_order_acquire) &&
                      memcmp(salt, g_target_salt, kSaltBytes) == 0;
  emit_marker(salt_matches ? kMarkerSaltMatch : kMarkerSaltMiss);
  emit_marker(derived_key_length == kCandidateBytes ? kMarkerLengthMatch : kMarkerLengthOther);

  bool eligible = salt_matches && derived_key != NULL && derived_key_length == kCandidateBytes;
  if (!eligible || atomic_exchange_explicit(&g_candidate_sent, true, memory_order_acq_rel)) {
    return status;
  }

  uint8_t frame[kFrameBytes] = {0};
  frame[0] = 'C';
  frame[1] = 'M';
  frame[2] = 'K';
  frame[3] = '1';
  frame[4] = 1;
  frame[5] = 1;
  memcpy(frame + 8, salt, kSaltBytes);
  memcpy(frame + 24, derived_key, kCandidateBytes);
  (void)write_exact(kCandidateFd, frame, sizeof(frame));
  emit_marker(kMarkerFrameSent);
  secure_clear(frame, sizeof(frame));
  secure_clear(g_target_salt, sizeof(g_target_salt));
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

DYLD_INTERPOSE(intercepted_CCKeyDerivationPBKDF, CCKeyDerivationPBKDF)
