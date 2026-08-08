import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS, type StickerAppApi } from '../shared/ipc.js'
import type {
  ImportMode,
  ImportProgress,
  PrepareProgress,
  SendPackProgress,
  WhatsAppConnectionView,
} from '../shared/domain.js'

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
  getWhatsAppStatus: () => ipcRenderer.invoke(IPC_CHANNELS.whatsappGetStatus),
  connectWhatsApp: (pairingPhone?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.whatsappConnect, pairingPhone),
  disconnectWhatsApp: () => ipcRenderer.invoke(IPC_CHANNELS.whatsappDisconnect),
  logoutWhatsApp: () => ipcRenderer.invoke(IPC_CHANNELS.whatsappLogout),
  listWhatsAppGroups: () => ipcRenderer.invoke(IPC_CHANNELS.whatsappListGroups),
  sendWhatsAppPacks: (targetId: string, packIds?: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.whatsappSendPacks, targetId, packIds),
  onWhatsAppStatus: (listener: (status: WhatsAppConnectionView) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: WhatsAppConnectionView) =>
      listener(status)
    ipcRenderer.on(IPC_CHANNELS.whatsappStatus, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.whatsappStatus, handler)
  },
  onSendPackProgress: (listener: (progress: SendPackProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: SendPackProgress) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.whatsappSendProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.whatsappSendProgress, handler)
  },
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
