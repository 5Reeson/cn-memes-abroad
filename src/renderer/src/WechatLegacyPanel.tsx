import { useEffect, useState } from 'react'
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise'
import { DownloadSimpleIcon as DownloadSimple } from '@phosphor-icons/react/DownloadSimple'
import { InfoIcon as Info } from '@phosphor-icons/react/Info'
import { WechatLogoIcon as WechatLogo } from '@phosphor-icons/react/WechatLogo'
import { XIcon as X } from '@phosphor-icons/react/X'

import type {
  ImportProgress,
  ImportSummary,
  LegacyWechatDownloadMode,
  LegacyWechatDiscoveryView,
} from '../../shared/domain.js'

export function WechatLegacyPanel({
  onClose,
  onImported,
  onStopped,
}: {
  onClose: () => void
  onImported: (summary: ImportSummary) => void
  onStopped: () => void
}) {
  const [discovery, setDiscovery] = useState<LegacyWechatDiscoveryView | null>(null)
  const [loading, setLoading] = useState(true)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [downloadMode, setDownloadMode] = useState<LegacyWechatDownloadMode>('default')
  const [showSpeedInfo, setShowSpeedInfo] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function discover() {
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    setLoading(true)
    setError(null)
    try {
      setDiscovery(await api.discoverLegacyWechat())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const api = window.stickerApp
    const unsubscribe = api?.onLegacyWechatProgress(setProgress)
    void discover()
    return () => unsubscribe?.()
  }, [])

  async function importAccount(accountId: string) {
    const api = window.stickerApp
    if (!api) return setError('桌面桥接不可用，请重新打开应用。')
    setImportingId(accountId)
    setProgress(null)
    setError(null)
    try {
      const result = await api.importLegacyWechat(accountId, downloadMode)
      if (!result.canceled) onImported(result)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setImportingId(null)
      setProgress(null)
    }
  }

  async function closePanel() {
    if (!importingId) return onClose()
    const api = window.stickerApp
    if (!api || canceling) return
    setCanceling(true)
    try {
      if (await api.cancelLegacyWechatImport()) onStopped()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setCanceling(false)
    }
  }

  return (
    <section className="wechat-legacy-panel" aria-labelledby="wechat-legacy-title">
      <div className="wechat-legacy-heading">
        <span className="wechat-legacy-icon">
          <WechatLogo size={22} weight="light" />
        </span>
        <div>
          <span className="legacy-badge">Legacy Beta</span>
          <h2 id="wechat-legacy-title">从微信 3.x 收藏导入</h2>
          <p>只读解析本机 fav.archive；选择账号后，图片会从微信 CDN 下载到本地素材库。</p>
        </div>
        <button
          type="button"
          className="panel-close"
          onClick={() => void closePanel()}
          disabled={canceling}
          aria-label={importingId ? '停止导入并关闭' : '关闭微信导入'}
        >
          <X size={17} />
        </button>
      </div>

      {error && <p className="wechat-legacy-error">{error}</p>}
      {loading ? (
        <p className="wechat-legacy-empty">正在检测本机微信收藏…</p>
      ) : discovery?.accounts.length ? (
        <>
          <div className="wechat-download-settings">
            <label htmlFor="wechat-download-speed">下载速度</label>
            <div>
              <select
                id="wechat-download-speed"
                value={downloadMode}
                disabled={importingId !== null}
                onChange={(event) =>
                  setDownloadMode(event.target.value as LegacyWechatDownloadMode)
                }
              >
                <option value="default">默认速度</option>
                <option value="fast">快速获取</option>
                <option value="safe">安全获取</option>
              </select>
              <button
                type="button"
                className="wechat-speed-info-button"
                aria-label="查看下载速度说明"
                aria-expanded={showSpeedInfo}
                aria-controls="wechat-speed-info"
                onClick={() => setShowSpeedInfo(true)}
              >
                <Info size={17} />
              </button>
            </div>
          </div>

          {showSpeedInfo && (
            <aside id="wechat-speed-info" className="wechat-speed-info" role="note">
              <div>
                <strong>下载速率说明</strong>
                <p>
                  微信没有公开此接口的频率阈值。降低请求频率只能减少风险，不能保证不会触发服务端限制。
                </p>
              </div>
              <button
                type="button"
                className="panel-close"
                onClick={() => setShowSpeedInfo(false)}
                aria-label="关闭下载速度说明"
              >
                <X size={15} />
              </button>
              <dl>
                <div>
                  <dt>默认速度</dt>
                  <dd>单并发，每张间隔随机 0.5-1.5 秒</dd>
                </div>
                <div>
                  <dt>快速获取</dt>
                  <dd>4 并发连续下载，适合少量图片或网络稳定时</dd>
                </div>
                <div>
                  <dt>安全获取</dt>
                  <dd>单并发，每张间隔随机 1.5-3.5 秒</dd>
                </div>
              </dl>
            </aside>
          )}

          <div className="wechat-account-list">
            {discovery.accounts.map((account) => {
              const importing = importingId === account.id
              return (
                <article key={account.id}>
                  <div>
                    <strong>{account.label}</strong>
                    <span>{account.stickerCount} 张收藏贴纸</span>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={importingId !== null}
                    onClick={() => void importAccount(account.id)}
                  >
                    <DownloadSimple size={16} />
                    {importing ? '正在导入' : '导入这个账号'}
                  </button>
                </article>
              )
            })}
          </div>
        </>
      ) : (
        <div className="wechat-legacy-empty">
          <p>
            {discovery?.rootFound
              ? '没有找到可读取的 fav.archive。请确认微信 3.x 曾在这台 Mac 登录并收藏过贴纸。'
              : '没有找到微信 3.x 的 Legacy 数据目录。微信 4.x 将在 Phase 7 支持。'}
          </p>
          <button type="button" className="secondary-button" onClick={() => void discover()}>
            <ArrowClockwise size={16} /> 重新检测
          </button>
        </div>
      )}

      {importingId && (
        <div className="wechat-import-progress" aria-live="polite">
          <div>
            <span>{progress?.phase === 'importing' ? '验证并导入图片' : '下载图片'}</span>
            <span>{progress ? `${progress.completed} / ${progress.total}` : '准备中'}</span>
          </div>
          <div className="progress-line">
            <span
              style={{
                width: progress?.total
                  ? `${Math.min(100, (progress.completed / progress.total) * 100)}%`
                  : '3%',
              }}
            />
          </div>
          {progress?.phase === 'downloading' ? (
            <p>当前下载失败 {progress.failed}；新增与重复将在图片验证时统计。</p>
          ) : (
            <p>
              新增 {progress?.imported ?? 0} · 重复 {progress?.duplicates ?? 0} · 失败{' '}
              {progress?.failed ?? 0}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
