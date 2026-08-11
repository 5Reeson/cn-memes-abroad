import { createHash } from 'node:crypto'
import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import sharp, { type Metadata, type Sharp } from 'sharp'

import type {
  PreparedPackView,
  PrepareProgress,
  PreparedStickerView,
  StickerAsset,
  StickerCollection,
} from '../../shared/domain.js'
import { planStickerPacks } from '../../shared/pack-plan.js'

export const WHATSAPP_CONVERSION_VERSION = 'wa-webp-v2'
const STICKER_DIMENSION = 512
const TRAY_DIMENSION = 96
const STATIC_LIMIT_BYTES = 100 * 1024
const ANIMATED_LIMIT_BYTES = 500 * 1024
const TRAY_LIMIT_BYTES = 50 * 1024
const MAX_ANIMATION_DURATION_MS = 10_000
const MIN_FRAME_DURATION_MS = 8
// Bounded WebP compression attempts, from better image quality to smaller files.
// These values are encoder quality percentages, not sticker counts or pack sizes.
const STATIC_WEBP_QUALITY_STEPS = [90, 82, 74, 66, 58, 50, 42, 34, 28]
const ANIMATED_WEBP_QUALITY_STEPS = [82, 74, 66, 58, 50, 42, 34, 28, 22]

export interface PreparedSticker extends PreparedStickerView {
  outputPath: string
}

export interface PreparedPack extends Omit<PreparedPackView, 'stickers'> {
  stickers: PreparedSticker[]
  trayPath: string
}

function conversionKey(asset: StickerAsset): string {
  return createHash('sha256')
    .update(
      `${WHATSAPP_CONVERSION_VERSION}|${asset.sha256}|${asset.animated ? 'animated' : 'static'}`,
    )
    .digest('hex')
}

async function writeAtomically(path: string, contents: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, contents, { mode: 0o600 })
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

function animationDuration(metadata: Metadata): number | undefined {
  if (!metadata.pages || metadata.pages <= 1) return undefined
  return metadata.delay?.reduce((total, delay) => total + delay, 0)
}

function validateAnimation(metadata: Metadata, displayName: string): number {
  const delays = metadata.delay ?? []
  if (!metadata.pages || metadata.pages <= 1) {
    throw new Error(`${displayName} 被标记为动态图片，但解码后没有多个帧`)
  }
  if (delays.length !== metadata.pages) {
    throw new Error(`${displayName} 无法读取完整的动画帧时长`)
  }
  if (delays.some((delay) => delay < MIN_FRAME_DURATION_MS)) {
    throw new Error(`${displayName} 包含短于 8ms 的动画帧`)
  }
  const durationMs = delays.reduce((total, delay) => total + delay, 0)
  if (durationMs > MAX_ANIMATION_DURATION_MS) {
    throw new Error(`${displayName} 动画总时长超过 10 秒`)
  }
  return durationMs
}

function resizeToStickerCanvas(pipeline: Sharp, metadata: Metadata, animated: boolean): Sharp {
  const sourceWidth = metadata.width
  const sourceHeight = animated ? metadata.pageHeight : metadata.height
  if (!sourceWidth || !sourceHeight) throw new Error('无法读取图片尺寸')

  const scale = Math.min(1, STICKER_DIMENSION / sourceWidth, STICKER_DIMENSION / sourceHeight)
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const horizontalPadding = STICKER_DIMENSION - width
  const verticalPadding = STICKER_DIMENSION - height

  return pipeline.resize({ width, height, fit: 'fill' }).extend({
    top: Math.floor(verticalPadding / 2),
    bottom: Math.ceil(verticalPadding / 2),
    left: Math.floor(horizontalPadding / 2),
    right: Math.ceil(horizontalPadding / 2),
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
}

async function validateCachedSticker(
  path: string,
  animated: boolean,
): Promise<PreparedStickerView | undefined> {
  try {
    const file = await stat(path)
    const metadata = await sharp(path, { animated, pages: animated ? -1 : 1 }).metadata()
    const height = animated ? metadata.pageHeight : metadata.height
    const limit = animated ? ANIMATED_LIMIT_BYTES : STATIC_LIMIT_BYTES
    if (
      metadata.format !== 'webp' ||
      metadata.width !== STICKER_DIMENSION ||
      height !== STICKER_DIMENSION ||
      file.size > limit
    ) {
      return undefined
    }
    return { assetId: '', sizeBytes: file.size, durationMs: animationDuration(metadata) }
  } catch {
    return undefined
  }
}

async function convertSticker(
  asset: StickerAsset,
  cacheDirectory: string,
): Promise<PreparedSticker> {
  const outputPath = join(cacheDirectory, `${conversionKey(asset)}.webp`)
  const cached = await validateCachedSticker(outputPath, asset.animated)
  if (cached) return { ...cached, assetId: asset.id, outputPath }

  const inputMetadata = await sharp(asset.originalPath, {
    animated: asset.animated,
    pages: asset.animated ? -1 : 1,
  }).metadata()
  const durationMs = asset.animated
    ? validateAnimation(inputMetadata, asset.displayName)
    : undefined
  const qualitySteps = asset.animated ? ANIMATED_WEBP_QUALITY_STEPS : STATIC_WEBP_QUALITY_STEPS
  const limit = asset.animated ? ANIMATED_LIMIT_BYTES : STATIC_LIMIT_BYTES
  let smallest: Buffer | undefined

  const encode = async (quality: number, exhaustive: boolean): Promise<Buffer> => {
    const pipeline = resizeToStickerCanvas(
      sharp(asset.originalPath, {
        animated: asset.animated,
        pages: asset.animated ? -1 : 1,
        limitInputPixels: 128 * 1024 * 1024,
      }),
      inputMetadata,
      asset.animated,
    )
    return pipeline
      .webp({
        quality,
        alphaQuality: Math.max(quality, 70),
        effort: exhaustive ? 6 : 2,
        loop: asset.animated ? (inputMetadata.loop ?? 0) : undefined,
        minSize: asset.animated && exhaustive,
        mixed: asset.animated && exhaustive,
      })
      .toBuffer()
  }

  for (const quality of qualitySteps) {
    const candidate = await encode(quality, false)
    if (!smallest || candidate.length < smallest.length) smallest = candidate
    if (candidate.length <= limit) {
      await writeAtomically(outputPath, candidate)
      return { assetId: asset.id, outputPath, sizeBytes: candidate.length, durationMs }
    }
  }

  const exhaustiveCandidate = await encode(qualitySteps.at(-1)!, true)
  if (!smallest || exhaustiveCandidate.length < smallest.length) smallest = exhaustiveCandidate
  if (exhaustiveCandidate.length <= limit) {
    await writeAtomically(outputPath, exhaustiveCandidate)
    return {
      assetId: asset.id,
      outputPath,
      sizeBytes: exhaustiveCandidate.length,
      durationMs,
    }
  }

  throw new Error(
    `${asset.displayName} 无法压缩到 ${asset.animated ? '500KB' : '100KB'} 以内（最小 ${Math.ceil((smallest?.length ?? 0) / 1024)}KB）`,
  )
}

async function prepareTrayIcon(asset: StickerAsset, path: string): Promise<number> {
  try {
    const existing = await stat(path)
    if (existing.size <= TRAY_LIMIT_BYTES) return existing.size
  } catch {
    // Regenerate a missing tray icon.
  }

  const contents = await sharp(asset.originalPath, { page: 0, pages: 1 })
    .resize({
      width: TRAY_DIMENSION,
      height: TRAY_DIMENSION,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toBuffer()
  if (contents.length > TRAY_LIMIT_BYTES) throw new Error('托盘图标无法压缩到 50KB 以内')
  await writeAtomically(path, contents)
  return contents.length
}

function validatePackMetadata(collection: StickerCollection): void {
  if (!collection.title.trim() || collection.title.length > 128) {
    throw new Error('贴纸包名称必须为 1–128 个字符')
  }
  if (!collection.publisher.trim() || collection.publisher.length > 128) {
    throw new Error('发布者必须为 1–128 个字符')
  }
}

export class PackPreparer {
  async prepare(
    collection: StickerCollection,
    collectionDirectory: string,
    onProgress?: (progress: PrepareProgress) => void,
  ): Promise<PreparedPack[]> {
    validatePackMetadata(collection)
    const plan = planStickerPacks(collection)
    const byId = new Map(collection.assets.map((asset) => [asset.id, asset]))
    const cacheDirectory = join(collectionDirectory, 'converted', 'whatsapp')
    const trayDirectory = join(collectionDirectory, 'tray')
    const total = plan.packs.reduce((count, pack) => count + pack.assetIds.length, 0)
    let completed = 0

    const preparedPacks: PreparedPack[] = []
    for (const [packIndex, pack] of plan.packs.entries()) {
      const assets = pack.assetIds.map((id) => byId.get(id)!)
      const suffix = plan.packs.length > 1 ? ` ${packIndex + 1}` : ''
      const name = `${collection.title.slice(0, 128 - suffix.length)}${suffix}`
      try {
        const stickers: PreparedSticker[] = []
        for (const asset of assets) {
          try {
            stickers.push(await convertSticker(asset, cacheDirectory))
          } finally {
            completed += 1
            onProgress?.({
              completed,
              total,
              currentName: asset.displayName,
              packIndex: packIndex + 1,
              packCount: plan.packs.length,
            })
          }
        }
        const trayPath = join(trayDirectory, `${pack.id}.png`)
        const traySizeBytes = await prepareTrayIcon(assets[0]!, trayPath)
        preparedPacks.push({
          id: pack.id,
          name,
          publisher: collection.publisher,
          mediaKind: pack.mediaKind,
          stickers,
          trayPath,
          traySizeBytes,
          status: 'prepared',
        })
      } catch (error) {
        preparedPacks.push({
          id: pack.id,
          name,
          publisher: collection.publisher,
          mediaKind: pack.mediaKind,
          stickers: [],
          trayPath: '',
          traySizeBytes: 0,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return preparedPacks
  }
}
