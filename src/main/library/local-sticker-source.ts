import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

import sharp, { type Metadata } from 'sharp'

import type {
  ImportFailure,
  ImportProgress,
  ImportResult,
  StickerAsset,
  StickerCollection,
  StickerSource,
  StickerSourceKind,
} from '../../shared/domain.js'

const SUPPORTED_FORMATS = new Set(['png', 'jpeg', 'webp', 'gif'])

const EXTENSIONS: Record<string, string> = {
  gif: '.gif',
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
}

const MIME_TYPES: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export interface LocalImportRequest {
  collection: StickerCollection
  /** Directory containing manifest.json and the originals directory. */
  collectionDirectory: string
  /** Explicit files and/or directories, kept in the order supplied by the user. */
  inputs: readonly string[]
}

export type ImportProgressHandler = (progress: ImportProgress) => void | Promise<void>

interface DiscoveryResult {
  files: string[]
  failures: ImportFailure[]
}

interface InspectedImage {
  bytes: Buffer
  extension: string
  mimeType: string
  width: number
  height: number
  animated: boolean
  durationMs?: number
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function walkDirectory(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => lexicalCompare(left.name, right.name))

  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkDirectory(path)))
    } else if (entry.isFile()) {
      files.push(path)
    }
    // Deliberately do not follow symlinks. Besides avoiding cycles, this keeps a
    // directory import inside the directory the user actually selected.
  }
  return files
}

/**
 * Expands files and directories without filtering by filename extension.
 * Image support is decided later from decoded content, not from user-controlled
 * extensions. Explicit input order is preserved; directory entries are sorted.
 */
export async function discoverLocalFiles(inputs: readonly string[]): Promise<string[]> {
  const result = await discoverWithFailures(inputs)
  if (result.failures.length > 0) {
    throw new AggregateError(
      result.failures.map((failure) => new Error(`${failure.path}: ${failure.reason}`)),
      'One or more import locations could not be read',
    )
  }
  return result.files
}

async function discoverWithFailures(inputs: readonly string[]): Promise<DiscoveryResult> {
  const files: string[] = []
  const failures: ImportFailure[] = []

  for (const input of inputs) {
    const path = resolve(input)
    try {
      const details = await lstat(path)
      if (details.isFile()) {
        files.push(path)
      } else if (details.isDirectory()) {
        files.push(...(await walkDirectory(path)))
      } else {
        failures.push({ path, reason: 'Not a regular file or directory' })
      }
    } catch (error) {
      failures.push({ path, reason: errorMessage(error) })
    }
  }

  return { files, failures }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function durationFrom(metadata: Metadata): number | undefined {
  if (!metadata.delay || metadata.delay.length === 0) return undefined
  return metadata.delay.reduce((total, delay) => total + delay, 0)
}

async function inspectImage(path: string): Promise<InspectedImage> {
  const bytes = await readFile(path)
  const image = sharp(bytes, {
    animated: true,
    failOn: 'error',
    limitInputPixels: 100_000_000,
  })
  const metadata = await image.metadata()

  if (
    !metadata.format ||
    !SUPPORTED_FORMATS.has(metadata.format) ||
    !metadata.width ||
    !metadata.height
  ) {
    throw new Error('Unsupported or unreadable image (PNG, JPEG, WebP and GIF only)')
  }

  // metadata() validates the container. Force a pixel decode as well so a file
  // with a plausible header but corrupt image data cannot enter the library.
  await image.clone().raw().toBuffer()

  const pages = metadata.pages ?? 1
  const pageHeight = metadata.pageHeight ?? metadata.height
  const animated = pages > 1 || (metadata.delay?.length ?? 0) > 1
  const durationMs = animated ? durationFrom(metadata) : undefined

  return {
    bytes,
    extension: EXTENSIONS[metadata.format]!,
    mimeType: MIME_TYPES[metadata.format]!,
    width: metadata.width,
    height: pageHeight,
    animated,
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function nextOrder(assets: readonly StickerAsset[], key: 'sourceOrder' | 'userOrder') {
  return assets.reduce((highest, asset) => Math.max(highest, asset[key]), -1) + 1
}

async function copyOriginal(
  bytes: Buffer,
  originalsDirectory: string,
  fileName: string,
  expectedHash: string,
): Promise<string> {
  await mkdir(originalsDirectory, { recursive: true, mode: 0o700 })
  await chmod(originalsDirectory, 0o700)

  const destination = join(originalsDirectory, fileName)
  try {
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw error

    const existingHash = sha256(await readFile(destination))
    if (existingHash !== expectedHash) {
      throw new Error(
        `Library destination already exists with different content: ${basename(destination)}`,
        { cause: error },
      )
    }
  }

  await chmod(destination, 0o600)
  // Ensure an unexpected filesystem implementation did not produce a partial
  // copy before this path is persisted in the manifest.
  const destinationStat = await stat(destination)
  if (!destinationStat.isFile()) throw new Error('Imported original is not a file')
  return destination
}

export class LocalStickerSource implements StickerSource {
  readonly kind: StickerSourceKind = 'local'

  discover(inputs: readonly string[]): Promise<string[]> {
    return discoverLocalFiles(inputs)
  }

  async import(
    request: LocalImportRequest,
    onProgress?: ImportProgressHandler,
  ): Promise<ImportResult> {
    const discovery = await discoverWithFailures(request.inputs)
    const originalsDirectory = join(resolve(request.collectionDirectory), 'originals')
    const assets: StickerAsset[] = []
    const duplicates: string[] = []
    const failures = [...discovery.failures]
    const knownHashes = new Set(request.collection.assets.map((asset) => asset.sha256))
    let sourceOrder = nextOrder(request.collection.assets, 'sourceOrder')
    let userOrder = nextOrder(request.collection.assets, 'userOrder')
    const total = discovery.files.length + discovery.failures.length
    let completed = discovery.failures.length

    const report = async (currentPath?: string) => {
      if (!onProgress) return
      await onProgress({
        completed,
        total,
        imported: assets.length,
        duplicates: duplicates.length,
        failed: failures.length,
        ...(currentPath === undefined ? {} : { currentPath }),
      })
    }

    await report()

    for (const path of discovery.files) {
      try {
        const inspected = await inspectImage(path)
        const hash = sha256(inspected.bytes)
        if (knownHashes.has(hash)) {
          duplicates.push(path)
        } else {
          const id = `asset-${hash.slice(0, 24)}`
          const originalPath = await copyOriginal(
            inspected.bytes,
            originalsDirectory,
            `${id}${inspected.extension}`,
            hash,
          )
          const importedAt = new Date().toISOString()
          assets.push({
            id,
            sourceKind: this.kind,
            displayName: basename(path, extname(path)),
            originalPath,
            sha256: hash,
            mimeType: inspected.mimeType,
            animated: inspected.animated,
            width: inspected.width,
            height: inspected.height,
            ...(inspected.durationMs === undefined ? {} : { durationMs: inspected.durationMs }),
            importedAt,
            sourceOrder,
            userOrder,
          })
          knownHashes.add(hash)
          sourceOrder += 1
          userOrder += 1
        }
      } catch (error) {
        failures.push({ path, reason: errorMessage(error) })
      }

      completed += 1
      await report(path)
    }

    return { assets, duplicates, failures }
  }
}
