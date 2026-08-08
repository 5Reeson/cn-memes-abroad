import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CURRENT_SCHEMA_VERSION, type StickerCollection } from '../../src/shared/domain.js'
import {
  ManifestReadError,
  ManifestStore,
  UnsupportedManifestSchemaError,
} from '../../src/main/library/manifest-store.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('ManifestStore', () => {
  it('creates and reloads a stable default collection', async () => {
    const directory = await temporaryDirectory()
    const now = new Date('2026-08-08T01:02:03.000Z')
    const store = new ManifestStore({ directory, now: () => now })

    const created = await store.loadOrCreate()
    const loaded = await store.loadOrCreate()

    expect(created).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'default',
      title: '我的贴纸',
      publisher: 'CN Memes Abroad',
      packSize: 30,
      assets: [],
      selectedAssetIds: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    expect(loaded).toEqual(created)
    expect(JSON.parse(await readFile(store.manifestPath, 'utf8'))).toEqual(created)
  })

  it('atomically saves and retains the previous valid manifest as one backup', async () => {
    const directory = await temporaryDirectory()
    const times = [
      new Date('2026-08-08T01:00:00.000Z'),
      new Date('2026-08-08T02:00:00.000Z'),
      new Date('2026-08-08T03:00:00.000Z'),
    ]
    const store = new ManifestStore({ directory, now: () => times.shift()! })
    const original = await store.loadOrCreate()

    const firstSave = await store.save({ ...original, title: '第一版' })
    const secondSave = await store.save({ ...firstSave, title: '第二版' })

    expect((await store.load()).title).toBe('第二版')
    expect(JSON.parse(await readFile(store.backupPath, 'utf8'))).toEqual(firstSave)
    expect(secondSave.createdAt).toBe(original.createdAt)
    expect(secondSave.updatedAt).toBe('2026-08-08T03:00:00.000Z')
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('recovers a corrupt primary from the valid backup and restores the primary', async () => {
    const directory = await temporaryDirectory()
    const store = new ManifestStore(directory)
    const original = await store.loadOrCreate()
    const saved = await store.save({ ...original, title: '可恢复版本' })
    await store.save({ ...saved, title: '最新版' })
    await writeFile(store.manifestPath, '{broken json', 'utf8')

    const recovered = await store.load()

    expect(recovered.title).toBe('可恢复版本')
    expect(JSON.parse(await readFile(store.manifestPath, 'utf8'))).toEqual(recovered)
  })

  it('recovers from backup when the primary is missing', async () => {
    const directory = await temporaryDirectory()
    const store = new ManifestStore(directory)
    const original = await store.loadOrCreate()
    const saved = await store.save({ ...original, title: '备份内容' })
    await store.save({ ...saved, title: '后来内容' })
    await unlink(store.manifestPath)

    const recovered = await store.loadOrCreate()

    expect(recovered.title).toBe('备份内容')
    expect(JSON.parse(await readFile(store.manifestPath, 'utf8'))).toEqual(recovered)
  })

  it('rejects unsupported schema versions instead of replacing user data', async () => {
    const directory = await temporaryDirectory()
    const store = new ManifestStore(directory)
    const unsupported = { ...collectionFixture(), schemaVersion: CURRENT_SCHEMA_VERSION + 1 }
    await writeFile(store.manifestPath, JSON.stringify(unsupported), 'utf8')

    await expect(store.loadOrCreate()).rejects.toBeInstanceOf(UnsupportedManifestSchemaError)
    expect(JSON.parse(await readFile(store.manifestPath, 'utf8'))).toEqual(unsupported)
  })

  it('does not overwrite a good backup when saving over a corrupt primary', async () => {
    const directory = await temporaryDirectory()
    const store = new ManifestStore(directory)
    const original = await store.loadOrCreate()
    const firstSave = await store.save({ ...original, title: '保留这个备份' })
    await store.save({ ...firstSave, title: '损坏前版本' })
    const backupBefore = await readFile(store.backupPath, 'utf8')
    await writeFile(store.manifestPath, 'not json', 'utf8')

    await store.save({ ...firstSave, title: '修复后版本' })

    expect(await readFile(store.backupPath, 'utf8')).toBe(backupBefore)
    expect((await store.load()).title).toBe('修复后版本')
  })

  it('rejects unsafe serialization without changing the current manifest', async () => {
    const directory = await temporaryDirectory()
    const store = new ManifestStore(directory)
    const original = await store.loadOrCreate()
    const unsafe = { ...original, metadata: {} } as StickerCollection & {
      metadata: Record<string, unknown>
    }
    unsafe.metadata.self = unsafe.metadata

    await expect(store.save(unsafe)).rejects.toBeInstanceOf(ManifestReadError)
    expect(await store.load()).toEqual(original)
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cn-memes-manifest-'))
  temporaryDirectories.push(directory)
  return directory
}

function collectionFixture(): StickerCollection {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'fixture',
    title: '测试贴纸',
    publisher: 'CN Memes Abroad',
    packSize: 30,
    assets: [],
    selectedAssetIds: [],
    createdAt: '2026-08-08T01:00:00.000Z',
    updatedAt: '2026-08-08T01:00:00.000Z',
  }
}
