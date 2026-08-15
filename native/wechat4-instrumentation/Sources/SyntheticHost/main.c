#include <CommonCrypto/CommonKeyDerivation.h>
#include <CommonCrypto/CommonCryptor.h>
#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

enum {
  kHostSaltFd = 5,
  kSaltBytes = 16,
  kCandidateBytes = 32,
  kLongOutputBytes = 64,
  kSyntheticRounds = 256000,
};

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

static int derive(const uint8_t *salt, size_t output_length, CCPBKDFAlgorithm algorithm) {
  // Clearly synthetic test-only bytes, assembled directly into the wipeable stack buffer.
  uint8_t password[] = {
      0x63, 0x6e, 0x2d, 0x6d, 0x65, 0x6d, 0x65, 0x73, 0x2d, 0x73, 0x79,
      0x6e, 0x74, 0x68, 0x65, 0x74, 0x69, 0x63, 0x2d, 0x69, 0x6e, 0x73,
      0x74, 0x72, 0x75, 0x6d, 0x65, 0x6e, 0x74, 0x61, 0x74, 0x69, 0x6f,
      0x6e, 0x2d, 0x70, 0x61, 0x73, 0x73, 0x77, 0x6f, 0x72, 0x64,
  };
  uint8_t output[kLongOutputBytes] = {0};
  int status = CCKeyDerivationPBKDF(
      algorithm, (const char *)password, sizeof(password), salt, kSaltBytes,
      kCCPRFHmacAlgSHA512, kSyntheticRounds, output, output_length);
  secure_clear(output, sizeof(output));
  secure_clear(password, sizeof(password));
  return status;
}

static void hang_ignoring_term(void) {
  (void)signal(SIGTERM, SIG_IGN);
  for (;;) pause();
}

int main(int argument_count, char **arguments) {
  if (argument_count != 2) return 2;
  uint8_t salt[kSaltBytes] = {0};
  if (!read_exact(kHostSaltFd, salt, sizeof(salt))) return 3;
  (void)close(kHostSaltFd);

  const char *mode = arguments[1];
  int status = kCCSuccess;
  if (strcmp(mode, "correct") == 0) {
    status = derive(salt, kCandidateBytes, kCCPBKDF2);
  } else if (strcmp(mode, "wrong-salt") == 0) {
    salt[0] ^= 0xff;
    status = derive(salt, kCandidateBytes, kCCPBKDF2);
  } else if (strcmp(mode, "wrong-length") == 0) {
    status = derive(salt, kLongOutputBytes, kCCPBKDF2);
  } else if (strcmp(mode, "kdf-failure") == 0) {
    status = derive(salt, kCandidateBytes, (CCPBKDFAlgorithm)99);
  } else if (strcmp(mode, "mixed") == 0) {
    uint8_t wrong_salt[kSaltBytes] = {0};
    memcpy(wrong_salt, salt, sizeof(wrong_salt));
    wrong_salt[0] ^= 0xff;
    (void)derive(wrong_salt, kCandidateBytes, kCCPBKDF2);
    secure_clear(wrong_salt, sizeof(wrong_salt));
    (void)derive(salt, kLongOutputBytes, kCCPBKDF2);
    status = derive(salt, kCandidateBytes, kCCPBKDF2);
    (void)derive(salt, kCandidateBytes, kCCPBKDF2);
  } else if (strcmp(mode, "hang") == 0) {
    status = derive(salt, kCandidateBytes, kCCPBKDF2);
    secure_clear(salt, sizeof(salt));
    if (status == kCCSuccess) hang_ignoring_term();
  } else if (strcmp(mode, "silent-hang") == 0) {
    salt[0] ^= 0xff;
    (void)derive(salt, kCandidateBytes, kCCPBKDF2);
    secure_clear(salt, sizeof(salt));
    hang_ignoring_term();
  } else {
    secure_clear(salt, sizeof(salt));
    return 4;
  }

  secure_clear(salt, sizeof(salt));
  return status == kCCSuccess ? 0 : 5;
}
