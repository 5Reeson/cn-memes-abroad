import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys'
import { safeStorage } from 'electron'

interface StoredAuthState {
  creds: AuthenticationCreds
  keys: SignalDataSet
}

export interface LoadedEncryptedAuthState {
  state: AuthenticationState
  saveCreds(): Promise<void>
}

export function hasPairedCredentials(creds: AuthenticationCreds): boolean {
  return Boolean(creds.registered || (creds.me?.id && creds.account))
}

export class EncryptedAuthStore {
  private stored: StoredAuthState | undefined
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  private assertEncryptionAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('macOS 安全存储当前不可用，无法安全保存 WhatsApp 登录信息')
    }
  }

  private async readStored(): Promise<StoredAuthState | undefined> {
    this.assertEncryptionAvailable()
    try {
      const encrypted = await readFile(this.path)
      const plaintext = safeStorage.decryptString(encrypted)
      return JSON.parse(plaintext, BufferJSON.reviver) as StoredAuthState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('无法解密 WhatsApp session；请清除登录后重新关联', { cause: error })
    }
  }

  private async persist(): Promise<void> {
    this.assertEncryptionAvailable()
    const stored = this.stored
    if (!stored) return
    const write = async () => {
      const directory = dirname(this.path)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const encrypted = safeStorage.encryptString(JSON.stringify(stored, BufferJSON.replacer))
      const temporaryPath = `${this.path}.${process.pid}.tmp`
      await writeFile(temporaryPath, encrypted, { mode: 0o600 })
      await rename(temporaryPath, this.path)
      await chmod(this.path, 0o600)
    }
    this.saveQueue = this.saveQueue.then(write, write)
    await this.saveQueue
  }

  async hasSession(): Promise<boolean> {
    const stored = this.stored ?? (await this.readStored())
    return stored ? hasPairedCredentials(stored.creds) : false
  }

  async load(): Promise<LoadedEncryptedAuthState> {
    this.stored = this.stored ?? (await this.readStored()) ?? { creds: initAuthCreds(), keys: {} }
    const stored = this.stored

    return {
      state: {
        creds: stored.creds,
        keys: {
          get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
            const values: Partial<Record<string, SignalDataTypeMap[T]>> = {}
            const category = stored.keys[type] as
              Record<string, SignalDataTypeMap[T] | null> | undefined
            for (const id of ids) {
              let value = category?.[id]
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as proto.Message.IAppStateSyncKeyData,
                ) as unknown as SignalDataTypeMap[T]
              }
              if (value) values[id] = value
            }
            return values as Record<string, SignalDataTypeMap[T]>
          },
          set: async (updates: SignalDataSet) => {
            for (const type of Object.keys(updates) as Array<keyof SignalDataTypeMap>) {
              const current = (stored.keys[type] ?? {}) as Record<string, unknown>
              const changes = updates[type] as Record<string, unknown | null>
              for (const [id, value] of Object.entries(changes)) {
                if (value === null) delete current[id]
                else current[id] = value
              }
              ;(stored.keys as Record<string, unknown>)[type] = current
            }
            await this.persist()
          },
        },
      },
      saveCreds: () => this.persist(),
    }
  }

  async clear(): Promise<void> {
    await this.saveQueue.catch(() => undefined)
    this.stored = undefined
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
