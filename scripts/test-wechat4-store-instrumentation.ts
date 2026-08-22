import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import type { Writable } from 'node:stream'

import { collectWechat4Markers } from '../src/main/sources/wechat4/load-gate.js'
import { withManagedProcessGroup } from '../src/main/sources/wechat4/process-group.js'
import {
  clearWechat4StoreKeyCandidate,
  encodeWechat4StoreTargetFrame,
  readWechat4StoreKeyCandidate,
} from '../src/main/sources/wechat4/store-key-pipe.js'

type Architecture = 'arm64' | 'x86_64'
type HostMode =
  | 'correct'
  | 'correct-ecb'
  | 'correct-32'
  | 'correct-32-ascii'
  | 'wrong'
  | 'ineligible'
  | 'mixed'

const correctKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
const plaintext = Buffer.alloc(16)
Buffer.from('89504e470d0a1a0a', 'hex').copy(plaintext)
const cipher = createCipheriv('aes-128-cbc', correctKey, correctKey)
cipher.setAutoPadding(false)
const targetBlock = Buffer.concat([cipher.update(plaintext), cipher.final()])
const correctKey32 = Buffer.from(
  '00112233445566778899aabbccddeefff0e1d2c3b4a5968778695a4b3c2d1e0f',
  'hex',
)
const cipher32 = createCipheriv('aes-256-cbc', correctKey32, correctKey32.subarray(0, 16))
cipher32.setAutoPadding(false)
const targetBlock32 = Buffer.concat([cipher32.update(plaintext), cipher32.final()])

const MARKER = {
  loaded: 'CMS8LOAD',
  targetOk: 'CMS8TGOK',
  targetNo: 'CMS8TGNO',
  call: 'CMS8CALL',
  algorithm: 'CMS8ALGO',
  key16: 'CMS8KEY1',
  key32: 'CMS8KEY2',
  cbc: 'CMS8CBCM',
  ecb: 'CMS8ECBM',
  eligible: 'CMS8AES1',
  validated: 'CMS8GOOD',
  sent: 'CMS8SENT',
} as const

const expectedMarkers: Record<HostMode, string[]> = {
  correct: [
    MARKER.loaded,
    MARKER.targetOk,
    MARKER.call,
    MARKER.algorithm,
    MARKER.key16,
    MARKER.cbc,
    MARKER.eligible,
    MARKER.validated,
    MARKER.sent,
  ],
  'correct-ecb': [
    MARKER.loaded,
    MARKER.targetOk,
    MARKER.call,
    MARKER.algorithm,
    MARKER.key16,
    MARKER.ecb,
    MARKER.eligible,
    MARKER.validated,
    MARKER.sent,
  ],
  'correct-32': [
    MARKER.loaded,
    MARKER.targetOk,
    MARKER.call,
    MARKER.algorithm,
    MARKER.key32,
    MARKER.cbc,
    MARKER.eligible,
    MARKER.validated,
    MARKER.sent,
  ],
  'correct-32-ascii': [
    MARKER.loaded,
    MARKER.targetOk,
    MARKER.call,
    MARKER.algorithm,
    MARKER.key32,
    MARKER.cbc,
    MARKER.eligible,
    MARKER.validated,
    MARKER.sent,
  ],
  wrong: [
    MARKER.loaded,
    MARKER.targetOk,
    MARKER.call,
    MARKER.algorithm,
    MARKER.key16,
    MARKER.cbc,
    MARKER.eligible,
  ],
  ineligible: [MARKER.loaded, MARKER.targetOk, MARKER.call, MARKER.key16],
  mixed: [
    MARKER.loaded,
    MARKER.targetOk,
    MARKER.call,
    MARKER.algorithm,
    MARKER.key16,
    MARKER.cbc,
    MARKER.eligible,
    MARKER.validated,
    MARKER.sent,
  ],
}

function artifact(architecture: Architecture, filename: string): string {
  return new URL(
    `../native/wechat4-store-instrumentation/build/${architecture}/${filename}`,
    import.meta.url,
  ).pathname
}

async function writeAndClear(input: Writable, bytes: Buffer): Promise<void> {
  try {
    await new Promise<void>((resolveWrite, reject) => {
      const onError = () => reject(new Error('Store target input pipe failed'))
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

async function runScenario(
  architecture: Architecture,
  mode: HostMode,
  deliverTarget = true,
): Promise<void> {
  await withManagedProcessGroup(
    {
      executable: artifact(architecture, 'wechat4-store-synthetic-host'),
      arguments: [mode],
      environment: {
        DYLD_INSERT_LIBRARIES: artifact(
          architecture,
          'libwechat4-store-key-interposer.dylib',
        ),
      },
      anonymousInputDescriptors: [4],
      anonymousOutputDescriptors: [7],
      allowLeaderSignalFallback: true,
      operationTimeoutMs: 5_000,
      terminationGraceMs: 100,
    },
    async (group, signal) => {
      const markerOutput = group.anonymousOutputs.get(7)
      const targetInput = group.anonymousInputs.get(4)
      assert(markerOutput)
      assert(targetInput)
      const markerPromise = collectWechat4Markers(markerOutput, { signal })
      if (deliverTarget) {
        const targetFrame = encodeWechat4StoreTargetFrame([
          mode === 'correct-32' ? targetBlock32 : targetBlock,
        ])
        await writeAndClear(targetInput, targetFrame)
        assert.equal(targetFrame.equals(Buffer.alloc(targetFrame.length)), true)
      } else {
        targetInput.end()
      }

      if (
        deliverTarget &&
        ['correct', 'correct-ecb', 'correct-32', 'correct-32-ascii', 'mixed'].includes(mode)
      ) {
        const candidate = await readWechat4StoreKeyCandidate(group.candidateKeyPipe, { signal })
        const candidateBytes = candidate.key.length
        try {
          assert.equal(candidate.targetIndex, 0)
          assert.equal(candidate.key.equals(mode === 'correct-32' ? correctKey32 : correctKey), true)
          assert.equal(candidate.sourceMode, mode === 'correct-32-ascii' ? 'hex-decoded' : 'direct')
        } finally {
          clearWechat4StoreKeyCandidate(candidate)
          assert.equal(candidate.targetIndex, -1)
          assert.equal(candidate.key.equals(Buffer.alloc(candidateBytes)), true)
        }
      } else {
        await assert.rejects(
          readWechat4StoreKeyCandidate(group.candidateKeyPipe, { signal }),
          /closed before a complete frame/i,
        )
      }
      await group.waitForExit()
      const markers = await markerPromise
      assert.equal(markers.invalidMarkerObserved, false)
      assert.equal(markers.limitReached, false)
      assert.equal(markers.trailingBytes, 0)
      assert.deepEqual(
        markers.markers,
        deliverTarget
          ? expectedMarkers[mode]
          : [
              MARKER.loaded,
              MARKER.targetNo,
              MARKER.call,
              MARKER.algorithm,
              MARKER.key16,
              MARKER.cbc,
            ],
      )
    },
  )
}

try {
  for (const architecture of ['arm64', 'x86_64'] as const) {
    for (const mode of [
      'correct',
      'correct-ecb',
      'correct-32',
      'correct-32-ascii',
      'wrong',
      'ineligible',
      'mixed',
    ] as const) {
      await runScenario(architecture, mode)
    }
  }
  await runScenario('arm64', 'correct', false)
  console.log('WeChat 4 official-store instrumentation matrix passed')
} finally {
  correctKey.fill(0)
  plaintext.fill(0)
  targetBlock.fill(0)
  correctKey32.fill(0)
  targetBlock32.fill(0)
}
