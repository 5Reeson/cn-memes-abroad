import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { zipSync } from 'fflate'

import {
  VX_PLUGIN_API_VERSION,
  VX_PLUGIN_DISTRIBUTION_SCHEMA_VERSION,
} from '../src/shared/vx-plugin.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const stagingRoot = join(projectRoot, '.plugin-staging', 'vx')
const outputRoot = join(projectRoot, 'release', 'plugin')
const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
  version: string
}
const manifest = JSON.parse(await readFile(join(stagingRoot, 'manifest.json'), 'utf8')) as {
  pluginVersion: string
  pluginApiVersion: number
  architectures: string[]
  artifacts: {
    helper: { fileName: string }
    interposer: { fileName: string }
  }
}

if (
  manifest.pluginVersion !== packageJson.version ||
  manifest.pluginApiVersion !== VX_PLUGIN_API_VERSION
) {
  throw new Error('Staged plugin manifest does not match the current application version/API')
}

const archiveName = `vx-plugin-${manifest.pluginVersion}-macos-universal.zip`
const archive = zipSync(
  {
    'manifest.json': await readFile(join(stagingRoot, 'manifest.json')),
    [manifest.artifacts.helper.fileName]: await readFile(
      join(stagingRoot, manifest.artifacts.helper.fileName),
    ),
    [manifest.artifacts.interposer.fileName]: await readFile(
      join(stagingRoot, manifest.artifacts.interposer.fileName),
    ),
  },
  { level: 9 },
)
const archiveHash = createHash('sha256').update(archive).digest('hex')
const index = {
  schemaVersion: VX_PLUGIN_DISTRIBUTION_SCHEMA_VERSION,
  packages: [
    {
      pluginVersion: manifest.pluginVersion,
      pluginApiVersion: manifest.pluginApiVersion,
      architectures: manifest.architectures,
      format: 'zip',
      url: `./${archiveName}`,
      sha256: archiveHash,
      sizeBytes: archive.byteLength,
    },
  ],
}

await mkdir(outputRoot, { recursive: true, mode: 0o700 })
await Promise.all([
  writeFile(join(outputRoot, archiveName), archive, { mode: 0o600 }),
  writeFile(join(outputRoot, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 }),
])

process.stdout.write(`VX plugin package: release/plugin/${archiveName}\n`)
process.stdout.write('Distribution index: release/plugin/index.json\n')
