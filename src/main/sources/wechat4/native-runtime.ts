import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface Wechat4NativeArtifacts {
  helperPath: string
  interposerPath: string
}

export interface ResolveWechat4NativeArtifactsOptions {
  packaged: boolean
  resourcesPath?: string
  projectRoot?: string
}

export function resolveWechat4NativeArtifacts(
  options: ResolveWechat4NativeArtifactsOptions,
): Wechat4NativeArtifacts {
  if (options.packaged) {
    if (!options.resourcesPath) throw new Error('WeChat 4 packaged resources path is unavailable')
    const directory = join(resolve(options.resourcesPath), 'wechat4-native')
    return {
      helperPath: join(directory, 'wechat4-helper'),
      interposerPath: join(directory, 'libwechat4-emoticon-interposer.dylib'),
    }
  }

  const root = resolve(options.projectRoot ?? process.cwd())
  return {
    helperPath: join(root, 'native', 'wechat4-helper', 'build', 'universal', 'wechat4-helper'),
    interposerPath: join(
      root,
      'native',
      'wechat4-instrumentation',
      'build',
      'universal',
      'libwechat4-synthetic-interposer.dylib',
    ),
  }
}

async function assertRegularExecutable(path: string, label: string): Promise<void> {
  let details
  try {
    details = await lstat(path)
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error })
  }
  if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o111) === 0) {
    throw new Error(`${label} is not a regular executable file`)
  }
}

export async function assertWechat4NativeArtifacts(
  artifacts: Wechat4NativeArtifacts,
): Promise<void> {
  await Promise.all([
    assertRegularExecutable(artifacts.helperPath, 'WeChat 4 helper'),
    assertRegularExecutable(artifacts.interposerPath, 'WeChat 4 interposer'),
  ])
}
