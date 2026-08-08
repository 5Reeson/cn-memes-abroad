import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import { LocalStickerSource } from '../../src/main/library/local-sticker-source.js'
import { ManifestStore } from '../../src/main/library/manifest-store.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('local library persistence', () => {
  it('keeps imported assets, selection, and order after the source moves and the app reloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cn-memes-library-integration-'))
    cleanup.push(root)
    const sourceDirectory = join(root, 'source')
    const firstSource = join(sourceDirectory, 'first.png')
    const secondSource = join(sourceDirectory, 'second.webp')
    const collectionDirectory = join(root, 'library', 'collections', 'default')

    await mkdir(sourceDirectory, { recursive: true })
    await sharp({ create: { width: 20, height: 24, channels: 4, background: '#f2c94c' } })
      .png()
      .toFile(firstSource)
    await sharp({ create: { width: 30, height: 18, channels: 4, background: '#56b7ae' } })
      .webp()
      .toFile(secondSource)

    const store = new ManifestStore(collectionDirectory)
    const initial = await store.loadOrCreate()
    const imported = await new LocalStickerSource().import({
      collection: initial,
      collectionDirectory,
      inputs: [firstSource, secondSource],
    })
    const ordered = [...imported.assets]
      .reverse()
      .map((asset, userOrder) => ({ ...asset, userOrder }))
    await store.save({
      ...initial,
      assets: ordered,
      selectedAssetIds: ordered.map((asset) => asset.id),
    })

    await rename(sourceDirectory, join(root, 'source-moved'))

    const reloaded = await new ManifestStore(collectionDirectory).load()
    expect(reloaded.assets.map((asset) => asset.displayName)).toEqual(['second', 'first'])
    expect(reloaded.assets.map((asset) => asset.userOrder)).toEqual([0, 1])
    expect(reloaded.selectedAssetIds).toEqual(reloaded.assets.map((asset) => asset.id))
    await Promise.all(
      reloaded.assets.map((asset) =>
        expect(readFile(asset.originalPath)).resolves.not.toHaveLength(0),
      ),
    )
  })
})
