import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ExportTaskStore,
  UnsupportedExportTaskSchemaError,
} from '../../src/main/exports/export-task-store.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ExportTaskStore', () => {
  it('persists workflow selection and task-local order across reloads', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'exports', 'current-task.json')
    const times = [new Date('2026-08-11T01:00:00.000Z'), new Date('2026-08-11T02:00:00.000Z')]
    const store = new ExportTaskStore({
      path,
      now: () => times.shift()!,
      createId: () => 'fixture-id',
    })
    const initial = await store.loadOrCreate()
    const saved = await store.saveDraft({
      currentStep: 3,
      source: { kind: 'library', label: '我的表情库' },
      destination: { kind: 'whatsapp' },
      selectedAssetIds: ['asset-a', 'asset-b'],
      orderedAssetIds: ['asset-b', 'asset-a'],
      whatsapp: { ...initial.whatsapp, title: '旅行表情', packSize: 13 },
      localFolder: initial.localFolder,
    })

    expect(await new ExportTaskStore({ path }).load()).toEqual(saved)
    expect(saved.id).toBe('export-task-fixture-id')
    expect(saved.createdAt).toBe(initial.createdAt)
    expect(saved.updatedAt).toBe('2026-08-11T02:00:00.000Z')
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('recovers the previous valid task from its backup', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'current-task.json')
    const store = new ExportTaskStore({ path, createId: () => 'fixture' })
    const initial = await store.loadOrCreate()
    const first = await store.save({ ...initial, currentStep: 2 })
    await store.save({ ...first, currentStep: 3 })
    await writeFile(path, '{broken', 'utf8')

    expect((await new ExportTaskStore({ path }).load()).currentStep).toBe(2)
  })

  it('rejects future schemas and invalid task-local ordering without replacing the file', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'current-task.json')
    const future = { schemaVersion: 99, id: 'future' }
    await writeFile(path, JSON.stringify(future), 'utf8')
    await expect(new ExportTaskStore({ path }).loadOrCreate()).rejects.toBeInstanceOf(
      UnsupportedExportTaskSchemaError,
    )
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(future)

    const validPath = join(root, 'valid-task.json')
    const validStore = new ExportTaskStore({ path: validPath, createId: () => 'valid' })
    const valid = await validStore.loadOrCreate()
    await expect(
      validStore.save({
        ...valid,
        selectedAssetIds: ['asset-a'],
        orderedAssetIds: ['asset-b'],
      }),
    ).rejects.toThrow(/order must contain every selected asset exactly once/)
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cn-memes-export-task-'))
  cleanup.push(directory)
  return directory
}
