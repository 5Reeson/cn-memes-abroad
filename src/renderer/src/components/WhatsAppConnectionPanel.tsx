import { useEffect, useState } from 'react'
import { DeviceMobileIcon as DeviceMobile } from '@phosphor-icons/react/DeviceMobile'
import { SignOutIcon as SignOut } from '@phosphor-icons/react/SignOut'
import { WhatsappLogoIcon as WhatsappLogo } from '@phosphor-icons/react/WhatsappLogo'

import type {
  WhatsAppConnectionPhase,
  WhatsAppConnectionView,
  WhatsAppCredentialMode,
} from '../../../shared/domain.js'

const initialConnection: WhatsAppConnectionView = {
  phase: 'disconnected',
  hasSession: false,
  credentialMode: 'keychain',
  canChangeCredentialMode: true,
}

export function connectionLabel(phase: WhatsAppConnectionPhase): string {
  if (phase === 'connected') return '已连接'
  if (phase === 'connecting' || phase === 'reconnecting') return '连接中'
  if (phase === 'awaiting-qr' || phase === 'awaiting-pairing-code') return '等待关联'
  if (phase === 'error') return '连接异常'
  if (phase === 'logged-out') return '未登录'
  return '未连接'
}

export function WhatsAppConnectionPanel({
  compact = false,
  onStatus,
  onError,
}: {
  compact?: boolean
  onStatus?(status: WhatsAppConnectionView): void
  onError(message: string): void
}) {
  const [connection, setConnection] = useState(initialConnection)
  const [busy, setBusy] = useState(false)
  const [pairingMode, setPairingMode] = useState(false)
  const [pairingPhone, setPairingPhone] = useState('')

  function receiveStatus(status: WhatsAppConnectionView) {
    setConnection(status)
    onStatus?.(status)
    if (status.phase === 'connected') setPairingMode(false)
  }

  useEffect(() => {
    const api = window.stickerApp
    if (!api) return
    const unsubscribe = api.onWhatsAppStatus(receiveStatus)
    api
      .getWhatsAppStatus()
      .then(receiveStatus)
      .catch(() => undefined)
    return unsubscribe
  }, [])

  async function connect(phone?: string) {
    const api = window.stickerApp
    if (!api) return onError('桌面桥接不可用，请重新打开应用。')
    setBusy(true)
    try {
      receiveStatus(await api.connectWhatsApp(phone))
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    const api = window.stickerApp
    if (!api) return
    setBusy(true)
    try {
      receiveStatus(await api.disconnectWhatsApp())
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  async function changeCredentialMode(mode: WhatsAppCredentialMode) {
    const api = window.stickerApp
    if (!api || mode === connection.credentialMode) return
    setBusy(true)
    try {
      receiveStatus(await api.setWhatsAppCredentialMode(mode))
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
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
    setBusy(true)
    try {
      receiveStatus(await api.logoutWhatsApp(true))
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const connected = connection.phase === 'connected'
  const awaiting = ['connecting', 'reconnecting', 'awaiting-qr', 'awaiting-pairing-code'].includes(
    connection.phase,
  )

  return (
    <section className={`connection-panel${compact ? ' is-compact' : ''}`}>
      <header>
        <span className="destination-icon whatsapp">
          <WhatsappLogo size={30} weight="regular" />
        </span>
        <div>
          <h3>WhatsApp</h3>
          <p>{connection.message ?? '连接状态和凭证只保存在本机。'}</p>
        </div>
        <span className={`semantic-status ${connection.phase}`}>
          {connectionLabel(connection.phase)}
        </span>
      </header>

      {!connected && (
        <>
          <fieldset
            className="credential-options"
            disabled={!connection.canChangeCredentialMode || busy}
          >
            <legend>凭证存储方式</legend>
            <label className={connection.credentialMode === 'keychain' ? 'is-selected' : ''}>
              <input
                type="radio"
                checked={connection.credentialMode === 'keychain'}
                onChange={() => void changeCredentialMode('keychain')}
              />
              <span>
                <strong>macOS 钥匙串保护</strong>
                <small>默认推荐，使用系统安全存储。</small>
              </span>
            </label>
            <label className={connection.credentialMode === 'plaintext' ? 'is-selected' : ''}>
              <input
                type="radio"
                checked={connection.credentialMode === 'plaintext'}
                onChange={() => void changeCredentialMode('plaintext')}
              />
              <span>
                <strong>本地明文文件</strong>
                <small>安全性较低，目录 0700、文件 0600。</small>
              </span>
            </label>
          </fieldset>
          {!connection.canChangeCredentialMode && (
            <p className="inline-note">已有 session 时不能切换存储方式，请先登出。</p>
          )}
        </>
      )}

      {connection.phase === 'awaiting-qr' && connection.qrDataUrl && (
        <div className="login-challenge">
          <img src={connection.qrDataUrl} alt="WhatsApp 登录二维码" />
          <div>
            <strong>请用手机扫描二维码</strong>
            <p>WhatsApp 设置 → 已关联设备 → 关联设备。</p>
          </div>
        </div>
      )}

      {connection.phase === 'awaiting-pairing-code' && connection.pairingCode && (
        <div className="pairing-code-box">
          <span>在手机 WhatsApp 中输入配对码</span>
          <strong>{connection.pairingCode}</strong>
        </div>
      )}

      {pairingMode && !connection.hasSession && connection.phase !== 'awaiting-pairing-code' && (
        <div className="pairing-form">
          <label>
            <span>手机号（含国家/地区代码）</span>
            <input
              type="tel"
              value={pairingPhone}
              placeholder="例如 85212345678"
              onChange={(event) => setPairingPhone(event.target.value.replace(/[^\d+\s-]/g, ''))}
            />
          </label>
          <button
            className="secondary-button"
            type="button"
            disabled={busy || pairingPhone.replace(/\D/g, '').length < 8}
            onClick={() => void connect(pairingPhone)}
          >
            获取配对码
          </button>
        </div>
      )}

      <footer>
        {!connected && !awaiting && (
          <button
            className="primary-button"
            type="button"
            disabled={busy}
            onClick={() => void connect()}
          >
            <DeviceMobile size={16} />
            {connection.hasSession ? '恢复连接' : '显示二维码'}
          </button>
        )}
        {!connected && !awaiting && !connection.hasSession && (
          <button
            className="text-button"
            type="button"
            onClick={() => setPairingMode((value) => !value)}
          >
            使用手机号关联
          </button>
        )}
        {awaiting && (
          <button className="secondary-button" type="button" onClick={() => void disconnect()}>
            取消连接
          </button>
        )}
        {connected && (
          <button className="secondary-button" type="button" onClick={() => void disconnect()}>
            断开连接
          </button>
        )}
        {(connection.hasSession || connection.phase === 'error') && !awaiting && (
          <button className="text-button danger-text" type="button" onClick={() => void logout()}>
            <SignOut size={14} />
            登出并删除 session
          </button>
        )}
      </footer>
    </section>
  )
}
