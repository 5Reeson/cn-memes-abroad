#include <CommonCrypto/CommonCryptor.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

static const uint8_t kCorrectKey[16] = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
                                        0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff};
static const uint8_t kWrongKey[16] = {0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88,
                                      0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00};
static const uint8_t kCorrectKey32[32] = {
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa,
    0xbb, 0xcc, 0xdd, 0xee, 0xff, 0xf0, 0xe1, 0xd2, 0xc3, 0xb4, 0xa5,
    0x96, 0x87, 0x78, 0x69, 0x5a, 0x4b, 0x3c, 0x2d, 0x1e, 0x0f};
static const uint8_t kCorrectKeyAscii[32] = "00112233445566778899aabbccddeeff";

static int create_cryptor(const uint8_t *key, size_t key_length, CCAlgorithm algorithm,
                          CCOptions options) {
  CCCryptorRef cryptor = NULL;
  CCCryptorStatus status =
      CCCryptorCreate(kCCDecrypt, algorithm, options, key, key_length, key, &cryptor);
  if (cryptor != NULL) CCCryptorRelease(cryptor);
  return status == kCCSuccess ? 0 : 1;
}

int main(int argc, const char *argv[]) {
  const char *mode = argc > 1 ? argv[1] : "correct";
  if (strcmp(mode, "correct") == 0) return create_cryptor(kCorrectKey, sizeof(kCorrectKey), kCCAlgorithmAES, kCCOptionPKCS7Padding);
  if (strcmp(mode, "correct-ecb") == 0) return create_cryptor(kCorrectKey, sizeof(kCorrectKey), kCCAlgorithmAES, kCCOptionECBMode);
  if (strcmp(mode, "correct-32") == 0) return create_cryptor(kCorrectKey32, sizeof(kCorrectKey32), kCCAlgorithmAES, kCCOptionPKCS7Padding);
  if (strcmp(mode, "correct-32-ascii") == 0) return create_cryptor(kCorrectKeyAscii, sizeof(kCorrectKeyAscii), kCCAlgorithmAES, kCCOptionPKCS7Padding);
  if (strcmp(mode, "wrong") == 0) return create_cryptor(kWrongKey, sizeof(kWrongKey), kCCAlgorithmAES, kCCOptionPKCS7Padding);
  if (strcmp(mode, "ineligible") == 0) return create_cryptor(kCorrectKey, sizeof(kCorrectKey), kCCAlgorithmDES, 0);
  if (strcmp(mode, "mixed") == 0) {
    (void)create_cryptor(kWrongKey, sizeof(kWrongKey), kCCAlgorithmAES, kCCOptionPKCS7Padding);
    (void)create_cryptor(kCorrectKey, sizeof(kCorrectKey), kCCAlgorithmAES, kCCOptionPKCS7Padding);
    (void)create_cryptor(kCorrectKey, sizeof(kCorrectKey), kCCAlgorithmAES, kCCOptionPKCS7Padding);
    return 0;
  }
  if (strcmp(mode, "hang") == 0) {
    (void)create_cryptor(kWrongKey, sizeof(kWrongKey), kCCAlgorithmAES, kCCOptionPKCS7Padding);
    for (;;) pause();
  }
  return 2;
}
