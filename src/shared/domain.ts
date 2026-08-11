export const CURRENT_SCHEMA_VERSION = 1 as const

export type StickerSourceKind = 'local' | 'wechat4' | 'wechat-legacy'

export interface StickerAsset {
  id: string
  sourceKind: StickerSourceKind
  sourceAccountId?: string
  displayName: string
  originalPath: string
  sha256: string
  mimeType: string
  animated: boolean
  width: number
  height: number
  durationMs?: number
  importedAt: string
  sourceOrder: number
  userOrder: number
}

export interface StickerCollection {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION
  id: string
  title: string
  publisher: string
  packSize: number
  assets: StickerAsset[]
  selectedAssetIds: string[]
  createdAt: string
  updatedAt: string
}

export interface ImportFailure {
  path: string
  reason: string
}

export interface ImportProgress {
  completed: number
  total: number
  imported: number
  duplicates: number
  failed: number
  phase?: 'downloading' | 'importing'
  currentPath?: string
}

export interface ImportResult {
  assets: StickerAsset[]
  duplicates: string[]
  failures: ImportFailure[]
}

export type ImportMode = 'files' | 'directory'

export interface ImportSummary {
  canceled: boolean
  collection: CollectionView
  imported: number
  duplicates: number
  failures: ImportFailure[]
}

export interface LegacyWechatAccountView {
  id: string
  label: string
  stickerCount: number
  archiveBytes: number
}

export interface LegacyWechatDiscoveryView {
  rootFound: boolean
  accounts: LegacyWechatAccountView[]
  failures: string[]
}

export interface Wechat4ImportAccountView {
  id: string
  label: string
  databaseBytes: number
  walPresent: boolean
  shmPresent: boolean
}

export interface Wechat4ImportDiscoveryView {
  rootFound: boolean
  permissionDenied: boolean
  accounts: Wechat4ImportAccountView[]
  failures: string[]
}

export type Wechat4GatePhase =
  | 'idle'
  | 'preparing'
  | 'quitting-original'
  | 'copying'
  | 'signing'
  | 'awaiting-qr'
  | 'awaiting-favorites'
  | 'validating'
  | 'resolving'
  | 'importing'
  | 'cleaning'
  | 'complete'
  | 'canceled'
  | 'failed'

export interface Wechat4GateStatus {
  phase: Wechat4GatePhase
  message: string
}

export type LegacyWechatDownloadMode = 'default' | 'fast' | 'safe'

export interface PackSettings {
  title: string
  publisher: string
  packSize: number
}

export interface PreparedStickerView {
  assetId: string
  sizeBytes: number
  durationMs?: number
}

export interface PreparedPackView {
  id: string
  name: string
  publisher: string
  mediaKind: 'static' | 'animated'
  stickers: PreparedStickerView[]
  traySizeBytes: number
  status: 'prepared' | 'failed'
  error?: string
}

export interface PreparePacksSummary {
  packs: PreparedPackView[]
}

export interface PrepareProgress {
  completed: number
  total: number
  currentName: string
  packIndex: number
  packCount: number
}

export type WhatsAppConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'awaiting-qr'
  | 'awaiting-pairing-code'
  | 'connected'
  | 'reconnecting'
  | 'logged-out'
  | 'error'

export interface WhatsAppTarget {
  id: string
  name: string
  kind: 'self' | 'group'
  participantCount?: number
}

export interface WhatsAppConnectionView {
  phase: WhatsAppConnectionPhase
  hasSession: boolean
  selfTarget?: WhatsAppTarget
  qrDataUrl?: string
  pairingCode?: string
  message?: string
}

export interface SendPackProgress {
  packId: string
  packName: string
  packIndex: number
  packCount: number
  status: 'uploading' | 'sent' | 'failed' | 'skipped'
  message?: string
}

export interface SendPackReceipt {
  packId: string
  packName: string
  status: 'sent' | 'failed' | 'skipped'
  messageId?: string
  error?: string
}

export interface SendPacksSummary {
  receipts: SendPackReceipt[]
}

export interface StickerSource {
  kind: StickerSourceKind
  import(
    request: {
      collection: StickerCollection
      collectionDirectory: string
      inputs: string[]
    },
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportResult>
}

export interface CollectionView extends Omit<StickerCollection, 'assets'> {
  assets: Array<Omit<StickerAsset, 'originalPath'> & { previewUrl: string }>
}
