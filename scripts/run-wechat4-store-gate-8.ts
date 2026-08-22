import { execFile } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'

import { app } from 'electron'

import {
  clearCandidateDatabaseKey,
  encodeSyntheticCandidateFrame,
} from '../src/main/sources/wechat4/candidate-key-pipe.js'
import { runWechat4HelperForStoreEmoticons } from '../src/main/sources/wechat4/helper-runner.js'
import {
  assertTemporaryAppOperationPaths,
  collectWechat4Markers,
  commonWechatProcesses,
  parseNativeProcessTable,
  processesInsideApp,
  type NativeProcessEntry,
  type Wechat4MarkerCollection,
} from '../src/main/sources/wechat4/load-gate.js'
import { ManagedProcessGroup } from '../src/main/sources/wechat4/process-group.js'
import {
  clearWechat4StoreEmoticonCatalog,
  type Wechat4StoreEmoticon,
} from '../src/main/sources/wechat4/store-emoticon-catalog.js'
import {
  clearWechat4StoreKeyCandidate,
  encodeWechat4StoreTargetFrame,
  readWechat4StoreKeyCandidate,
  type Wechat4StoreKeyCandidate,
} from '../src/main/sources/wechat4/store-key-pipe.js'
import { TemporaryWechatAppCopy } from '../src/main/sources/wechat4/temporary-app-copy.js'
import { Wechat4KeyStore } from '../src/main/sources/wechat4/wechat4-key-store.js'
import {
  DEFAULT_WECHAT4_ROOT,
  discoverWechat4,
  removeWechat4Snapshot,
  snapshotWechat4Database,
  type Wechat4Snapshot,
} from '../src/main/sources/wechat4/wechat4-layout.js'

const execFileAsync = promisify(execFile)
const originalAppPath = '/Applications/WeChat.app'
const originalExecutable = join(originalAppPath, 'Contents', 'MacOS', 'WeChat')
const builtInterposer = resolve(
  'native/wechat4-store-instrumentation/build/universal/libwechat4-store-key-interposer.dylib',
)
const helper = resolve('native/wechat4-helper/build/universal/wechat4-helper')
const gate8SessionPrefix = 'cn-memes-wechat4-store-gate-8-'
const preflightOnly = process.argv.includes('--preflight')
const candidateTimeoutMs = 5 * 60_000

type Gate8ErrorCode =
  | 'NO_CACHED_CATALOG'
  | 'NO_STORE_CONTAINER'
  | 'SIGNING_FAILED'
  | 'CANDIDATE_TIMEOUT'
  | 'CANDIDATE_FRAME_INVALID'
  | 'STORE_KEY_VALIDATION_FAILED'
  | 'PROCESS_CLEANUP_FAILED'
  | 'SESSION_CLEANUP_FAILED'
  | 'ORIGINAL_RESTART_FAILED'
  | 'INTERNAL'

interface Gate8Report {
  mode: 'preflight' | 'real'
  discoveredAccounts: number
  accountsWithCachedCatalog: number
  selectedPackageCount: number
  selectedMemberCount: number
  targetBlockCount: number
  temporarySignatureVerified: boolean
  candidateFrameValid: boolean
  candidateKeyBytes?: number
  candidateSourceMode?: Wechat4StoreKeyCandidate['sourceMode']
  decryptedContainers: number
  imageHeaderContainers: number
  memberMd5Matches: number
  memberMd5Mismatches: number
  verified: boolean
  markerSequence: string[]
  markerInvalidObserved: boolean
  markerLimitReached: boolean
  cleanupComplete: boolean
  originalAppUnchanged: boolean
  originalAppRestarted: boolean
  errorCode?: Gate8ErrorCode
}

interface PackageTarget {
  path: string
  firstBlock: Buffer
  records: Wechat4StoreEmoticon[]
}

interface PreparedAccount {
  packageCount: number
  memberCount: number
  targets: PackageTarget[]
  records: Wechat4StoreEmoticon[]
}

function accountId(directoryName: string): string {
  return `wechat4-${createHash('sha256').update(directoryName).digest('hex').slice(0, 16)}`
}

function md5(value: string | Buffer): string {
  return createHash('md5').update(value).digest('hex')
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child)
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation)
}

function imageHeader(bytes: Buffer): boolean {
  return (
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    bytes.subarray(0, 6).toString('ascii') === 'GIF89a' ||
    bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ||
    (bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP') ||
    bytes.subarray(0, 4).toString('ascii') === 'wxgf'
  )
}

async function accountRoots(): Promise<Map<string, string>> {
  const roots = new Map<string, string>()
  const entries = await readdir(DEFAULT_WECHAT4_ROOT, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      roots.set(accountId(entry.name), join(DEFAULT_WECHAT4_ROOT, entry.name))
    }
  }
  return roots
}

async function regularContainerFiles(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const shards = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const shard of shards) {
    if (!shard.isDirectory() || shard.isSymbolicLink()) continue
    const shardPath = join(directory, shard.name)
    const entries = await readdir(shardPath, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{32}$/i.test(entry.name)) {
        continue
      }
      const path = join(shardPath, entry.name)
      const details = await lstat(path)
      if (details.isFile() && !details.isSymbolicLink() && details.size >= 16) {
        files.set(entry.name.toLowerCase(), path)
      }
    }
  }
  return files
}

async function firstBlock(path: string): Promise<Buffer> {
  const block = Buffer.alloc(16)
  const handle = await open(path, 'r')
  try {
    const { bytesRead } = await handle.read(block, 0, block.length, 0)
    if (bytesRead !== block.length) throw new Error('store-container-header-short')
    return block
  } catch (error) {
    block.fill(0)
    throw error
  } finally {
    await handle.close()
  }
}

async function prepareAccountTargets(report: Gate8Report): Promise<PreparedAccount> {
  const keyStore = new Wechat4KeyStore(
    join(homedir(), 'Library', 'Application Support', 'cn-memes-abroad', 'wechat4', 'keys'),
  )
  const [discovery, roots] = await Promise.all([discoverWechat4(), accountRoots()])
  report.discoveredAccounts = discovery.accounts.length
  const prepared: PreparedAccount[] = []

  for (const account of discovery.accounts) {
    const candidate = await keyStore.load(account.id)
    if (!candidate) continue
    let snapshot: Wechat4Snapshot | undefined
    let records: Wechat4StoreEmoticon[] | undefined
    try {
      snapshot = await snapshotWechat4Database(account.id)
      const result = await runWechat4HelperForStoreEmoticons(
        {
          v: 1,
          id: `gate-8-preflight-${Date.now()}`,
          method: 'storeEmoticonsFd',
          params: { databasePath: snapshot.databasePath },
        },
        encodeSyntheticCandidateFrame(candidate),
        { executable: helper },
      )
      if (!result.response.ok || result.records.length === 0) continue
      records = result.records
      report.accountsWithCachedCatalog += 1
      const root = roots.get(account.id)
      if (!root) continue
      const files = await regularContainerFiles(
        join(root, 'business', 'emoticon', 'PersistStore'),
      )
      const packages = new Map<string, Wechat4StoreEmoticon[]>()
      for (const record of records) {
        const members = packages.get(record.packageId) ?? []
        members.push(record)
        packages.set(record.packageId, members)
      }
      const targets: PackageTarget[] = []
      for (const [packageId, members] of packages) {
        const path = files.get(md5(packageId)) ?? files.get(packageId.toLowerCase())
        if (!path) continue
        targets.push({ path, firstBlock: await firstBlock(path), records: members })
      }
      targets.sort((left, right) => right.records.length - left.records.length)
      prepared.push({
        packageCount: packages.size,
        memberCount: records.length,
        targets: targets.slice(0, 16),
        records,
      })
      records = undefined
    } finally {
      if (records) clearWechat4StoreEmoticonCatalog(records)
      clearCandidateDatabaseKey(candidate)
      if (snapshot) await removeWechat4Snapshot(snapshot)
    }
  }

  prepared.sort(
    (left, right) =>
      right.targets.length - left.targets.length || right.memberCount - left.memberCount,
  )
  const selected = prepared.shift()
  for (const unused of prepared) clearPreparedAccount(unused)
  if (!selected) throw new Error('no-cached-catalog')
  if (selected.targets.length === 0) {
    clearPreparedAccount(selected)
    throw new Error('no-store-container')
  }
  report.selectedPackageCount = selected.packageCount
  report.selectedMemberCount = selected.memberCount
  report.targetBlockCount = selected.targets.length
  return selected
}

function clearPreparedAccount(prepared: PreparedAccount): void {
  for (const target of prepared.targets) target.firstBlock.fill(0)
  clearWechat4StoreEmoticonCatalog(prepared.records)
  prepared.targets.length = 0
}

async function validateStoreKey(
  prepared: PreparedAccount,
  candidate: Wechat4StoreKeyCandidate,
  report: Gate8Report,
): Promise<void> {
  for (const target of prepared.targets) {
    const ciphertext = await readFile(target.path)
    let plaintext: Buffer | undefined
    try {
      const decipher = createDecipheriv(
        `aes-${candidate.key.length * 8}-cbc`,
        candidate.key,
        candidate.key.subarray(0, 16),
      )
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      report.decryptedContainers += 1
      if (imageHeader(plaintext)) report.imageHeaderContainers += 1
      for (const record of target.records) {
        const end = record.emoticonOffset + record.emoticonSize
        if (
          record.emoticonSize <= 0 ||
          !Number.isSafeInteger(end) ||
          end > plaintext.length
        ) {
          report.memberMd5Mismatches += 1
          continue
        }
        if (md5(plaintext.subarray(record.emoticonOffset, end)) === record.md5) {
          report.memberMd5Matches += 1
        } else {
          report.memberMd5Mismatches += 1
        }
      }
    } catch {
      report.memberMd5Mismatches += target.records.length
    } finally {
      ciphertext.fill(0)
      plaintext?.fill(0)
    }
  }
  report.verified =
    report.decryptedContainers > 0 &&
    report.imageHeaderContainers > 0 &&
    report.memberMd5Matches > 0 &&
    report.memberMd5Mismatches === 0
  if (!report.verified) throw new Error('store-key-validation-failed')
}

async function runSilent(
  executable: string,
  arguments_: string[],
  label: string,
  timeout = 30_000,
): Promise<void> {
  try {
    await execFileAsync(executable, arguments_, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout,
    })
  } catch (error) {
    throw new Error(label, { cause: error })
  }
}

async function codeDirectoryHash(appPath: string): Promise<string> {
  const { stderr } = await execFileAsync('/usr/bin/codesign', ['-dvvv', appPath], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
  })
  const hash = stderr.match(/^CDHash=([a-f0-9]+)$/m)?.[1]
  if (!hash) throw new Error('signature-check')
  return hash
}

async function processTable(): Promise<NativeProcessEntry[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid=,comm='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  return parseNativeProcessTable(stdout)
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  return await predicate()
}

async function quitOriginalWechat(): Promise<void> {
  const verifiedMainExecutable = await realpath(originalExecutable)
  const mainProcesses = processesInsideApp(await processTable(), originalAppPath).filter(
    (entry) => resolve(entry.executablePath) === verifiedMainExecutable,
  )
  for (const entry of mainProcesses) {
    try {
      process.kill(entry.pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  if (
    !(await waitUntil(async () => commonWechatProcesses(await processTable()).length === 0, 20_000))
  ) {
    throw new Error('original-processes-still-running')
  }
}

async function restartOriginalWechat(): Promise<boolean> {
  try {
    await runSilent('/usr/bin/open', [originalAppPath], 'original-restart-request', 15_000)
    return await waitUntil(
      async () => processesInsideApp(await processTable(), originalAppPath).length > 0,
      20_000,
    )
  } catch {
    return false
  }
}

async function signTemporaryArtifacts(copiedAppPath: string, dylibPath: string): Promise<void> {
  await runSilent(
    '/usr/bin/codesign',
    ['--force', '--sign', '-', '--timestamp=none', dylibPath],
    'interposer-signing',
  )
  await runSilent(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', copiedAppPath],
    'temporary-app-signing',
    120_000,
  )
  await runSilent(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', copiedAppPath],
    'temporary-signature-verification',
    60_000,
  )
}

async function verifiedTemporaryProcesses(appPath: string): Promise<NativeProcessEntry[]> {
  const appRoot = await realpath(appPath)
  const candidates = processesInsideApp(await processTable(), appRoot)
  const verified: NativeProcessEntry[] = []
  for (const candidate of candidates) {
    try {
      const executable = await realpath(candidate.executablePath)
      const details = await lstat(executable)
      if (details.isFile() && !details.isSymbolicLink() && isWithin(appRoot, executable)) {
        verified.push(candidate)
      }
    } catch {
      // Process may exit between the read-only process snapshot and path verification.
    }
  }
  return verified
}

async function terminateVerifiedTemporaryProcesses(appPath: string): Promise<void> {
  const signal = async (name: NodeJS.Signals) => {
    for (const entry of await verifiedTemporaryProcesses(appPath)) {
      try {
        process.kill(entry.pid, name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }
  await signal('SIGTERM')
  if (!(await waitUntil(async () => (await verifiedTemporaryProcesses(appPath)).length === 0, 1_000))) {
    await signal('SIGKILL')
  }
  if (!(await waitUntil(async () => (await verifiedTemporaryProcesses(appPath)).length === 0, 3_000))) {
    throw new Error('temporary-process-cleanup')
  }
}

async function writeAndClear(input: Writable, bytes: Buffer): Promise<void> {
  try {
    await new Promise<void>((resolveWrite, reject) => {
      const onError = () => reject(new Error('target-block-pipe-failed'))
      input.once('error', onError)
      input.end(bytes, () => {
        input.removeListener('error', onError)
        resolveWrite()
      })
    })
  } finally {
    bytes.fill(0)
  }
}

async function cleanupGate8Session(sessionRoot: string): Promise<void> {
  const resolvedRoot = resolve(sessionRoot)
  if (
    dirname(resolvedRoot) !== resolve(tmpdir()) ||
    !basename(resolvedRoot).startsWith(gate8SessionPrefix)
  ) {
    throw new Error('unexpected-gate-8-session')
  }
  await rm(resolvedRoot, { recursive: true, force: true })
}

function safeErrorCode(stage: string, error: unknown): Gate8ErrorCode {
  const message = error instanceof Error ? error.message : ''
  if (message === 'no-cached-catalog') return 'NO_CACHED_CATALOG'
  if (message === 'no-store-container') return 'NO_STORE_CONTAINER'
  if (stage === 'temporary-signing') return 'SIGNING_FAILED'
  if (stage === 'candidate-acquisition') {
    return /timed out/i.test(message) ? 'CANDIDATE_TIMEOUT' : 'CANDIDATE_FRAME_INVALID'
  }
  if (stage === 'candidate-validation') return 'STORE_KEY_VALIDATION_FAILED'
  return 'INTERNAL'
}

async function runGate8(): Promise<Gate8Report> {
  const report: Gate8Report = {
    mode: preflightOnly ? 'preflight' : 'real',
    discoveredAccounts: 0,
    accountsWithCachedCatalog: 0,
    selectedPackageCount: 0,
    selectedMemberCount: 0,
    targetBlockCount: 0,
    temporarySignatureVerified: false,
    candidateFrameValid: false,
    decryptedContainers: 0,
    imageHeaderContainers: 0,
    memberMd5Matches: 0,
    memberMd5Mismatches: 0,
    verified: false,
    markerSequence: [],
    markerInvalidObserved: false,
    markerLimitReached: false,
    cleanupComplete: preflightOnly,
    originalAppUnchanged: preflightOnly,
    originalAppRestarted: preflightOnly,
  }

  let prepared: PreparedAccount | undefined
  let stage = 'preflight'
  let failure: unknown
  let originalHash = ''
  let sessionRoot: string | undefined
  let appCopy: TemporaryWechatAppCopy | undefined
  let copiedAppPath: string | undefined
  let group: ManagedProcessGroup | undefined
  let candidate: Wechat4StoreKeyCandidate | undefined
  let markers: Promise<Wechat4MarkerCollection> | undefined
  try {
    process.stderr.write('GATE8_STAGE=CATALOG_PREFLIGHT\n')
    prepared = await prepareAccountTargets(report)
    if (preflightOnly) return report

    originalHash = await codeDirectoryHash(originalAppPath)
    stage = 'original-quit'
    process.stderr.write('GATE8_STAGE=STOPPING_ORIGINAL\n')
    await quitOriginalWechat()

    stage = 'session-create'
    sessionRoot = await mkdtemp(join(tmpdir(), gate8SessionPrefix))
    await chmod(sessionRoot, 0o700)

    stage = 'temporary-copy'
    process.stderr.write('GATE8_STAGE=PREPARING_TEMPORARY_COPY\n')
    appCopy = await TemporaryWechatAppCopy.create({
      sourceAppPath: originalAppPath,
      temporaryParent: sessionRoot,
    })
    copiedAppPath = appCopy.appPath
    const dylibPath = join(sessionRoot, 'libwechat4-store-key-interposer.dylib')
    await copyFile(builtInterposer, dylibPath)
    await chmod(dylibPath, 0o700)
    await assertTemporaryAppOperationPaths({
      originalAppPath,
      sessionRoot,
      copiedAppPath,
      probePath: dylibPath,
    })
    const executablePath = await realpath(join(copiedAppPath, 'Contents', 'MacOS', 'WeChat'))
    const copiedRoot = await realpath(copiedAppPath)
    if (!isWithin(copiedRoot, executablePath) || executablePath === (await realpath(originalExecutable))) {
      throw new Error('temporary-executable-boundary')
    }

    stage = 'temporary-signing'
    await signTemporaryArtifacts(copiedAppPath, dylibPath)
    report.temporarySignatureVerified = true

    stage = 'candidate-acquisition'
    process.stderr.write('GATE8_STAGE=LAUNCHING_TEMPORARY_WECHAT\n')
    group = await ManagedProcessGroup.launch({
      executable: executablePath,
      environment: { DYLD_INSERT_LIBRARIES: dylibPath },
      anonymousInputDescriptors: [4],
      anonymousOutputDescriptors: [7],
      terminationGraceMs: 1_000,
    })
    group.input.end()
    group.controlOutput.resume()
    const markerOutput = group.anonymousOutputs.get(7)
    const targetInput = group.anonymousInputs.get(4)
    if (!markerOutput || !targetInput) throw new Error('gate-8-pipe-missing')
    markers = collectWechat4Markers(markerOutput, { timeoutMs: candidateTimeoutMs + 15_000 })
    const targetFrame = encodeWechat4StoreTargetFrame(
      prepared.targets.map((target) => target.firstBlock),
    )
    await writeAndClear(targetInput, targetFrame)
    process.stderr.write('GATE8_STAGE=WAITING_FOR_OFFICIAL_STICKER_KEY\n')
    candidate = await readWechat4StoreKeyCandidate(group.candidateKeyPipe, {
      timeoutMs: candidateTimeoutMs,
    })
    report.candidateFrameValid = true
    report.candidateKeyBytes = candidate.key.length
    report.candidateSourceMode = candidate.sourceMode

    stage = 'candidate-validation'
    process.stderr.write('GATE8_STAGE=VALIDATING_OFFLINE\n')
    await validateStoreKey(prepared, candidate, report)
  } catch (error) {
    failure = error
    report.errorCode = safeErrorCode(stage, error)
  } finally {
    if (candidate) clearWechat4StoreKeyCandidate(candidate)
    if (prepared) clearPreparedAccount(prepared)
    if (!preflightOnly) {
      let cleanupFailed = false
      if (group) {
        try {
          await group.terminate()
        } catch {
          // Exact-path cleanup below remains mandatory.
        }
      }
      if (copiedAppPath) {
        try {
          await terminateVerifiedTemporaryProcesses(copiedAppPath)
        } catch (error) {
          cleanupFailed = true
          failure ??= error
          report.errorCode = 'PROCESS_CLEANUP_FAILED'
        }
      }
      if (markers) {
        const collected = await markers.catch(() => undefined)
        if (collected) {
          report.markerSequence = collected.markers
          report.markerInvalidObserved = collected.invalidMarkerObserved
          report.markerLimitReached = collected.limitReached
        }
      }
      if (appCopy) {
        try {
          await appCopy.cleanup()
        } catch (error) {
          cleanupFailed = true
          failure ??= error
          report.errorCode = 'SESSION_CLEANUP_FAILED'
        }
      }
      if (sessionRoot) {
        try {
          await cleanupGate8Session(sessionRoot)
          await stat(sessionRoot)
          cleanupFailed = true
          report.errorCode = 'SESSION_CLEANUP_FAILED'
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            cleanupFailed = true
            failure ??= error
            report.errorCode = 'SESSION_CLEANUP_FAILED'
          }
        }
      }
      report.cleanupComplete = !cleanupFailed
      try {
        if (originalHash) {
          report.originalAppUnchanged = (await codeDirectoryHash(originalAppPath)) === originalHash
        }
      } catch (error) {
        failure ??= error
        report.errorCode ??= 'INTERNAL'
      }
      report.originalAppRestarted = await restartOriginalWechat()
      if (!report.originalAppRestarted) {
        failure ??= new Error('original-restart')
        report.errorCode = 'ORIGINAL_RESTART_FAILED'
      }
    }
  }

  if (failure || (!preflightOnly && !report.verified)) process.exitCode = 1
  return report
}

app.setName('cn-memes-abroad')
app.whenReady().then(
  async () => {
    const report = await runGate8()
    const exitCode = Number(process.exitCode ?? 0)
    process.stdout.write(`${JSON.stringify(report)}\n`, () => app.exit(exitCode))
  },
  () => app.exit(1),
)
