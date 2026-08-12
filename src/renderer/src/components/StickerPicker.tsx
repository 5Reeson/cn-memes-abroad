import { useEffect, useMemo, useRef, useState } from 'react'
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
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/CaretDown'
import { CheckIcon as Check } from '@phosphor-icons/react/Check'
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react/MagnifyingGlass'
import { SquareIcon as Square } from '@phosphor-icons/react/Square'
import { XIcon as X } from '@phosphor-icons/react/X'

import type { CollectionView, StickerSourceKind } from '../../../shared/domain.js'

type Asset = CollectionView['assets'][number]

export interface StickerPickerProps {
  assets: Asset[]
  selectedIds: string[]
  orderedIds: string[]
  mode: 'library' | 'export'
  onSelection(ids: string[]): void
  onOrder(ids: string[]): void
  onDelete?(ids: string[]): void
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
  const [preview, setPreview] = useState<Asset | null>(null)
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
  const baseOrder =
    mode === 'export'
      ? [...orderedIds, ...assets.map((asset) => asset.id).filter((id) => !selected.has(id))]
      : assets
          .slice()
          .sort((a, b) => a.userOrder - b.userOrder)
          .map((asset) => asset.id)
  const orderIndex = new Map(baseOrder.map((id, index) => [id, index]))
  const visible = assets
    .filter(
      (asset) =>
        !query.trim() ||
        asset.displayName
          .toLocaleLowerCase('zh-Hans-CN')
          .includes(query.trim().toLocaleLowerCase('zh-Hans-CN')),
    )
    .filter((asset) => media === 'all' || asset.animated === (media === 'animated'))
    .filter((asset) => source === 'all' || sourceKey(asset).includes(source))
    .sort(
      (left, right) =>
        (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )

  function toggle(id: string) {
    if (selected.has(id)) {
      onSelection(selectedIds.filter((candidate) => candidate !== id))
      if (mode === 'export') onOrder(orderedIds.filter((candidate) => candidate !== id))
    } else {
      onSelection([...selectedIds, id])
      if (mode === 'export') onOrder([...orderedIds, id])
    }
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
                  ? `静态 ${assets.filter((asset) => !asset.animated).length}`
                  : `动图 ${assets.filter((asset) => asset.animated).length}`}
            </button>
          ))}
        </div>
        <label className="picker-search">
          <Search size={16} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索表情"
          />
        </label>
        <SourceFilter value={source} options={sourceOptions} onChange={setSource} />
      </div>
      <div className="picker-selection-bar">
        <span>
          <strong>{selectedIds.length}</strong> 张已选择 · 包含 {animatedSelected} 张动图
        </span>
        <div>
          <button
            type="button"
            onClick={() => {
              const visibleIds = visible.map((asset) => asset.id)
              onSelection([...selectedIds, ...visibleIds.filter((id) => !selected.has(id))])
              if (mode === 'export') {
                onOrder([...orderedIds, ...visibleIds.filter((id) => !orderedIds.includes(id))])
              }
            }}
          >
            选择当前结果
          </button>
          <button
            type="button"
            onClick={() => {
              onSelection([])
              if (mode === 'export') onOrder([])
            }}
          >
            清空选择
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
          <SortableContext items={visible.map((asset) => asset.id)} strategy={rectSortingStrategy}>
            <div className="picker-grid">
              {visible.map((asset) => (
                <PickerTile
                  key={asset.id}
                  asset={asset}
                  selected={selected.has(asset.id)}
                  index={selectedIds.indexOf(asset.id)}
                  onToggle={() => toggle(asset.id)}
                  onPreview={() => setPreview(asset)}
                  dragEnabled={mode === 'library' || selected.has(asset.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="picker-empty">没有符合当前筛选条件的表情。</div>
      )}
      {preview && (
        <div className="preview-backdrop" role="presentation" onClick={() => setPreview(null)}>
          <div
            className="preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`预览 ${preview.displayName}`}
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" onClick={() => setPreview(null)} aria-label="关闭预览">
              <X size={18} />
            </button>
            <img src={preview.previewUrl} alt={preview.displayName} />
            <strong>{preview.displayName}</strong>
            <span>
              {preview.animated ? '动图' : '静态'} · {preview.width} × {preview.height}
            </span>
          </div>
        </div>
      )}
    </section>
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
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const allOptions: Array<[string, string]> = [['all', '全部来源'], ...options]
  const label = allOptions.find(([option]) => option === value)?.[1] ?? '全部来源'

  useEffect(() => {
    if (!open) return
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div className="source-filter" ref={root}>
      <button
        className="source-filter-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        <CaretDown size={15} weight="bold" />
      </button>
      {open && (
        <div className="source-filter-menu" role="listbox" aria-label="按来源筛选">
          {allOptions.map(([option, optionLabel]) => (
            <button
              className={option === value ? 'is-selected' : ''}
              type="button"
              role="option"
              aria-selected={option === value}
              key={option}
              onClick={() => {
                onChange(option)
                setOpen(false)
              }}
            >
              <span>{optionLabel}</span>
              {option === value && <Check size={15} weight="bold" />}
            </button>
          ))}
        </div>
      )}
    </div>
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
    >
      <button className="picker-preview" type="button" onClick={onPreview}>
        <img src={asset.previewUrl} alt={asset.displayName} />
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
