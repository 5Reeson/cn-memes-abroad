import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain, protocol, type IpcMainInvokeEvent } from 'electron'

import { LocalStickerSource } from './library/local-sticker-source.js'
import { ImportPreferencesStore } from './library/import-preferences.js'
import { ManifestStore } from './library/manifest-store.js'
import { PackPreparer, type PreparedPack } from './packs/pack-preparer.js'
import { WechatLegacySource } from './sources/wechat-legacy/wechat-legacy-source.js'
import { Wechat4GateGAcquirer } from './sources/wechat4/gate-g-acquirer.js'
import { resolveWechat4NativeArtifacts } from './sources/wechat4/native-runtime.js'
import {
  createProductWechat4StickerSource,
  type Wechat4StickerSource,
} from './sources/wechat4/wechat4-source.js'
import { EncryptedAuthStore } from './whatsapp/encrypted-auth-store.js'
import { SendReceiptStore } from './whatsapp/send-receipt-store.js'
import { WhatsAppManager } from './whatsapp/whatsapp-manager.js'
import type {
  CollectionView,
  ImportMode,
  ImportSummary,
  LegacyWechatDownloadMode,
  PackSettings,
  PreparedPackView,
  StickerCollection,
  Wechat4GateStatus,
  Wechat4ImportDiscoveryView,
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
let whatsappManager: WhatsAppManager
let wechat4Source: Wechat4StickerSource
const localSource = new LocalStickerSource()
const legacyWechatSource = new WechatLegacySource()
const packPreparer = new PackPreparer()
let mutationQueue: Promise<unknown> = Promise.resolve()
let legacyWechatImportController: AbortController | null = null
let wechat4ImportController: AbortController | null = null
let wechat4ImportTask: Promise<ImportSummary> | null = null
let allowQuitAfterWechat4Cleanup = false
let resolveWechat4FavoritesReady: (() => void) | null = null

function waitForWechat4FavoritesReady(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (resolveWechat4FavoritesReady) {
    return Promise.reject(new Error('微信收藏表情确认已在等待中'))
  }
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort)
      resolveWechat4FavoritesReady = null
      resolve()
    }
    const onAbort = () => {
      resolveWechat4FavoritesReady = null
      reject(signal?.reason ?? new DOMException('WeChat 4 import stopped', 'AbortError'))
    }
    resolveWechat4FavoritesReady = finish
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function sendWechat4GateStatus(status: Wechat4GateStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.wechat4GateStatus, status)
  }
}

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

function assertLegacyWechatDownloadMode(value: unknown): asserts value is LegacyWechatDownloadMode {
  if (value !== 'default' && value !== 'fast' && value !== 'safe') {
    throw new TypeError('Invalid Legacy WeChat download mode')
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

  ipcMain.handle(IPC_CHANNELS.wechatLegacyDiscover, async () => {
    try {
      return await legacyWechatSource.discover()
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.wechatLegacyCancel, () => {
    const controller = legacyWechatImportController
    if (!controller || controller.signal.aborted) return false
    controller.abort(new DOMException('Legacy WeChat import stopped', 'AbortError'))
    return true
  })

  ipcMain.handle(
    IPC_CHANNELS.wechatLegacyImport,
    async (
      event: IpcMainInvokeEvent,
      accountId: unknown,
      downloadMode: unknown,
    ): Promise<ImportSummary> => {
      if (typeof accountId !== 'string' || !accountId) throw new TypeError('Invalid account ID')
      assertLegacyWechatDownloadMode(downloadMode)
      if (legacyWechatImportController) throw new Error('已有微信导入任务正在运行')
      const controller = new AbortController()
      legacyWechatImportController = controller
      try {
        return await enqueueMutation(async (): Promise<ImportSummary> => {
          const collection = await manifestStore.loadOrCreate()
          let uncommittedOriginalPaths: string[] = []
          try {
            controller.signal.throwIfAborted()
            const result = await legacyWechatSource.import(
              {
                accountId,
                collection,
                collectionDirectory,
                downloadMode,
                signal: controller.signal,
              },
              (progress) => event.sender.send(IPC_CHANNELS.wechatLegacyProgress, progress),
            )
            uncommittedOriginalPaths = result.assets.map((asset) => asset.originalPath)
            controller.signal.throwIfAborted()
            if (legacyWechatImportController === controller) legacyWechatImportController = null
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
          } catch (error) {
            if (!controller.signal.aborted) throw error
            await Promise.all(
              uncommittedOriginalPaths.map((originalPath) => rm(originalPath, { force: true })),
            )
            return {
              canceled: true,
              collection: toCollectionView(collection),
              imported: 0,
              duplicates: 0,
              failures: [],
            }
          }
        })
      } catch (error) {
        throw sanitizeError(error)
      } finally {
        if (legacyWechatImportController === controller) legacyWechatImportController = null
      }
    },
  )

  ipcMain.handle(IPC_CHANNELS.wechat4Discover, async (): Promise<Wechat4ImportDiscoveryView> => {
    try {
      const discovery = await wechat4Source.discover()
      return {
        rootFound: discovery.rootFound,
        permissionDenied: discovery.permissionDenied,
        accounts: discovery.accounts.map(
          ({ id, label, databaseBytes, walPresent, shmPresent }) => ({
            id,
            label,
            databaseBytes,
            walPresent,
            shmPresent,
          }),
        ),
        failures: discovery.failures.map((failure) => failure.message),
      }
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.wechat4Cancel, () => {
    const controller = wechat4ImportController
    if (!controller || controller.signal.aborted) return false
    controller.abort(new DOMException('WeChat 4 import stopped', 'AbortError'))
    return true
  })

  ipcMain.handle(IPC_CHANNELS.wechat4FavoritesReady, () => {
    const resolveReady = resolveWechat4FavoritesReady
    if (!resolveReady) return false
    resolveReady()
    return true
  })

  ipcMain.handle(
    IPC_CHANNELS.wechat4Import,
    async (
      event: IpcMainInvokeEvent,
      accountId: unknown,
      confirmed: unknown,
    ): Promise<ImportSummary> => {
      if (typeof accountId !== 'string' || !/^wechat4-[a-f0-9]{16}$/.test(accountId)) {
        throw new TypeError('Invalid WeChat 4 account ID')
      }
      if (confirmed !== true) throw new Error('必须先确认微信临时副本授权说明')
      if (wechat4ImportController || legacyWechatImportController) {
        throw new Error('已有微信导入任务正在运行')
      }

      const controller = new AbortController()
      wechat4ImportController = controller
      const task = (async (): Promise<ImportSummary> => {
        sendWechat4GateStatus({ phase: 'preparing', message: '正在检查已验证的安全缓存' })
        try {
          return await enqueueMutation(async (): Promise<ImportSummary> => {
            const collection = await manifestStore.loadOrCreate()
            let uncommittedOriginalPaths: string[] = []
            try {
              controller.signal.throwIfAborted()
              const result = await wechat4Source.import(
                {
                  accountId,
                  collection,
                  collectionDirectory,
                  signal: controller.signal,
                },
                (progress) => {
                  event.sender.send(IPC_CHANNELS.wechat4Progress, progress)
                  if (progress.phase === 'downloading') {
                    sendWechat4GateStatus({
                      phase: 'resolving',
                      message: '正在并发解析本地缓存与微信 CDN 素材',
                    })
                  } else if (progress.phase === 'importing') {
                    sendWechat4GateStatus({
                      phase: 'importing',
                      message: '正在验证图片并写入本地素材库',
                    })
                  }
                },
              )
              uncommittedOriginalPaths = result.assets.map((asset) => asset.originalPath)
              controller.signal.throwIfAborted()
              if (wechat4ImportController === controller) wechat4ImportController = null
              const next = await manifestStore.save({
                ...collection,
                assets: [...collection.assets, ...result.assets],
                selectedAssetIds: [
                  ...collection.selectedAssetIds,
                  ...result.assets.map((asset) => asset.id),
                ],
              })
              sendWechat4GateStatus({ phase: 'complete', message: '微信 4.x 收藏表情导入完成' })
              return {
                canceled: false,
                collection: toCollectionView(next),
                imported: result.assets.length,
                duplicates: result.duplicates.length,
                failures: result.failures,
              }
            } catch (error) {
              await Promise.allSettled(
                uncommittedOriginalPaths.map((originalPath) => rm(originalPath, { force: true })),
              )
              if (!controller.signal.aborted) throw error
              sendWechat4GateStatus({ phase: 'canceled', message: '微信 4.x 导入已取消并清理' })
              return {
                canceled: true,
                collection: toCollectionView(collection),
                imported: 0,
                duplicates: 0,
                failures: [],
              }
            }
          })
        } catch (error) {
          sendWechat4GateStatus({ phase: 'failed', message: '微信 4.x 导入失败' })
          throw sanitizeError(error)
        } finally {
          resolveWechat4FavoritesReady = null
          if (wechat4ImportController === controller) wechat4ImportController = null
        }
      })()
      wechat4ImportTask = task
      try {
        return await task
      } finally {
        if (wechat4ImportTask === task) wechat4ImportTask = null
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

  ipcMain.handle(IPC_CHANNELS.whatsappGetStatus, () => whatsappManager.getStatus())

  ipcMain.handle(IPC_CHANNELS.whatsappConnect, async (_event, pairingPhone: unknown) => {
    if (pairingPhone !== undefined && typeof pairingPhone !== 'string') {
      throw new TypeError('Pairing phone must be a string')
    }
    try {
      return await whatsappManager.connect(pairingPhone)
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.whatsappDisconnect, async () => whatsappManager.disconnect())
  ipcMain.handle(IPC_CHANNELS.whatsappLogout, async () => whatsappManager.logout())

  ipcMain.handle(IPC_CHANNELS.whatsappListGroups, async () => {
    try {
      return await whatsappManager.listGroups()
    } catch (error) {
      throw sanitizeError(error)
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.whatsappSendPacks,
    async (event: IpcMainInvokeEvent, targetId: unknown, packIds: unknown) => {
      if (typeof targetId !== 'string' || !targetId) throw new TypeError('Invalid WhatsApp target')
      if (packIds !== undefined) assertStringArray(packIds, 'packIds')
      try {
        const collection = await manifestStore.loadOrCreate()
        const prepared = await packPreparer.prepare(collection, collectionDirectory, (progress) =>
          event.sender.send(IPC_CHANNELS.prepareProgress, progress),
        )
        const requestedIds = packIds === undefined ? undefined : new Set(packIds)
        if (requestedIds) {
          const knownIds = new Set(prepared.map((pack) => pack.id))
          if ([...requestedIds].some((id) => !knownIds.has(id))) {
            throw new TypeError('Send request contains an unknown pack')
          }
        }
        const selectedPacks = requestedIds
          ? prepared.filter((pack) => requestedIds.has(pack.id))
          : prepared
        if (selectedPacks.length === 0) throw new Error('没有可发送的贴纸包')
        const receipts = await whatsappManager.sendPacks(targetId, selectedPacks, (progress) =>
          event.sender.send(IPC_CHANNELS.whatsappSendProgress, progress),
        )
        return { receipts }
      } catch (error) {
        throw sanitizeError(error)
      }
    },
  )
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
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  const userDataDirectory = app.getPath('userData')
  const wechat4Artifacts = resolveWechat4NativeArtifacts({
    packaged: app.isPackaged,
    ...(app.isPackaged ? { resourcesPath: process.resourcesPath } : { projectRoot: process.cwd() }),
  })
  const wechat4Acquirer = new Wechat4GateGAcquirer({
    artifacts: wechat4Artifacts,
    candidateTimeoutMs: 10 * 60_000,
    onStatus: sendWechat4GateStatus,
    waitForFavoritesReady: waitForWechat4FavoritesReady,
  })
  wechat4Source = createProductWechat4StickerSource({
    helper: { executable: wechat4Artifacts.helperPath, timeoutMs: 90_000 },
    keyStoreDirectory: join(userDataDirectory, 'wechat4', 'keys'),
    acquireCandidate: (request) => wechat4Acquirer.acquire(request),
  })
  collectionDirectory = join(userDataDirectory, 'library', 'collections', 'default')
  manifestStore = new ManifestStore(collectionDirectory)
  importPreferences = new ImportPreferencesStore(
    join(userDataDirectory, 'settings', 'import-preferences.json'),
  )
  whatsappManager = new WhatsAppManager(
    new EncryptedAuthStore(join(userDataDirectory, 'whatsapp', 'session.enc')),
    new SendReceiptStore(join(userDataDirectory, 'whatsapp', 'send-receipts.json')),
    (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.whatsappStatus, status)
      }
    },
  )
  await whatsappManager.initialize()
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

app.on('before-quit', (event) => {
  if (allowQuitAfterWechat4Cleanup || !wechat4ImportTask) return
  event.preventDefault()
  wechat4ImportController?.abort(new DOMException('Application is quitting', 'AbortError'))
  const task = wechat4ImportTask
  void task
    .catch(() => undefined)
    .then(() => {
      if (wechat4ImportTask === task) wechat4ImportTask = null
      allowQuitAfterWechat4Cleanup = true
      app.quit()
    })
})
