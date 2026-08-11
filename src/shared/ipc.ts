import type {
  CollectionView,
  ImportMode,
  ImportProgress,
  ImportSummary,
  LegacyWechatDownloadMode,
  LegacyWechatDiscoveryView,
  PackSettings,
  PreparePacksSummary,
  PrepareProgress,
  SendPackProgress,
  SendPacksSummary,
  WhatsAppConnectionView,
  WhatsAppTarget,
  Wechat4GateStatus,
  Wechat4ImportDiscoveryView,
} from './domain.js'

export const IPC_CHANNELS = {
  getCollection: 'library:get-collection',
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
  whatsappLogout: 'whatsapp:logout',
  whatsappListGroups: 'whatsapp:list-groups',
  whatsappSendPacks: 'whatsapp:send-packs',
  whatsappStatus: 'whatsapp:status',
  whatsappSendProgress: 'whatsapp:send-progress',
} as const

export interface StickerAppApi {
  getCollection(): Promise<CollectionView>
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
  logoutWhatsApp(): Promise<WhatsAppConnectionView>
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
