import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS, type StickerAppApi } from '../shared/ipc.js'
import type { ImportMode, ImportProgress } from '../shared/domain.js'

const api: StickerAppApi = {
  getCollection: () => ipcRenderer.invoke(IPC_CHANNELS.getCollection),
  importAssets: (mode: ImportMode) => ipcRenderer.invoke(IPC_CHANNELS.importAssets, mode),
  reorderAssets: (orderedIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.reorderAssets, orderedIds),
  removeAssets: (assetIds: string[]) => ipcRenderer.invoke(IPC_CHANNELS.removeAssets, assetIds),
  setSelection: (selectedIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.setSelection, selectedIds),
  onImportProgress: (listener: (progress: ImportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ImportProgress) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.importProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.importProgress, handler)
  },
}

contextBridge.exposeInMainWorld('stickerApp', Object.freeze(api))
