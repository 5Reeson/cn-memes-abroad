import { createDecipheriv, createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'

import { app } from 'electron'

import {
  clearCandidateDatabaseKey,
  encodeSyntheticCandidateFrame,
} from '../src/main/sources/wechat4/candidate-key-pipe.js'
import {
  runWechat4HelperForStoreEmoticons,
  runWechat4HelperWithCandidateFrame,
} from '../src/main/sources/wechat4/helper-runner.js'
import { clearWechat4StoreEmoticonCatalog } from '../src/main/sources/wechat4/store-emoticon-catalog.js'
import { Wechat4KeyStore } from '../src/main/sources/wechat4/wechat4-key-store.js'
import {
  DEFAULT_WECHAT4_ROOT,
  discoverWechat4,
  removeWechat4Snapshot,
  snapshotWechat4Database,
  type Wechat4Snapshot,
} from '../src/main/sources/wechat4/wechat4-layout.js'
import type { Wechat4StoreEmoticon } from '../src/main/sources/wechat4/store-emoticon-catalog.js'

type ImageFormat = 'gif' | 'jpeg' | 'png' | 'webp'

// safeStorage derives its Keychain service from the app name. Match the production package rather
// than the default name of a standalone Electron entry script.
app.setName('cn-memes-abroad')

const signatures: Array<{ format: ImageFormat; bytes: Buffer; offset?: number }> = [
  { format: 'png', bytes: Buffer.from('89504e470d0a1a0a', 'hex') },
  { format: 'gif', bytes: Buffer.from('GIF87a') },
  { format: 'gif', bytes: Buffer.from('GIF89a') },
  { format: 'jpeg', bytes: Buffer.from('ffd8ff', 'hex') },
  { format: 'webp', bytes: Buffer.from('WEBP'), offset: 8 },
]

function md5(value: string | Buffer): string {
  return createHash('md5').update(value).digest('hex')
}

function pkcs7CipherLength(plainLength: number): number {
  return Math.ceil((plainLength + 1) / 16) * 16
}

function fixedAesKey(bytes: Buffer): Buffer {
  const key = Buffer.alloc(16)
  bytes.copy(key, 0, 0, Math.min(bytes.length, key.length))
  return key
}

function aesKeyCandidates(record: Wechat4StoreEmoticon): Array<[string, Buffer]> {
  const packageHash = md5(record.packageId)
  return [
    ['package-id-utf8', fixedAesKey(Buffer.from(record.packageId, 'utf8'))],
    ['package-id-md5-utf8', fixedAesKey(Buffer.from(packageHash, 'ascii'))],
    ['package-id-md5-hex', fixedAesKey(Buffer.from(packageHash, 'hex'))],
    ['member-md5-utf8', fixedAesKey(Buffer.from(record.md5, 'ascii'))],
    ['member-md5-hex', fixedAesKey(Buffer.from(record.md5, 'hex'))],
  ]
}

function decryptEmoticonData(ciphertext: Buffer, key: Buffer): Buffer | undefined {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) return undefined
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, key)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    return undefined
  }
}

function decryptEmoticonFirstBlock(ciphertext: Buffer, key: Buffer): Buffer | undefined {
  if (ciphertext.length < 16 || key.length !== 16) return undefined
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, key)
    decipher.setAutoPadding(false)
    return Buffer.concat([decipher.update(ciphertext.subarray(0, 16)), decipher.final()])
  } catch {
    return undefined
  }
}

async function kvcommCodes(): Promise<string[]> {
  const directory = join(
    homedir(),
    'Library',
    'Containers',
    'com.tencent.xinWeChat',
    'Data',
    'Documents',
    'app_data',
    'net',
    'kvcomm',
  )
  const codes = new Set<string>()
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const match = /^key_(\d{1,20})_.+\.statistic$/i.exec(entry.name)
    if (match?.[1]) codes.add(match[1])
  }
  return [...codes]
}

function wxidCandidates(accountRoot: string): string[] {
  const raw = accountRoot.split('/').at(-1) ?? ''
  const candidates = new Set<string>([raw])
  const suffix = /^(.+)_([a-z0-9]{4})$/i.exec(raw)?.[1]
  if (suffix) candidates.add(suffix)
  return [...candidates].filter(Boolean)
}

function accountId(directoryName: string): string {
  return `wechat4-${createHash('sha256').update(directoryName).digest('hex').slice(0, 16)}`
}

function identify(bytes: Buffer): ImageFormat | undefined {
  for (const signature of signatures) {
    const offset = signature.offset ?? 0
    if (bytes.subarray(offset, offset + signature.bytes.length).equals(signature.bytes)) {
      if (signature.format !== 'webp' || bytes.subarray(0, 4).toString('ascii') === 'RIFF') {
        return signature.format
      }
    }
  }
  return undefined
}

function containsImage(bytes: Buffer): boolean {
  return signatures.some((signature) => {
    if (signature.format !== 'webp') return bytes.indexOf(signature.bytes) >= 0
    let offset = bytes.indexOf(signature.bytes)
    while (offset >= 8) {
      if (bytes.subarray(offset - 8, offset - 4).toString('ascii') === 'RIFF') return true
      offset = bytes.indexOf(signature.bytes, offset + 1)
    }
    return false
  })
}

function xorDecodedFormat(bytes: Buffer): { format: ImageFormat; md5: string } | undefined {
  for (const signature of signatures.filter((candidate) => (candidate.offset ?? 0) === 0)) {
    const key = bytes[0]! ^ signature.bytes[0]!
    if (signature.bytes.every((byte, index) => (bytes[index]! ^ key) === byte)) {
      const decoded = Buffer.allocUnsafe(bytes.length)
      try {
        for (let index = 0; index < bytes.length; index += 1) decoded[index] = bytes[index]! ^ key
        return { format: signature.format, md5: md5(decoded) }
      } finally {
        decoded.fill(0)
      }
    }
  }
  return undefined
}

function rebuildableThumb(bytes: Buffer): boolean {
  const marker = Buffer.from('IDAT')
  const idat = bytes.indexOf(marker)
  if (idat < 4 || bytes.indexOf(Buffer.from('IEND')) < 0) return false
  const length = bytes.readUInt32BE(idat - 4)
  const start = idat + marker.length
  const end = start + length
  if (end > bytes.length) return false
  let raw: Buffer
  try {
    raw = inflateSync(bytes.subarray(start, end))
  } catch {
    return false
  }
  try {
    const candidates: Array<[number, number, number]> = [
      [120, 120, 1],
      [60, 120, 2],
      [40, 120, 3],
      [30, 120, 4],
      [241, 60, 1],
      [362, 40, 1],
      [483, 30, 1],
      [180, 120, 2],
      [90, 120, 4],
    ]
    return candidates.some(([width, height, bytesPerPixel]) => {
      const rowBytes = 1 + width * bytesPerPixel
      if (raw.length !== rowBytes * height) return false
      for (let offset = 0; offset < raw.length; offset += rowBytes) {
        if (raw[offset]! > 4) return false
      }
      return true
    })
  } finally {
    raw.fill(0)
  }
}

async function storeDirectories(): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const entries = await readdir(DEFAULT_WECHAT4_ROOT, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    result.set(
      accountId(entry.name),
      join(DEFAULT_WECHAT4_ROOT, entry.name, 'business', 'emoticon', 'PersistStore'),
    )
  }
  return result
}

async function accountDirectories(): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const entries = await readdir(DEFAULT_WECHAT4_ROOT, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    result.set(accountId(entry.name), join(DEFAULT_WECHAT4_ROOT, entry.name))
  }
  return result
}

async function containerFiles(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const shards = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const shard of shards) {
    if (!shard.isDirectory() || shard.isSymbolicLink()) continue
    const entries = await readdir(join(directory, shard.name), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && !entry.isSymbolicLink() && /^[a-f0-9]{32}$/i.test(entry.name)) {
        files.set(entry.name.toLowerCase(), join(directory, shard.name, entry.name))
      }
    }
  }
  return files
}

async function probe(): Promise<void> {
  process.stderr.write('Store probe: discovery\n')
  const projectRoot = resolve(process.cwd())
  const keyStore = new Wechat4KeyStore(
    join(homedir(), 'Library', 'Application Support', 'cn-memes-abroad', 'wechat4', 'keys'),
  )
  const helper = join(
    projectRoot,
    'native',
    'wechat4-helper',
    'build',
    'universal',
    'wechat4-helper',
  )
  const [stores, accountRoots, localKvcommCodes] = await Promise.all([
    storeDirectories(),
    accountDirectories(),
    kvcommCodes(),
  ])
  const discovery = await discoverWechat4()
  const reports: Array<Record<string, unknown>> = []

  for (const [accountIndex, account] of discovery.accounts.entries()) {
    process.stderr.write(`Store probe: account ${accountIndex + 1}\n`)
    const candidate = await keyStore.load(account.id)
    if (!candidate) {
      reports.push({ account: accountIndex + 1, cachedCandidate: false })
      continue
    }
    let snapshot: Wechat4Snapshot | undefined
    let recordsToClear: Wechat4StoreEmoticon[] | undefined
    try {
      const accountRoot = accountRoots.get(account.id)
      const generalDatabase = accountRoot
        ? join(accountRoot, 'db_storage', 'general', 'general.db')
        : undefined
      const generalOverview = generalDatabase
        ? await runWechat4HelperWithCandidateFrame(
            {
              v: 1,
              id: `store-general-probe-${Date.now()}`,
              method: 'schemaOverviewFd',
              params: { databasePath: generalDatabase },
            },
            encodeSyntheticCandidateFrame(candidate),
            { executable: helper },
          )
        : undefined
      snapshot = await snapshotWechat4Database(account.id)
      const storeOverview = await runWechat4HelperWithCandidateFrame(
        {
          v: 1,
          id: `store-schema-probe-${Date.now()}`,
          method: 'schemaOverviewFd',
          params: { databasePath: snapshot.databasePath },
        },
        encodeSyntheticCandidateFrame(candidate),
        { executable: helper },
      )
      process.stderr.write(`Store probe: account ${accountIndex + 1} catalog\n`)
      const result = await runWechat4HelperForStoreEmoticons(
        {
          v: 1,
          id: `store-probe-${Date.now()}`,
          method: 'storeEmoticonsFd',
          params: { databasePath: snapshot.databasePath },
        },
        encodeSyntheticCandidateFrame(candidate),
        { executable: helper },
      )
      if (!result.response.ok) {
        reports.push({
          account: accountIndex + 1,
          cachedCandidate: true,
          helperError: result.response.error.code,
        })
        continue
      }
      recordsToClear = result.records
      process.stderr.write(`Store probe: account ${accountIndex + 1} media\n`)

      const storeDirectory = stores.get(account.id)
      const files = storeDirectory
        ? await containerFiles(storeDirectory)
        : new Map<string, string>()
      const directPackages = new Set<string>()
      const hashedPackages = new Set<string>()
      for (const record of result.records) {
        if (files.has(record.packageId.toLowerCase())) directPackages.add(record.packageId)
        if (files.has(md5(record.packageId))) hashedPackages.add(record.packageId)
      }
      const strategy =
        directPackages.size >= hashedPackages.size ? 'direct-package-id' : 'md5-package-id'
      const containerName = (packageId: string) =>
        strategy === 'direct-package-id' ? packageId.toLowerCase() : md5(packageId)

      let mappedRecords = 0
      let rangesInBounds = 0
      let exactMd5 = 0
      let xorExactMd5 = 0
      let zeroLength = 0
      let embeddedImages = 0
      let blockAligned = 0
      let offsetBlockAligned = 0
      let adjacentRanges = 0
      let adjacentDeclaredSizes = 0
      let adjacentPaddedSizes = 0
      let paddedRangesInBounds = 0
      let standalonePersist = 0
      let standaloneThumb = 0
      let standalonePersistImage = 0
      let standaloneThumbImage = 0
      let sliceEqualsStandalonePersist = 0
      let encryptedRemote = 0
      let anyRemote = 0
      let kvcommKeyHeaderHits = 0
      let kvcommVerifiedContainers = 0
      let kvcommVerifiedMembers = 0
      let thumbRangesInBounds = 0
      let thumbEmbeddedImages = 0
      let rebuildableThumbs = 0
      const formats: Partial<Record<ImageFormat, number>> = {}
      const xorFormats: Partial<Record<ImageFormat, number>> = {}
      const aesImageHits: Record<string, number> = {}
      const aesExactMd5Hits: Record<string, number> = {}
      const cache = new Map<string, Buffer>()
      const thumbStoreCache = new Map<string, Buffer>()
      try {
        const packages = new Map<string, Wechat4StoreEmoticon[]>()
        for (const record of result.records) {
          const members = packages.get(record.packageId) ?? []
          members.push(record)
          packages.set(record.packageId, members)
        }
        for (const members of packages.values()) {
          members.sort((left, right) => left.emoticonOffset - right.emoticonOffset)
          for (let index = 0; index + 1 < members.length; index += 1) {
            const current = members[index]!
            const next = members[index + 1]!
            const span = next.emoticonOffset - current.emoticonOffset
            adjacentRanges += 1
            if (span === current.emoticonSize) adjacentDeclaredSizes += 1
            if (span === pkcs7CipherLength(current.emoticonSize)) adjacentPaddedSizes += 1
          }
        }

        if (accountRoot && localKvcommCodes.length > 0) {
          const firstPackage = [...packages.entries()].find(([packageId]) =>
            files.has(containerName(packageId)),
          )
          if (firstPackage) {
            const firstPath = files.get(containerName(firstPackage[0]))!
            const firstContainer = await readFile(firstPath)
            try {
              for (const code of localKvcommCodes) {
                for (const candidateWxid of wxidCandidates(accountRoot)) {
                  const key = createHash('md5').update(`${code}${candidateWxid}EMOTICON`).digest()
                  try {
                    const firstBlock = decryptEmoticonFirstBlock(firstContainer, key)
                    if (!firstBlock) continue
                    try {
                      if (!identify(firstBlock)) continue
                      kvcommKeyHeaderHits += 1
                      for (const [packageId, members] of packages) {
                        const path = files.get(containerName(packageId))
                        if (!path) continue
                        const encrypted = await readFile(path)
                        const decrypted = decryptEmoticonData(encrypted, key)
                        encrypted.fill(0)
                        if (!decrypted) continue
                        try {
                          let verified = 0
                          for (const member of members) {
                            const end = member.emoticonOffset + member.emoticonSize
                            if (end > decrypted.length) continue
                            if (
                              md5(decrypted.subarray(member.emoticonOffset, end)) === member.md5
                            ) {
                              verified += 1
                            }
                          }
                          if (verified === members.length) kvcommVerifiedContainers += 1
                          kvcommVerifiedMembers += verified
                        } finally {
                          decrypted.fill(0)
                        }
                      }
                    } finally {
                      firstBlock.fill(0)
                    }
                  } finally {
                    key.fill(0)
                  }
                }
              }
            } finally {
              firstContainer.fill(0)
            }
          }
        }

        for (const record of result.records) {
          if (record.hasEncryptedRemote) encryptedRemote += 1
          if (record.hasAnyRemote) anyRemote += 1
          if (record.emoticonSize === 0) {
            zeroLength += 1
            continue
          }
          const path = files.get(containerName(record.packageId))
          if (!path) continue
          mappedRecords += 1
          let container = cache.get(path)
          if (!container) {
            container = await readFile(path)
            cache.set(path, container)
          }
          const end = record.emoticonOffset + record.emoticonSize
          if (!Number.isSafeInteger(end) || end > container.length) continue
          rangesInBounds += 1
          const payload = container.subarray(record.emoticonOffset, end)
          if (containsImage(payload)) embeddedImages += 1
          if (payload.length % 16 === 0) blockAligned += 1
          if (record.emoticonOffset % 16 === 0) offsetBlockAligned += 1
          const format = identify(payload)
          if (format) formats[format] = (formats[format] ?? 0) + 1
          if (md5(payload) === record.md5) exactMd5 += 1
          const xor = xorDecodedFormat(payload)
          if (xor) {
            xorFormats[xor.format] = (xorFormats[xor.format] ?? 0) + 1
            if (xor.md5 === record.md5) xorExactMd5 += 1
          }

          const paddedEnd = record.emoticonOffset + pkcs7CipherLength(record.emoticonSize)
          if (Number.isSafeInteger(paddedEnd) && paddedEnd <= container.length) {
            paddedRangesInBounds += 1
            const ciphertexts: Array<[string, Buffer]> = []
            if (payload.length % 16 === 0) ciphertexts.push(['declared-range', payload])
            if (paddedEnd !== end || payload.length % 16 !== 0) {
              ciphertexts.push([
                'padded-from-declared-size',
                container.subarray(record.emoticonOffset, paddedEnd),
              ])
            }
            const candidates = aesKeyCandidates(record)
            try {
              for (const [rangeName, ciphertext] of ciphertexts) {
                for (const [keyName, key] of candidates) {
                  const decoded = decryptEmoticonData(ciphertext, key)
                  if (!decoded) continue
                  try {
                    const identity = `${rangeName}:${keyName}`
                    if (identify(decoded))
                      aesImageHits[identity] = (aesImageHits[identity] ?? 0) + 1
                    if (md5(decoded) === record.md5) {
                      aesExactMd5Hits[identity] = (aesExactMd5Hits[identity] ?? 0) + 1
                    }
                  } finally {
                    decoded.fill(0)
                  }
                }
              }
            } finally {
              for (const [, key] of candidates) key.fill(0)
            }
          }

          const shard = record.md5.slice(0, 2)
          const persistPath = join(storeDirectory!, '..', 'Persist', shard, record.md5)
          const thumbPath = join(storeDirectory!, '..', 'Thumb', shard, `${record.md5}.thumb`)
          const persist = await readFile(persistPath).catch(() => undefined)
          const thumb = await readFile(thumbPath).catch(() => undefined)
          try {
            if (persist) {
              standalonePersist += 1
              if (containsImage(persist)) standalonePersistImage += 1
              if (payload.equals(persist)) sliceEqualsStandalonePersist += 1
            }
            if (thumb) {
              standaloneThumb += 1
              if (containsImage(thumb)) standaloneThumbImage += 1
            }
          } finally {
            persist?.fill(0)
            thumb?.fill(0)
          }

          const packageHash = md5(record.packageId)
          const thumbContainerPath = join(
            storeDirectory!,
            '..',
            'ThumbStore',
            packageHash.slice(0, 2),
            packageHash,
          )
          let thumbContainer = thumbStoreCache.get(thumbContainerPath)
          if (!thumbContainer) {
            thumbContainer = await readFile(thumbContainerPath).catch(() => undefined)
            if (thumbContainer) thumbStoreCache.set(thumbContainerPath, thumbContainer)
          }
          if (thumbContainer && record.thumbSize > 0) {
            const thumbEnd = record.thumbOffset + record.thumbSize
            if (Number.isSafeInteger(thumbEnd) && thumbEnd <= thumbContainer.length) {
              thumbRangesInBounds += 1
              const thumbPayload = thumbContainer.subarray(record.thumbOffset, thumbEnd)
              if (containsImage(thumbPayload)) thumbEmbeddedImages += 1
              if (rebuildableThumb(thumbPayload)) rebuildableThumbs += 1
            }
          }
        }
      } finally {
        for (const bytes of cache.values()) bytes.fill(0)
        for (const bytes of thumbStoreCache.values()) bytes.fill(0)
      }

      reports.push({
        account: accountIndex + 1,
        cachedCandidate: true,
        generalCandidateValidated: generalOverview?.ok === true,
        storePackageColumns:
          storeOverview.ok &&
          typeof storeOverview.result.overview === 'object' &&
          storeOverview.result.overview !== null &&
          Array.isArray((storeOverview.result.overview as { tables?: unknown }).tables)
            ? ((
                (storeOverview.result.overview as { tables: unknown }).tables as Array<{
                  name?: unknown
                  columns?: Array<{ name?: unknown }>
                }>
              )
                .find((table) => table.name === 'kStoreEmoticonPackageTable')
                ?.columns?.map((column) => column.name)
                .filter((name): name is string => typeof name === 'string') ?? [])
            : [],
        databaseRecords: result.response.result.recordCount,
        databasePackages: result.response.result.packageCount,
        containerFiles: files.size,
        mappingStrategy: strategy,
        directlyMappedPackages: directPackages.size,
        md5MappedPackages: hashedPackages.size,
        mappedRecords,
        rangesInBounds,
        zeroLength,
        embeddedImages,
        blockAligned,
        offsetBlockAligned,
        adjacentRanges,
        adjacentDeclaredSizes,
        adjacentPaddedSizes,
        paddedRangesInBounds,
        directFormats: formats,
        exactMd5,
        xorFormats,
        xorExactMd5,
        aesImageHits,
        aesExactMd5Hits,
        standalonePersist,
        standalonePersistImage,
        sliceEqualsStandalonePersist,
        standaloneThumb,
        standaloneThumbImage,
        encryptedRemote,
        anyRemote,
        kvcommCodeCandidates: localKvcommCodes.length,
        kvcommWxidCandidates: accountRoot ? wxidCandidates(accountRoot).length : 0,
        kvcommKeyHeaderHits,
        kvcommVerifiedContainers,
        kvcommVerifiedMembers,
        thumbRangesInBounds,
        thumbEmbeddedImages,
        rebuildableThumbs,
      })
      process.stderr.write(`Store probe: account ${accountIndex + 1} complete\n`)
    } finally {
      if (recordsToClear) clearWechat4StoreEmoticonCatalog(recordsToClear)
      clearCandidateDatabaseKey(candidate)
      if (snapshot) await removeWechat4Snapshot(snapshot)
    }
  }

  process.stdout.write(`${JSON.stringify({ accounts: reports }, null, 2)}\n`)
}

app
  .whenReady()
  .then(probe)
  .then(
    () => app.quit(),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Store probe failed'}\n`)
      app.exit(1)
    },
  )
