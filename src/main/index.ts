import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain, protocol, type IpcMainInvokeEvent } from 'electron'

import { LocalStickerSource } from './library/local-sticker-source.js'
import { ImportPreferencesStore } from './library/import-preferences.js'
import { ManifestStore } from './library/manifest-store.js'
import { PackPreparer, type PreparedPack } from './packs/pack-preparer.js'
import type {
  CollectionView,
  ImportMode,
  ImportSummary,
  PackSettings,
  PreparedPackView,
  StickerCollection,
} from '../shared/domain.js'
import { IPC_CHANNELS } from '../shared/ipc.js'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sticker-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

let mainWindow: BrowserWindow | null = null
let manifestStore: ManifestStore
let collectionDirectory: string
let importPreferences: ImportPreferencesStore
const localSource = new LocalStickerSource()
const packPreparer = new PackPreparer()
let mutationQueue: Promise<unknown> = Promise.resolve()

function sanitizeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(message.replaceAll(app.getPath('home'), '<home>'))
}

function previewUrl(assetId: string, sha256: string): string {
  return `sticker-asset://preview/${encodeURIComponent(assetId)}?v=${sha256.slice(0, 12)}`
}

function toCollectionView(collection: StickerCollection): CollectionView {
  return {
    ...collection,
    assets: collection.assets.map(({ originalPath: _originalPath, ...asset }) => ({
      ...asset,
      previewUrl: previewUrl(asset.id, asset.sha256),
    })),
  }
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(operation, operation)
  mutationQueue = next.catch(() => undefined)
  return next
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100_000 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new TypeError(`${label} must be a string array`)
  }
}

function assertPackSettings(value: unknown): asserts value is PackSettings {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid pack settings')
  const settings = value as Partial<PackSettings>
  if (
    typeof settings.title !== 'string' ||
    !settings.title.trim() ||
    settings.title.length > 128 ||
    typeof settings.publisher !== 'string' ||
    !settings.publisher.trim() ||
    settings.publisher.length > 128 ||
    !Number.isInteger(settings.packSize) ||
    settings.packSize! < 3 ||
    settings.packSize! > 30
  ) {
    throw new TypeError('Pack settings are invalid')
  }
}

function toPreparedPackView(pack: PreparedPack): PreparedPackView {
  return {
    id: pack.id,
    name: pack.name,
    publisher: pack.publisher,
    mediaKind: pack.mediaKind,
    stickers: pack.stickers.map(({ outputPath: _outputPath, ...sticker }) => sticker),
    traySizeBytes: pack.traySizeBytes,
    status: pack.status,
    error: pack.error,
  }
}

async function chooseImportPaths(mode: ImportMode): Promise<string[]> {
  if (mode !== 'files' && mode !== 'directory') throw new TypeError('Invalid import mode')
  const defaultPath = (await importPreferences.getLastImportDirectory()) ?? app.getPath('downloads')
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: mode === 'files' ? '选择贴纸图片' : '选择包含贴纸图片的文件夹',
    buttonLabel: '导入',
    properties: mode === 'files' ? ['openFile', 'multiSelections'] : ['openDirectory'],
    defaultPath,
    ...(mode === 'files'
      ? {
          filters: [
            { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
            { name: '所有文件', extensions: ['*'] },
          ],
        }
      : {}),
  })
  if (result.canceled || result.filePaths.length === 0) return []

  const selectedDirectory =
    mode === 'directory' ? result.filePaths[0]! : dirname(result.filePaths[0]!)
  await importPreferences.setLastImportDirectory(selectedDirectory)
  return result.filePaths
}

function installIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getCollection, async () => {
    try {
      return toCollectionView(await manifestStore.loadOrCreate())
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.importAssets,
    async (event: IpcMainInvokeEvent, mode: ImportMode): Promise<ImportSummary> => {
      try {
        const inputs = await chooseImportPaths(mode)
        if (inputs.length === 0) {
          const collection = await manifestStore.loadOrCreate()
          return {
            canceled: true,
            collection: toCollectionView(collection),
            imported: 0,
            duplicates: 0,
            failures: [],
          }
        }

        return await enqueueMutation(async () => {
          const collection = await manifestStore.loadOrCreate()
          const result = await localSource.import(
            { collection, collectionDirectory, inputs },
            (progress) => event.sender.send(IPC_CHANNELS.importProgress, progress),
          )
          const next = await manifestStore.save({
            ...collection,
            assets: [...collection.assets, ...result.assets],
            selectedAssetIds: [
              ...collection.selectedAssetIds,
              ...result.assets.map((asset) => asset.id),
            ],
          })
          return {
            canceled: false,
            collection: toCollectionView(next),
            imported: result.assets.length,
            duplicates: result.duplicates.length,
            failures: result.failures,
          }
        })
      } catch (error) {
        throw sanitizeError(error)
      }
    },
  )

  ipcMain.handle(IPC_CHANNELS.setSelection, async (_event, selectedIds: unknown) => {
    assertStringArray(selectedIds, 'selectedIds')
    return enqueueMutation(async () => {
      const collection = await manifestStore.loadOrCreate()
      const knownIds = new Set(collection.assets.map((asset) => asset.id))
      const unique = [...new Set(selectedIds)]
      if (unique.some((id) => !knownIds.has(id)))
        throw new TypeError('Selection contains an unknown asset')
      return toCollectionView(await manifestStore.save({ ...collection, selectedAssetIds: unique }))
    })
  })

  ipcMain.handle(IPC_CHANNELS.reorderAssets, async (_event, orderedIds: unknown) => {
    assertStringArray(orderedIds, 'orderedIds')
    return enqueueMutation(async () => {
      const collection = await manifestStore.loadOrCreate()
      const byId = new Map(collection.assets.map((asset) => [asset.id, asset]))
      if (
        orderedIds.length !== byId.size ||
        new Set(orderedIds).size !== byId.size ||
        orderedIds.some((id) => !byId.has(id))
      ) {
        throw new TypeError('Reorder must contain every asset exactly once')
      }
      const assets = orderedIds.map((id, userOrder) => ({ ...byId.get(id)!, userOrder }))
      return toCollectionView(await manifestStore.save({ ...collection, assets }))
    })
  })

  ipcMain.handle(IPC_CHANNELS.removeAssets, async (_event, assetIds: unknown) => {
    assertStringArray(assetIds, 'assetIds')
    return enqueueMutation(async () => {
      const collection = await manifestStore.loadOrCreate()
      const removed = new Set(assetIds)
      const assets = collection.assets
        .filter((asset) => !removed.has(asset.id))
        .map((asset, userOrder) => ({ ...asset, userOrder }))
      const selectedAssetIds = collection.selectedAssetIds.filter((id) => !removed.has(id))
      return toCollectionView(await manifestStore.save({ ...collection, assets, selectedAssetIds }))
    })
  })

  ipcMain.handle(IPC_CHANNELS.updatePackSettings, async (_event, settings: unknown) => {
    assertPackSettings(settings)
    return enqueueMutation(async () => {
      const collection = await manifestStore.loadOrCreate()
      return toCollectionView(
        await manifestStore.save({
          ...collection,
          title: settings.title.trim(),
          publisher: settings.publisher.trim(),
          packSize: settings.packSize,
        }),
      )
    })
  })

  ipcMain.handle(IPC_CHANNELS.preparePacks, async (event: IpcMainInvokeEvent) => {
    try {
      const collection = await manifestStore.loadOrCreate()
      const packs = await packPreparer.prepare(collection, collectionDirectory, (progress) =>
        event.sender.send(IPC_CHANNELS.prepareProgress, progress),
      )
      return { packs: packs.map(toPreparedPackView) }
    } catch (error) {
      throw sanitizeError(error)
    }
  })
}

async function installAssetProtocol(): Promise<void> {
  await protocol.handle('sticker-asset', async (request) => {
    try {
      const url = new URL(request.url)
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const collection = await manifestStore.loadOrCreate()
      const asset = collection.assets.find((candidate) => candidate.id === id)
      if (!asset) return new Response('Not found', { status: 404 })
      const body = await readFile(asset.originalPath)
      return new Response(Uint8Array.from(body), {
        headers: {
          'Content-Type': asset.mimeType,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return new Response('Unable to load asset', { status: 404 })
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 620,
    show: false,
    title: 'CN Memes Abroad',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  collectionDirectory = join(app.getPath('userData'), 'library', 'collections', 'default')
  manifestStore = new ManifestStore(collectionDirectory)
  importPreferences = new ImportPreferencesStore(
    join(app.getPath('userData'), 'settings', 'import-preferences.json'),
  )
  installIpcHandlers()
  await installAssetProtocol()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
