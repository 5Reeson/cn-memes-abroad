import { execFile } from 'node:child_process'
import { chmod, copyFile, lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  assertGateFOperationPaths,
  commonWechatProcesses,
  parseNativeProcessTable,
  processesInsideApp,
  readWechat4Readiness,
  type NativeProcessEntry,
} from '../src/main/sources/wechat4/load-gate.js'
import { ManagedProcessGroup } from '../src/main/sources/wechat4/process-group.js'
import { TemporaryWechatAppCopy } from '../src/main/sources/wechat4/temporary-app-copy.js'

const execFileAsync = promisify(execFile)
const originalAppPath = '/Applications/WeChat.app'
const originalExecutable = join(originalAppPath, 'Contents', 'MacOS', 'WeChat')
const builtProbe = resolve(
  'native/wechat4-instrumentation/build/universal/libwechat4-readiness-probe.dylib',
)

interface GateFResult {
  readiness: boolean
  temporarySignatureVerified: boolean
  escapedTemporaryProcessObserved: boolean
  processCleanupVerified: boolean
  sessionCleanupVerified: boolean
  originalAppUnchanged: boolean
  originalAppRestarted: boolean
  manualConfirmationRequired: boolean
  failedStage?: string
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
  } catch {
    throw new Error(label)
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
  } catch {
    throw new Error('original-signature-check')
  }
}

async function processTable(): Promise<NativeProcessEntry[]> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid=,comm='], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    return parseNativeProcessTable(stdout)
  } catch {
    throw new Error('process-list-check')
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
  const originalProcesses = processesInsideApp(await processTable(), originalAppPath)
  const mainProcesses = originalProcesses.filter(
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
  const ended = await waitUntil(
    async () => commonWechatProcesses(await processTable()).length === 0,
    20_000,
  )
  if (!ended) throw new Error('original-processes-still-running')
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

async function assertReadinessProbeIsNonInterposing(): Promise<void> {
  const { stdout } = await execFileAsync('/usr/bin/otool', ['-l', builtProbe], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
  })
  if (stdout.includes('__interpose')) throw new Error('readiness-probe-contained-interpose-section')
}

async function signTemporaryArtifacts(copiedAppPath: string, probePath: string): Promise<void> {
  await runSilent(
    '/usr/bin/codesign',
    ['--force', '--sign', '-', '--timestamp=none', probePath],
    'readiness-probe-signing',
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
      // A process may exit between the read-only process snapshot and path verification.
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
  const graceful = await waitUntil(
    async () => (await verifiedTemporaryProcesses(appPath)).length === 0,
    1_000,
  )
  if (!graceful) {
    await signalVerifiedTemporaryProcesses(appPath, 'SIGKILL')
  }
  const ended = await waitUntil(
    async () => (await verifiedTemporaryProcesses(appPath)).length === 0,
    3_000,
  )
  if (!ended) throw new Error('temporary-process-cleanup')
}

const result: GateFResult = {
  readiness: false,
  temporarySignatureVerified: false,
  escapedTemporaryProcessObserved: false,
  processCleanupVerified: false,
  sessionCleanupVerified: false,
  originalAppUnchanged: false,
  originalAppRestarted: false,
  manualConfirmationRequired: false,
}

let stage = 'preflight'
let originalHash = ''
let copy: TemporaryWechatAppCopy | undefined
let copiedAppPath: string | undefined
let sessionRoot: string | undefined
let group: ManagedProcessGroup | undefined
let runFailure: unknown
const operationController = new AbortController()
const cancelOperation = () => {
  operationController.abort(new DOMException('Gate F canceled', 'AbortError'))
}
process.once('SIGINT', cancelOperation)
process.once('SIGTERM', cancelOperation)

try {
  originalHash = await codeDirectoryHash(originalAppPath)
  await assertReadinessProbeIsNonInterposing()

  stage = 'original-quit'
  await quitOriginalWechat()

  stage = 'temporary-copy'
  copy = await TemporaryWechatAppCopy.create({ sourceAppPath: originalAppPath })
  copiedAppPath = copy.appPath
  sessionRoot = copy.sessionRoot
  const probePath = join(sessionRoot, 'libwechat4-readiness-probe.dylib')
  await copyFile(builtProbe, probePath)
  await chmod(probePath, 0o700)
  await assertGateFOperationPaths({
    originalAppPath,
    sessionRoot,
    copiedAppPath,
    probePath,
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
  await signTemporaryArtifacts(copiedAppPath, probePath)
  result.temporarySignatureVerified = true

  stage = 'readiness-load'
  group = await ManagedProcessGroup.launch({
    executable: executablePath,
    environment: { DYLD_INSERT_LIBRARIES: probePath },
    anonymousOutputDescriptors: [6],
    terminationGraceMs: 1_000,
  })
  const readiness = group.anonymousOutputs.get(6)
  if (!readiness) throw new Error('readiness-pipe-missing')
  await readWechat4Readiness(readiness, {
    signal: operationController.signal,
    timeoutMs: 15_000,
  })
  result.readiness = true
  result.escapedTemporaryProcessObserved = (await verifiedTemporaryProcesses(copiedAppPath)).some(
    (entry) => entry.processGroupId !== group!.pid,
  )
} catch (error) {
  runFailure = error
  result.failedStage = stage
  if (stage === 'original-quit') result.manualConfirmationRequired = true
} finally {
  if (group) {
    try {
      await group.terminate()
    } catch {
      // Exact-path cleanup below remains mandatory if group signaling is unavailable.
    }
  }
  if (copiedAppPath) {
    try {
      await terminateVerifiedTemporaryProcesses(copiedAppPath)
      result.processCleanupVerified = true
    } catch (error) {
      runFailure ??= error
      result.failedStage ??= 'temporary-process-cleanup'
    }
  }
  if (copy && sessionRoot) {
    try {
      await copy.cleanup()
      try {
        await stat(sessionRoot)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') result.sessionCleanupVerified = true
      }
    } catch (error) {
      runFailure ??= error
      result.failedStage ??= 'session-cleanup'
    }
  }
  try {
    if (originalHash) {
      result.originalAppUnchanged = (await codeDirectoryHash(originalAppPath)) === originalHash
    }
  } catch (error) {
    runFailure ??= error
    result.failedStage ??= 'original-signature-recheck'
  }
  result.originalAppRestarted = await restartOriginalWechat()
  if (!result.originalAppRestarted) {
    runFailure ??= new Error('original-restart')
    result.failedStage ??= 'original-restart'
  }
}

process.removeListener('SIGINT', cancelOperation)
process.removeListener('SIGTERM', cancelOperation)
console.log(JSON.stringify(result))
if (runFailure) process.exitCode = 1
