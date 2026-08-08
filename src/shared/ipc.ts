import type { CollectionView, ImportMode, ImportProgress, ImportSummary } from './domain.js'

export const IPC_CHANNELS = {
  getCollection: 'library:get-collection',
  importAssets: 'library:import-assets',
  importProgress: 'library:import-progress',
  reorderAssets: 'library:reorder-assets',
  removeAssets: 'library:remove-assets',
  setSelection: 'library:set-selection',
} as const

export interface StickerAppApi {
  getCollection(): Promise<CollectionView>
  importAssets(mode: ImportMode): Promise<ImportSummary>
  reorderAssets(orderedIds: string[]): Promise<CollectionView>
  removeAssets(assetIds: string[]): Promise<CollectionView>
  setSelection(selectedIds: string[]): Promise<CollectionView>
  onImportProgress(listener: (progress: ImportProgress) => void): () => void
}
