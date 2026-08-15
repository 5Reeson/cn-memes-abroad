import { useEffect, useMemo, useState } from 'react'
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise'
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/CheckCircle'
import { DeviceMobileIcon as DeviceMobile } from '@phosphor-icons/react/DeviceMobile'
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/MagnifyingGlass'
import { PaperPlaneTiltIcon as PaperPlaneTilt } from '@phosphor-icons/react/PaperPlaneTilt'
import { SignOutIcon as SignOut } from '@phosphor-icons/react/SignOut'
import { UserCircleIcon as UserCircle } from '@phosphor-icons/react/UserCircle'
import { UsersThreeIcon as UsersThree } from '@phosphor-icons/react/UsersThree'
import { WhatsappLogoIcon as WhatsappLogo } from '@phosphor-icons/react/WhatsappLogo'

import type {
  PreparedPackView,
  SendPackProgress,
  SendPackReceipt,
  WhatsAppConnectionPhase,
  WhatsAppConnectionView,
  WhatsAppCredentialMode,
  WhatsAppTarget,
} from '../../shared/domain.js'

interface WhatsAppSendPanelProps {
  expectedPackCount: number
  preparedPacks: PreparedPackView[]
  selectedPackIds: string[]
  onError(message: string): void
  onSent?(): void
}

const initialConnection: WhatsAppConnectionView = {
  phase: 'disconnected',
  hasSession: false,
  credentialMode: 'keychain',
  canChangeCredentialMode: true,
}

function connectionLabel(phase: WhatsAppConnectionPhase): string {
  switch (phase) {
    case 'connected':
      return '已连接'
    case 'connecting':
    case 'reconnecting':
      return '连接中'
    case 'awaiting-qr':
    case 'awaiting-pairing-code':
      return '等待关联'
    case 'error':
      return '连接异常'
    case 'logged-out':
      return '未登录'
    default:
      return '未连接'
  }
}

export function WhatsAppSendPanel({
  expectedPackCount,
  preparedPacks,
  selectedPackIds,
  onError,
  onSent,
}: WhatsAppSendPanelProps) {
  const [connection, setConnection] = useState<WhatsAppConnectionView>(initialConnection)
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [pairingMode, setPairingMode] = useState(false)
  const [pairingPhone, setPairingPhone] = useState('')
  const [groups, setGroups] = useState<WhatsAppTarget[] | null>(null)
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [groupSearch, setGroupSearch] = useState('')
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendProgress, setSendProgress] = useState<Record<string, SendPackProgress>>({})
  const [receipts, setReceipts] = useState<Record<string, SendPackReceipt>>({})

  const packSignature = preparedPacks.map((pack) => `${pack.id}:${pack.status}`).join('|')
  const selectedPacks = preparedPacks.filter((pack) => selectedPackIds.includes(pack.id))
  const selectedPackCount = selectedPacks.length
  const readyToSend =
    selectedPackIds.length > 0 &&
    preparedPacks.length === expectedPackCount &&
    selectedPackCount === selectedPackIds.length &&
    selectedPacks.every((pack) => pack.status === 'prepared')
  const filteredGroups = useMemo(() => {
    const query = groupSearch.trim().toLocaleLowerCase('zh-Hans-CN')
    return query
      ? (groups ?? []).filter((group) => group.name.toLocaleLowerCase('zh-Hans-CN').includes(query))
      : (groups ?? [])
  }, [groupSearch, groups])
  const selectedTarget =
    selectedTargetId === connection.selfTarget?.id
      ? connection.selfTarget
      : groups?.find((group) => group.id === selectedTargetId)
  const failedPackIds = selectedPacks
    .filter((pack) => receipts[pack.id]?.status === 'failed')
    .map((pack) => pack.id)
  const sentCount = selectedPacks.filter((pack) =>
    ['sent', 'skipped'].includes(receipts[pack.id]?.status ?? ''),
  ).length

  useEffect(() => {
    const api = window.stickerApp
    if (!api) return
    const receiveStatus = (status: WhatsAppConnectionView) => {
      setConnection(status)
      if (status.phase === 'connected' && status.selfTarget) {
        setPairingMode(false)
        setSelectedTargetId((current) => current ?? status.selfTarget!.id)
      }
      if (status.phase !== 'connected') {
        setGroups(null)
        setGroupSearch('')
      }
    }
    const unsubscribeStatus = api.onWhatsAppStatus(receiveStatus)
    const unsubscribeProgress = api.onSendPackProgress((progress) => {
      setSendProgress((current) => ({ ...current, [progress.packId]: progress }))
    })
    api
      .getWhatsAppStatus()
      .then(receiveStatus)
      .catch(() => undefined)
    return () => {
      unsubscribeStatus()
      unsubscribeProgress()
    }
  }, [])

  useEffect(() => {
    setSendProgress({})
    setReceipts({})
  }, [packSignature])

  async function connect(pairingPhoneNumber?: string) {
    const api = window.stickerApp
    if (!api) return onError('桌面桥接不可用，请重新打开应用。')
    setConnectionBusy(true)
    if (pairingPhoneNumber === undefined) setPairingMode(false)
    try {
      setConnection(await api.connectWhatsApp(pairingPhoneNumber))
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setConnectionBusy(false)
    }
  }

  async function disconnect() {
    const api = window.stickerApp
    if (!api) return
    setConnectionBusy(true)
    try {
      setConnection(await api.disconnectWhatsApp())
      setSelectedTargetId(null)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setConnectionBusy(false)
    }
  }

  async function setCredentialMode(mode: WhatsAppCredentialMode) {
    const api = window.stickerApp
    if (!api || mode === connection.credentialMode) return
    setConnectionBusy(true)
    try {
      setConnection(await api.setWhatsAppCredentialMode(mode))
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setConnectionBusy(false)
    }
  }

  async function switchToPairingMode() {
    if (
      ['connecting', 'reconnecting', 'awaiting-qr', 'awaiting-pairing-code'].includes(
        connection.phase,
      )
    ) {
      await disconnect()
    }
    setPairingMode(true)
  }

  async function logout() {
    const api = window.stickerApp
    if (
      !api ||
      !window.confirm(
        '确认登出 WhatsApp 并删除本机 session？我的表情库、微信安全缓存和已保存的传输结果不会删除。',
      )
    )
      return
    setConnectionBusy(true)
    try {
      setConnection(await api.logoutWhatsApp(true))
      setSelectedTargetId(null)
      setGroups(null)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setConnectionBusy(false)
    }
  }

  async function loadGroups() {
    const api = window.stickerApp
    if (!api) return
    setGroupsLoading(true)
    try {
      setGroups(await api.listWhatsAppGroups())
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setGroupsLoading(false)
    }
  }

  async function send(packIds?: string[]) {
    const api = window.stickerApp
    if (!api || !selectedTargetId) return
    setSending(true)
    if (!packIds) {
      setSendProgress({})
      setReceipts({})
    }
    try {
      const result = await api.sendWhatsAppPacks(selectedTargetId, packIds)
      setReceipts((current) => ({
        ...current,
        ...Object.fromEntries(result.receipts.map((receipt) => [receipt.packId, receipt])),
      }))
      onSent?.()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }

  const connected = connection.phase === 'connected'
  const awaitingLogin = [
    'connecting',
    'reconnecting',
    'awaiting-qr',
    'awaiting-pairing-code',
  ].includes(connection.phase)

  return (
    <section className="whatsapp-panel" aria-labelledby="whatsapp-panel-title">
      <div className="whatsapp-heading">
        <div>
          <p className="section-label">最后一步</p>
          <h2 id="whatsapp-panel-title">发送到 WhatsApp</h2>
          <p>默认只发给你自己。只有你主动读取后，应用才会加载群聊。</p>
        </div>
        <span className={`connection-pill ${connection.phase}`}>
          <span /> {connectionLabel(connection.phase)}
        </span>
      </div>

      {!connected && (
        <div className="connection-card">
          <div className="connection-copy">
            <span className="connection-icon">
              <WhatsappLogo size={25} weight="light" />
            </span>
            <div>
              <strong>{connection.hasSession ? '复用已保存的登录' : '连接你的 WhatsApp'}</strong>
              <p>
                {connection.message ??
                  (connection.hasSession
                    ? connection.credentialMode === 'keychain'
                      ? 'session 由 macOS 钥匙串保护；连接后通常无需再次扫码。'
                      : 'session 保存在权限受限的本地明文文件；连接后通常无需再次扫码。'
                    : '首次关联前请选择 session 的本机存储方式。')}
              </p>
            </div>
          </div>

          <fieldset
            className="credential-mode-picker"
            disabled={!connection.canChangeCredentialMode || connectionBusy}
          >
            <legend>WhatsApp 凭证存储</legend>
            <label className={connection.credentialMode === 'keychain' ? 'is-selected' : ''}>
              <input
                type="radio"
                name="whatsapp-credential-mode"
                checked={connection.credentialMode === 'keychain'}
                onChange={() => void setCredentialMode('keychain')}
              />
              <span>
                <strong>macOS 钥匙串保护</strong>
                <small>推荐。使用系统安全存储加密 session。</small>
              </span>
            </label>
            <label className={connection.credentialMode === 'plaintext' ? 'is-selected' : ''}>
              <input
                type="radio"
                name="whatsapp-credential-mode"
                checked={connection.credentialMode === 'plaintext'}
                onChange={() => void setCredentialMode('plaintext')}
              />
              <span>
                <strong>本地明文文件</strong>
                <small>安全性较低；目录 0700、文件 0600，仅建议排障时使用。</small>
              </span>
            </label>
            {!connection.canChangeCredentialMode && (
              <p>已有 session 时不能直接切换；如需更改，请先登出 WhatsApp。</p>
            )}
          </fieldset>

          {connection.phase === 'awaiting-qr' && connection.qrDataUrl && (
            <div className="login-challenge">
              <img src={connection.qrDataUrl} alt="WhatsApp 登录二维码" />
              <div>
                <strong>请用手机扫描二维码</strong>
                <p>WhatsApp → 设置 → 已关联设备 → 关联设备。</p>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => void switchToPairingMode()}
                >
                  改用手机号关联
                </button>
              </div>
            </div>
          )}

          {connection.phase === 'awaiting-pairing-code' && connection.pairingCode && (
            <div className="pairing-code-box">
              <span>手机 WhatsApp → 已关联设备 → 使用电话号码关联</span>
              <strong>{connection.pairingCode}</strong>
            </div>
          )}

          {pairingMode &&
            !connection.hasSession &&
            connection.phase !== 'awaiting-pairing-code' && (
              <div className="pairing-form">
                <label>
                  <span>手机号（含国家/地区代码）</span>
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="例如 85212345678"
                    value={pairingPhone}
                    onChange={(event) =>
                      setPairingPhone(event.target.value.replace(/[^\d+\s-]/g, ''))
                    }
                  />
                </label>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={connectionBusy || pairingPhone.replace(/\D/g, '').length < 8}
                  onClick={() => connect(pairingPhone)}
                >
                  获取配对码
                </button>
              </div>
            )}

          <div className="connection-actions">
            {!awaitingLogin && (
              <button
                className="primary-button"
                type="button"
                disabled={connectionBusy}
                onClick={() => connect()}
              >
                <DeviceMobile size={16} />
                {connection.hasSession ? '连接 WhatsApp' : '显示二维码'}
              </button>
            )}
            {!connection.hasSession && !pairingMode && connection.phase !== 'awaiting-qr' && (
              <button className="text-button" type="button" onClick={() => setPairingMode(true)}>
                使用手机号关联
              </button>
            )}
            {awaitingLogin && (
              <button className="text-button" type="button" onClick={disconnect}>
                取消连接
              </button>
            )}
            {!awaitingLogin && (connection.hasSession || connection.phase === 'error') && (
              <button className="text-button danger-text" type="button" onClick={logout}>
                清除本地登录
              </button>
            )}
          </div>
        </div>
      )}

      {connected && connection.selfTarget && (
        <div className="target-picker">
          <div className="target-picker-heading">
            <div>
              <strong>发送目标</strong>
              <p>为保护隐私，群聊不会自动读取。</p>
            </div>
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={groupsLoading}
              onClick={loadGroups}
            >
              {groupsLoading ? (
                <ArrowClockwise className="is-spinning" size={15} />
              ) : (
                <UsersThree size={15} />
              )}
              {groups === null ? '读取其他群聊' : '刷新群聊'}
            </button>
          </div>

          <button
            className={`target-option self-target${selectedTargetId === connection.selfTarget.id ? ' is-selected' : ''}`}
            type="button"
            onClick={() => setSelectedTargetId(connection.selfTarget!.id)}
          >
            <span className="target-avatar">
              <UserCircle size={21} />
            </span>
            <span>
              <strong>给自己发</strong>
              <small>默认选项 · 仅发送到你自己的聊天</small>
            </span>
            <span className="target-radio" />
          </button>

          {groups !== null && (
            <div className="group-picker">
              <label className="group-search">
                <MagnifyingGlass size={15} />
                <input
                  type="search"
                  placeholder="搜索群聊"
                  value={groupSearch}
                  onChange={(event) => setGroupSearch(event.target.value)}
                />
              </label>
              <div className="group-list">
                {filteredGroups.map((group) => (
                  <button
                    className={`target-option${selectedTargetId === group.id ? ' is-selected' : ''}`}
                    type="button"
                    key={group.id}
                    onClick={() => setSelectedTargetId(group.id)}
                  >
                    <span className="target-avatar">
                      <UsersThree size={19} />
                    </span>
                    <span>
                      <strong>{group.name}</strong>
                      <small>{group.participantCount ?? 0} 位成员</small>
                    </span>
                    <span className="target-radio" />
                  </button>
                ))}
                {filteredGroups.length === 0 && (
                  <p className="group-empty">
                    {groups.length === 0 ? '没有可用群聊。' : '没有匹配的群聊。'}
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="send-footer">
            <div className="send-summary">
              <strong>{selectedTarget?.name ?? '请选择发送目标'}</strong>
              <p>
                {selectedPackCount === 0
                  ? '请在传输预览中至少选择一个表情包。'
                  : !readyToSend
                    ? '请先点击上方“准备传输”完成表情转换。'
                    : sending
                      ? '正在逐包上传，请保持应用打开。'
                      : sentCount === selectedPackCount
                        ? '所选 WhatsApp 原生贴纸包已发送，请回到手机逐包添加。'
                        : `准备发送 ${selectedPackCount} 个 WhatsApp 原生贴纸包。`}
              </p>
            </div>
            {failedPackIds.length > 0 ? (
              <button
                className="secondary-button"
                type="button"
                disabled={sending}
                onClick={() => send(failedPackIds)}
              >
                <ArrowClockwise size={16} /> 重试失败的 {failedPackIds.length} 个包
              </button>
            ) : (
              <button
                className="primary-button"
                type="button"
                disabled={
                  !readyToSend || !selectedTarget || sending || sentCount === selectedPackCount
                }
                onClick={() => send(selectedPackIds)}
              >
                <PaperPlaneTilt size={16} />
                {sending ? '正在发送' : `发送 ${selectedPackCount} 个包`}
              </button>
            )}
          </div>

          {Object.keys(sendProgress).length > 0 && (
            <div className="send-progress-list" aria-live="polite">
              {preparedPacks.map((pack) => {
                const progress = sendProgress[pack.id]
                if (!progress) return null
                return (
                  <div key={pack.id} className={progress.status}>
                    {progress.status === 'sent' || progress.status === 'skipped' ? (
                      <CheckCircle size={16} weight="fill" />
                    ) : progress.status === 'failed' ? (
                      <ArrowClockwise size={16} />
                    ) : (
                      <span className="progress-spinner" />
                    )}
                    <span>
                      <strong>{pack.name}</strong>
                      <small>
                        {progress.message ??
                          (progress.status === 'uploading'
                            ? '正在上传 WhatsApp 原生贴纸包…'
                            : '发送成功')}
                      </small>
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          <div className="whatsapp-session-actions">
            <span>非官方 WhatsApp 集成；协议变化可能导致暂时不可用。</span>
            <div>
              <button
                className="text-button"
                type="button"
                disabled={connectionBusy || sending}
                onClick={disconnect}
              >
                断开连接
              </button>
              <button
                className="text-button danger-text"
                type="button"
                disabled={connectionBusy || sending}
                onClick={logout}
              >
                <SignOut size={14} /> 退出并清除登录
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
