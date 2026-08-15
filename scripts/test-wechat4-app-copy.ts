import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'

import { TemporaryWechatAppCopy } from '../src/main/sources/wechat4/temporary-app-copy.js'

const execFileAsync = promisify(execFile)
const originalApp = '/Applications/WeChat.app'

async function codeDirectoryHash(appPath: string): Promise<string> {
  const { stderr } = await execFileAsync('/usr/bin/codesign', ['-dvvv', appPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  })
  const hash = stderr.match(/^CDHash=([a-f0-9]+)$/m)?.[1]
  if (!hash) throw new Error('Could not read the WeChat code-directory hash')
  return hash
}

interface SignatureVerification {
  exitCode: number
  diagnostic: string
}

async function verifySignature(appPath: string): Promise<SignatureVerification> {
  try {
    const { stderr } = await execFileAsync(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', appPath],
      { encoding: 'utf8', maxBuffer: 64 * 1024 },
    )
    return { exitCode: 0, diagnostic: stderr.replaceAll(appPath, '<APP>') }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (typeof failure.code !== 'number') throw error
    return {
      exitCode: failure.code,
      diagnostic: (failure.stderr ?? '').replaceAll(appPath, '<APP>'),
    }
  }
}

const originalHashBefore = await codeDirectoryHash(originalApp)
const originalVerification = await verifySignature(originalApp)
const copy = await TemporaryWechatAppCopy.create({ sourceAppPath: originalApp })
const sessionRoot = copy.sessionRoot
try {
  assert.equal(await codeDirectoryHash(copy.appPath), originalHashBefore)
  assert.deepEqual(await verifySignature(copy.appPath), originalVerification)
} finally {
  await copy.cleanup()
}

await assert.rejects(stat(sessionRoot), { code: 'ENOENT' })
assert.equal(await codeDirectoryHash(originalApp), originalHashBefore)
console.log(
  'Real WeChat.app was copied byte-signature-equivalently and the session copy was removed',
)
