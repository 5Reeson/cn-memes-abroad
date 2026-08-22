import { Fragment, useEffect, useState } from 'react'
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise'
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle'
import { DownloadSimpleIcon as DownloadSimple } from '@phosphor-icons/react/DownloadSimple'
import { EyeIcon as Eye } from '@phosphor-icons/react/Eye'
import { InfoIcon as Info } from '@phosphor-icons/react/Info'
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/ShieldCheck'
import { WarningIcon as Warning } from '@phosphor-icons/react/Warning'
import { WechatLogoIcon as WechatLogo } from '@phosphor-icons/react/WechatLogo'
import { XIcon as X } from '@phosphor-icons/react/X'

import type {
  ImportProgress,
  ImportSummary,
  LegacyWechatAccountView,
  LegacyWechatDiscoveryView,
  Wechat4GateStatus,
  Wechat4ImportAccountView,
  Wechat4ImportDiscoveryView,
  WechatAccountPreviewView,
  WechatStagedAssetView,
  WechatStagedImportView,
  WechatDownloadMode,
} from '../../shared/domain.js'
import { DismissibleInfoNotice } from './components/DismissibleInfoNotice.js'
import { ProgressiveImage } from './components/ProgressiveImage.js'
import { StickerImagePreviewDialog } from './components/StickerImagePreviewDialog.js'
import { StickerPicker } from './components/StickerPicker.js'
import { WechatDownloadSettings } from './components/WechatDownloadSettings.js'

type WechatAccount =
  | { kind: 'current'; account: Wechat4ImportAccountView }
  | { kind: 'legacy'; account: LegacyWechatAccountView }

type WechatAccountAction = 'preview' | 'download'

interface PendingAction {
  account: Wechat4ImportAccountView
  action: WechatAccountAction
}

interface ActiveTask {
  item: WechatAccount
  action: WechatAccountAction
}

interface DownloadedImport {
  item: WechatAccount
  stagedImport: WechatStagedImportView
}

interface WechatDiscoveries {
  current: Wechat4ImportDiscoveryView
  legacy: LegacyWechatDiscoveryView
}

const EMPTY_DISCOVERIES: WechatDiscoveries = {
  current: { rootFound: false, permissionDenied: false, accounts: [], failures: [] },
  legacy: { rootFound: false, permissionDenied: false, accounts: [], failures: [] },
}

function accountKey(item: WechatAccount): string {
  return `${item.kind}:${item.account.id}`
}

function importStatusLabel(status: Wechat4GateStatus): string {
  switch (status.phase) {
    case 'preparing':
      return '正在准备导入'
    case 'quitting-original':
      return '正在关闭当前微信'
    case 'copying':
    case 'signing':
      return '正在准备临时微信'
    case 'awaiting-qr':
      return '等待扫码与数据加载'
    case 'awaiting-favorites':
      return '等待打开收藏表情'
    case 'validating':
      return '正在读取收藏数据'
    case 'resolving':
      return '正在获取收藏表情'
    case 'importing':
      return '正在保存到我的表情库'
    case 'cleaning':
      return '正在关闭临时微信并恢复原微信'
    case 'complete':
      return '即将完成'
    default:
      return status.message
  }
}

export function WechatImportPanel({
  onClose,
  onImported,
  onStopped,
}: {
  onClose: () => void
  onImported: (summary: ImportSummary) => void
  onStopped: () => void
}) {
  const [discoveries, setDiscoveries] = useState<WechatDiscoveries>(EMPTY_DISCOVERIES)
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [activeTask, setActiveTask] = useState<ActiveTask | null>(null)
  const [accountPreviews, setAccountPreviews] = useState<Record<string, WechatAccountPreviewView>>(
    {},
  )
  const [previewAsset, setPreviewAsset] = useState<WechatStagedAssetView | null>(null)
  const [downloadedImport, setDownloadedImport] = useState<DownloadedImport | null>(null)
  const [selectionDialogOpen, setSelectionDialogOpen] = useState(false)
  const [stagedSelectedIds, setStagedSelectedIds] = useState<string[]>([])
  const [stagedOrderedIds, setStagedOrderedIds] = useState<string[]>([])
  const [committingSelection, setCommittingSelection] = useState(false)
  const [downloadMode, setDownloadMode] = useState<WechatDownloadMode>('default')
  const [canceling, setCanceling] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [gateStatus, setGateStatus] = useState<Wechat4GateStatus>({
    phase: 'idle',
    message: '等待选择账号',
  })
  const [error, setError] = useState<string | null>(null)

  async function discover() {
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    setLoading(true)
    setError(null)
    try {
      const [current, legacy] = await Promise.all([
        api.discoverWechat4(),
        api.discoverLegacyWechat(),
      ])
      setDiscoveries({ current, legacy })
      const accounts: WechatAccount[] = [
        ...current.accounts.map((account) => ({ kind: 'current' as const, account })),
        ...legacy.accounts.map((account) => ({ kind: 'legacy' as const, account })),
      ]
      const cached = await Promise.all(
        accounts.map(async (item) => {
          const preview = await api
            .getWechatAccountPreview(item.kind, item.account.id)
            .catch(() => undefined)
          return preview ? ([accountKey(item), preview] as const) : undefined
        }),
      )
      setAccountPreviews(Object.fromEntries(cached.filter((item) => item !== undefined)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const api = window.stickerApp
    const unsubscribeCurrentProgress = api?.onWechat4Progress(setProgress)
    const unsubscribeLegacyProgress = api?.onLegacyWechatProgress(setProgress)
    const unsubscribeGate = api?.onWechat4GateStatus(setGateStatus)
    void discover()
    return () => {
      unsubscribeCurrentProgress?.()
      unsubscribeLegacyProgress?.()
      unsubscribeGate?.()
    }
  }, [])

  function selectAccount(item: WechatAccount, action: WechatAccountAction) {
    setError(null)
    if (item.kind === 'current') {
      setPendingAction({ account: item.account, action })
      setConfirmed(false)
      return
    }
    void runLegacyAccountAction(item, action)
  }

  async function runLegacyAccountAction(
    item: Extract<WechatAccount, { kind: 'legacy' }>,
    action: WechatAccountAction,
  ) {
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    if (action === 'download') setDownloadedImport(null)
    setActiveTask({ item, action })
    setProgress(null)
    try {
      if (action === 'preview') {
        const result = await api.previewLegacyWechat(item.account.id, downloadMode)
        if (result.preview) {
          setAccountPreviews((current) => ({
            ...current,
            [accountKey(item)]: result.preview!,
          }))
        }
      } else {
        const result = await api.downloadLegacyWechat(item.account.id, downloadMode)
        if (result.stagedImport) {
          if (result.stagedImport.assets.length === 0) {
            setError('下载已完成，但没有可导入的表情。')
          } else {
            setDownloadedImport({ item, stagedImport: result.stagedImport })
          }
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setActiveTask(null)
      setProgress(null)
      setCanceling(false)
    }
  }

  async function runCurrentAccountAction() {
    const api = window.stickerApp
    if (!api || !pendingAction || !confirmed) return
    const item: WechatAccount = { kind: 'current', account: pendingAction.account }
    const action = pendingAction.action
    setPendingAction(null)
    if (action === 'download') setDownloadedImport(null)
    setActiveTask({ item, action })
    setProgress(null)
    setError(null)
    try {
      if (action === 'preview') {
        const result = await api.previewWechat4(item.account.id, true, downloadMode)
        if (result.preview) {
          setAccountPreviews((current) => ({
            ...current,
            [accountKey(item)]: result.preview!,
          }))
        }
      } else {
        const result = await api.downloadWechat4(item.account.id, true, downloadMode)
        if (result.stagedImport) {
          if (result.stagedImport.assets.length === 0) {
            setError('下载已完成，但没有可导入的表情。')
          } else {
            setDownloadedImport({ item, stagedImport: result.stagedImport })
          }
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setActiveTask(null)
      setProgress(null)
      setCanceling(false)
    }
  }

  async function cancelImport(closeAfterCancel = false) {
    if (!activeTask) {
      if (closeAfterCancel) onClose()
      return
    }
    const api = window.stickerApp
    if (!api || canceling) return
    setCanceling(true)
    try {
      const stopped =
        activeTask.item.kind === 'current'
          ? await api.cancelWechat4Import()
          : await api.cancelLegacyWechatImport()
      if (stopped) onStopped()
      if (closeAfterCancel) onClose()
      if (!stopped) setCanceling(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setCanceling(false)
    }
  }

  async function closePanel() {
    if (committingSelection) return
    await cancelImport(true)
  }

  async function confirmFavoritesReady() {
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    try {
      const accepted = await api.confirmWechat4FavoritesReady()
      if (!accepted) setError('临时微信当前不在等待收藏表情确认。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  function openStagedImportPicker() {
    if (!downloadedImport) return
    setError(null)
    const ids = downloadedImport.stagedImport.assets.map((asset) => asset.id)
    setStagedSelectedIds(ids)
    setStagedOrderedIds(ids)
    setSelectionDialogOpen(true)
  }

  async function commitStagedImport() {
    const api = window.stickerApp
    if (!api || !downloadedImport || committingSelection || stagedSelectedIds.length === 0) return
    const selected = new Set(stagedSelectedIds)
    const orderedSelection = stagedOrderedIds.filter((id) => selected.has(id))
    setCommittingSelection(true)
    setError(null)
    try {
      const result = await api.commitWechatStagedImport(
        downloadedImport.item.kind,
        downloadedImport.item.account.id,
        orderedSelection,
      )
      setSelectionDialogOpen(false)
      onImported(result)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCommittingSelection(false)
    }
  }

  const accounts: WechatAccount[] = [
    ...discoveries.current.accounts.map((account) => ({ kind: 'current' as const, account })),
    ...discoveries.legacy.accounts.map((account) => ({ kind: 'legacy' as const, account })),
  ]
  const permissionDenied =
    discoveries.current.permissionDenied || discoveries.legacy.permissionDenied
  const busy = activeTask !== null || pendingAction !== null || committingSelection
  const statusLabel =
    activeTask?.action === 'preview' && gateStatus.phase === 'importing'
      ? '正在生成账户预览'
      : activeTask?.action === 'download' && gateStatus.phase === 'importing'
        ? '正在整理下载结果'
        : importStatusLabel(gateStatus)

  return (
    <section className="wechat-import-panel" aria-labelledby="wechat-title">
      <div className="wechat-import-heading">
        <span className="wechat-import-icon">
          <WechatLogo size={30} weight="fill" />
        </span>
        <div>
          <h2 id="wechat-title">从微信个人收藏导入</h2>
          <p>选择一个微信账号，将个人收藏中的表情保存到我的表情库。</p>
        </div>
        <button
          type="button"
          className="panel-close"
          onClick={() => void closePanel()}
          disabled={canceling || committingSelection}
          aria-label={activeTask ? '停止当前任务并关闭' : '关闭微信导入'}
        >
          <X size={17} />
        </button>
      </div>

      {error && <p className="wechat-import-error">{error}</p>}

      {loading ? (
        <p className="wechat-import-empty">正在查找微信账号…</p>
      ) : (
        <>
          {permissionDenied && (
            <div className="wechat-permission-note" role="note">
              <Info size={19} weight="fill" />
              <div>
                <strong>需要读取其他应用的数据</strong>
                <p>请在 macOS 的系统提示中允许访问微信数据，然后重新检测账号。</p>
              </div>
              <button type="button" className="secondary-button" onClick={() => void discover()}>
                <ArrowClockwise size={16} /> 重新检测
              </button>
            </div>
          )}

          {accounts.length > 0 && (
            <>
              <DismissibleInfoNotice
                title="微信新版/旧版账户的区别"
                ariaLabel="微信新版和旧版账户的区别"
                closeLabel="关闭微信账户区别提示"
                className="wechat-version-notice"
              >
                <p>
                  新版微信账号需要打开临时微信副本并扫码；旧版微信账号只需要允许读取其他应用的数据。
                </p>
              </DismissibleInfoNotice>

              <WechatDownloadSettings
                value={downloadMode}
                disabled={busy}
                onChange={setDownloadMode}
              />

              <div className="wechat-account-list">
                {accounts.map((item) => {
                  const taskForAccount =
                    activeTask && accountKey(activeTask.item) === accountKey(item)
                      ? activeTask
                      : null
                  const preview = accountPreviews[accountKey(item)]
                  const awaitingConsent =
                    item.kind === 'current' && pendingAction?.account.id === item.account.id
                  return (
                    <Fragment key={accountKey(item)}>
                      <article>
                        <div className="wechat-account-meta">
                          <strong>{item.account.label}</strong>
                          <span>
                            {item.kind === 'current'
                              ? `数据库 ${(item.account.databaseBytes / 1024 / 1024).toFixed(1)} MB`
                              : `${item.account.stickerCount} 张收藏表情`}
                          </span>
                        </div>
                        {preview?.assets.length ? (
                          <div className="wechat-account-preview-strip" aria-label="账户表情预览">
                            {preview.assets.map((asset) => (
                              <button
                                type="button"
                                key={asset.id}
                                title={`预览 ${asset.displayName}`}
                                aria-label={`预览 ${asset.displayName}`}
                                onClick={() => setPreviewAsset(asset)}
                              >
                                <ProgressiveImage src={asset.previewUrl} alt="" eager />
                              </button>
                            ))}
                          </div>
                        ) : null}
                        <div className="wechat-account-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busy}
                            onClick={() => selectAccount(item, 'preview')}
                          >
                            <Eye size={16} />
                            {taskForAccount?.action === 'preview' ? '下载中...' : '预览5张'}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={busy}
                            onClick={() => selectAccount(item, 'download')}
                          >
                            <DownloadSimple size={16} />
                            {taskForAccount?.action === 'download' ? '下载中...' : '全部加载'}
                          </button>
                        </div>
                      </article>
                      {awaitingConsent && (
                        <aside
                          className="wechat4-consent"
                          role="dialog"
                          aria-labelledby={`wechat-consent-title-${item.account.id}`}
                        >
                          <div className="wechat4-consent-title">
                            <Warning size={20} weight="fill" />
                            <div>
                              <strong id={`wechat-consent-title-${item.account.id}`}>
                                确认临时微信授权
                              </strong>
                              <span>{item.account.label}</span>
                            </div>
                          </div>
                          <ul>
                            <li>开始前，应用可能需要先退出当前微信。</li>
                            <li>应用只会复制并运行临时微信副本，不会修改原微信应用。</li>
                            <li>你需要在临时微信中扫码，并打开一次收藏表情面板。</li>
                            <li>临时登录可能会退出原 Mac 会话，任务结束后会重新打开原微信。</li>
                          </ul>
                          <label className="wechat4-confirm-check">
                            <input
                              type="checkbox"
                              checked={confirmed}
                              onChange={(event) => setConfirmed(event.target.checked)}
                            />
                            <span>我了解上述流程，并同意在需要时运行临时微信副本。</span>
                          </label>
                          <div className="button-row">
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => setPendingAction(null)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="primary-button"
                              disabled={!confirmed}
                              onClick={() => void runCurrentAccountAction()}
                            >
                              <ShieldCheck size={16} />
                              {pendingAction?.action === 'preview' ? '确认并预览' : '确认并开始'}
                            </button>
                          </div>
                        </aside>
                      )}
                    </Fragment>
                  )
                })}
              </div>
            </>
          )}

          {!permissionDenied && accounts.length === 0 && (
            <div className="wechat-import-empty">
              <p>没有找到可读取的微信个人收藏。请先登录微信并打开一次收藏表情，然后重新检测。</p>
              <button type="button" className="secondary-button" onClick={() => void discover()}>
                <ArrowClockwise size={16} /> 重新检测
              </button>
            </div>
          )}
        </>
      )}

      {activeTask && (
        <div
          className={`wechat-import-progress${
            activeTask.item.kind === 'current' ? ` wechat4-gate-${gateStatus.phase}` : ''
          }`}
          aria-live="polite"
        >
          <div>
            <span>
              {activeTask.item.kind === 'current'
                ? statusLabel
                : progress?.phase === 'importing'
                  ? activeTask.action === 'preview'
                    ? '生成账户预览'
                    : '验证并导入图片'
                  : '下载图片'}
            </span>
            <span>{progress ? `${progress.completed} / ${progress.total}` : '准备中'}</span>
          </div>
          <div className="progress-line">
            <span
              style={{
                width: progress?.total
                  ? `${Math.min(100, (progress.completed / progress.total) * 100)}%`
                  : activeTask.item.kind === 'current' && gateStatus.phase === 'awaiting-qr'
                    ? '45%'
                    : '8%',
              }}
            />
          </div>
          {activeTask.item.kind === 'current' && gateStatus.phase === 'awaiting-qr' ? (
            <p>请在临时微信窗口扫码登录，然后打开收藏表情面板。</p>
          ) : activeTask.item.kind === 'current' && gateStatus.phase === 'awaiting-favorites' ? (
            <div className="wechat4-favorites-ready">
              <p>请等到临时微信中的收藏表情缩略图显示出来，再继续导入。</p>
              <button
                type="button"
                className="primary-button"
                onClick={() => void confirmFavoritesReady()}
              >
                <CheckCircle size={16} /> 收藏表情已显示，继续导入
              </button>
            </div>
          ) : progress ? (
            <div className="wechat-import-summary">
              <p>
                新增 {progress.imported}，重复 {progress.duplicates}，失败 {progress.failed}
              </p>
              <button
                type="button"
                className="text-button danger-text"
                disabled={canceling}
                onClick={() => void cancelImport()}
              >
                {canceling ? '正在取消' : '取消本次导入'}
              </button>
            </div>
          ) : activeTask.item.kind === 'current' ? (
            <p>{gateStatus.message}</p>
          ) : (
            <p>正在准备导入…</p>
          )}
        </div>
      )}

      {downloadedImport && !activeTask && (
        <div className="wechat-download-ready" aria-live="polite">
          <span>
            <CheckCircle size={17} weight="fill" />
            <strong>下载成功</strong>
            <small>{downloadedImport.stagedImport.assets.length} 张表情可供选择</small>
          </span>
          <button type="button" className="primary-button" onClick={openStagedImportPicker}>
            选择导入表情
          </button>
        </div>
      )}

      {!activeTask && !pendingAction && accounts.length > 0 ? (
        <p className="wechat4-privacy-note">
          <CheckCircle size={15} /> 微信数据只在本机读取和处理。
        </p>
      ) : null}

      {previewAsset && (
        <StickerImagePreviewDialog asset={previewAsset} onClose={() => setPreviewAsset(null)} />
      )}

      {selectionDialogOpen && downloadedImport && (
        <div
          className="preview-backdrop wechat-picker-backdrop"
          role="presentation"
          onClick={() => {
            if (!committingSelection) setSelectionDialogOpen(false)
          }}
        >
          <section
            className="wechat-import-picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wechat-picker-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2 id="wechat-picker-title">选择导入表情</h2>
                <p>筛选并勾选要保存到“我的表情库”的内容。</p>
              </div>
              <button
                type="button"
                className="panel-close"
                aria-label="关闭表情选择器"
                disabled={committingSelection}
                onClick={() => setSelectionDialogOpen(false)}
              >
                <X size={17} />
              </button>
            </header>
            <div className="wechat-import-picker-content">
              {error && <p className="wechat-import-error wechat-picker-error">{error}</p>}
              <StickerPicker
                assets={downloadedImport.stagedImport.assets}
                selectedIds={stagedSelectedIds}
                orderedIds={stagedOrderedIds}
                mode="export"
                toolbar="wechat-import"
                allowCopy={false}
                onSelection={setStagedSelectedIds}
                onOrder={setStagedOrderedIds}
              />
            </div>
            <footer>
              <span>已选择 {stagedSelectedIds.length} 张</span>
              <div className="button-row">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={committingSelection}
                  onClick={() => setSelectionDialogOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={committingSelection || stagedSelectedIds.length === 0}
                  onClick={() => void commitStagedImport()}
                >
                  {committingSelection ? '正在导入...' : `导入 ${stagedSelectedIds.length} 张表情`}
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}
    </section>
  )
}
