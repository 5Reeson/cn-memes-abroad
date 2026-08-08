import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS, type StickerAppApi } from '../shared/ipc.js'
import type { ImportMode, ImportProgress, PrepareProgress } from '../shared/domain.js'

const api: StickerAppApi = {
  getCollection: () => ipcRenderer.invoke(IPC_CHANNELS.getCollection),
  importAssets: (mode: ImportMode) => ipcRenderer.invoke(IPC_CHANNELS.importAssets, mode),
  reorderAssets: (orderedIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.reorderAssets, orderedIds),
  removeAssets: (assetIds: string[]) => ipcRenderer.invoke(IPC_CHANNELS.removeAssets, assetIds),
  setSelection: (selectedIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.setSelection, selectedIds),
  updatePackSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.updatePackSettings, settings),
  preparePacks: () => ipcRenderer.invoke(IPC_CHANNELS.preparePacks),
  onPrepareProgress: (listener: (progress: PrepareProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: PrepareProgress) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.prepareProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.prepareProgress, handler)
  },
  onImportProgress: (listener: (progress: ImportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ImportProgress) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.importProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.importProgress, handler)
  },
}

contextBridge.exposeInMainWorld('stickerApp', Object.freeze(api))
