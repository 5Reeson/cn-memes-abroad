import { execFile } from 'node:child_process'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'

import {
  clearCandidateDatabaseKey,
  encodeSyntheticCandidateFrame,
  readCandidateDatabaseKey,
  type CandidateDatabaseKey,
} from '../src/main/sources/wechat4/candidate-key-pipe.js'
import { runWechat4HelperWithCandidateFrame } from '../src/main/sources/wechat4/helper-runner.js'
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
import { TemporaryWechatAppCopy } from '../src/main/sources/wechat4/temporary-app-copy.js'
import {
  discoverWechat4EmoticonTargets,
  removeWechat4Snapshot,
  snapshotWechat4Database,
  type Wechat4Snapshot,
} from '../src/main/sources/wechat4/wechat4-layout.js'

const execFileAsync = promisify(execFile)
const originalAppPath = '/Applications/WeChat.app'
const originalExecutable = join(originalAppPath, 'Contents', 'MacOS', 'WeChat')
const builtInterposer = resolve(
  'native/wechat4-instrumentation/build/universal/libwechat4-synthetic-interposer.dylib',
)
const helper = resolve('native/wechat4-helper/build/universal/wechat4-helper')
const gateGSessionPrefix = 'cn-memes-wechat4-gate-g-'
// Gitignored project-local directory for sanitized post-validation artifacts.
const phase7Directory = resolve('.phase7')

type GateGErrorCode =
  | 'TARGET_NOT_UNIQUE'
  | 'SNAPSHOT_FAILED'
  | 'SIGNING_FAILED'
  | 'CANDIDATE_TIMEOUT'
  | 'CANDIDATE_FRAME_INVALID'
  | 'KEY_VALIDATION_FAILED'
  | 'PROCESS_CLEANUP_FAILED'
  | 'SESSION_CLEANUP_FAILED'
  | 'ORIGINAL_RESTART_FAILED'
  | 'UNEXPECTED_PERMISSION_PROMPT'
  | 'INTERNAL'

interface GateGReport {
  uniqueEmoticonDatabase: boolean
  walSnapshotted: boolean
  shmSnapshotted: boolean
  candidateFrameValid: boolean
  cipherIntegrityValidated: boolean
  schemaQueryValidated: boolean
  quickCheckValidated: boolean
  verified: boolean
  temporarySignatureVerified: boolean
  escapedTemporaryProcessObserved: boolean
  cleanupComplete: boolean
  originalAppUnchanged: boolean
  originalAppRestarted: boolean
  arm64Executed: boolean
  x64Executed: boolean
  markerSequence: string[]
  markerInvalidObserved: boolean
  markerLimitReached: boolean
  schemaOverview: unknown
  schemaOverviewPersisted: boolean
  schemaOverviewErrorCode?: string
  errorCode?: GateGErrorCode | string
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child)
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation)
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
  try {
    const { stderr } = await execFileAsync('/usr/bin/codesign', ['-dvvv', appPath], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
    })
    const hash = stderr.match(/^CDHash=([a-f0-9]+)$/m)?.[1]
    if (!hash) throw new Error()
    return hash
  } catch (error) {
    throw new Error('signature-check', { cause: error })
  }
}

async function processTable(): Promise<NativeProcessEntry[]> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid=,comm='], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    return parseNativeProcessTable(stdout)
  } catch (error) {
    throw new Error('process-list-check', { cause: error })
  }
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
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw new Error('original-quit-request', { cause: error })
      }
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
    30_000,
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
      // The candidate may exit between the read-only process snapshot and path verification.
    }
  }
  return verified
}

async function signalVerifiedTemporaryProcesses(
  appPath: string,
  signal: NodeJS.Signals,
): Promise<void> {
  for (const processEntry of await verifiedTemporaryProcesses(appPath)) {
    try {
      process.kill(processEntry.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

async function terminateVerifiedTemporaryProcesses(appPath: string): Promise<void> {
  await signalVerifiedTemporaryProcesses(appPath, 'SIGTERM')
  if (
    !(await waitUntil(async () => (await verifiedTemporaryProcesses(appPath)).length === 0, 1_000))
  ) {
    await signalVerifiedTemporaryProcesses(appPath, 'SIGKILL')
  }
  if (
    !(await waitUntil(async () => (await verifiedTemporaryProcesses(appPath)).length === 0, 3_000))
  ) {
    throw new Error('temporary-process-cleanup')
  }
}

async function readDatabaseSalt(databasePath: string): Promise<Buffer> {
  const salt = Buffer.alloc(16)
  const handle = await open(databasePath, 'r')
  try {
    const { bytesRead } = await handle.read(salt, 0, salt.length, 0)
    if (bytesRead !== salt.length) throw new Error('snapshot-header-short')
    return salt
  } catch (error) {
    salt.fill(0)
    throw error
  } finally {
    await handle.close()
  }
}

async function writeAndClear(input: Writable, buffer: Buffer): Promise<void> {
  try {
    await new Promise<void>((resolveWrite, reject) => {
      const onError = () => reject(new Error('target-salt-pipe-failed'))
      input.once('error', onError)
      input.end(buffer, () => {
        input.removeListener('error', onError)
        resolveWrite()
      })
    })
  } finally {
    buffer.fill(0)
  }
}

async function cleanupGateGSession(sessionRoot: string): Promise<void> {
  const resolvedRoot = resolve(sessionRoot)
  if (
    dirname(resolvedRoot) !== resolve(tmpdir()) ||
    !basename(resolvedRoot).startsWith(gateGSessionPrefix)
  ) {
    throw new Error('unexpected-gate-g-session')
  }
  await rm(resolvedRoot, { recursive: true, force: true })
}

const DEFAULT_CANDIDATE_TIMEOUT_MS = 45_000
const MARKER_COLLECTION_TAIL_MS = 15_000

/**
 * Operational window only. Extending it (via WECHAT4_GATE_G_CANDIDATE_TIMEOUT_MS)
 * never relaxes the cryptographic filters: salt equality, KDF success, 32-byte
 * derived length, and emit-once stay intact.
 */
function resolveCandidateTimeoutMs(): number {
  const raw = process.env.WECHAT4_GATE_G_CANDIDATE_TIMEOUT_MS
  if (!raw) return DEFAULT_CANDIDATE_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1_000 || parsed > 30 * 60_000) {
    return DEFAULT_CANDIDATE_TIMEOUT_MS
  }
  return Math.floor(parsed)
}

function safeErrorCode(stage: string, error: unknown): GateGErrorCode | string {
  if (stage === 'target-discovery') return 'TARGET_NOT_UNIQUE'
  if (stage === 'snapshot' || stage === 'snapshot-salt') return 'SNAPSHOT_FAILED'
  if (stage === 'temporary-signing') return 'SIGNING_FAILED'
  if (stage === 'candidate-acquisition') {
    const message = error instanceof Error ? error.message : ''
    if (/timed out/i.test(message)) return 'CANDIDATE_TIMEOUT'
    return 'CANDIDATE_FRAME_INVALID'
  }
  if (stage === 'candidate-validation') return 'KEY_VALIDATION_FAILED'
  return 'INTERNAL'
}

const report: GateGReport = {
  uniqueEmoticonDatabase: false,
  walSnapshotted: false,
  shmSnapshotted: false,
  candidateFrameValid: false,
  cipherIntegrityValidated: false,
  schemaQueryValidated: false,
  quickCheckValidated: false,
  verified: false,
  temporarySignatureVerified: false,
  escapedTemporaryProcessObserved: false,
  cleanupComplete: false,
  originalAppUnchanged: false,
  originalAppRestarted: false,
  arm64Executed: process.arch === 'arm64',
  x64Executed: process.arch === 'x64',
  markerSequence: [],
  markerInvalidObserved: false,
  markerLimitReached: false,
  schemaOverview: null,
  schemaOverviewPersisted: false,
}

let stage = 'preflight'
let runFailure: unknown
let originalHash = ''
let gateSession: string | undefined
let snapshot: Wechat4Snapshot | undefined
let appCopy: TemporaryWechatAppCopy | undefined
let copiedAppPath: string | undefined
let group: ManagedProcessGroup | undefined
let targetSalt: Buffer = Buffer.alloc(0)
let candidate: CandidateDatabaseKey | undefined
let markerCollection: Promise<Wechat4MarkerCollection> | undefined
const candidateTimeoutMs = resolveCandidateTimeoutMs()
const operationController = new AbortController()
const cancelOperation = () => {
  operationController.abort(new DOMException('Gate G canceled', 'AbortError'))
}
process.once('SIGINT', cancelOperation)
process.once('SIGTERM', cancelOperation)

try {
  originalHash = await codeDirectoryHash(originalAppPath)

  stage = 'original-quit'
  await quitOriginalWechat()

  stage = 'session-create'
  gateSession = await mkdtemp(join(tmpdir(), gateGSessionPrefix))
  await chmod(gateSession, 0o700)

  stage = 'target-discovery'
  const targets = await discoverWechat4EmoticonTargets()
  if (targets.length !== 1) throw new Error('target-not-unique')
  report.uniqueEmoticonDatabase = true

  stage = 'snapshot'
  snapshot = await snapshotWechat4Database(targets[0]!.id, {
    signal: operationController.signal,
    temporaryParent: gateSession,
  })
  report.walSnapshotted = snapshot.sidecars.includes('emoticon.db-wal')
  report.shmSnapshotted = snapshot.sidecars.includes('emoticon.db-shm')

  stage = 'snapshot-salt'
  targetSalt = await readDatabaseSalt(snapshot.databasePath)

  stage = 'temporary-copy'
  appCopy = await TemporaryWechatAppCopy.create({
    sourceAppPath: originalAppPath,
    temporaryParent: gateSession,
  })
  copiedAppPath = appCopy.appPath
  const dylibPath = join(gateSession, 'libwechat4-emoticon-pbkdf-interposer.dylib')
  await copyFile(builtInterposer, dylibPath)
  await chmod(dylibPath, 0o700)
  await assertTemporaryAppOperationPaths({
    originalAppPath,
    sessionRoot: gateSession,
    copiedAppPath,
    probePath: dylibPath,
  })
  const executablePath = await realpath(join(copiedAppPath, 'Contents', 'MacOS', 'WeChat'))
  const copiedRoot = await realpath(copiedAppPath)
  if (
    !isWithin(copiedRoot, executablePath) ||
    executablePath === (await realpath(originalExecutable))
  ) {
    throw new Error('temporary-executable-boundary')
  }

  stage = 'temporary-signing'
  await signTemporaryArtifacts(copiedAppPath, dylibPath)
  report.temporarySignatureVerified = true

  stage = 'candidate-acquisition'
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
  if (!markerOutput) throw new Error('marker-pipe-missing')
  markerCollection = collectWechat4Markers(markerOutput, {
    signal: operationController.signal,
    timeoutMs: candidateTimeoutMs + MARKER_COLLECTION_TAIL_MS,
  })
  const targetSaltInput = group.anonymousInputs.get(4)
  if (!targetSaltInput) throw new Error('target-salt-pipe-missing')
  const saltForWrite = Buffer.from(targetSalt)
  targetSalt.fill(0)
  await writeAndClear(targetSaltInput, saltForWrite)
  candidate = await readCandidateDatabaseKey(group.candidateKeyPipe, {
    signal: operationController.signal,
    timeoutMs: candidateTimeoutMs,
  })
  group.candidateKeyPipe.destroy()
  report.candidateFrameValid = true

  stage = 'candidate-validation'
  const frame = encodeSyntheticCandidateFrame(candidate)
  const validation = await runWechat4HelperWithCandidateFrame(
    {
      v: 1,
      id: 'gate-g-emoticon-validation',
      method: 'validateCandidateFd',
      params: { databasePath: snapshot.databasePath },
    },
    frame,
    { executable: helper, timeoutMs: 60_000 },
  )
  if (!validation.ok) {
    report.errorCode = validation.error.code
    throw new Error('candidate-validation-rejected')
  }
  report.cipherIntegrityValidated = validation.result.cipherIntegrityValidated === true
  report.schemaQueryValidated = validation.result.schemaQueryValidated === true
  report.quickCheckValidated = validation.result.quickCheckValidated === true
  report.verified =
    validation.result.verified === true &&
    validation.result.formatValidated === true &&
    report.cipherIntegrityValidated &&
    report.schemaQueryValidated &&
    report.quickCheckValidated
  if (!report.verified) throw new Error('candidate-validation-incomplete')

  stage = 'schema-overview'
  try {
    // Same-run sanitized schema export: the candidate still lives only in this
    // process and is zeroed in the final cleanup; nothing is persisted here.
    const overviewFrame = encodeSyntheticCandidateFrame(candidate)
    const overview = await runWechat4HelperWithCandidateFrame(
      {
        v: 1,
        id: 'gate-g-schema-overview',
        method: 'schemaOverviewFd',
        params: { databasePath: snapshot.databasePath },
      },
      overviewFrame,
      { executable: helper, timeoutMs: 60_000 },
    )
    if (overview.ok) {
      report.schemaOverview = overview.result.overview ?? null
    } else {
      report.schemaOverviewErrorCode = overview.error.code
    }
    if (report.schemaOverview) {
      await mkdir(phase7Directory, { recursive: true, mode: 0o700 })
      await writeFile(
        join(phase7Directory, 'schema-overview.json'),
        `${JSON.stringify(report.schemaOverview, null, 2)}\n`,
        { mode: 0o600 },
      )
      report.schemaOverviewPersisted = true
    }
  } catch {
    // Sanitized schema export is best-effort and must not mask a verified result.
  }
} catch (error) {
  runFailure = error
  report.errorCode ??= safeErrorCode(stage, error)
} finally {
  targetSalt.fill(0)
  if (candidate) {
    clearCandidateDatabaseKey(candidate)
  }
  let cleanupFailed = false
  if (group) {
    try {
      await group.terminate()
    } catch {
      // Exact-path cleanup below is still mandatory if group signaling is unavailable.
    }
  }
  if (copiedAppPath) {
    try {
      report.escapedTemporaryProcessObserved = (
        await verifiedTemporaryProcesses(copiedAppPath)
      ).some((entry) => group !== undefined && entry.processGroupId !== group.pid)
      await terminateVerifiedTemporaryProcesses(copiedAppPath)
    } catch (error) {
      cleanupFailed = true
      runFailure ??= error
      report.errorCode = 'PROCESS_CLEANUP_FAILED'
    }
  }
  if (markerCollection) {
    try {
      // Markers carry no secret material; collect whatever state the
      // instrumentation reached before the process group was torn down.
      const collected = await markerCollection
      report.markerSequence = collected.markers
      report.markerInvalidObserved = collected.invalidMarkerObserved
      report.markerLimitReached = collected.limitReached
    } catch {
      // Marker collection is diagnostic-only and must not mask the run result.
    }
  }
  if (appCopy) {
    try {
      await appCopy.cleanup()
    } catch (error) {
      cleanupFailed = true
      runFailure ??= error
      report.errorCode = 'SESSION_CLEANUP_FAILED'
    }
  }
  if (snapshot) {
    try {
      await removeWechat4Snapshot(snapshot)
    } catch (error) {
      cleanupFailed = true
      runFailure ??= error
      report.errorCode = 'SESSION_CLEANUP_FAILED'
    }
  }
  if (gateSession) {
    try {
      await cleanupGateGSession(gateSession)
    } catch (error) {
      cleanupFailed = true
      runFailure ??= error
      report.errorCode = 'SESSION_CLEANUP_FAILED'
    }
    try {
      await stat(gateSession)
      cleanupFailed = true
      report.errorCode = 'SESSION_CLEANUP_FAILED'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        cleanupFailed = true
        runFailure ??= error
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
    runFailure ??= error
    report.errorCode ??= 'INTERNAL'
  }
  report.originalAppRestarted = await restartOriginalWechat()
  if (!report.originalAppRestarted) {
    runFailure ??= new Error('original-restart')
    report.errorCode = 'ORIGINAL_RESTART_FAILED'
  }
}

process.removeListener('SIGINT', cancelOperation)
process.removeListener('SIGTERM', cancelOperation)
console.log(JSON.stringify(report))
if (runFailure || !report.verified) process.exitCode = 1
