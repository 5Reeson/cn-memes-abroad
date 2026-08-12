import { useEffect, useRef, useState } from 'react'
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/ArrowRight'
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle'
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/FolderOpen'
import { ImagesIcon as Images } from '@phosphor-icons/react/Images'
import { LinkIcon as Link } from '@phosphor-icons/react/Link'
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/ShieldCheck'
import { TrashIcon as Trash } from '@phosphor-icons/react/Trash'
import { UploadSimpleIcon as UploadSimple } from '@phosphor-icons/react/UploadSimple'
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/WarningCircle'
import { WechatLogoIcon as WechatLogo } from '@phosphor-icons/react/WechatLogo'
import { WhatsappLogoIcon as WhatsappLogo } from '@phosphor-icons/react/WhatsappLogo'
import { XIcon as X } from '@phosphor-icons/react/X'

import type {
  CollectionView,
  ExportTask,
  ExportTaskDraft,
  ImportFailure,
  ImportMode,
  ImportProgress,
  ImportSummary,
  PrepareExportSummary,
  PreparedPackView,
  PreparedSnapshotView,
  PreparedSnapshotSummary,
  WhatsAppConnectionView,
} from '../../shared/domain.js'
import { AppShell, type AppPage } from './components/AppShell.js'
import { StickerPicker } from './components/StickerPicker.js'
import { WhatsAppConnectionPanel, connectionLabel } from './components/WhatsAppConnectionPanel.js'
import { WorkflowRail } from './components/WorkflowRail.js'
import { WhatsAppSendPanel } from './WhatsAppSendPanel.js'
import { Wechat4Panel } from './Wechat4Panel.js'
import { WechatLegacyPanel } from './WechatLegacyPanel.js'

function draftFromTask(task: ExportTask): ExportTaskDraft {
  return {
    currentStep: task.currentStep,
    source: task.source,
    destination: task.destination,
    selectedAssetIds: task.selectedAssetIds,
    orderedAssetIds: task.orderedAssetIds,
    whatsapp: task.whatsapp,
    localFolder: task.localFolder,
  }
}

function toPreparedPacks(summary: PrepareExportSummary | null): PreparedPackView[] {
  if (!summary || summary.destination !== 'whatsapp') return []
  return summary.groups.map((group) => ({
    id: group.id,
    name: group.name,
    publisher: summary.publisher ?? '',
    mediaKind: group.mediaKind === 'animated' ? 'animated' : 'static',
    stickers: group.items.map((item) => ({
      assetId: item.assetId,
      sizeBytes: item.sizeBytes,
      durationMs: item.durationMs,
      animationTimingAdjusted: item.animationTimingAdjusted,
      droppedFrameCount: item.droppedFrameCount,
    })),
    traySizeBytes: 0,
    assetFailures: summary.assetFailures.filter((failure) =>
      group.assetIds.includes(failure.assetId),
    ),
    status: group.status,
    error: group.error,
  }))
}

export function App() {
  const [page, setPage] = useState<AppPage>('export')
  const [collection, setCollection] = useState<CollectionView | null>(null)
  const [task, setTask] = useState<ExportTask | null>(null)
  const taskRef = useRef<ExportTask | null>(null)
  const saveQueue = useRef(Promise.resolve())
  const [snapshots, setSnapshots] = useState<PreparedSnapshotSummary[]>([])
  const [snapshotPreview, setSnapshotPreview] = useState<PreparedSnapshotView | null>(null)
  const [prepared, setPrepared] = useState<PrepareExportSummary | null>(null)
  const [whatsApp, setWhatsApp] = useState<WhatsAppConnectionView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [failures, setFailures] = useState<ImportFailure[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wechat4Open, setWechat4Open] = useState(false)
  const [legacyOpen, setLegacyOpen] = useState(false)

  useEffect(() => {
    const api = window.stickerApp
    if (!api) {
      setError('桌面桥接未能启动，请重新打开应用。')
      setLoading(false)
      return
    }
    const unsubscribeImport = api.onImportProgress(setProgress)
    const unsubscribeStatus = api.onWhatsAppStatus(setWhatsApp)
    Promise.all([
      api.getCollection(),
      api.getExportTask(),
      api.listPreparedSnapshots(),
      api.getWhatsAppStatus(),
    ])
      .then(([nextCollection, nextTask, nextSnapshots, status]) => {
        setCollection(nextCollection)
        taskRef.current = nextTask
        setTask(nextTask)
        setSnapshots(nextSnapshots)
        setWhatsApp(status)
      })
      .catch(showError)
      .finally(() => setLoading(false))
    return () => {
      unsubscribeImport()
      unsubscribeStatus()
    }
  }, [])

  function showError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason))
  }

  function updateTask(patch: Partial<ExportTaskDraft>) {
    const current = taskRef.current
    const api = window.stickerApp
    if (!current || !api) return
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
    taskRef.current = next
    setTask(next)
    setPrepared(null)
    saveQueue.current = saveQueue.current
      .then(async () => {
        const latest = taskRef.current
        if (!latest) return
        const saved = await api.saveExportTask(draftFromTask(latest))
        if (taskRef.current === latest) {
          taskRef.current = saved
          setTask(saved)
        }
      })
      .catch(showError)
  }

  function moveToStep(step: ExportTask['currentStep']) {
    updateTask({ currentStep: step })
  }

  async function importAssets(mode: ImportMode) {
    const api = window.stickerApp
    if (!api) return
    setBusy(true)
    setError(null)
    setFailures([])
    try {
      applyImportSummary(await api.importAssets(mode), 'local')
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  function applyImportSummary(result: ImportSummary, sourceKind?: 'local' | 'wechat') {
    setCollection(result.collection)
    setFailures(result.failures)
    if (result.canceled) return
    const previousIds = new Set(collection?.assets.map((asset) => asset.id) ?? [])
    const importedIds = result.collection.assets
      .filter((asset) => !previousIds.has(asset.id))
      .map((asset) => asset.id)
    const latestSource = result.collection.assets
      .flatMap((asset) => asset.sources)
      .filter((source) =>
        sourceKind === 'local' ? source.kind === 'local' : source.kind.startsWith('wechat'),
      )
      .sort((left, right) => right.importedAt.localeCompare(left.importedAt))[0]
    const source =
      sourceKind === 'local'
        ? {
            kind: 'local' as const,
            label: latestSource?.label ?? '本机导入',
            importBatchId: latestSource?.importBatchId,
          }
        : latestSource?.accountId
          ? {
              kind:
                latestSource.kind === 'wechat4' ? ('wechat4' as const) : ('wechat-legacy' as const),
              label: latestSource.label,
              sourceAccountId: latestSource.accountId,
            }
          : { kind: 'library' as const, label: '我的表情库' }
    updateTask({
      source,
      selectedAssetIds: importedIds,
      orderedAssetIds: importedIds,
      currentStep: 2,
    })
    setNotice(
      `已导入 ${result.imported} 张，跳过 ${result.duplicates} 张重复素材。新内容已保存到我的表情库。`,
    )
  }

  async function chooseLocalDestination() {
    const choice = await window.stickerApp?.chooseExportDirectory()
    if (!choice) return
    updateTask({ destination: choice, currentStep: 3 })
  }

  async function prepareTask() {
    const api = window.stickerApp
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.prepareExportTask()
      setPrepared(result)
      const refreshed = await api.getExportTask()
      taskRef.current = refreshed
      setTask(refreshed)
      if (result.animationRepairs.length) {
        setNotice(`已自动规范化 ${result.animationRepairs.length} 张动图的短帧，其余素材不受影响。`)
      }
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  async function saveSnapshot(forceDuplicate = false) {
    const api = window.stickerApp
    if (!api) return
    setBusy(true)
    try {
      const result = await api.savePreparedSnapshot(forceDuplicate)
      if (result.kind === 'duplicate' && !forceDuplicate) {
        const saveCopy = window.confirm(
          '已有内容、顺序和配置完全相同的已保存版本。是否仍另存为副本？',
        )
        if (saveCopy) return void saveSnapshot(true)
        setNotice('已打开相同的已保存版本。')
      } else {
        setNotice('已保留本次准备结果，可在以后预览或再次传输。')
      }
      setSnapshots(await api.listPreparedSnapshots())
      const refreshed = await api.getExportTask()
      taskRef.current = refreshed
      setTask(refreshed)
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  async function deleteSnapshot(id: string) {
    if (!window.confirm('删除这个已保存的传输结果？我的表情库素材不会删除。')) return
    try {
      await window.stickerApp?.deletePreparedSnapshot(id)
      setSnapshots((current) => current.filter((snapshot) => snapshot.id !== id))
    } catch (reason) {
      showError(reason)
    }
  }

  async function openSnapshot(id: string) {
    try {
      const snapshot = await window.stickerApp?.getPreparedSnapshot(id)
      if (snapshot) setSnapshotPreview(snapshot)
    } catch (reason) {
      showError(reason)
    }
  }

  async function transferLocal() {
    const api = window.stickerApp
    if (!api) return
    if (!window.confirm('确认开始导出到所选本地文件夹？应用会创建新的导出批次，不会覆盖原素材。'))
      return
    setBusy(true)
    try {
      const result = await api.transferLocalExport()
      setNotice(
        `已导出 ${result.assetCount} 张素材到“${result.directoryLabel}”，共 ${result.groupCount} 个文件夹分组。`,
      )
      const refreshed = await api.getExportTask()
      taskRef.current = refreshed
      setTask(refreshed)
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  async function removeAssets(ids: string[]) {
    const api = window.stickerApp
    if (!api || !ids.length) return
    if (
      !window.confirm(`从我的表情库删除所选 ${ids.length} 张素材？已保存的传输结果仍保留独立副本。`)
    )
      return
    try {
      const next = await api.removeAssets(ids)
      setCollection(next)
      const refreshed = await api.getExportTask()
      taskRef.current = refreshed
      setTask(refreshed)
    } catch (reason) {
      showError(reason)
    }
  }

  const content =
    loading || !collection || !task ? (
      <div className="product-loading">正在恢复我的表情库与导出任务…</div>
    ) : page === 'export' ? (
      <ExportPage
        collection={collection}
        task={task}
        prepared={prepared}
        snapshots={snapshots}
        whatsApp={whatsApp}
        busy={busy}
        progress={progress}
        failures={failures}
        onTask={updateTask}
        onStep={moveToStep}
        onLocalImport={importAssets}
        onWechat4={() => {
          setLegacyOpen(false)
          setWechat4Open(true)
        }}
        onLegacy={() => {
          setWechat4Open(false)
          setLegacyOpen(true)
        }}
        onChooseLocalDestination={chooseLocalDestination}
        onPrepare={prepareTask}
        onSaveSnapshot={saveSnapshot}
        onTransferLocal={transferLocal}
        onDeleteSnapshot={deleteSnapshot}
        onOpenSnapshot={openSnapshot}
        onError={setError}
        onWhatsAppStatus={setWhatsApp}
        onRefreshTask={() => {
          void window.stickerApp?.getExportTask().then((refreshed) => {
            taskRef.current = refreshed
            setTask(refreshed)
          })
        }}
      />
    ) : page === 'library' ? (
      <LibraryPage
        collection={collection}
        onSelection={async (ids) => setCollection(await window.stickerApp!.setSelection(ids))}
        onOrder={async (ids) => setCollection(await window.stickerApp!.reorderAssets(ids))}
        onDelete={removeAssets}
        onLocalImport={importAssets}
        onWechat4={() => setWechat4Open(true)}
      />
    ) : page === 'connections' ? (
      <ConnectionsPage
        onError={setError}
        onStatus={setWhatsApp}
        onWechat4={() => setWechat4Open(true)}
      />
    ) : page === 'settings' ? (
      <SettingsPage task={task} onChooseDirectory={chooseLocalDestination} />
    ) : (
      <AboutPage />
    )

  return (
    <AppShell
      page={page}
      onNavigate={setPage}
      rail={
        page === 'export' && task ? <WorkflowRail task={task} onStep={moveToStep} /> : undefined
      }
    >
      {error && (
        <div className="product-banner error" role="alert">
          <WarningCircle size={18} />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="关闭错误">
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="product-banner notice" role="status">
          <CheckCircle size={18} />
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      )}
      {wechat4Open && (
        <Wechat4Panel
          onClose={() => setWechat4Open(false)}
          onImported={(result) => applyImportSummary(result, 'wechat')}
          onStopped={() => setNotice('已停止微信导入，已写入的素材不会回滚。')}
        />
      )}
      {legacyOpen && (
        <WechatLegacyPanel
          onClose={() => setLegacyOpen(false)}
          onImported={(result) => applyImportSummary(result, 'wechat')}
          onStopped={() => setNotice('已停止微信旧版导入。')}
        />
      )}
      {snapshotPreview && (
        <SnapshotPreviewDialog
          snapshot={snapshotPreview}
          onClose={() => setSnapshotPreview(null)}
        />
      )}
      {content}
    </AppShell>
  )
}

interface ExportPageProps {
  collection: CollectionView
  task: ExportTask
  prepared: PrepareExportSummary | null
  snapshots: PreparedSnapshotSummary[]
  whatsApp: WhatsAppConnectionView | null
  busy: boolean
  progress: ImportProgress | null
  failures: ImportFailure[]
  onTask(patch: Partial<ExportTaskDraft>): void
  onStep(step: ExportTask['currentStep']): void
  onLocalImport(mode: ImportMode): void
  onWechat4(): void
  onLegacy(): void
  onChooseLocalDestination(): void
  onPrepare(): void
  onSaveSnapshot(forceDuplicate?: boolean): void
  onTransferLocal(): void
  onDeleteSnapshot(id: string): void
  onOpenSnapshot(id: string): void
  onError(message: string): void
  onWhatsAppStatus(status: WhatsAppConnectionView): void
  onRefreshTask(): void
}

function ExportPage(props: ExportPageProps) {
  const { task } = props
  if (task.currentStep === 1) return <SourceStep {...props} />
  if (task.currentStep === 2) return <DestinationStep {...props} />
  if (task.currentStep === 3) return <PickerStep {...props} />
  return <TransferStep {...props} />
}

function StepHeading({
  title,
  description,
  aside,
}: {
  title: string
  description: string
  aside?: React.ReactNode
}) {
  return (
    <header className="workspace-heading">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {aside}
    </header>
  )
}

function SourceStep(props: ExportPageProps) {
  return (
    <div className="workflow-workspace">
      <StepHeading
        title="选择表情"
        description="选择这次传输的素材来源。新导入的内容会安全保存到我的表情库。"
      />
      <div className="choice-list">
        <section className="choice-row is-featured">
          <span className="destination-icon wechat">
            <WechatLogo size={34} weight="fill" />
          </span>
          <div>
            <h3>从微信导入</h3>
            <p>选择脱敏账号并导入收藏表情</p>
            <small>需要明确授权。不会修改原微信。</small>
          </div>
          <div className="choice-actions">
            <button className="primary-button" type="button" onClick={props.onWechat4}>
              选择微信
            </button>
            <button className="text-button" type="button" onClick={props.onLegacy}>
              旧版微信
            </button>
          </div>
        </section>
        <section className="choice-row">
          <span className="destination-icon">
            <FolderOpen size={32} />
          </span>
          <div>
            <h3>从本机导入</h3>
            <p>选择单张、多张图片或整个文件夹</p>
          </div>
          <div className="choice-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={props.busy}
              onClick={() => props.onLocalImport('files')}
            >
              选择图片
            </button>
            <button
              className="text-button"
              type="button"
              disabled={props.busy}
              onClick={() => props.onLocalImport('directory')}
            >
              选择文件夹
            </button>
          </div>
        </section>
        <button
          className="choice-row choice-button"
          type="button"
          onClick={() =>
            props.onTask({ source: { kind: 'library', label: '我的表情库' }, currentStep: 2 })
          }
        >
          <span className="destination-icon">
            <Images size={32} />
          </span>
          <span>
            <strong>使用我的表情库</strong>
            <small>不重新导入，直接挑选已有素材</small>
          </span>
          <ArrowRight size={20} />
        </button>
      </div>
      {props.progress && (
        <div className="compact-progress">
          正在导入 {props.progress.completed} / {props.progress.total}
        </div>
      )}
      {props.failures.length > 0 && (
        <p className="inline-note warning">
          有 {props.failures.length} 个文件未导入，成功素材已保留。
        </p>
      )}
      <p className="privacy-line">
        <ShieldCheck size={17} />
        仅在你确认后读取本机微信数据。所有图片与数据库都在本机处理。
      </p>
    </div>
  )
}

function DestinationStep(props: ExportPageProps) {
  const connected = props.whatsApp?.phase === 'connected'
  return (
    <div className="workflow-workspace">
      <StepHeading
        title="选择目的地"
        description="目的地是必选项。只有 WhatsApp 需要先建立连接。"
      />
      <div className="choice-list">
        <section
          className={`choice-row${props.task.destination?.kind === 'whatsapp' ? ' is-selected' : ''}`}
        >
          <span className="destination-icon whatsapp">
            <WhatsappLogo size={34} />
          </span>
          <div>
            <h3>WhatsApp</h3>
            <p>
              {connected
                ? '已连接，可以准备并发送原生贴纸包'
                : `${connectionLabel(props.whatsApp?.phase ?? 'disconnected')}，可在这里完成关联`}
            </p>
          </div>
          <button
            className={connected ? 'primary-button' : 'secondary-button'}
            type="button"
            onClick={() =>
              props.onTask({ destination: { kind: 'whatsapp' }, currentStep: connected ? 3 : 2 })
            }
          >
            {connected ? '选择' : '连接并选择'}
          </button>
        </section>
        {!connected && props.task.destination?.kind === 'whatsapp' && (
          <WhatsAppConnectionPanel
            compact
            onStatus={props.onWhatsAppStatus}
            onError={props.onError}
          />
        )}
        <button
          className={`choice-row choice-button${props.task.destination?.kind === 'local-folder' ? ' is-selected' : ''}`}
          type="button"
          onClick={props.onChooseLocalDestination}
        >
          <span className="destination-icon">
            <FolderOpen size={32} />
          </span>
          <span>
            <strong>导出到本地文件夹</strong>
            <small>
              {props.task.destination?.kind === 'local-folder' &&
              props.task.destination.directoryLabel
                ? props.task.destination.directoryLabel
                : '复制或转换后保存到你选择的位置'}
            </small>
          </span>
          <ArrowRight size={20} />
        </button>
        <section className="choice-row is-disabled">
          <span className="destination-icon">
            <Link size={30} />
          </span>
          <div>
            <h3>更多 App 即将支持</h3>
            <p>目前可先导出到本地文件夹，再手动添加。</p>
          </div>
        </section>
      </div>
      {connected && props.task.destination?.kind === 'whatsapp' && (
        <div className="workspace-footer">
          <span>WhatsApp 已连接</span>
          <button className="primary-button" type="button" onClick={() => props.onStep(3)}>
            下一步
          </button>
        </div>
      )}
    </div>
  )
}

function PickerStep(props: ExportPageProps) {
  const animated = props.collection.assets.filter(
    (asset) => props.task.selectedAssetIds.includes(asset.id) && asset.animated,
  ).length
  return (
    <div className="workflow-workspace picker-workspace">
      <StepHeading
        title="挑选表情"
        description={`我的表情库共有 ${props.collection.assets.length} 张素材。本次选择不会改变素材库的管理选择或全局顺序。`}
        aside={
          <strong className="heading-count">已选择 {props.task.selectedAssetIds.length} 张</strong>
        }
      />
      <StickerPicker
        assets={props.collection.assets}
        selectedIds={props.task.selectedAssetIds}
        orderedIds={props.task.orderedAssetIds}
        mode="export"
        onSelection={(ids) => props.onTask({ selectedAssetIds: ids })}
        onOrder={(ids) => props.onTask({ orderedAssetIds: ids })}
      />
      <div className="workspace-footer">
        <span>
          <strong>{props.task.selectedAssetIds.length} 张已选择</strong>
          <small>
            包含 {animated} 张动图。
            {props.task.destination?.kind === 'whatsapp'
              ? '静态和动图会自动分开传输。'
              : '将按本地文件夹规则分组。'}
          </small>
        </span>
        <button
          className="primary-button"
          type="button"
          disabled={!props.task.selectedAssetIds.length}
          onClick={() => props.onStep(4)}
        >
          继续
        </button>
      </div>
    </div>
  )
}

function TransferStep(props: ExportPageProps) {
  const { task, prepared } = props
  const whatsAppDestination = task.destination?.kind === 'whatsapp'
  const preparedPacks = toPreparedPacks(prepared)
  return (
    <div className="workflow-workspace transfer-workspace">
      <StepHeading
        title="传输表情"
        description={
          whatsAppDestination
            ? 'WhatsApp 要求静态与动图分开传输。检查配置与分包后再确认发送。'
            : '确认输出格式、命名规则和文件夹分组，再开始本地导出。'
        }
      />
      {whatsAppDestination ? (
        <div className="transfer-fields">
          <label>
            <span>表情包名称</span>
            <input
              value={task.whatsapp.title}
              maxLength={128}
              onChange={(event) =>
                props.onTask({ whatsapp: { ...task.whatsapp, title: event.target.value } })
              }
            />
          </label>
          <label>
            <span>发布者</span>
            <input
              value={task.whatsapp.publisher}
              maxLength={128}
              onChange={(event) =>
                props.onTask({ whatsapp: { ...task.whatsapp, publisher: event.target.value } })
              }
            />
          </label>
          <label>
            <span>每包数量</span>
            <input
              type="number"
              min={3}
              max={30}
              value={task.whatsapp.packSize}
              onChange={(event) =>
                props.onTask({
                  whatsapp: { ...task.whatsapp, packSize: Number(event.target.value) },
                })
              }
            />
          </label>
        </div>
      ) : (
        <LocalTransferFields
          task={task}
          onTask={props.onTask}
          onChooseDestination={props.onChooseLocalDestination}
        />
      )}
      <section className="prepared-preview">
        <div className="section-heading-row">
          <div>
            <h3>{whatsAppDestination ? '传输预览' : '文件夹分组预览'}</h3>
            <p>
              {prepared
                ? `${prepared.groups.length} 个${whatsAppDestination ? '表情包' : '文件夹分组'}，${prepared.groups.reduce((count, group) => count + group.items.length, 0)} 张素材`
                : '准备后会显示每组素材与转换状态。'}
            </p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={props.busy || !task.selectedAssetIds.length}
            onClick={props.onPrepare}
          >
            {props.busy ? '正在准备' : task.prepared ? '重新准备' : '准备传输'}
          </button>
        </div>
        {prepared?.warnings.map((warning) => (
          <p className="inline-note warning" key={warning}>
            {warning}
          </p>
        ))}
        {prepared?.assetFailures.map((failure) => (
          <p className="inline-note warning" key={failure.assetId}>
            一张异常素材未能准备：{failure.message}
          </p>
        ))}
        {prepared && (
          <div className="prepared-groups">
            {prepared.groups.map((group) => (
              <article key={group.id} className={group.status === 'failed' ? 'is-failed' : ''}>
                <div>
                  <strong>{group.name}</strong>
                  <span>
                    {group.items.length} 张 ·{' '}
                    {group.mediaKind === 'animated'
                      ? '动图'
                      : group.mediaKind === 'static'
                        ? '静态表情'
                        : '混合素材'}
                  </span>
                </div>
                <div className="prepared-thumbs">
                  {group.items.slice(0, 6).map((item) => (
                    <img src={item.previewUrl} alt="" key={item.id} />
                  ))}
                </div>
                <small>{group.status === 'failed' ? '准备失败' : '待传输'}</small>
              </article>
            ))}
          </div>
        )}
      </section>
      {prepared && (
        <label className="snapshot-choice">
          <input type="checkbox" checked={Boolean(task.prepared?.snapshotId)} readOnly />
          <span>
            <strong>保留本次准备结果</strong>
            <small>保存不可变副本，以后可预览或再次传输。</small>
          </span>
          <button
            className="text-button"
            type="button"
            disabled={props.busy || Boolean(task.prepared?.snapshotId)}
            onClick={() => props.onSaveSnapshot()}
          >
            {task.prepared?.snapshotId ? '已保存' : '保存'}
          </button>
        </label>
      )}
      {prepared && whatsAppDestination && (
        <WhatsAppSendPanel
          expectedPackCount={prepared.groups.length}
          preparedPacks={preparedPacks}
          onError={props.onError}
          onSent={props.onRefreshTask}
        />
      )}
      {prepared && !whatsAppDestination && (
        <div className="workspace-footer">
          <span>将创建新的本地导出批次，不覆盖原文件。</span>
          <button
            className="primary-button"
            type="button"
            disabled={props.busy || prepared.groups.some((group) => group.status === 'failed')}
            onClick={props.onTransferLocal}
          >
            导出到本地文件夹
          </button>
        </div>
      )}
      {props.snapshots.length > 0 && (
        <SavedResults
          snapshots={props.snapshots}
          onOpen={props.onOpenSnapshot}
          onDelete={props.onDeleteSnapshot}
        />
      )}
    </div>
  )
}

function LocalTransferFields({
  task,
  onTask,
  onChooseDestination,
}: {
  task: ExportTask
  onTask(patch: Partial<ExportTaskDraft>): void
  onChooseDestination(): void
}) {
  return (
    <div className="local-transfer-settings">
      <button className="destination-summary" type="button" onClick={onChooseDestination}>
        <FolderOpen size={20} />
        <span>
          <strong>
            {task.destination?.kind === 'local-folder'
              ? (task.destination.directoryLabel ?? '选择导出位置')
              : '选择导出位置'}
          </strong>
          <small>点击更改本地文件夹</small>
        </span>
      </button>
      <div className="transfer-fields">
        <label>
          <span>批次名称</span>
          <input
            value={task.localFolder.batchName}
            onChange={(event) =>
              onTask({ localFolder: { ...task.localFolder, batchName: event.target.value } })
            }
          />
        </label>
        <label>
          <span>输出格式</span>
          <select
            value={task.localFolder.format}
            onChange={(event) =>
              onTask({
                localFolder: {
                  ...task.localFolder,
                  format: event.target.value as 'original' | 'converted-webp',
                },
              })
            }
          >
            <option value="original">保留原格式</option>
            <option value="converted-webp">转换为 WebP</option>
          </select>
        </label>
        <label>
          <span>命名规则</span>
          <select
            value={task.localFolder.naming}
            onChange={(event) =>
              onTask({
                localFolder: {
                  ...task.localFolder,
                  naming: event.target.value as 'original' | 'sequence',
                },
              })
            }
          >
            <option value="original">保留原文件名</option>
            <option value="sequence">按顺序编号</option>
          </select>
        </label>
        <label>
          <span>每文件夹数量</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={task.localFolder.itemsPerFolder}
            onChange={(event) =>
              onTask({
                localFolder: { ...task.localFolder, itemsPerFolder: Number(event.target.value) },
              })
            }
          />
        </label>
      </div>
    </div>
  )
}

function SavedResults({
  snapshots,
  onOpen,
  onDelete,
}: {
  snapshots: PreparedSnapshotSummary[]
  onOpen(id: string): void
  onDelete(id: string): void
}) {
  return (
    <section className="saved-results">
      <h3>已保存的传输结果</h3>
      <div>
        {snapshots.slice(0, 6).map((snapshot) => (
          <article key={snapshot.id}>
            <button className="saved-result-main" type="button" onClick={() => onOpen(snapshot.id)}>
              <strong>{snapshot.name}</strong>
              <small>
                {new Date(snapshot.createdAt).toLocaleString('zh-CN')} · {snapshot.assetCount} 张 ·{' '}
                {snapshot.groupCount} 组 ·{' '}
                {snapshot.destination === 'whatsapp' ? 'WhatsApp' : '本地文件夹'}
              </small>
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={`删除 ${snapshot.name}`}
              onClick={() => onDelete(snapshot.id)}
            >
              <Trash size={16} />
            </button>
          </article>
        ))}
      </div>
    </section>
  )
}

function SnapshotPreviewDialog({
  snapshot,
  onClose,
}: {
  snapshot: PreparedSnapshotView
  onClose(): void
}) {
  return (
    <div className="preview-backdrop" role="presentation" onClick={onClose}>
      <section
        className="snapshot-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snapshot-preview-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="snapshot-preview-title">{snapshot.name}</h2>
            <p>
              {snapshot.destination === 'whatsapp' ? 'WhatsApp' : '本地文件夹'}，
              {snapshot.assetCount} 张素材，{snapshot.groupCount} 组
            </p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭预览">
            <X size={18} />
          </button>
        </header>
        <div className="snapshot-preview-groups">
          {snapshot.groups.map((group) => (
            <article key={group.id}>
              <div>
                <strong>{group.name}</strong>
                <small>{group.items.length} 张</small>
              </div>
              <div>
                {group.items.map((item) => (
                  <img src={item.previewUrl} alt="" key={item.id} />
                ))}
              </div>
            </article>
          ))}
        </div>
        <footer>
          <span>这是独立保存的不可变副本，删除源素材后仍可安全预览。</span>
          <button className="primary-button" type="button" onClick={onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  )
}

function LibraryPage({
  collection,
  onSelection,
  onOrder,
  onDelete,
  onLocalImport,
  onWechat4,
}: {
  collection: CollectionView
  onSelection(ids: string[]): void
  onOrder(ids: string[]): void
  onDelete(ids: string[]): void
  onLocalImport(mode: ImportMode): void
  onWechat4(): void
}) {
  return (
    <div className="page-workspace">
      <StepHeading
        title="我的表情库"
        description="本机已管理素材的浏览与管理入口。筛选不会改变全局顺序或来源归属。"
        aside={
          <div className="heading-actions">
            <button className="secondary-button" type="button" onClick={onWechat4}>
              <WechatLogo size={16} />
              微信导入
            </button>
            <button className="primary-button" type="button" onClick={() => onLocalImport('files')}>
              <UploadSimple size={16} />
              本机导入
            </button>
          </div>
        }
      />
      {collection.assets.length ? (
        <StickerPicker
          assets={collection.assets}
          selectedIds={collection.selectedAssetIds}
          orderedIds={[...collection.assets]
            .sort((a, b) => a.userOrder - b.userOrder)
            .map((asset) => asset.id)}
          mode="library"
          onSelection={onSelection}
          onOrder={onOrder}
          onDelete={onDelete}
        />
      ) : (
        <div className="empty-state">
          <Images size={36} />
          <h3>表情库还是空的</h3>
          <p>从本机或微信导入后，素材会安全保存到这里。</p>
        </div>
      )}
    </div>
  )
}

function ConnectionsPage({
  onError,
  onStatus,
  onWechat4,
}: {
  onError(message: string): void
  onStatus(status: WhatsAppConnectionView): void
  onWechat4(): void
}) {
  return (
    <div className="page-workspace narrow-page">
      <StepHeading
        title="连接到 App"
        description="管理长期连接与本机导入授权。连接配置不会变成第二条导出流程。"
      />
      <WhatsAppConnectionPanel onError={onError} onStatus={onStatus} />
      <section className="connection-panel wechat-access">
        <header>
          <span className="destination-icon wechat">
            <WechatLogo size={30} weight="fill" />
          </span>
          <div>
            <h3>微信导入访问</h3>
            <p>微信不是永久连接。只有你点击重新授权后，才会启动临时副本或读取真实数据。</p>
          </div>
        </header>
        <footer>
          <button className="secondary-button" type="button" onClick={onWechat4}>
            查看脱敏账号与重新授权
          </button>
        </footer>
      </section>
      <section className="connection-panel is-muted">
        <header>
          <span className="destination-icon">
            <Link size={27} />
          </span>
          <div>
            <h3>更多 App</h3>
            <p>暂未支持。可以先导出到本地文件夹后手动添加。</p>
          </div>
        </header>
      </section>
    </div>
  )
}

function SettingsPage({
  task,
  onChooseDirectory,
}: {
  task: ExportTask
  onChooseDirectory(): void
}) {
  return (
    <div className="page-workspace narrow-page">
      <StepHeading
        title="设置"
        description="调整本地导出与默认行为。敏感凭证请在“连接到 App”中管理。"
      />
      <section className="settings-section">
        <h3>本地导出</h3>
        <button className="settings-row" type="button" onClick={onChooseDirectory}>
          <span>
            <strong>默认导出位置</strong>
            <small>
              {task.destination?.kind === 'local-folder'
                ? (task.destination.directoryLabel ?? '尚未选择')
                : '尚未选择'}
            </small>
          </span>
          <ArrowRight size={18} />
        </button>
        <div className="settings-row">
          <span>
            <strong>默认文件夹分组</strong>
            <small>
              每组 {task.localFolder.itemsPerFolder} 张，
              {task.localFolder.format === 'original' ? '保留原格式' : '转换为 WebP'}
            </small>
          </span>
        </div>
      </section>
      <section className="settings-section">
        <h3>隐私与存储</h3>
        <div className="settings-row">
          <span>
            <strong>本地优先</strong>
            <small>素材库、准备缓存、snapshot 与连接状态只保存在这台 Mac。</small>
          </span>
          <ShieldCheck size={20} />
        </div>
      </section>
    </div>
  )
}

function AboutPage() {
  return (
    <div className="page-workspace narrow-page about-page">
      <StepHeading
        title="关于与安全"
        description="梗出海是一款本地优先的 macOS 表情整理与传输工具。"
      />
      <section>
        <h3>微信数据怎么读取？</h3>
        <p>
          应用只在你明确授权后读取微信表情相关数据。必要时会创建隔离的临时副本并请你扫码，不会修改原
          WeChat.app。你可以通过退出临时副本和系统权限设置撤销访问。
        </p>
      </section>
      <section>
        <h3>数据会上传吗？</h3>
        <p>
          本机图片与数据库在本地处理。微信 key 只用于当前解密验证，WhatsApp session
          只用于你主动发起的连接与传输，不进入日志或 renderer state。
        </p>
      </section>
      <section>
        <h3>WhatsApp 凭证如何保存？</h3>
        <p>
          默认使用 macOS 钥匙串保护。也可选择权限受限的本地明文文件，目录为 0700、文件为
          0600。切换模式前必须先登出。
        </p>
      </section>
      <section>
        <h3>独立项目与公开审查</h3>
        <p>
          本项目不是腾讯或 Meta 官方产品。源码、构建配置和依赖可公开审查。Phase 9
          还会进行许可证、安全、隐私和发布审查。
        </p>
      </section>
    </div>
  )
}
