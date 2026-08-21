import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { DotsSixIcon as Grip } from '@phosphor-icons/react/DotsSix'
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react/MagnifyingGlass'
import { SquareIcon as Square } from '@phosphor-icons/react/Square'

import type { CollectionView, StickerSourceKind } from '../../../shared/domain.js'
import {
  boxSelectionScrollDelta,
  hasCrossedBoxSelectionThreshold,
  intersectRectangles,
  rectanglesIntersect,
  viewportPointInScrollContent,
} from './boxSelection.js'
import { MenuSelect } from './MenuSelect.js'
import { ProgressiveImage } from './ProgressiveImage.js'
import { StickerImagePreviewDialog } from './StickerImagePreviewDialog.js'
import { useProgressiveCount } from './useProgressiveCount.js'

type Asset = CollectionView['assets'][number]

const INITIAL_TILE_COUNT = 72
const TILE_BATCH_SIZE = 48
const BOX_SELECTION_THRESHOLD = 5

interface BoxSelectionSession {
  pointerId: number
  startContentX: number
  startContentY: number
  clientX: number
  clientY: number
  active: boolean
  targetIds: Set<string>
  scrollElement: HTMLElement
}

function findPickerScrollElement(grid: HTMLElement): HTMLElement {
  for (let element = grid.parentElement; element; element = element.parentElement) {
    const overflowY = window.getComputedStyle(element).overflowY
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      element.scrollHeight > element.clientHeight
    ) {
      return element
    }
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

export interface StickerPickerProps {
  assets: Asset[]
  selectedIds: string[]
  orderedIds: string[]
  mode: 'library' | 'export'
  onSelection(ids: string[]): void
  onOrder(ids: string[]): void
  onDelete?(ids: string[]): void | Promise<void>
}

function sourceKey(asset: Asset): string[] {
  return asset.sources.flatMap((source) => [
    `kind:${source.kind}`,
    ...(source.accountId ? [`account:${source.accountId}`] : []),
    ...(source.importBatchId ? [`batch:${source.importBatchId}`] : []),
  ])
}

export function StickerPicker({
  assets,
  selectedIds,
  orderedIds,
  mode,
  onSelection,
  onOrder,
  onDelete,
}: StickerPickerProps) {
  const [query, setQuery] = useState('')
  const [media, setMedia] = useState<'all' | 'static' | 'animated'>('all')
  const [source, setSource] = useState('all')
  const [sort, setSort] = useState<'user-order' | 'reverse-order'>('user-order')
  const [preview, setPreview] = useState<Asset | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const marqueeRef = useRef<HTMLDivElement>(null)
  const boxSelectionRef = useRef<BoxSelectionSession | null>(null)
  const boxSelectionFrameRef = useRef<number | null>(null)
  const boxSelectionMoveFrameRef = useRef<number | null>(null)
  const removeBoxSelectionListenersRef = useRef<() => void>(() => undefined)
  const suppressPreviewRef = useRef(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const sourceOptions = useMemo(() => {
    const options = new Map<string, string>()
    for (const asset of assets) {
      for (const item of asset.sources) {
        options.set(`kind:${item.kind}`, sourceKindLabel(item.kind))
        if (item.accountId) options.set(`account:${item.accountId}`, item.label)
        if (item.importBatchId) {
          options.set(
            `batch:${item.importBatchId}`,
            `${item.label}（${new Date(item.importedAt).toLocaleDateString('zh-CN')}）`,
          )
        }
      }
    }
    return [...options].sort((left, right) => left[1].localeCompare(right[1], 'zh-Hans-CN'))
  }, [assets])
  const mediaCounts = useMemo(
    () => ({
      static: assets.filter((asset) => !asset.animated).length,
      animated: assets.filter((asset) => asset.animated).length,
    }),
    [assets],
  )
  const baseOrder = useMemo(
    () =>
      assets
        .slice()
        .sort((a, b) => a.userOrder - b.userOrder)
        .map((asset) => asset.id),
    [assets],
  )
  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-Hans-CN')
    const orderIndex = new Map(baseOrder.map((id, index) => [id, index]))
    const filtered = assets
      .filter(
        (asset) =>
          !normalizedQuery ||
          asset.displayName.toLocaleLowerCase('zh-Hans-CN').includes(normalizedQuery),
      )
      .filter((asset) => media === 'all' || asset.animated === (media === 'animated'))
      .filter((asset) => source === 'all' || sourceKey(asset).includes(source))
    return filtered.sort((left, right) => {
      const difference =
        (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      return sort === 'reverse-order' ? -difference : difference
    })
  }, [assets, baseOrder, media, query, sort, source])
  const filterKey = `${query}\u0000${media}\u0000${source}\u0000${sort}\u0000${assets.length}`
  const progressive = useProgressiveCount({
    total: visible.length,
    initialCount: INITIAL_TILE_COUNT,
    batchSize: TILE_BATCH_SIZE,
    resetKey: filterKey,
  })
  const renderedAssets = visible.slice(0, progressive.visibleCount)
  const selectedOrder = useMemo(
    () => new Map(selectedIds.map((id, index) => [id, index])),
    [selectedIds],
  )

  useEffect(
    () => () => {
      if (boxSelectionFrameRef.current !== null) {
        window.cancelAnimationFrame(boxSelectionFrameRef.current)
      }
      if (boxSelectionMoveFrameRef.current !== null) {
        window.cancelAnimationFrame(boxSelectionMoveFrameRef.current)
      }
      removeBoxSelectionListenersRef.current()
    },
    [],
  )

  useEffect(() => {
    if (preview && !assets.some((asset) => asset.id === preview.id)) setPreview(null)
  }, [assets, preview])

  function toggle(id: string) {
    if (selected.has(id)) {
      onSelection(selectedIds.filter((candidate) => candidate !== id))
      if (mode === 'export') onOrder(orderedIds.filter((candidate) => candidate !== id))
    } else {
      onSelection([...selectedIds, id])
      if (mode === 'export') onOrder([...orderedIds, id])
    }
  }

  function selectMany(ids: string[]) {
    const additions = ids.filter((id) => !selected.has(id))
    if (!additions.length) return
    onSelection([...selectedIds, ...additions])
    if (mode === 'export') {
      const ordered = new Set(orderedIds)
      const orderAdditions = additions.filter((id) => !ordered.has(id))
      if (orderAdditions.length) onOrder([...orderedIds, ...orderAdditions])
    }
  }

  async function copyPreviewImage() {
    if (!preview) return
    const api = window.stickerApp
    if (!api) throw new Error('桌面桥接不可用')
    await api.copyAssetImage(preview.id)
  }

  function dragEnd(event: DragEndEvent) {
    const active = String(event.active.id)
    const over = event.over ? String(event.over.id) : undefined
    if (!over || active === over) return
    if (mode === 'export' && (!selected.has(active) || !selected.has(over))) return
    const order = mode === 'export' ? [...orderedIds] : [...baseOrder]
    const from = order.indexOf(active)
    const to = order.indexOf(over)
    if (from < 0 || to < 0) return
    order.splice(to, 0, ...order.splice(from, 1))
    onOrder(order)
  }

  function clearBoxSelectionVisuals(grid: HTMLDivElement) {
    grid.classList.remove('is-box-selecting')
    for (const tile of grid.querySelectorAll<HTMLElement>('[data-picker-asset-id]')) {
      tile.classList.remove('is-box-target')
    }
    if (marqueeRef.current) marqueeRef.current.hidden = true
  }

  function stopBoxSelectionScroll() {
    if (boxSelectionFrameRef.current === null) return
    window.cancelAnimationFrame(boxSelectionFrameRef.current)
    boxSelectionFrameRef.current = null
  }

  function updateBoxSelectionVisuals(session: BoxSelectionSession) {
    const grid = gridRef.current
    const marquee = marqueeRef.current
    if (!grid || !marquee) return
    const scrollLeft = session.scrollElement.scrollLeft
    const scrollTop = session.scrollElement.scrollTop
    const current = viewportPointInScrollContent(
      session.clientX,
      session.clientY,
      scrollLeft,
      scrollTop,
    )
    const selection = {
      top: Math.min(session.startContentY, current.y),
      right: Math.max(session.startContentX, current.x),
      bottom: Math.max(session.startContentY, current.y),
      left: Math.min(session.startContentX, current.x),
    }
    const gridBounds = grid.getBoundingClientRect()
    const gridContent = {
      top: gridBounds.top + scrollTop,
      right: gridBounds.right + scrollLeft,
      bottom: gridBounds.bottom + scrollTop,
      left: gridBounds.left + scrollLeft,
    }
    const documentScrollElement = document.scrollingElement
    const scrollViewport =
      session.scrollElement === documentScrollElement
        ? { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 }
        : session.scrollElement.getBoundingClientRect()
    const footer = grid.closest('.workflow-workspace')?.querySelector('.workspace-footer')
    const visibleClientBottom = Math.min(
      scrollViewport.bottom,
      footer?.getBoundingClientRect().top ?? scrollViewport.bottom,
    )
    const visibleContent = {
      top: Math.max(gridBounds.top, scrollViewport.top) + scrollTop,
      right: Math.min(gridBounds.right, scrollViewport.right) + scrollLeft,
      bottom: Math.min(gridBounds.bottom, visibleClientBottom) + scrollTop,
      left: Math.max(gridBounds.left, scrollViewport.left) + scrollLeft,
    }
    const visualSelection = intersectRectangles(selection, visibleContent)
    marquee.hidden = !visualSelection
    if (visualSelection) {
      marquee.style.transform = `translate(${visualSelection.left - gridContent.left}px, ${visualSelection.top - gridContent.top}px)`
      marquee.style.width = `${visualSelection.right - visualSelection.left}px`
      marquee.style.height = `${visualSelection.bottom - visualSelection.top}px`
    }
    grid.classList.add('is-box-selecting')

    const nextTargets = new Set<string>()
    for (const tile of grid.querySelectorAll<HTMLElement>('[data-picker-asset-id]')) {
      const bounds = tile.getBoundingClientRect()
      const targeted = rectanglesIntersect(selection, {
        top: bounds.top + scrollTop,
        right: bounds.right + scrollLeft,
        bottom: bounds.bottom + scrollTop,
        left: bounds.left + scrollLeft,
      })
      tile.classList.toggle('is-box-target', targeted)
      if (targeted) nextTargets.add(tile.dataset.pickerAssetId!)
    }
    session.targetIds = nextTargets
  }

  function continueBoxSelectionScroll() {
    boxSelectionFrameRef.current = null
    const session = boxSelectionRef.current
    if (!session?.active) return
    const documentScrollElement = document.scrollingElement
    const scrollBounds =
      session.scrollElement === documentScrollElement
        ? { top: 0, height: window.innerHeight }
        : session.scrollElement.getBoundingClientRect()
    const delta = boxSelectionScrollDelta(session.clientY - scrollBounds.top, scrollBounds.height)
    if (delta === 0) return
    session.scrollElement.scrollBy({ top: delta, behavior: 'auto' })
    updateBoxSelectionVisuals(session)
    boxSelectionFrameRef.current = window.requestAnimationFrame(continueBoxSelectionScroll)
  }

  function startBoxSelectionScroll() {
    if (boxSelectionFrameRef.current !== null) return
    boxSelectionFrameRef.current = window.requestAnimationFrame(continueBoxSelectionScroll)
  }

  function scheduleBoxSelectionVisuals(session: BoxSelectionSession) {
    if (boxSelectionMoveFrameRef.current !== null) return
    boxSelectionMoveFrameRef.current = window.requestAnimationFrame(() => {
      boxSelectionMoveFrameRef.current = null
      if (boxSelectionRef.current === session) updateBoxSelectionVisuals(session)
    })
  }

  function startBoxSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.picker-select, .picker-drag')) return
    const scrollElement = findPickerScrollElement(event.currentTarget)
    const start = viewportPointInScrollContent(
      event.clientX,
      event.clientY,
      scrollElement.scrollLeft,
      scrollElement.scrollTop,
    )
    boxSelectionRef.current = {
      pointerId: event.pointerId,
      startContentX: start.x,
      startContentY: start.y,
      clientX: event.clientX,
      clientY: event.clientY,
      active: false,
      targetIds: new Set(),
      scrollElement,
    }
    window.addEventListener('pointermove', moveBoxSelection)
    window.addEventListener('pointerup', finishBoxSelection)
    window.addEventListener('pointercancel', cancelBoxSelection)
    removeBoxSelectionListenersRef.current = () => {
      window.removeEventListener('pointermove', moveBoxSelection)
      window.removeEventListener('pointerup', finishBoxSelection)
      window.removeEventListener('pointercancel', cancelBoxSelection)
    }
  }

  function moveBoxSelection(event: PointerEvent) {
    const session = boxSelectionRef.current
    const grid = gridRef.current
    const marquee = marqueeRef.current
    if (!session || session.pointerId !== event.pointerId || !grid || !marquee) return
    session.clientX = event.clientX
    session.clientY = event.clientY
    const current = viewportPointInScrollContent(
      event.clientX,
      event.clientY,
      session.scrollElement.scrollLeft,
      session.scrollElement.scrollTop,
    )
    if (
      !session.active &&
      !hasCrossedBoxSelectionThreshold(
        session.startContentX,
        session.startContentY,
        current.x,
        current.y,
        BOX_SELECTION_THRESHOLD,
      )
    ) {
      return
    }
    if (!session.active) {
      session.active = true
    }
    event.preventDefault()
    scheduleBoxSelectionVisuals(session)
    startBoxSelectionScroll()
  }

  function finishBoxSelection(event: PointerEvent) {
    const session = boxSelectionRef.current
    const grid = gridRef.current
    if (!session || session.pointerId !== event.pointerId || !grid) return
    session.clientX = event.clientX
    session.clientY = event.clientY
    if (boxSelectionMoveFrameRef.current !== null) {
      window.cancelAnimationFrame(boxSelectionMoveFrameRef.current)
      boxSelectionMoveFrameRef.current = null
    }
    if (session.active) updateBoxSelectionVisuals(session)
    boxSelectionRef.current = null
    removeBoxSelectionListenersRef.current()
    stopBoxSelectionScroll()
    clearBoxSelectionVisuals(grid)
    if (!session.active) return

    suppressPreviewRef.current = true
    window.setTimeout(() => {
      suppressPreviewRef.current = false
    }, 0)
    selectMany(
      renderedAssets.filter((asset) => session.targetIds.has(asset.id)).map((asset) => asset.id),
    )
  }

  function cancelBoxSelection(event: PointerEvent) {
    const session = boxSelectionRef.current
    const grid = gridRef.current
    if (!session || session.pointerId !== event.pointerId || !grid) return
    boxSelectionRef.current = null
    removeBoxSelectionListenersRef.current()
    stopBoxSelectionScroll()
    if (boxSelectionMoveFrameRef.current !== null) {
      window.cancelAnimationFrame(boxSelectionMoveFrameRef.current)
      boxSelectionMoveFrameRef.current = null
    }
    if (grid.hasPointerCapture(event.pointerId)) grid.releasePointerCapture(event.pointerId)
    clearBoxSelectionVisuals(grid)
  }

  const animatedSelected = assets.filter((asset) => selected.has(asset.id) && asset.animated).length
  return (
    <section className={`sticker-picker ${mode}`}>
      <div className="picker-toolbar">
        <div className="picker-media-tabs" aria-label="按类型筛选">
          {(['all', 'static', 'animated'] as const).map((value) => (
            <button
              className={media === value ? 'is-active' : ''}
              type="button"
              key={value}
              onClick={() => setMedia(value)}
            >
              {value === 'all'
                ? `全部 ${assets.length}`
                : value === 'static'
                  ? `静态 ${mediaCounts.static}`
                  : `动图 ${mediaCounts.animated}`}
            </button>
          ))}
        </div>
        <label className="picker-search">
          <Search size={16} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索表情名称"
          />
        </label>
        <SourceFilter value={source} options={sourceOptions} onChange={setSource} />
        <SortFilter value={sort} onChange={setSort} />
      </div>
      <div className="picker-selection-bar">
        <span>
          <strong>{selectedIds.length}</strong> 张已选择 · 包含 {animatedSelected} 张动图
          <small>拖过缩略图可框选多张</small>
        </span>
        <div>
          <button
            type="button"
            onClick={() => {
              selectMany(visible.map((asset) => asset.id))
            }}
          >
            全选当前结果
          </button>
          <button
            type="button"
            onClick={() => {
              onSelection([])
              if (mode === 'export') onOrder([])
            }}
          >
            取消选择
          </button>
          {mode === 'library' && onDelete && (
            <button
              className="danger-text"
              type="button"
              disabled={!selectedIds.length}
              onClick={() => onDelete(selectedIds)}
            >
              删除所选
            </button>
          )}
        </div>
      </div>
      {visible.length ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
          <SortableContext
            items={renderedAssets.map((asset) => asset.id)}
            strategy={rectSortingStrategy}
          >
            <div
              className="picker-grid"
              ref={gridRef}
              onPointerDown={startBoxSelection}
              onDragStart={(event) => {
                if (!(event.target as HTMLElement).closest('.picker-drag')) {
                  event.preventDefault()
                }
              }}
              onClickCapture={(event) => {
                if (!suppressPreviewRef.current) return
                suppressPreviewRef.current = false
                event.preventDefault()
                event.stopPropagation()
              }}
            >
              <div
                className="picker-selection-marquee"
                ref={marqueeRef}
                hidden
                aria-hidden="true"
              />
              {renderedAssets.map((asset) => (
                <PickerTile
                  key={asset.id}
                  asset={asset}
                  selected={selected.has(asset.id)}
                  index={selectedOrder.get(asset.id) ?? -1}
                  onToggle={() => toggle(asset.id)}
                  onPreview={() => setPreview(asset)}
                  dragEnabled={
                    sort === 'user-order' && (mode === 'library' || selected.has(asset.id))
                  }
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="picker-empty">没有符合当前筛选条件的表情。</div>
      )}
      {progressive.hasMore && (
        <button
          className="progressive-load-more"
          type="button"
          ref={progressive.sentinelRef}
          onClick={progressive.showMore}
        >
          已显示 {progressive.visibleCount} / {visible.length} 张，继续加载
        </button>
      )}
      {preview && (
        <StickerImagePreviewDialog
          asset={preview}
          onClose={() => setPreview(null)}
          onCopy={copyPreviewImage}
          {...(onDelete ? { onDelete: () => onDelete([preview.id]) } : {})}
        />
      )}
    </section>
  )
}

function SortFilter({
  value,
  onChange,
}: {
  value: 'user-order' | 'reverse-order'
  onChange(value: 'user-order' | 'reverse-order'): void
}) {
  return (
    <MenuSelect
      value={value}
      options={[
        { value: 'user-order', label: '当前排序' },
        { value: 'reverse-order', label: '倒序排序' },
      ]}
      ariaLabel="排序表情"
      onChange={onChange}
    />
  )
}

function SourceFilter({
  value,
  options,
  onChange,
}: {
  value: string
  options: Array<[string, string]>
  onChange(value: string): void
}) {
  const allOptions: Array<[string, string]> = [['all', '全部来源'], ...options]
  return (
    <MenuSelect
      value={value}
      options={allOptions.map(([option, label]) => ({ value: option, label }))}
      ariaLabel="按来源筛选"
      onChange={onChange}
    />
  )
}

function PickerTile({
  asset,
  selected,
  index,
  onToggle,
  onPreview,
  dragEnabled,
}: {
  asset: Asset
  selected: boolean
  index: number
  onToggle(): void
  onPreview(): void
  dragEnabled: boolean
}) {
  const sortable = useSortable({ id: asset.id, disabled: !dragEnabled })
  return (
    <article
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={`picker-tile${selected ? ' is-selected' : ''}${sortable.isDragging ? ' is-dragging' : ''}`}
      data-picker-asset-id={asset.id}
    >
      <button className="picker-preview" type="button" onClick={onPreview}>
        <ProgressiveImage src={asset.previewUrl} alt={asset.displayName} />
      </button>
      <button className="picker-select" type="button" aria-pressed={selected} onClick={onToggle}>
        {selected ? <span>{index + 1}</span> : <Square size={15} />}
      </button>
      <button
        className="picker-drag"
        type="button"
        disabled={!dragEnabled}
        aria-label={`拖动排序 ${asset.displayName}`}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <Grip size={17} />
      </button>
      {asset.animated && <span className="picker-media-badge">动图</span>}
    </article>
  )
}

function sourceKindLabel(kind: StickerSourceKind): string {
  return kind === 'local' ? '本机导入' : kind === 'wechat4' ? '微信 4.x' : '微信旧版'
}
