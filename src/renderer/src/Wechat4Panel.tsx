import { useEffect, useState } from 'react'
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise'
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle'
import { DownloadSimpleIcon as DownloadSimple } from '@phosphor-icons/react/DownloadSimple'
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/ShieldCheck'
import { WarningIcon as Warning } from '@phosphor-icons/react/Warning'
import { WechatLogoIcon as WechatLogo } from '@phosphor-icons/react/WechatLogo'
import { XIcon as X } from '@phosphor-icons/react/X'

import type {
  ImportProgress,
  ImportSummary,
  Wechat4GateStatus,
  Wechat4ImportAccountView,
  Wechat4ImportDiscoveryView,
  WechatDownloadMode,
} from '../../shared/domain.js'
import { WechatDownloadSettings } from './components/WechatDownloadSettings.js'

export function Wechat4Panel({
  onClose,
  onImported,
  onStopped,
}: {
  onClose: () => void
  onImported: (summary: ImportSummary) => void
  onStopped: () => void
}) {
  const [discovery, setDiscovery] = useState<Wechat4ImportDiscoveryView | null>(null)
  const [loading, setLoading] = useState(true)
  const [pendingAccount, setPendingAccount] = useState<Wechat4ImportAccountView | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [importingId, setImportingId] = useState<string | null>(null)
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
      setDiscovery(await api.discoverWechat4())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const api = window.stickerApp
    const unsubscribeProgress = api?.onWechat4Progress(setProgress)
    const unsubscribeGate = api?.onWechat4GateStatus(setGateStatus)
    void discover()
    return () => {
      unsubscribeProgress?.()
      unsubscribeGate?.()
    }
  }, [])

  function requestImport(account: Wechat4ImportAccountView) {
    setPendingAccount(account)
    setConfirmed(false)
    setError(null)
  }

  async function startImport() {
    const api = window.stickerApp
    if (!api || !pendingAccount || !confirmed) return
    const accountId = pendingAccount.id
    setPendingAccount(null)
    setImportingId(accountId)
    setProgress(null)
    setError(null)
    try {
      const result = await api.importWechat4(accountId, true, downloadMode)
      if (result.canceled) onStopped()
      else onImported(result)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setImportingId(null)
      setProgress(null)
      setCanceling(false)
    }
  }

  async function closePanel() {
    if (!importingId) return onClose()
    const api = window.stickerApp
    if (!api || canceling) return
    setCanceling(true)
    try {
      await api.cancelWechat4Import()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setCanceling(false)
    }
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

  const statusLabel =
    gateStatus.phase === 'awaiting-qr'
      ? '等待扫码与数据库加载'
      : gateStatus.phase === 'resolving'
        ? '正在解析本地缓存与微信 CDN'
        : gateStatus.phase === 'importing'
          ? '正在写入素材库'
          : gateStatus.message

  return (
    <section className="wechat-legacy-panel wechat4-panel" aria-labelledby="wechat4-title">
      <div className="wechat-legacy-heading">
        <span className="wechat-legacy-icon wechat4-icon">
          <WechatLogo size={22} weight="light" />
        </span>
        <div>
          <span className="wechat4-badge">WeChat 4</span>
          <h2 id="wechat4-title">从微信 4.x 收藏导入</h2>
          <p>只读处理表情数据库副本；优先使用本机缓存，缺失时才访问微信 CDN。</p>
        </div>
        <button
          type="button"
          className="panel-close"
          onClick={() => void closePanel()}
          disabled={canceling}
          aria-label={importingId ? '停止导入并关闭' : '关闭微信 4.x 导入'}
        >
          <X size={17} />
        </button>
      </div>

      {error && <p className="wechat-legacy-error">{error}</p>}

      {pendingAccount && (
        <aside
          className="wechat4-consent"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wechat4-consent-title"
        >
          <div className="wechat4-consent-title">
            <Warning size={20} weight="fill" />
            <div>
              <strong id="wechat4-consent-title">确认临时微信授权</strong>
              <span>{pendingAccount.label}</span>
            </div>
          </div>
          <ul>
            <li>若该账号没有可用安全缓存，应用会先退出原微信。</li>
            <li>应用只复制并临时签名隔离副本；不会修改 `/Applications/WeChat.app`。</li>
            <li>你需要在临时副本中扫码，并打开一次收藏表情面板。</li>
            <li>临时登录可能顶下原 Mac 会话；任务结束后会重新打开原微信。</li>
            <li>缺失的本地素材可能从微信 CDN 下载；数据库 key 不会进入日志或界面。</li>
          </ul>
          <label className="wechat4-confirm-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>我理解上述影响，并授权本次导入在需要时运行临时副本流程。</span>
          </label>
          <div className="button-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setPendingAccount(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!confirmed}
              onClick={() => void startImport()}
            >
              <ShieldCheck size={16} /> 确认并开始
            </button>
          </div>
        </aside>
      )}

      {loading ? (
        <p className="wechat-legacy-empty">正在检测本机微信 4.x 表情数据库…</p>
      ) : discovery?.accounts.length ? (
        <>
          <WechatDownloadSettings
            value={downloadMode}
            disabled={importingId !== null || pendingAccount !== null}
            cacheFirst
            onChange={setDownloadMode}
          />
          <div className="wechat-account-list">
            {discovery.accounts.map((account) => (
              <article key={account.id}>
                <div>
                  <strong>{account.label}</strong>
                  <span>
                    数据库 {(account.databaseBytes / 1024 / 1024).toFixed(1)} MB
                    {account.walPresent ? ' · 含 WAL' : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={importingId !== null || pendingAccount !== null}
                  onClick={() => requestImport(account)}
                >
                  <DownloadSimple size={16} />
                  {importingId === account.id ? '正在导入' : '授权并导入'}
                </button>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="wechat-legacy-empty">
          <p>
            {discovery?.permissionDenied
              ? '没有读取微信数据目录的权限。请在系统提示中允许访问后重试。'
              : discovery?.rootFound
                ? '没有找到可读取的 emoticon.db。请确认微信 4.x 已登录并加载过收藏表情。'
                : '没有找到微信 4.x 数据目录。'}
          </p>
          <button type="button" className="secondary-button" onClick={() => void discover()}>
            <ArrowClockwise size={16} /> 重新检测
          </button>
        </div>
      )}

      {importingId && (
        <div
          className={`wechat-import-progress wechat4-gate-${gateStatus.phase}`}
          aria-live="polite"
        >
          <div>
            <span>{statusLabel}</span>
            <span>{progress ? `${progress.completed} / ${progress.total}` : '准备中'}</span>
          </div>
          <div className="progress-line">
            <span
              style={{
                width: progress?.total
                  ? `${Math.min(100, (progress.completed / progress.total) * 100)}%`
                  : gateStatus.phase === 'awaiting-qr'
                    ? '45%'
                    : '8%',
              }}
            />
          </div>
          {gateStatus.phase === 'awaiting-qr' ? (
            <p>请查看临时微信窗口：扫码登录后打开收藏表情面板。等待期间可关闭本面板取消。</p>
          ) : gateStatus.phase === 'awaiting-favorites' ? (
            <div className="wechat4-favorites-ready">
              <p>在临时微信中打开收藏表情，并等到表情缩略图显示出来；不要提前继续。</p>
              <button
                type="button"
                className="primary-button"
                onClick={() => void confirmFavoritesReady()}
              >
                <CheckCircle size={16} /> 已显示收藏表情，继续导入
              </button>
            </div>
          ) : progress ? (
            <p>
              新增 {progress.imported} · 重复 {progress.duplicates} · 失败 {progress.failed}
            </p>
          ) : (
            <p>{gateStatus.message}</p>
          )}
        </div>
      )}

      {!importingId && !pendingAccount && discovery?.accounts.length ? (
        <p className="wechat4-privacy-note">
          <CheckCircle size={15} /> key 仅在验证成功后写入 macOS Keychain-backed 安全缓存。
        </p>
      ) : null}
    </section>
  )
}
