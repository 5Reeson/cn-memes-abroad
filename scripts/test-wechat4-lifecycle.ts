import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'

import {
  clearCandidateDatabaseKey,
  readCandidateDatabaseKey,
} from '../src/main/sources/wechat4/candidate-key-pipe.js'
import { runWechat4Helper } from '../src/main/sources/wechat4/helper-runner.js'
import {
  ProcessGroupTimeoutError,
  withManagedProcessGroup,
  type ManagedProcessGroup,
} from '../src/main/sources/wechat4/process-group.js'

interface ProcessControl {
  parentPid: number
  grandchildPid: number
}

const helper = resolve('native/wechat4-helper/build/universal/wechat4-helper')
const fixtureMaker = resolve('native/wechat4-helper/build/universal/wechat4-fixture-maker')
const processFixture = resolve('tests/fixtures/wechat4-process-fixture.mjs')

async function readControl(stream: Readable): Promise<ProcessControl> {
  return await new Promise<ProcessControl>((resolveControl, reject) => {
    let buffer = Buffer.alloc(0)
    const cleanup = () => {
      stream.removeListener('data', onData)
      stream.removeListener('error', onError)
      stream.removeListener('end', onEnd)
    }
    const onError = () => {
      cleanup()
      reject(new Error('Synthetic process control pipe failed'))
    }
    const onEnd = () => {
      cleanup()
      reject(new Error('Synthetic process control pipe closed early'))
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 1_024) return onError()
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) return
      const line = buffer.subarray(0, newline).toString('utf8')
      buffer.fill(0)
      cleanup()
      try {
        const parsed = JSON.parse(line) as Partial<ProcessControl>
        assert.equal(Number.isInteger(parsed.parentPid), true)
        assert.equal(Number.isInteger(parsed.grandchildPid), true)
        resolveControl(parsed as ProcessControl)
      } catch {
        reject(new Error('Synthetic process control message was invalid'))
      }
    }
    stream.on('data', onData)
    stream.once('error', onError)
    stream.once('end', onEnd)
  })
}

async function createFixture(databasePath: string, keyHex: string): Promise<void> {
  await new Promise<void>((resolveFixture, reject) => {
    const child = spawn(fixtureMaker, [], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir() },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const output: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)))
    child.once('error', () => reject(new Error('Synthetic fixture maker could not start')))
    child.once('close', (code) => {
      const response = Buffer.concat(output).toString('utf8').trim()
      for (const chunk of output) chunk.fill(0)
      if (code === 0 && response === '{"ok":true}') resolveFixture()
      else {
        const safeCode = response.match(/^\{"ok":false,"code":(-?\d+)\}$/)?.[1] ?? 'unknown'
        reject(new Error(`Synthetic fixture maker failed at safe stage ${safeCode}`))
      }
    })
    child.stdin.end(`${JSON.stringify({ databasePath, keyHex })}\n`)
  })
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

async function assertProcessTreeGone(control: ProcessControl): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isAlive(control.parentPid) && !isAlive(control.grandchildPid)) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  assert.equal(isAlive(control.parentPid), false)
  assert.equal(isAlive(control.grandchildPid), false)
}

async function startScenario(
  mode: 'success' | 'invalid' | 'silent' | 'ignore-term' | 'descendant-ignore-term',
  keyInput: Buffer,
  operation: (
    group: ManagedProcessGroup,
    control: ProcessControl,
    signal: AbortSignal,
  ) => Promise<void>,
  options: { signal?: AbortSignal; timeoutMs?: number; graceMs?: number } = {},
): Promise<ProcessControl> {
  let control: ProcessControl | undefined
  try {
    await withManagedProcessGroup(
      {
        executable: process.execPath,
        arguments: [processFixture, mode],
        signal: options.signal,
        operationTimeoutMs: options.timeoutMs ?? 2_000,
        terminationGraceMs: options.graceMs ?? 100,
      },
      async (group, signal) => {
        const controlPromise = readControl(group.controlOutput)
        group.input.end(keyInput)
        control = await controlPromise
        await operation(group, control, signal)
      },
    )
  } finally {
    keyInput.fill(0)
  }
  assert.ok(control)
  await assertProcessTreeGone(control)
  return control
}

const sessionRoot = await mkdtemp(join(tmpdir(), 'wechat4-lifecycle-test-'))
await chmod(sessionRoot, 0o700)
const fixturePath = join(sessionRoot, 'synthetic-emoticon.db')
const key = randomBytes(32)
const keyHex = key.toString('hex')

try {
  const rejectedFixturePath = join(sessionRoot, 'rejected-synthetic.db')
  await assert.rejects(createFixture(rejectedFixturePath, 'invalid'), /safe stage 2$/)
  await assert.rejects(stat(rejectedFixturePath), { code: 'ENOENT' })

  const occupiedFixturePath = join(sessionRoot, 'occupied-synthetic.db')
  const occupiedMarker = Buffer.from('synthetic-do-not-replace')
  await writeFile(occupiedFixturePath, occupiedMarker, { mode: 0o600 })
  await assert.rejects(createFixture(occupiedFixturePath, keyHex), /safe stage 30$/)
  assert.equal((await readFile(occupiedFixturePath)).equals(occupiedMarker), true)

  await createFixture(fixturePath, keyHex)
  assert.equal((await stat(fixturePath)).mode & 0o777, 0o600)
  const salt = (await readFile(fixturePath)).subarray(0, 16)

  await startScenario('success', Buffer.concat([salt, key]), async (group, _control, signal) => {
    const candidate = await readCandidateDatabaseKey(group.candidateKeyPipe, { signal })
    try {
      assert.equal(candidate.salt.equals(salt), true)
      const response = await runWechat4Helper(
        {
          v: 1,
          id: 'synthetic-pipe-validation',
          method: 'validateKey',
          params: { databasePath: fixturePath, keyHex: candidate.key.toString('hex') },
        },
        { executable: helper },
      )
      assert.equal(response.ok, true)
      if (response.ok) assert.equal(response.result.verified, true)
    } finally {
      clearCandidateDatabaseKey(candidate)
      assert.equal(candidate.key.equals(Buffer.alloc(32)), true)
    }
  })

  let invalidControl: ProcessControl | undefined
  await assert.rejects(
    startScenario('invalid', Buffer.concat([salt, key]), async (group, control, signal) => {
      invalidControl = control
      await readCandidateDatabaseKey(group.candidateKeyPipe, { signal })
    }),
    /invalid frame/i,
  )
  assert.ok(invalidControl)
  await assertProcessTreeGone(invalidControl)

  let canceledControl: ProcessControl | undefined
  const controller = new AbortController()
  await assert.rejects(
    startScenario(
      'silent',
      Buffer.concat([salt, key]),
      async (group, control, signal) => {
        canceledControl = control
        setTimeout(
          () => controller.abort(new DOMException('Canceled by lifecycle test', 'AbortError')),
          10,
        )
        await readCandidateDatabaseKey(group.candidateKeyPipe, { signal, timeoutMs: 5_000 })
      },
      { signal: controller.signal },
    ),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  )
  assert.ok(canceledControl)
  await assertProcessTreeGone(canceledControl)

  let timeoutControl: ProcessControl | undefined
  await assert.rejects(
    startScenario(
      'ignore-term',
      Buffer.concat([salt, key]),
      async (group, control, signal) => {
        timeoutControl = control
        const candidate = await readCandidateDatabaseKey(group.candidateKeyPipe, { signal })
        clearCandidateDatabaseKey(candidate)
        await new Promise<void>(() => undefined)
      },
      { timeoutMs: 2_000, graceMs: 50 },
    ),
    ProcessGroupTimeoutError,
  )
  assert.ok(timeoutControl)
  await assertProcessTreeGone(timeoutControl)

  let descendantTimeoutControl: ProcessControl | undefined
  await assert.rejects(
    startScenario(
      'descendant-ignore-term',
      Buffer.concat([salt, key]),
      async (group, control, signal) => {
        descendantTimeoutControl = control
        const candidate = await readCandidateDatabaseKey(group.candidateKeyPipe, { signal })
        clearCandidateDatabaseKey(candidate)
        await new Promise<void>(() => undefined)
      },
      { timeoutMs: 2_000, graceMs: 50 },
    ),
    ProcessGroupTimeoutError,
  )
  assert.ok(descendantTimeoutControl)
  await assertProcessTreeGone(descendantTimeoutControl)
} finally {
  key.fill(0)
  await rm(sessionRoot, { recursive: true, force: true })
}

await assert.rejects(stat(sessionRoot), { code: 'ENOENT' })
console.log('WeChat 4 app-copy/process-group/anonymous-pipe fixture lifecycle passed')
