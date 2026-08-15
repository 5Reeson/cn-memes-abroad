import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

import { runWechat4Helper } from './main/sources/wechat4/helper-runner.js'
import { DEFAULT_WECHAT4_ROOT, discoverWechat4 } from './main/sources/wechat4/wechat4-layout.js'

const argumentsList = process.argv.slice(2)
const rootIndex = argumentsList.indexOf('--root')
const root = rootIndex >= 0 ? argumentsList[rootIndex + 1] : DEFAULT_WECHAT4_ROOT
if (!root) throw new Error('--root requires a directory')

const helper = resolve('native/wechat4-helper/build/universal/wechat4-helper')
const discovery = await discoverWechat4(root)
let helperResult: Record<string, unknown> | undefined
try {
  await access(helper)
  const [probe, selfTest] = await Promise.all([
    runWechat4Helper({ v: 1, id: 'inspect-probe', method: 'probe' }, { executable: helper }),
    runWechat4Helper({ v: 1, id: 'inspect-self-test', method: 'selfTest' }, { executable: helper }),
  ])
  helperResult = {
    built: true,
    probe: probe.ok ? probe.result : { errorCode: probe.error.code },
    selfTest: selfTest.ok ? selfTest.result : { errorCode: selfTest.error.code },
  }
} catch {
  helperResult = { built: false }
}

console.log(
  JSON.stringify(
    {
      rootFound: discovery.rootFound,
      permissionDenied: discovery.permissionDenied,
      accounts: discovery.accounts,
      failures: discovery.failures,
      helper: helperResult,
    },
    null,
    2,
  ),
)
