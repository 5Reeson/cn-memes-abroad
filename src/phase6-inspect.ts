import { resolve } from 'node:path'

import { WechatLegacySource } from './main/sources/wechat-legacy/wechat-legacy-source.js'

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`)
  return value
}

async function main(): Promise<void> {
  const root = optionValue('--root')
  const source = new WechatLegacySource(root ? { root: resolve(root) } : undefined)
  const result = await source.discover()
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        rootFound: result.rootFound,
        accounts: result.accounts,
        failures: result.failures,
      },
      null,
      2,
    )}\n`,
  )
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      schemaVersion: 1,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  )
  process.exitCode = 1
})
