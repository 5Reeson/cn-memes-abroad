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
