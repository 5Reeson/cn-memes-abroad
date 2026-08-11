import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PackPreparer } from '../../src/main/packs/pack-preparer.js'
import {
  CURRENT_SCHEMA_VERSION,
  type StickerAsset,
  type StickerCollection,
} from '../../src/shared/domain.js'

describe('PackPreparer', () => {
  let temporaryDirectory: string
  let collectionDirectory: string

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'pack-preparer-'))
    collectionDirectory = join(temporaryDirectory, 'collection')
    await mkdir(collectionDirectory, { recursive: true })
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  async function asset(index: number, animated = false): Promise<StickerAsset> {
    const originalPath = join(temporaryDirectory, `source-${index}.${animated ? 'gif' : 'png'}`)
    let contents: Buffer
    if (animated) {
      const frameHeight = 40
      contents = await sharp({
        create: {
          width: 60,
          height: frameHeight * 3,
          pageHeight: frameHeight,
          channels: 4,
          background: 'red',
        },
      })
        .composite([
          {
            input: Buffer.from(
              '<svg width="60" height="40"><rect width="60" height="40" fill="green"/></svg>',
            ),
            top: 40,
            left: 0,
          },
          {
            input: Buffer.from(
              '<svg width="60" height="40"><rect width="60" height="40" fill="blue"/></svg>',
            ),
            top: 80,
            left: 0,
          },
        ])
        .gif({ delay: [80, 120, 160], loop: 0, keepDuplicateFrames: true })
        .toBuffer()
    } else {
      contents = await sharp({
        create: {
          width: 140 + index,
          height: 90 + index,
          channels: 4,
          background: { r: 30 * index, g: 110, b: 210, alpha: 1 },
        },
      })
        .png()
        .toBuffer()
    }
    await writeFile(originalPath, contents)
    return {
      id: `asset-${index}`,
      sources: [
        {
          id: 'source-local-test',
          kind: 'local',
          label: '本机导入',
          importBatchId: 'test-import',
          importedAt: '2026-08-08T00:00:00.000Z',
        },
      ],
      displayName: `Sticker ${index}`,
      originalPath,
      sha256: createHash('sha256').update(contents).digest('hex'),
      mimeType: animated ? 'image/gif' : 'image/png',
      animated,
      width: 140 + index,
      height: 90 + index,
      durationMs: animated ? 360 : undefined,
      importedAt: '2026-08-08T00:00:00.000Z',
      sourceOrder: index,
      userOrder: index,
    }
  }

  function collection(assets: StickerAsset[]): StickerCollection {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'test-collection',
      title: 'Test pack',
      publisher: 'Tests',
      packSize: 30,
      assets,
      selectedAssetIds: assets.map((item) => item.id),
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    }
  }

  it('prepares static 512px WebP stickers and a 96px tray icon within limits', async () => {
    const assets = await Promise.all([asset(0), asset(1), asset(2)])
    const [pack] = await new PackPreparer().prepare(collection(assets), collectionDirectory)

    expect(pack).toMatchObject({ status: 'prepared', mediaKind: 'static', name: 'Test pack' })
    expect(pack?.stickers).toHaveLength(3)
    for (const sticker of pack!.stickers) {
      expect(sticker.sizeBytes).toBeLessThanOrEqual(100 * 1024)
      const metadata = await sharp(sticker.outputPath).metadata()
      expect([metadata.format, metadata.width, metadata.height]).toEqual(['webp', 512, 512])
      expect((await stat(sticker.outputPath)).mode & 0o777).toBe(0o600)
    }
    expect(pack!.traySizeBytes).toBeLessThanOrEqual(50 * 1024)
    const tray = await sharp(await readFile(pack!.trayPath)).metadata()
    expect([tray.format, tray.width, tray.height]).toEqual(['png', 96, 96])
  })

  it('preserves animated frames and duration in animated WebP output', async () => {
    const assets = await Promise.all([asset(0, true), asset(1, true), asset(2, true)])
    const [pack] = await new PackPreparer().prepare(collection(assets), collectionDirectory)

    expect(pack).toMatchObject({ status: 'prepared', mediaKind: 'animated' })
    for (const sticker of pack!.stickers) {
      expect(sticker.durationMs).toBe(360)
      expect(sticker.sizeBytes).toBeLessThanOrEqual(500 * 1024)
      const metadata = await sharp(sticker.outputPath, { animated: true, pages: -1 }).metadata()
      expect(metadata.format).toBe('webp')
      expect(metadata.width).toBe(512)
      expect(metadata.pageHeight).toBe(512)
      expect(metadata.pages).toBe(3)
      expect(metadata.delay).toEqual([80, 120, 160])
    }
  })

  it('reuses valid cached conversions', async () => {
    const assets = await Promise.all([asset(0), asset(1), asset(2)])
    const preparer = new PackPreparer()
    const first = await preparer.prepare(collection(assets), collectionDirectory)
    const firstPath = first[0]!.stickers[0]!.outputPath
    const firstModifiedAt = (await stat(firstPath)).mtimeMs
    const second = await preparer.prepare(collection(assets), collectionDirectory)

    expect(second[0]!.stickers[0]!.outputPath).toBe(firstPath)
    expect((await stat(firstPath)).mtimeMs).toBe(firstModifiedAt)
  })
})
