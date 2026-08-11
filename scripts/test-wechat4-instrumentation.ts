import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Writable } from 'node:stream'

import {
  clearCandidateDatabaseKey,
  encodeSyntheticCandidateFrame,
  readCandidateDatabaseKey,
  type CandidateDatabaseKey,
} from '../src/main/sources/wechat4/candidate-key-pipe.js'
import { runWechat4HelperWithCandidateFrame } from '../src/main/sources/wechat4/helper-runner.js'
import {
  collectWechat4Markers,
  type Wechat4MarkerCollection,
} from '../src/main/sources/wechat4/load-gate.js'
import {
  ProcessGroupTimeoutError,
  withManagedProcessGroup,
  type ManagedProcessGroup,
} from '../src/main/sources/wechat4/process-group.js'

type Architecture = 'arm64' | 'x86_64'
type HostMode =
  'correct' | 'wrong-salt' | 'wrong-length' | 'kdf-failure' | 'mixed' | 'hang' | 'silent-hang'

// Fixed non-secret state markers emitted by the interposer over fd 7.
const MARKER = {
  loaded: 'CMIPLOAD',
  saltReceived: 'CMSALTOK',
  saltMissing: 'CMSALTNO',
  callHit: 'CMIPHIT0',
  saltMatch: 'CMIPMTCH',
  saltMiss: 'CMIPMISS',
  lengthMatch: 'CMIPSZ32',
  lengthOther: 'CMIPSZOT',
  frameSent: 'CMIPSENT',
} as const

const EXPECTED_MARKERS: Record<
  'correct' | 'wrong-salt' | 'wrong-length' | 'kdf-failure' | 'mixed',
  string[]
> = {
  correct: [
    MARKER.loaded,
    MARKER.saltReceived,
    MARKER.callHit,
    MARKER.saltMatch,
    MARKER.lengthMatch,
    MARKER.frameSent,
  ],
  'wrong-salt': [
    MARKER.loaded,
    MARKER.saltReceived,
    MARKER.callHit,
    MARKER.saltMiss,
    MARKER.lengthMatch,
  ],
  'wrong-length': [
    MARKER.loaded,
    MARKER.saltReceived,
    MARKER.callHit,
    MARKER.saltMatch,
    MARKER.lengthOther,
  ],
  'kdf-failure': [MARKER.loaded, MARKER.saltReceived, MARKER.callHit],
  mixed: [
    MARKER.loaded,
    MARKER.saltReceived,
    // call 1: wrong salt, valid length
    MARKER.callHit,
    MARKER.saltMiss,
    MARKER.lengthMatch,
    // call 2: correct salt, oversized output
    MARKER.callHit,
    MARKER.saltMatch,
    MARKER.lengthOther,
    // call 3: eligible -> exactly one frame, then the target salt state is wiped
    MARKER.callHit,
    MARKER.saltMatch,
    MARKER.lengthMatch,
    MARKER.frameSent,
    // call 4: salt state already wiped and emit-once armed -> no match, no frame
    MARKER.callHit,
    MARKER.saltMiss,
    MARKER.lengthMatch,
  ],
}
const EXPECTED_MARKERS_SALT_NOT_DELIVERED = [
  MARKER.loaded,
  MARKER.saltMissing,
  MARKER.callHit,
  MARKER.saltMiss,
  MARKER.lengthMatch,
]

function startMarkerCollection(
  group: ManagedProcessGroup,
  signal: AbortSignal,
): Promise<Wechat4MarkerCollection> {
  const output = group.anonymousOutputs.get(7)
  if (!output) throw new Error('Synthetic marker pipe was not created')
  return collectWechat4Markers(output, { signal })
}

function assertMarkerCollection(collection: Wechat4MarkerCollection, expected: string[]): void {
  assert.equal(collection.invalidMarkerObserved, false)
  assert.equal(collection.limitReached, false)
  assert.equal(collection.trailingBytes, 0)
  assert.deepEqual(collection.markers, expected)
}

const builtDylibs: Record<Architecture, string> = {
  arm64: resolve(
    'native/wechat4-instrumentation/build/arm64/libwechat4-synthetic-interposer.dylib',
  ),
  x86_64: resolve(
    'native/wechat4-instrumentation/build/x86_64/libwechat4-synthetic-interposer.dylib',
  ),
}
const builtHosts: Record<Architecture, string> = {
  arm64: resolve('native/wechat4-instrumentation/build/arm64/wechat4-synthetic-host'),
  x86_64: resolve('native/wechat4-instrumentation/build/x86_64/wechat4-synthetic-host'),
}
const helper = resolve('native/wechat4-helper/build/universal/wechat4-helper')
const fixtureMaker = resolve('native/wechat4-helper/build/universal/wechat4-fixture-maker')

async function createInstrumentationFixture(databasePath: string): Promise<void> {
  await new Promise<void>((resolveFixture, reject) => {
    const child = spawn(fixtureMaker, [], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir() },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const output: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)))
    child.once('error', () => reject(new Error('Synthetic fixture maker could not start')))
    child.once('close', (code) => {
      const combined = Buffer.concat(output)
      const response = combined.toString('utf8').trim()
      combined.fill(0)
      for (const chunk of output) chunk.fill(0)
      if (code === 0 && response === '{"ok":true}') resolveFixture()
      else reject(new Error('Synthetic instrumentation fixture maker failed'))
    })
    child.stdin.end(`${JSON.stringify({ databasePath, mode: 'synthetic-instrumentation' })}\n`)
  })
}

async function validateCandidate(
  architecture: Architecture,
  databasePath: string,
  candidate: CandidateDatabaseKey,
): Promise<void> {
  const runner = { executable: '/usr/bin/arch', arguments: [`-${architecture}`, helper] }
  const request = {
    v: 1 as const,
    id: `${architecture}-synthetic-instrumentation`,
    method: 'validateCandidateFd' as const,
    params: { databasePath },
  }

  const frame = encodeSyntheticCandidateFrame(candidate)
  const verified = await runWechat4HelperWithCandidateFrame(request, frame, runner)
  assert.equal(frame.equals(Buffer.alloc(56)), true)
  assert.equal(verified.ok, true)
  if (verified.ok) {
    assert.equal(verified.result.verified, true)
    assert.equal(verified.result.formatValidated, true)
    assert.equal(verified.result.cipherIntegrityValidated, true)
    assert.equal(verified.result.schemaQueryValidated, true)
    assert.equal(verified.result.quickCheckValidated, true)
    assert.equal('schemaObjectCount' in verified.result, false)
  }

  const wrongSalt = Buffer.from(candidate.salt)
  wrongSalt[0] = wrongSalt[0]! ^ 0xff
  const wrongSaltFrame = encodeSyntheticCandidateFrame({ salt: wrongSalt, key: candidate.key })
  wrongSalt.fill(0)
  const saltRejected = await runWechat4HelperWithCandidateFrame(request, wrongSaltFrame, runner)
  assert.equal(wrongSaltFrame.equals(Buffer.alloc(56)), true)
  assert.equal(saltRejected.ok, false)
  if (!saltRejected.ok) assert.equal(saltRejected.error.code, 'KEY_VALIDATION_FAILED')

  const wrongKey = Buffer.from(candidate.key)
  wrongKey[0] = wrongKey[0]! ^ 0xff
  const wrongKeyFrame = encodeSyntheticCandidateFrame({ salt: candidate.salt, key: wrongKey })
  wrongKey.fill(0)
  const keyRejected = await runWechat4HelperWithCandidateFrame(request, wrongKeyFrame, runner)
  assert.equal(wrongKeyFrame.equals(Buffer.alloc(56)), true)
  assert.equal(keyRejected.ok, false)
  if (!keyRejected.ok) assert.equal(keyRejected.error.code, 'KEY_VALIDATION_FAILED')

  const invalidFrame = encodeSyntheticCandidateFrame(candidate)
  invalidFrame[0] = invalidFrame[0]! ^ 0xff
  const frameRejected = await runWechat4HelperWithCandidateFrame(request, invalidFrame, runner)
  assert.equal(invalidFrame.equals(Buffer.alloc(56)), true)
  assert.equal(frameRejected.ok, false)
  if (!frameRejected.ok) assert.equal(frameRejected.error.code, 'KEY_FORMAT_INVALID')
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function assertProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isAlive(pid)) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  assert.equal(isAlive(pid), false)
}

async function writeAndClear(input: Writable, buffer: Buffer): Promise<void> {
  try {
    await new Promise<void>((resolveWrite, reject) => {
      const onError = () => reject(new Error('Synthetic anonymous input pipe failed'))
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

async function runScenario<T>(input: {
  architecture: Architecture
  mode: HostMode
  dylibPath: string
  hostPath: string
  targetSalt: Buffer
  hostSalt?: Buffer
  deliverTargetSalt?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  operation: (group: ManagedProcessGroup, signal: AbortSignal) => Promise<T>
}): Promise<T> {
  let pid: number | undefined
  try {
    return await withManagedProcessGroup(
      {
        executable: input.hostPath,
        arguments: [input.mode],
        environment: { DYLD_INSERT_LIBRARIES: input.dylibPath },
        anonymousInputDescriptors: [4, 5],
        anonymousOutputDescriptors: [7],
        allowLeaderSignalFallback: true,
        signal: input.signal,
        operationTimeoutMs: input.timeoutMs ?? 10_000,
        terminationGraceMs: 100,
      },
      async (group, operationSignal) => {
        pid = group.pid
        const hostSaltWrite = Buffer.from(input.hostSalt ?? input.targetSalt)
        if (input.deliverTargetSalt === false) {
          group.anonymousInputs.get(4)!.end()
          await writeAndClear(group.anonymousInputs.get(5)!, hostSaltWrite)
        } else {
          const targetSaltWrite = Buffer.from(input.targetSalt)
          await Promise.all([
            writeAndClear(group.anonymousInputs.get(4)!, targetSaltWrite),
            writeAndClear(group.anonymousInputs.get(5)!, hostSaltWrite),
          ])
          assert.equal(targetSaltWrite.equals(Buffer.alloc(16)), true)
        }
        assert.equal(hostSaltWrite.equals(Buffer.alloc(16)), true)
        return await input.operation(group, operationSignal)
      },
    )
  } finally {
    if (pid !== undefined) await assertProcessGone(pid)
  }
}

async function waitForOperationAbort(signal: AbortSignal): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    const rejectWithReason = () =>
      reject(signal.reason ?? new DOMException('Canceled', 'AbortError'))
    if (signal.aborted) rejectWithReason()
    else signal.addEventListener('abort', rejectWithReason, { once: true })
  })
}

const sessionRoot = await mkdtemp(join(tmpdir(), 'wechat4-instrumentation-test-'))
await chmod(sessionRoot, 0o700)
const dylibPaths: Record<Architecture, string> = {
  arm64: join(sessionRoot, 'synthetic-interposer-arm64.dylib'),
  x86_64: join(sessionRoot, 'synthetic-interposer-x86_64.dylib'),
}
const hostPaths: Record<Architecture, string> = {
  arm64: join(sessionRoot, 'synthetic-host-arm64'),
  x86_64: join(sessionRoot, 'synthetic-host-x86_64'),
}
const fixturePath = join(sessionRoot, 'synthetic-instrumentation.db')
let targetSalt = Buffer.alloc(0)

try {
  await Promise.all(
    (['arm64', 'x86_64'] as const).flatMap((architecture) => [
      copyFile(builtDylibs[architecture], dylibPaths[architecture]),
      copyFile(builtHosts[architecture], hostPaths[architecture]),
    ]),
  )
  await createInstrumentationFixture(fixturePath)
  const fixtureDetails = await stat(fixturePath)
  assert.equal(fixtureDetails.mode & 0o777, 0o600)
  const fixtureBytes = await readFile(fixturePath)
  targetSalt = Buffer.from(fixtureBytes.subarray(0, 16))
  fixtureBytes.fill(0)
  await Promise.all(
    (['arm64', 'x86_64'] as const).flatMap((architecture) => [
      chmod(dylibPaths[architecture], 0o700),
      chmod(hostPaths[architecture], 0o700),
    ]),
  )

  for (const architecture of ['arm64', 'x86_64'] as const) {
    for (const mode of ['correct', 'mixed'] as const) {
      await runScenario({
        architecture,
        mode,
        dylibPath: dylibPaths[architecture],
        hostPath: hostPaths[architecture],
        targetSalt,
        operation: async (group, signal) => {
          const markerPromise = startMarkerCollection(group, signal)
          const candidate = await readCandidateDatabaseKey(group.candidateKeyPipe, { signal })
          try {
            assert.equal(candidate.salt.equals(targetSalt), true)
            assert.equal(candidate.key.length, 32)
            await group.waitForExit()
            if (mode === 'correct') {
              await validateCandidate(architecture, fixturePath, candidate)
            }
          } finally {
            clearCandidateDatabaseKey(candidate)
            assert.equal(candidate.salt.equals(Buffer.alloc(16)), true)
            assert.equal(candidate.key.equals(Buffer.alloc(32)), true)
          }
          assertMarkerCollection(await markerPromise, EXPECTED_MARKERS[mode])
        },
      })
    }

    for (const mode of ['wrong-salt', 'wrong-length', 'kdf-failure'] as const) {
      await runScenario({
        architecture,
        mode,
        dylibPath: dylibPaths[architecture],
        hostPath: hostPaths[architecture],
        targetSalt,
        operation: async (group, signal) => {
          const markerPromise = startMarkerCollection(group, signal)
          await assert.rejects(
            readCandidateDatabaseKey(group.candidateKeyPipe, { signal }),
            /closed before a complete frame/i,
          )
          await group.waitForExit()
          assertMarkerCollection(await markerPromise, EXPECTED_MARKERS[mode])
        },
      })
    }
  }

  // Salt-delivery failure path: fd 4 is closed without data, so the interposer
  // reports CMSALTNO and can never match a call salt or emit a frame.
  await runScenario({
    architecture: 'arm64',
    mode: 'correct',
    dylibPath: dylibPaths.arm64,
    hostPath: hostPaths.arm64,
    targetSalt,
    deliverTargetSalt: false,
    operation: async (group, signal) => {
      const markerPromise = startMarkerCollection(group, signal)
      await assert.rejects(
        readCandidateDatabaseKey(group.candidateKeyPipe, { signal }),
        /closed before a complete frame/i,
      )
      await group.waitForExit()
      assertMarkerCollection(await markerPromise, EXPECTED_MARKERS_SALT_NOT_DELIVERED)
    },
  })

  const cancelController = new AbortController()
  await assert.rejects(
    runScenario({
      architecture: 'arm64',
      mode: 'hang',
      dylibPath: dylibPaths.arm64,
      hostPath: hostPaths.arm64,
      targetSalt,
      signal: cancelController.signal,
      operation: async (group, signal) => {
        const candidate = await readCandidateDatabaseKey(group.candidateKeyPipe, { signal })
        clearCandidateDatabaseKey(candidate)
        assert.equal(candidate.salt.equals(Buffer.alloc(16)), true)
        assert.equal(candidate.key.equals(Buffer.alloc(32)), true)
        cancelController.abort(new DOMException('Synthetic operation canceled', 'AbortError'))
        await waitForOperationAbort(signal)
      },
    }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  )

  await assert.rejects(
    runScenario({
      architecture: 'arm64',
      mode: 'hang',
      dylibPath: dylibPaths.arm64,
      hostPath: hostPaths.arm64,
      targetSalt,
      timeoutMs: 2_000,
      operation: async (group, signal) => {
        const candidate = await readCandidateDatabaseKey(group.candidateKeyPipe, { signal })
        clearCandidateDatabaseKey(candidate)
        assert.equal(candidate.salt.equals(Buffer.alloc(16)), true)
        assert.equal(candidate.key.equals(Buffer.alloc(32)), true)
        await waitForOperationAbort(signal)
      },
    }),
    (error: unknown) => error instanceof ProcessGroupTimeoutError,
  )
} finally {
  targetSalt.fill(0)
  await rm(sessionRoot, { recursive: true, force: true })
}

await assert.rejects(stat(sessionRoot), { code: 'ENOENT' })
console.log('WeChat 4 synthetic PBKDF instrumentation matrix passed')
