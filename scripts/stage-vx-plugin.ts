import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { VX_PLUGIN_API_VERSION, VX_PLUGIN_SCHEMA_VERSION } from '../src/shared/vx-plugin.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const stagingRoot = join(projectRoot, '.plugin-staging', 'vx')
const helperName = 'vx-helper'
const interposerName = 'libvx-interposer.dylib'
const helperSource = join(
  projectRoot,
  'native',
  'wechat4-helper',
  'build',
  'universal',
  'wechat4-helper',
)
const interposerSource = join(
  projectRoot,
  'native',
  'wechat4-instrumentation',
  'build',
  'universal',
  'libwechat4-synthetic-interposer.dylib',
)

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function installInformation(): { install: { pageUrl: string } } | Record<string, never> {
  const value = process.env.VX_PLUGIN_INSTALL_PAGE_URL
  if (!value) return {}
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('VX_PLUGIN_INSTALL_PAGE_URL must be an HTTPS URL without credentials')
  }
  return { install: { pageUrl: parsed.toString() } }
}

async function main(): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
    version: string
  }
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  const helperTarget = join(stagingRoot, helperName)
  const interposerTarget = join(stagingRoot, interposerName)
  await Promise.all([
    copyFile(helperSource, helperTarget),
    copyFile(interposerSource, interposerTarget),
  ])
  await Promise.all([chmod(helperTarget, 0o755), chmod(interposerTarget, 0o755)])
  const [helperHash, interposerHash] = await Promise.all([
    sha256(helperTarget),
    sha256(interposerTarget),
  ])
  const manifest = {
    schemaVersion: VX_PLUGIN_SCHEMA_VERSION,
    pluginApiVersion: VX_PLUGIN_API_VERSION,
    pluginVersion: packageJson.version,
    architectures: ['arm64', 'x64'],
    artifacts: {
      helper: { fileName: helperName, sha256: helperHash },
      interposer: { fileName: interposerName, sha256: interposerHash },
    },
    ...installInformation(),
  }
  await writeFile(join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  })
  process.stdout.write('VX plugin staged for development and Official packaging.\n')
}

await main()
