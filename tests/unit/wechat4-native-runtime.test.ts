import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertWechat4NativeArtifacts,
  resolveWechat4NativeArtifacts,
} from '../../src/main/sources/wechat4/native-runtime.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('WeChat 4 native runtime artifacts', () => {
  it('resolves development and packaged artifacts from their explicit roots', () => {
    expect(
      resolveWechat4NativeArtifacts({ packaged: false, projectRoot: '/work/project' }),
    ).toEqual({
      helperPath: '/work/project/native/wechat4-helper/build/universal/wechat4-helper',
      interposerPath:
        '/work/project/native/wechat4-instrumentation/build/universal/libwechat4-synthetic-interposer.dylib',
    })
    expect(
      resolveWechat4NativeArtifacts({
        packaged: true,
        resourcesPath: '/Applications/App/Resources',
      }),
    ).toEqual({
      helperPath: '/Applications/App/Resources/wechat4-native/wechat4-helper',
      interposerPath:
        '/Applications/App/Resources/wechat4-native/libwechat4-emoticon-interposer.dylib',
    })
  })

  it('requires both artifacts to be regular executable files', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wechat4-native-runtime-'))
    cleanup.push(parent)
    const helperPath = join(parent, 'helper')
    const interposerPath = join(parent, 'interposer.dylib')
    await Promise.all([writeFile(helperPath, 'helper'), writeFile(interposerPath, 'interposer')])
    await Promise.all([chmod(helperPath, 0o700), chmod(interposerPath, 0o700)])

    await expect(
      assertWechat4NativeArtifacts({ helperPath, interposerPath }),
    ).resolves.toBeUndefined()

    await chmod(interposerPath, 0o600)
    await expect(assertWechat4NativeArtifacts({ helperPath, interposerPath })).rejects.toThrow(
      'interposer is not a regular executable file',
    )
  })

  it('rejects a symlink even when its target is executable', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wechat4-native-symlink-'))
    cleanup.push(parent)
    const targetPath = join(parent, 'target')
    const helperPath = join(parent, 'helper-link')
    const interposerPath = join(parent, 'interposer.dylib')
    await Promise.all([writeFile(targetPath, 'helper'), writeFile(interposerPath, 'interposer')])
    await Promise.all([chmod(targetPath, 0o700), chmod(interposerPath, 0o700)])
    await symlink(targetPath, helperPath)

    await expect(assertWechat4NativeArtifacts({ helperPath, interposerPath })).rejects.toThrow(
      'helper is not a regular executable file',
    )
  })

  it('packages both universal artifacts before every macOS build', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      build: { extraResources: Array<{ from: string; to: string }> }
    }

    expect(packageJson.scripts['phase7:native:build']).toContain('phase7:helper:build')
    expect(packageJson.scripts['phase7:native:build']).toContain('phase7:instrumentation:build')
    for (const script of ['package:mac', 'package:mac:arm64', 'package:mac:x64']) {
      expect(packageJson.scripts[script]).toContain('phase7:native:build')
    }
    expect(packageJson.build.extraResources).toEqual(
      expect.arrayContaining([
        {
          from: 'native/wechat4-helper/build/universal/wechat4-helper',
          to: 'wechat4-native/wechat4-helper',
        },
        {
          from: 'native/wechat4-instrumentation/build/universal/libwechat4-synthetic-interposer.dylib',
          to: 'wechat4-native/libwechat4-emoticon-interposer.dylib',
        },
      ]),
    )
  })
})
