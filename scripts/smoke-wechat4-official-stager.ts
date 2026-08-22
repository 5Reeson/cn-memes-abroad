import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { app } from 'electron'

import { createDefaultCollection } from '../src/main/library/manifest-store.js'
import { validateLocalStickerFile } from '../src/main/library/local-sticker-source.js'
import {
  HelperWechat4StoreEmoticonCatalogReader,
  LocalWechat4OfficialEmoticonStager,
} from '../src/main/sources/wechat4/store-emoticon-reader.js'
import { clearWechat4StoreEmoticonCatalog } from '../src/main/sources/wechat4/store-emoticon-catalog.js'
import { Wechat4KeyStore } from '../src/main/sources/wechat4/wechat4-key-store.js'
import type { Wechat4StoreKeyCache } from '../src/main/sources/wechat4/wechat4-store-key-store.js'
import { Wechat4StickerSource } from '../src/main/sources/wechat4/wechat4-source.js'
import {
  discoverWechat4,
  removeWechat4Snapshot,
  resolveWechat4StoreLayout,
  snapshotWechat4Database,
} from '../src/main/sources/wechat4/wechat4-layout.js'

app.setName('cn-memes-abroad')

class MemoryStoreKeyCache implements Wechat4StoreKeyCache {
  private readonly keys = new Map<string, Buffer>()

  async load(accountId: string): Promise<Buffer | undefined> {
    const key = this.keys.get(accountId)
    return key ? Buffer.from(key) : undefined
  }

  async save(accountId: string, key: Buffer): Promise<void> {
    this.keys.get(accountId)?.fill(0)
    this.keys.set(accountId, Buffer.from(key))
  }

  async clear(accountId: string): Promise<void> {
    this.keys.get(accountId)?.fill(0)
    this.keys.delete(accountId)
  }

  dispose(): void {
    for (const key of this.keys.values()) key.fill(0)
    this.keys.clear()
  }
}

async function smoke(): Promise<void> {
  const projectRoot = resolve(process.cwd())
  const helper = join(
    projectRoot,
    'native',
    'wechat4-helper',
    'build',
    'universal',
    'wechat4-helper',
  )
  const databaseKeys = new Wechat4KeyStore(
    join(homedir(), 'Library', 'Application Support', 'cn-memes-abroad', 'wechat4', 'keys'),
  )
  const catalogReader = new HelperWechat4StoreEmoticonCatalogReader({
    helper: { executable: helper, timeoutMs: 90_000 },
    candidateStore: databaseKeys,
  })
  const storeKeys = new MemoryStoreKeyCache()
  const stager = new LocalWechat4OfficialEmoticonStager({ catalogReader, keyStore: storeKeys })
  const discovery = await discoverWechat4()
  const reports: Array<{
    account: number
    catalogRecords: number
    catalogPackages: number
    namedPackages: number
    containers: number
    staged: number
    decoded: number
    selectedPackageImported: number
    selectedPackageFailures: number
    stageAvailable: boolean
    allDecoded: boolean
  }> = []

  try {
    for (const [index, account] of discovery.accounts.entries()) {
      const snapshot = await snapshotWechat4Database(account.id)
      const stagingDirectory = await mkdtemp(join(tmpdir(), 'cn-memes-official-smoke-'))
      await chmod(stagingDirectory, 0o700)
      let staged = 0
      let decoded = 0
      let catalogRecords = 0
      let catalogPackages = 0
      let namedPackages = 0
      let containers = 0
      let selectedPackageImported = 0
      let selectedPackageFailures = 0
      try {
        const records = await catalogReader.read({ accountId: account.id, snapshot })
        let packageIds: string[] = []
        try {
          catalogRecords = records.length
          packageIds = [...new Set(records.map((record) => record.packageId))]
          catalogPackages = packageIds.length
          namedPackages = new Set(
            records
              .filter((record) => record.packageName !== '未命名官方专辑')
              .map((record) => record.packageId),
          ).size
          containers = (await resolveWechat4StoreLayout(account.id, packageIds)).containers.size
        } finally {
          clearWechat4StoreEmoticonCatalog(records)
        }
        const assets = await stager.stage({
          accountId: account.id,
          snapshot,
          stagingDirectory,
        })
        staged = assets.length
        for (const asset of assets) {
          try {
            await validateLocalStickerFile(asset.path)
            decoded += 1
          } catch {
            // Continue to produce anonymous decoder coverage for the complete staged set.
          }
        }
        if (packageIds[0]) {
          const collectionDirectory = await mkdtemp(join(tmpdir(), 'cn-memes-official-import-'))
          try {
            const source = new Wechat4StickerSource({
              catalogReader: { read: async () => [] },
              officialStager: stager,
            })
            const imported = await source.importOfficialAlbums({
              accountId: account.id,
              collection: createDefaultCollection(undefined),
              collectionDirectory,
              packageIds: [packageIds[0]],
            })
            selectedPackageImported = imported.assets.length
            selectedPackageFailures = imported.failures.length
          } finally {
            await rm(collectionDirectory, { recursive: true, force: true })
          }
        }
        reports.push({
          account: index + 1,
          catalogRecords,
          catalogPackages,
          namedPackages,
          containers,
          staged,
          decoded,
          selectedPackageImported,
          selectedPackageFailures,
          stageAvailable: true,
          allDecoded: decoded === staged,
        })
      } catch {
        reports.push({
          account: index + 1,
          catalogRecords,
          catalogPackages,
          namedPackages,
          containers,
          staged,
          decoded,
          selectedPackageImported,
          selectedPackageFailures,
          stageAvailable: false,
          allDecoded: false,
        })
      } finally {
        await rm(stagingDirectory, { recursive: true, force: true })
        await removeWechat4Snapshot(snapshot)
      }
    }
  } finally {
    storeKeys.dispose()
  }

  process.stdout.write(`${JSON.stringify({ accounts: reports }, null, 2)}\n`)
}

app
  .whenReady()
  .then(smoke)
  .then(
    () => app.quit(),
    () => app.exit(1),
  )
