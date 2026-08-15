import { chmod, mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import makeWASocket, {
  Browsers,
  DisconnectReason,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import QRCode from 'qrcode'
import qrcode from 'qrcode-terminal'

import { prepareFixturePack, sendNativeStickerPack } from './sticker-pack.js'

const root = resolve(import.meta.dirname, '..')
const sessionDirectory = resolve(root, '.phase0/session')
const qrImagePath = resolve(root, '.phase0/whatsapp-login-qr.png')
const logger = pino({ level: 'silent' })

interface Options {
  checkOnly: boolean
  listOnly: boolean
  pairingPhone?: string
  target?: string
}

function usage(): string {
  return `Usage: npm run phase0 -- [options]

  --target self|JID       Send without prompting after login
  --list-only             List self and joined groups, then exit
  --pairing-code PHONE    Use a phone pairing code instead of QR
  --check-only            Validate the generated WebP/ZIP pack offline
  --help                  Show this help
`
}

function parseArgs(argv: string[]): Options {
  const options: Options = { checkOnly: false, listOnly: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help') {
      console.log(usage())
      process.exit(0)
    } else if (arg === '--check-only') {
      options.checkOnly = true
    } else if (arg === '--list-only') {
      options.listOnly = true
    } else if (arg === '--target') {
      options.target = argv[++index]
      if (!options.target) throw new Error('--target requires self or a JID')
    } else if (arg === '--pairing-code') {
      options.pairingPhone = argv[++index]?.replace(/\D/g, '')
      if (!options.pairingPhone)
        throw new Error('--pairing-code requires a country-code phone number')
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
    }
  }
  return options
}

async function hardenSessionFiles(): Promise<void> {
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 })
  await chmod(sessionDirectory, 0o700)
  const entries = await readdir(sessionDirectory, { withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => chmod(resolve(sessionDirectory, entry.name), 0o600)),
  )
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const output = 'output' in error ? error.output : undefined
  if (!output || typeof output !== 'object' || !('statusCode' in output)) return undefined
  return typeof output.statusCode === 'number' ? output.statusCode : undefined
}

async function selectTarget(socket: WASocket, requested?: string): Promise<string | undefined> {
  if (!socket.user?.id) throw new Error('Authenticated user is missing')
  const selfJid = jidNormalizedUser(socket.user.id)
  if (requested === 'self') return selfJid
  if (requested) return requested

  const groups = Object.values(await socket.groupFetchAllParticipating()).sort((left, right) =>
    left.subject.localeCompare(right.subject),
  )
  console.log(`\n[0] 给自己发（${selfJid}）`)
  groups.forEach((group, index) => console.log(`[${index + 1}] ${group.subject}  ${group.id}`))
  if (groups.length === 0) console.log('没有可用群聊；仍可选择 0 给自己发送。')

  const prompt = createInterface({ input: stdin, output: stdout })
  try {
    const answer = await prompt.question('\n请选择测试目标编号，或直接粘贴 JID：')
    const trimmed = answer.trim()
    if (trimmed === '0') return selfJid
    if (/^\d+$/.test(trimmed)) return groups[Number(trimmed) - 1]?.id
    return trimmed || undefined
  } finally {
    prompt.close()
  }
}

async function connectAndRun(options: Options): Promise<'done' | 'restart'> {
  await hardenSessionFiles()
  const { state, saveCreds } = await useMultiFileAuthState(sessionDirectory)
  let pairingRequested = false

  return new Promise<'done' | 'restart'>((resolvePromise, rejectPromise) => {
    const socket = makeWASocket({
      auth: state,
      browser: Browsers.macOS('Desktop'),
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })

    socket.ev.on('creds.update', async () => {
      await saveCreds()
      await hardenSessionFiles()
    })

    socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      try {
        if (qr && !options.pairingPhone) {
          await QRCode.toFile(qrImagePath, qr, { width: 900, margin: 3, errorCorrectionLevel: 'M' })
          await chmod(qrImagePath, 0o600)
          console.log('\n请在手机 WhatsApp 打开：设置 → 已关联设备 → 关联设备，然后扫描：\n')
          qrcode.generate(qr, { small: true })
          console.log(`\n二维码 PNG：${qrImagePath}`)
        }

        if (options.pairingPhone && !state.creds.registered && !pairingRequested) {
          pairingRequested = true
          const code = await socket.requestPairingCode(options.pairingPhone)
          console.log(`\n手机 WhatsApp → 设置 → 已关联设备 → 使用电话号码关联，输入：${code}`)
        }

        if (connection === 'open') {
          await hardenSessionFiles()
          console.log(
            `\n已登录；session 保存在 ${sessionDirectory}（目录 0700、文件 0600、已 gitignore）。`,
          )
          const target = await selectTarget(socket, options.target)
          if (!target) throw new Error('No target selected')
          if (options.listOnly) {
            await socket.end(undefined)
            resolvePromise('done')
            return
          }

          const pack = await prepareFixturePack()
          console.log(
            `正在上传一个原生 pack：${pack.stickers.length} 张 512x512 静态 WebP，ZIP ${pack.zip.length} bytes…`,
          )
          const messageId = await sendNativeStickerPack(socket, target, pack)
          console.log(
            `已提交消息 ${messageId} 到 ${target}。请在手机端打开 pack，并点击添加到贴纸托盘。`,
          )
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))
          await socket.end(undefined)
          resolvePromise('done')
        }

        if (connection === 'close') {
          const code = statusCode(lastDisconnect?.error)
          if (code === DisconnectReason.restartRequired) {
            await hardenSessionFiles()
            resolvePromise('restart')
          } else if (code === DisconnectReason.loggedOut) {
            rejectPromise(
              new Error('WhatsApp 已注销此 session；请手动删除 .phase0/session 后重新登录。'),
            )
          } else if (code !== undefined) {
            rejectPromise(new Error(`WhatsApp connection closed with status ${code}`))
          }
        }
      } catch (error) {
        rejectPromise(error)
      }
    })
  })
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const pack = await prepareFixturePack()
  console.log(
    `Pack 校验通过：${pack.stickers.map((item) => `${item.fileName}=${item.webp.length}B`).join(', ')}；tray=${pack.trayPng.length}B。`,
  )
  if (options.checkOnly) return

  // A successful first pairing normally asks the desktop client to restart.
  // Re-enter once using the newly written credentials, then continue the flow.
  while ((await connectAndRun(options)) === 'restart') {
    console.log('WhatsApp 要求关联后重启连接；正在复用刚保存的 session 继续…')
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Phase 0 失败：${message}`)
  process.exitCode = 1
})
