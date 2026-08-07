import { createHash } from 'node:crypto'
import { unlink } from 'node:fs/promises'

import {
  generateWAMessageFromContent,
  proto,
  type WASocket,
} from '@whiskeysockets/baileys'
import { zipSync } from 'fflate'
import sharp from 'sharp'

import { enableStickerPackMediaTypes, encryptMedia, type StickerPackMediaType } from './media.js'

const STICKER_COUNT = 3
const STICKER_SIZE = 512
const TRAY_SIZE = 96
const MAX_STATIC_STICKER_BYTES = 100 * 1024
const MAX_TRAY_BYTES = 50 * 1024

interface StickerFixture {
  accessibilityLabel: string
  emoji: string
  fileName: string
  webp: Buffer
}

export interface PreparedStickerPack {
  stickers: StickerFixture[]
  thumbnailJpeg: Buffer
  trayFileName: string
  trayPng: Buffer
  zip: Buffer
}

const palette = [
  { background: '#F7D047', foreground: '#172033', label: '好耶', emoji: '🎉' },
  { background: '#69D2C8', foreground: '#172033', label: '收到', emoji: '👌' },
  { background: '#FF8FA3', foreground: '#172033', label: '冲鸭', emoji: '🚀' },
] as const

function stickerSvg(background: string, foreground: string, label: string): Buffer {
  return Buffer.from(`
    <svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <rect x="20" y="20" width="472" height="472" rx="118" fill="${background}" stroke="${foreground}" stroke-width="18"/>
      <circle cx="188" cy="210" r="20" fill="${foreground}"/>
      <circle cx="324" cy="210" r="20" fill="${foreground}"/>
      <path d="M164 286 Q256 378 348 286" fill="none" stroke="${foreground}" stroke-width="22" stroke-linecap="round"/>
      <text x="256" y="112" text-anchor="middle" font-size="52" font-family="sans-serif" font-weight="700" fill="${foreground}">${label}</text>
    </svg>
  `)
}

function isAnimatedWebP(buffer: Buffer): boolean {
  return buffer.includes(Buffer.from('ANIM')) || buffer.includes(Buffer.from('ANMF'))
}

async function assertStaticSticker(buffer: Buffer, fileName: string): Promise<void> {
  const metadata = await sharp(buffer).metadata()
  if (metadata.format !== 'webp' || metadata.width !== STICKER_SIZE || metadata.height !== STICKER_SIZE) {
    throw new Error(`${fileName} must be a 512x512 WebP`)
  }
  if (isAnimatedWebP(buffer) || (metadata.pages ?? 1) !== 1) {
    throw new Error(`${fileName} must be static`)
  }
  if (buffer.length > MAX_STATIC_STICKER_BYTES) {
    throw new Error(`${fileName} is ${buffer.length} bytes; static stickers must be <= 100 KB`)
  }
}

export async function prepareFixturePack(): Promise<PreparedStickerPack> {
  const stickers = await Promise.all(
    palette.map(async ({ background, foreground, label, emoji }, index) => {
      const fileName = `phase0-${index + 1}.webp`
      const webp = await sharp(stickerSvg(background, foreground, label))
        .resize(STICKER_SIZE, STICKER_SIZE)
        .webp({ lossless: true, effort: 6 })
        .toBuffer()
      await assertStaticSticker(webp, fileName)
      return { accessibilityLabel: label, emoji, fileName, webp }
    }),
  )

  if (stickers.length !== STICKER_COUNT) {
    throw new Error(`Expected exactly ${STICKER_COUNT} fixtures`)
  }

  const coverSvg = stickerSvg(palette[0].background, palette[0].foreground, 'P0')
  const trayFileName = 'tray.png'
  const trayPng = await sharp(coverSvg).resize(TRAY_SIZE, TRAY_SIZE).png({ compressionLevel: 9 }).toBuffer()
  if (trayPng.length > MAX_TRAY_BYTES) {
    throw new Error(`Tray icon is ${trayPng.length} bytes; it must be <= 50 KB`)
  }

  const thumbnailJpeg = await sharp(coverSvg).resize(252, 252).jpeg({ quality: 82 }).toBuffer()
  const zipEntries: Record<string, Uint8Array> = Object.fromEntries([
    ...stickers.map(({ fileName, webp }) => [fileName, webp] as const),
    [trayFileName, trayPng] as const,
  ])
  const zip = Buffer.from(zipSync(zipEntries, { level: 0 }))

  return { stickers, thumbnailJpeg, trayFileName, trayPng, zip }
}

type UploadFunction = WASocket['waUploadToServer']

async function encryptAndUpload(
  upload: UploadFunction,
  contents: Buffer,
  mediaType: StickerPackMediaType,
  mediaKey?: Buffer,
) {
  const encrypted = await encryptMedia(contents, mediaType, mediaKey)
  try {
    const result = await upload(encrypted.encFilePath, {
      fileEncSha256B64: encrypted.fileEncSha256.toString('base64'),
      mediaType: mediaType as never,
      timeoutMs: 60_000,
    })
    return { encrypted, directPath: result.directPath }
  } finally {
    await unlink(encrypted.encFilePath).catch(() => undefined)
  }
}

export async function sendNativeStickerPack(
  socket: WASocket,
  targetJid: string,
  pack: PreparedStickerPack,
): Promise<string> {
  enableStickerPackMediaTypes()

  const packUpload = await encryptAndUpload(socket.waUploadToServer, pack.zip, 'sticker-pack')
  const thumbnailUpload = await encryptAndUpload(
    socket.waUploadToServer,
    pack.thumbnailJpeg,
    'thumbnail-sticker-pack',
    packUpload.encrypted.mediaKey,
  )

  const stickerPackMessage = proto.Message.StickerPackMessage.create({
    stickerPackId: 'com.cn-memes-abroad.phase0',
    name: 'CN Memes Abroad · Phase 0',
    publisher: 'cn-memes-abroad',
    packDescription: 'Three static WebP fixtures for the native pack protocol spike.',
    stickerPackOrigin: proto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED,
    stickerPackSize: pack.zip.length,
    stickers: pack.stickers.map((sticker) => ({
      fileName: sticker.fileName,
      mimetype: 'image/webp',
      isAnimated: false,
      isLottie: false,
      emojis: [sticker.emoji],
      accessibilityLabel: sticker.accessibilityLabel,
    })),
    fileLength: packUpload.encrypted.fileLength,
    fileSha256: packUpload.encrypted.fileSha256,
    fileEncSha256: packUpload.encrypted.fileEncSha256,
    mediaKey: packUpload.encrypted.mediaKey,
    directPath: packUpload.directPath,
    mediaKeyTimestamp: Math.floor(Date.now() / 1000),
    trayIconFileName: pack.trayFileName,
    thumbnailDirectPath: thumbnailUpload.directPath,
    thumbnailSha256: thumbnailUpload.encrypted.fileSha256,
    thumbnailEncSha256: thumbnailUpload.encrypted.fileEncSha256,
    thumbnailHeight: 252,
    thumbnailWidth: 252,
    imageDataHash: createHash('sha256').update(pack.thumbnailJpeg).digest('base64'),
  })

  if (!socket.user?.id) {
    throw new Error('Socket has no authenticated user')
  }
  const outgoing = generateWAMessageFromContent(
    targetJid,
    { stickerPackMessage },
    { userJid: socket.user.id },
  )
  if (!outgoing.message || !outgoing.key.id) {
    throw new Error('Baileys did not generate a message ID')
  }

  await socket.relayMessage(targetJid, outgoing.message, { messageId: outgoing.key.id })
  return outgoing.key.id
}
