import { useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CheckSquareIcon as CheckSquare } from '@phosphor-icons/react/CheckSquare'
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle'
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/FolderOpen'
import { GearSixIcon as GearSix } from '@phosphor-icons/react/GearSix'
import { DotsSixIcon as GripDotsSix } from '@phosphor-icons/react/DotsSix'
import { ImagesIcon as Images } from '@phosphor-icons/react/Images'
import { InfoIcon as Info } from '@phosphor-icons/react/Info'
import { PlusIcon as Plus } from '@phosphor-icons/react/Plus'
import { SquaresFourIcon as SquaresFour } from '@phosphor-icons/react/SquaresFour'
import { SquareIcon as Square } from '@phosphor-icons/react/Square'
import { TrashIcon as Trash } from '@phosphor-icons/react/Trash'
import { UploadSimpleIcon as UploadSimple } from '@phosphor-icons/react/UploadSimple'
import { WechatLogoIcon as WechatLogo } from '@phosphor-icons/react/WechatLogo'
import { XIcon as X } from '@phosphor-icons/react/X'

import type {
  CollectionView,
  ImportFailure,
  ImportMode,
  ImportProgress,
} from '../../shared/domain.js'

type AssetView = CollectionView['assets'][number]

interface ImportNotice {
  id: number
  imported: number
  duplicates: number
  failed: number
  dismissing: boolean
}

function formatBytes(width: number, height: number): string {
  return `${width} × ${height}`
}

function SortableSticker({
  asset,
  selected,
  selectionIndex,
  onToggle,
}: {
  asset: AssetView
  selected: boolean
  selectionIndex: number
  onToggle: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: asset.id,
  })
  const style = { transform: CSS.Transform.toString(transform), transition }

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`sticker-tile${selected ? ' is-selected' : ''}${isDragging ? ' is-dragging' : ''}`}
    >
      <div className="sticker-preview">
        <img src={asset.previewUrl} alt={asset.displayName} draggable={false} />
        <button
          className="selection-button"
          type="button"
          aria-label={selected ? `取消选择 ${asset.displayName}` : `选择 ${asset.displayName}`}
          aria-pressed={selected}
          onClick={onToggle}
        >
          {selected ? <span>{selectionIndex + 1}</span> : <Square size={14} />}
        </button>
        <button
          className="drag-handle"
          type="button"
          aria-label={`拖动排序 ${asset.displayName}`}
          {...attributes}
          {...listeners}
        >
          <GripDotsSix size={18} weight="bold" />
        </button>
        {asset.animated && <span className="media-badge">动图</span>}
      </div>
      <div className="sticker-meta">
        <strong title={asset.displayName}>{asset.displayName}</strong>
        <span>{formatBytes(asset.width, asset.height)}</span>
      </div>
    </article>
  )
}

function EmptyLibrary({ onImport }: { onImport: (mode: ImportMode) => void }) {
  return (
    <section className="empty-library" aria-labelledby="empty-title">
      <div className="empty-heading">
        <span className="empty-icon">
          <Images size={26} weight="light" />
        </span>
        <h2 id="empty-title">建立你的贴纸库</h2>
        <p>选择图片或文件夹。文件会复制到应用管理的本地素材库，原位置移动后仍然可用。</p>
      </div>
      <div className="source-grid">
        <article className="source-panel primary-source">
          <div>
            <UploadSimple size={24} weight="light" />
            <h3>从本地图片导入</h3>
            <p>支持 PNG、JPEG、WebP 和 GIF。重复文件会自动跳过。</p>
          </div>
          <div className="button-row">
            <button className="primary-button" type="button" onClick={() => onImport('files')}>
              <Plus size={16} weight="bold" /> 选择图片
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onImport('directory')}
            >
              <FolderOpen size={16} /> 选择文件夹
            </button>
          </div>
        </article>
        <article className="source-panel disabled-source" aria-disabled="true">
          <div>
            <WechatLogo size={24} weight="light" />
            <h3>从微信提取</h3>
            <p>微信数据适配器会在后续阶段接入。本阶段不会读取微信目录。</p>
          </div>
          <span className="availability-label">尚未开放</span>
        </article>
      </div>
    </section>
  )
}

function LoadingLibrary() {
  return (
    <div className="loading-grid" aria-label="正在加载收藏">
      {Array.from({ length: 8 }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  )
}

export function App() {
  const [collection, setCollection] = useState<CollectionView | null>(null)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [failures, setFailures] = useState<ImportFailure[]>([])
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const importNoticeId = importNotice?.id

  useEffect(() => {
    const api = window.stickerApp
    if (!api) {
      setError('桌面桥接未能启动，请重新打开应用。')
      setLoading(false)
      return
    }

    const unsubscribe = api.onImportProgress(setProgress)
    api
      .getCollection()
      .then(setCollection)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoading(false))
    return unsubscribe
  }, [])

  useEffect(() => {
    if (importNoticeId === undefined) return

    const fadeTimer = window.setTimeout(() => {
      setImportNotice((notice) =>
        notice?.id === importNoticeId ? { ...notice, dismissing: true } : notice,
      )
    }, 4500)
    const removeTimer = window.setTimeout(() => {
      setImportNotice((notice) => (notice?.id === importNoticeId ? null : notice))
    }, 5000)

    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(removeTimer)
    }
  }, [importNoticeId])

  const selected = useMemo(() => new Set(collection?.selectedAssetIds ?? []), [collection])

  async function importAssets(mode: ImportMode) {
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    setImporting(true)
    setFailures([])
    setError(null)
    try {
      const result = await api.importAssets(mode)
      setCollection(result.collection)
      setFailures(result.failures)
      if (!result.canceled) {
        setImportNotice({
          id: Date.now(),
          imported: result.imported,
          duplicates: result.duplicates,
          failed: result.failures.length,
          dismissing: false,
        })
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  async function persistSelection(nextIds: string[]) {
    if (!collection) return
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    setCollection({ ...collection, selectedAssetIds: nextIds })
    try {
      setCollection(await api.setSelection(nextIds))
    } catch (reason) {
      setCollection(collection)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  function toggleAsset(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    void persistSelection([...next])
  }

  async function handleDragEnd(event: DragEndEvent) {
    if (!collection || !event.over || event.active.id === event.over.id) return
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    const oldIndex = collection.assets.findIndex((asset) => asset.id === event.active.id)
    const newIndex = collection.assets.findIndex((asset) => asset.id === event.over?.id)
    const reordered = arrayMove(collection.assets, oldIndex, newIndex)
    setCollection({ ...collection, assets: reordered })
    try {
      setCollection(await api.reorderAssets(reordered.map((asset) => asset.id)))
    } catch (reason) {
      setCollection(collection)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function removeSelected() {
    if (!collection || selected.size === 0) return
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    if (!window.confirm(`从当前收藏中移除选中的 ${selected.size} 张图片？原始来源文件不会修改。`))
      return
    try {
      setCollection(await api.removeAssets([...selected]))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const allSelected =
    Boolean(collection?.assets.length) && selected.size === collection?.assets.length

  return (
    <div className="app-shell">
      <div className="window-drag-region" aria-hidden="true" />
      <aside className="sidebar">
        <div className="brand" aria-label="CN Memes Abroad">
          <span>贴</span>
          <strong>Memes Abroad</strong>
        </div>
        <nav aria-label="主导航">
          <button className="nav-item is-active" type="button">
            <SquaresFour size={18} /> 贴纸库
          </button>
          <button className="nav-item" type="button" disabled>
            <UploadSimple size={18} /> 发送到 WhatsApp
          </button>
          <button className="nav-item" type="button" disabled>
            <GearSix size={18} /> 设置
          </button>
        </nav>
        <div className="sidebar-note">
          <Info size={16} />
          <span>所有图片和收藏数据仅保存在本机。</span>
        </div>
      </aside>

      <main className="main-content">
        <header className="page-header">
          <div>
            <p className="section-label">本地收藏</p>
            <h1>{collection?.title ?? '贴纸库'}</h1>
            <p>导入、选择和调整顺序。后续会在这里预览 WhatsApp 分包。</p>
          </div>
          {Boolean(collection?.assets.length) && (
            <div className="header-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => importAssets('directory')}
                disabled={importing}
              >
                <FolderOpen size={16} /> 文件夹
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => importAssets('files')}
                disabled={importing}
              >
                <Plus size={16} weight="bold" /> 导入图片
              </button>
            </div>
          )}
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <X size={18} weight="bold" />
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示">
              <X size={16} />
            </button>
          </div>
        )}

        {importing && (
          <section className="import-status" aria-live="polite">
            <div>
              <strong>正在导入</strong>
              <span>
                {progress ? `${progress.completed} / ${progress.total}` : '正在读取所选文件'}
              </span>
            </div>
            <div className="progress-line">
              <span
                style={{
                  width: progress?.total ? `${(progress.completed / progress.total) * 100}%` : '8%',
                }}
              />
            </div>
          </section>
        )}

        {failures.length > 0 && (
          <section className="failure-panel" aria-labelledby="failure-title">
            <div>
              <h2 id="failure-title">有 {failures.length} 个文件未导入</h2>
              <p>已成功导入的图片不会回滚。</p>
            </div>
            <ul>
              {failures.slice(0, 5).map((failure) => (
                <li key={failure.path}>
                  <strong>{failure.path.split('/').pop()}</strong>
                  <span>{failure.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {loading ? (
          <LoadingLibrary />
        ) : collection && collection.assets.length > 0 ? (
          <section className="library-content" aria-label="贴纸收藏">
            <div className="collection-summary">
              <div>
                <strong>{collection.assets.length}</strong>
                <span>图片</span>
              </div>
              <div>
                <strong>{selected.size}</strong>
                <span>已选择</span>
              </div>
              <div>
                <strong>{collection.assets.filter((asset) => asset.animated).length}</strong>
                <span>动图</span>
              </div>
              <p>拖动图片右上角的手柄即可调整发送顺序。</p>
            </div>
            <div className="selection-toolbar">
              <div>
                <button
                  type="button"
                  onClick={() =>
                    persistSelection(allSelected ? [] : collection.assets.map((asset) => asset.id))
                  }
                >
                  <CheckSquare size={17} /> {allSelected ? '取消全选' : '全选'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    persistSelection(
                      collection.assets
                        .filter((asset) => !selected.has(asset.id))
                        .map((asset) => asset.id),
                    )
                  }
                >
                  反选
                </button>
              </div>
              <button
                className="danger-button"
                type="button"
                onClick={removeSelected}
                disabled={selected.size === 0}
              >
                <Trash size={17} /> 移除所选
              </button>
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={collection.assets.map((asset) => asset.id)}
                strategy={rectSortingStrategy}
              >
                <div className="sticker-grid">
                  {collection.assets.map((asset) => (
                    <SortableSticker
                      key={asset.id}
                      asset={asset}
                      selected={selected.has(asset.id)}
                      selectionIndex={collection.selectedAssetIds.indexOf(asset.id)}
                      onToggle={() => toggleAsset(asset.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </section>
        ) : (
          <EmptyLibrary onImport={importAssets} />
        )}
      </main>
      {importNotice && (
        <aside
          className={`import-notice${importNotice.dismissing ? ' is-dismissing' : ''}`}
          aria-live="polite"
          aria-label="导入结果"
        >
          <CheckCircle size={20} weight="fill" />
          <div>
            <strong>导入完成</strong>
            <p>
              新增 {importNotice.imported} · 重复 {importNotice.duplicates} · 失败{' '}
              {importNotice.failed}
            </p>
          </div>
          <button type="button" onClick={() => setImportNotice(null)} aria-label="关闭导入结果">
            <X size={16} />
          </button>
        </aside>
      )}
    </div>
  )
}
