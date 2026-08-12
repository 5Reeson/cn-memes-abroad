import type {
  CollectionView,
  ExportDestinationChoice,
  ExportTask,
  ExportTaskDraft,
  ImportMode,
  ImportProgress,
  ImportSummary,
  LegacyWechatDownloadMode,
  LegacyWechatDiscoveryView,
  LocalExportSummary,
  PackSettings,
  PrepareExportSummary,
  PreparePacksSummary,
  PrepareProgress,
  PreparedSnapshotSummary,
  PreparedSnapshotView,
  SavePreparedSnapshotResult,
  SendPackProgress,
  SendPacksSummary,
  WhatsAppConnectionView,
  WhatsAppCredentialMode,
  WhatsAppTarget,
  Wechat4GateStatus,
  Wechat4ImportDiscoveryView,
} from './domain.js'

export const IPC_CHANNELS = {
  getCollection: 'library:get-collection',
  getExportTask: 'exports:get-current-task',
  saveExportTask: 'exports:save-current-task',
  resetExportTask: 'exports:reset-current-task',
  chooseExportDirectory: 'exports:choose-local-directory',
  prepareExportTask: 'exports:prepare-current-task',
  cancelExportPreparation: 'exports:cancel-preparation',
  transferLocalExport: 'exports:transfer-local',
  savePreparedSnapshot: 'exports:save-prepared-snapshot',
  listPreparedSnapshots: 'exports:list-prepared-snapshots',
  getPreparedSnapshot: 'exports:get-prepared-snapshot',
  deletePreparedSnapshot: 'exports:delete-prepared-snapshot',
  importAssets: 'library:import-assets',
  importProgress: 'library:import-progress',
  wechatLegacyDiscover: 'wechat-legacy:discover',
  wechatLegacyImport: 'wechat-legacy:import',
  wechatLegacyCancel: 'wechat-legacy:cancel',
  wechatLegacyProgress: 'wechat-legacy:progress',
  wechat4Discover: 'wechat4:discover',
  wechat4Import: 'wechat4:import',
  wechat4Cancel: 'wechat4:cancel',
  wechat4FavoritesReady: 'wechat4:favorites-ready',
  wechat4Progress: 'wechat4:progress',
  wechat4GateStatus: 'wechat4:gate-status',
  reorderAssets: 'library:reorder-assets',
  removeAssets: 'library:remove-assets',
  setSelection: 'library:set-selection',
  updatePackSettings: 'packs:update-settings',
  preparePacks: 'packs:prepare',
  prepareProgress: 'packs:prepare-progress',
  whatsappGetStatus: 'whatsapp:get-status',
  whatsappConnect: 'whatsapp:connect',
  whatsappDisconnect: 'whatsapp:disconnect',
  whatsappSetCredentialMode: 'whatsapp:set-credential-mode',
  whatsappLogout: 'whatsapp:logout',
  whatsappListGroups: 'whatsapp:list-groups',
  whatsappSendPacks: 'whatsapp:send-packs',
  whatsappStatus: 'whatsapp:status',
  whatsappSendProgress: 'whatsapp:send-progress',
} as const

export interface StickerAppApi {
  getCollection(): Promise<CollectionView>
  getExportTask(): Promise<ExportTask>
  saveExportTask(task: ExportTaskDraft): Promise<ExportTask>
  resetExportTask(): Promise<ExportTask>
  chooseExportDirectory(): Promise<ExportDestinationChoice | undefined>
  prepareExportTask(): Promise<PrepareExportSummary>
  cancelExportPreparation(): Promise<boolean>
  transferLocalExport(): Promise<LocalExportSummary>
  savePreparedSnapshot(forceDuplicate?: boolean): Promise<SavePreparedSnapshotResult>
  listPreparedSnapshots(): Promise<PreparedSnapshotSummary[]>
  getPreparedSnapshot(id: string): Promise<PreparedSnapshotView>
  deletePreparedSnapshot(id: string): Promise<boolean>
  importAssets(mode: ImportMode): Promise<ImportSummary>
  discoverLegacyWechat(): Promise<LegacyWechatDiscoveryView>
  importLegacyWechat(
    accountId: string,
    downloadMode: LegacyWechatDownloadMode,
  ): Promise<ImportSummary>
  cancelLegacyWechatImport(): Promise<boolean>
  discoverWechat4(): Promise<Wechat4ImportDiscoveryView>
  importWechat4(accountId: string, confirmed: boolean): Promise<ImportSummary>
  cancelWechat4Import(): Promise<boolean>
  confirmWechat4FavoritesReady(): Promise<boolean>
  reorderAssets(orderedIds: string[]): Promise<CollectionView>
  removeAssets(assetIds: string[]): Promise<CollectionView>
  setSelection(selectedIds: string[]): Promise<CollectionView>
  updatePackSettings(settings: PackSettings): Promise<CollectionView>
  preparePacks(): Promise<PreparePacksSummary>
  getWhatsAppStatus(): Promise<WhatsAppConnectionView>
  connectWhatsApp(pairingPhone?: string): Promise<WhatsAppConnectionView>
  disconnectWhatsApp(): Promise<WhatsAppConnectionView>
  setWhatsAppCredentialMode(mode: WhatsAppCredentialMode): Promise<WhatsAppConnectionView>
  logoutWhatsApp(confirmed: boolean): Promise<WhatsAppConnectionView>
  listWhatsAppGroups(): Promise<WhatsAppTarget[]>
  sendWhatsAppPacks(targetId: string, packIds?: string[]): Promise<SendPacksSummary>
  onWhatsAppStatus(listener: (status: WhatsAppConnectionView) => void): () => void
  onSendPackProgress(listener: (progress: SendPackProgress) => void): () => void
  onPrepareProgress(listener: (progress: PrepareProgress) => void): () => void
  onImportProgress(listener: (progress: ImportProgress) => void): () => void
  onLegacyWechatProgress(listener: (progress: ImportProgress) => void): () => void
  onWechat4Progress(listener: (progress: ImportProgress) => void): () => void
  onWechat4GateStatus(listener: (status: Wechat4GateStatus) => void): () => void
}
