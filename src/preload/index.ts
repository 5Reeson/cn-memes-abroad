import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS, type StickerAppApi } from '../shared/ipc.js'
import type {
  ImportMode,
  ImportProgress,
  LegacyWechatDownloadMode,
  PrepareProgress,
  SendPackProgress,
  WhatsAppConnectionView,
  Wechat4GateStatus,
} from '../shared/domain.js'

const api: StickerAppApi = {
  getCollection: () => ipcRenderer.invoke(IPC_CHANNELS.getCollection),
  getExportTask: () => ipcRenderer.invoke(IPC_CHANNELS.getExportTask),
  saveExportTask: (task) => ipcRenderer.invoke(IPC_CHANNELS.saveExportTask, task),
  resetExportTask: () => ipcRenderer.invoke(IPC_CHANNELS.resetExportTask),
  chooseExportDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseExportDirectory),
  prepareExportTask: () => ipcRenderer.invoke(IPC_CHANNELS.prepareExportTask),
  transferLocalExport: () => ipcRenderer.invoke(IPC_CHANNELS.transferLocalExport),
  savePreparedSnapshot: (forceDuplicate?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.savePreparedSnapshot, forceDuplicate),
  listPreparedSnapshots: () => ipcRenderer.invoke(IPC_CHANNELS.listPreparedSnapshots),
  getPreparedSnapshot: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.getPreparedSnapshot, id),
  deletePreparedSnapshot: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.deletePreparedSnapshot, id),
  importAssets: (mode: ImportMode) => ipcRenderer.invoke(IPC_CHANNELS.importAssets, mode),
  discoverLegacyWechat: () => ipcRenderer.invoke(IPC_CHANNELS.wechatLegacyDiscover),
  importLegacyWechat: (accountId: string, downloadMode: LegacyWechatDownloadMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.wechatLegacyImport, accountId, downloadMode),
  cancelLegacyWechatImport: () => ipcRenderer.invoke(IPC_CHANNELS.wechatLegacyCancel),
  discoverWechat4: () => ipcRenderer.invoke(IPC_CHANNELS.wechat4Discover),
  importWechat4: (accountId: string, confirmed: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.wechat4Import, accountId, confirmed),
  cancelWechat4Import: () => ipcRenderer.invoke(IPC_CHANNELS.wechat4Cancel),
  confirmWechat4FavoritesReady: () => ipcRenderer.invoke(IPC_CHANNELS.wechat4FavoritesReady),
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
  setWhatsAppCredentialMode: (mode) =>
    ipcRenderer.invoke(IPC_CHANNELS.whatsappSetCredentialMode, mode),
  logoutWhatsApp: (confirmed) => ipcRenderer.invoke(IPC_CHANNELS.whatsappLogout, confirmed),
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
  onLegacyWechatProgress: (listener: (progress: ImportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ImportProgress) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.wechatLegacyProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.wechatLegacyProgress, handler)
  },
  onWechat4Progress: (listener: (progress: ImportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ImportProgress) =>
      listener(progress)
    ipcRenderer.on(IPC_CHANNELS.wechat4Progress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.wechat4Progress, handler)
  },
  onWechat4GateStatus: (listener: (status: Wechat4GateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: Wechat4GateStatus) =>
      listener(status)
    ipcRenderer.on(IPC_CHANNELS.wechat4GateStatus, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.wechat4GateStatus, handler)
  },
}

contextBridge.exposeInMainWorld('stickerApp', Object.freeze(api))
