import type {
  CollectionView,
  ImportMode,
  ImportProgress,
  ImportSummary,
  PackSettings,
  PreparePacksSummary,
  PrepareProgress,
} from './domain.js'

export const IPC_CHANNELS = {
  getCollection: 'library:get-collection',
  importAssets: 'library:import-assets',
  importProgress: 'library:import-progress',
  reorderAssets: 'library:reorder-assets',
  removeAssets: 'library:remove-assets',
  setSelection: 'library:set-selection',
  updatePackSettings: 'packs:update-settings',
  preparePacks: 'packs:prepare',
  prepareProgress: 'packs:prepare-progress',
} as const

export interface StickerAppApi {
  getCollection(): Promise<CollectionView>
  importAssets(mode: ImportMode): Promise<ImportSummary>
  reorderAssets(orderedIds: string[]): Promise<CollectionView>
  removeAssets(assetIds: string[]): Promise<CollectionView>
  setSelection(selectedIds: string[]): Promise<CollectionView>
  updatePackSettings(settings: PackSettings): Promise<CollectionView>
  preparePacks(): Promise<PreparePacksSummary>
  onPrepareProgress(listener: (progress: PrepareProgress) => void): () => void
  onImportProgress(listener: (progress: ImportProgress) => void): () => void
}
