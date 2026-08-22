import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { encodeSyntheticCandidateFrame } from '../src/main/sources/wechat4/candidate-key-pipe.js'
import {
  runWechat4Helper,
  runWechat4HelperForPersonalEmoticons,
  runWechat4HelperForStoreEmoticons,
  runWechat4HelperWithCandidateFrame,
} from '../src/main/sources/wechat4/helper-runner.js'
import { clearWechat4PersonalEmoticonCatalog } from '../src/main/sources/wechat4/personal-emoticon-catalog.js'
import { clearWechat4StoreEmoticonCatalog } from '../src/main/sources/wechat4/store-emoticon-catalog.js'

const helper = resolve('native/wechat4-helper/build/universal/wechat4-helper')
const fixtureMaker = resolve('native/wechat4-helper/build/universal/wechat4-fixture-maker')

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
      else reject(new Error('Synthetic fixture maker failed'))
    })
    child.stdin.end(`${JSON.stringify({ databasePath, keyHex })}\n`)
  })
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'wechat4-helper-protocol-'))
await chmod(temporaryDirectory, 0o700)
const fixturePath = join(temporaryDirectory, 'candidate-fixture.db')
const key = randomBytes(32)
let salt = Buffer.alloc(0)

try {
  await createFixture(fixturePath, key.toString('hex'))
  const fixtureBytes = await readFile(fixturePath)
  salt = Buffer.from(fixtureBytes.subarray(0, 16))
  fixtureBytes.fill(0)

  for (const architecture of ['arm64', 'x86_64'] as const) {
    const runner = { executable: '/usr/bin/arch', arguments: [`-${architecture}`, helper] }
    const probe = await runWechat4Helper(
      { v: 1, id: `${architecture}-probe`, method: 'probe' },
      runner,
    )
    assert.equal(probe.ok, true)
    if (probe.ok) {
      assert.equal(probe.result.architecture, architecture)
      assert.equal(probe.result.sqlcipherVersion, '4.17.0 community')
      assert.equal(probe.result.keyAcquisition, 'unavailable')
      assert.equal((probe.result.capabilities as unknown[]).includes('validateCandidateFd'), true)
      assert.equal((probe.result.capabilities as unknown[]).includes('schemaOverviewFd'), true)
      assert.equal((probe.result.capabilities as unknown[]).includes('personalEmoticonsFd'), true)
      assert.equal((probe.result.capabilities as unknown[]).includes('storeEmoticonsFd'), true)
    }

    const selfTest = await runWechat4Helper(
      { v: 1, id: `${architecture}-self-test`, method: 'selfTest' },
      runner,
    )
    assert.equal(selfTest.ok, true)
    if (selfTest.ok) {
      assert.deepEqual(selfTest.result, {
        correctKeyValidated: true,
        tamperRejected: true,
        walSnapshotValidated: true,
        wrongKeyRejected: true,
      })
    }

    const correctFrame = encodeSyntheticCandidateFrame({ salt, key })
    const verified = await runWechat4HelperWithCandidateFrame(
      {
        v: 1,
        id: `${architecture}-candidate-correct`,
        method: 'validateCandidateFd',
        params: { databasePath: fixturePath },
      },
      correctFrame,
      runner,
    )
    assert.equal(correctFrame.equals(Buffer.alloc(56)), true)
    assert.equal(verified.ok, true)
    if (verified.ok) {
      assert.equal(verified.result.verified, true)
      assert.equal(verified.result.formatValidated, true)
      assert.equal(verified.result.cipherIntegrityValidated, true)
      assert.equal(verified.result.schemaQueryValidated, true)
      assert.equal(verified.result.quickCheckValidated, true)
      assert.equal('schemaObjectCount' in verified.result, false)
    }

    const wrongSalt = Buffer.from(salt)
    wrongSalt[0] = wrongSalt[0]! ^ 0xff
    const wrongSaltFrame = encodeSyntheticCandidateFrame({ salt: wrongSalt, key })
    wrongSalt.fill(0)
    const saltRejected = await runWechat4HelperWithCandidateFrame(
      {
        v: 1,
        id: `${architecture}-candidate-wrong-salt`,
        method: 'validateCandidateFd',
        params: { databasePath: fixturePath },
      },
      wrongSaltFrame,
      runner,
    )
    assert.equal(wrongSaltFrame.equals(Buffer.alloc(56)), true)
    assert.equal(saltRejected.ok, false)
    if (!saltRejected.ok) assert.equal(saltRejected.error.code, 'KEY_VALIDATION_FAILED')

    const wrongKey = Buffer.from(key)
    wrongKey[0] = wrongKey[0]! ^ 0xff
    const wrongKeyFrame = encodeSyntheticCandidateFrame({ salt, key: wrongKey })
    wrongKey.fill(0)
    const keyRejected = await runWechat4HelperWithCandidateFrame(
      {
        v: 1,
        id: `${architecture}-candidate-wrong-key`,
        method: 'validateCandidateFd',
        params: { databasePath: fixturePath },
      },
      wrongKeyFrame,
      runner,
    )
    assert.equal(wrongKeyFrame.equals(Buffer.alloc(56)), true)
    assert.equal(keyRejected.ok, false)
    if (!keyRejected.ok) assert.equal(keyRejected.error.code, 'KEY_VALIDATION_FAILED')

    const overviewFrame = encodeSyntheticCandidateFrame({ salt, key })
    const overview = await runWechat4HelperWithCandidateFrame(
      {
        v: 1,
        id: `${architecture}-schema-overview`,
        method: 'schemaOverviewFd',
        params: { databasePath: fixturePath },
      },
      overviewFrame,
      runner,
    )
    assert.equal(overviewFrame.equals(Buffer.alloc(56)), true)
    assert.equal(overview.ok, true)
    if (overview.ok) {
      assert.equal(overview.result.verified, true)
      assert.equal(overview.result.cipherIntegrityValidated, true)
      const overviewResult = overview.result.overview as {
        tableCount: number
        viewCount: number
        indexCount: number
        triggerCount: number
        tables: Array<{
          name: string
          rowCount: number
          columns: Array<{ name: string; type: string; notNull: boolean; primaryKey: boolean }>
        }>
        views: Array<{ name: string; columns: string[] }>
      }
      assert.equal(overviewResult.tableCount, 7)
      assert.equal(overviewResult.viewCount, 1)
      assert.equal(overviewResult.indexCount, 1)
      assert.equal(overviewResult.triggerCount, 0)
      assert.deepEqual(
        overviewResult.tables.map((table) => table.name),
        [
          'fixture_marker',
          'fixture_second',
          'kCustomEmoticonOrderTable',
          'kFavEmoticonOrderTable',
          'kNonStoreEmoticonTable',
          'kStoreEmoticonFilesTable',
          'kStoreEmoticonPackageTable',
        ],
      )
      const markerTable = overviewResult.tables[0]!
      assert.equal(markerTable.rowCount, 1)
      assert.deepEqual(
        markerTable.columns.map((column) => column.name),
        ['id', 'value'],
      )
      const valueColumn = markerTable.columns[1]!
      assert.equal(valueColumn.type, 'TEXT')
      assert.equal(valueColumn.notNull, true)
      assert.equal(valueColumn.primaryKey, false)
      assert.equal(markerTable.columns[0]!.primaryKey, true)
      const secondTable = overviewResult.tables[1]!
      assert.equal(secondTable.rowCount, 2)
      assert.deepEqual(
        secondTable.columns.map((column) => column.name),
        ['id', 'label', 'score'],
      )
      assert.deepEqual(
        overviewResult.views.map((view) => view.name),
        ['fixture_view'],
      )
      assert.deepEqual(overviewResult.views[0]!.columns, ['id', 'label'])
      // Row content must never cross the sanitized schema boundary.
      const serialized = JSON.stringify(overview.result)
      assert.equal(serialized.includes('synthetic-pipe-test'), false)
      assert.equal(serialized.includes('synthetic-overview-a'), false)
      assert.equal(serialized.includes('synthetic-overview-b'), false)
    }

    const storeCatalogFrame = encodeSyntheticCandidateFrame({ salt, key })
    const storeCatalog = await runWechat4HelperForStoreEmoticons(
      {
        v: 1,
        id: `${architecture}-store-emoticons`,
        method: 'storeEmoticonsFd',
        params: { databasePath: fixturePath },
      },
      storeCatalogFrame,
      runner,
    )
    assert.equal(storeCatalogFrame.equals(Buffer.alloc(56)), true)
    assert.equal(storeCatalog.response.ok, true)
    if (storeCatalog.response.ok) {
      assert.equal(storeCatalog.response.result.verified, true)
      assert.equal(storeCatalog.response.result.recordCount, 3)
      assert.equal(storeCatalog.response.result.packageCount, 2)
      assert.equal(JSON.stringify(storeCatalog.response).includes('10000000'), false)
      assert.deepEqual(
        storeCatalog.records.map((record) => [
          record.order,
          record.packageId,
          record.packageName,
          record.md5,
          record.emoticonOffset,
          record.emoticonSize,
        ]),
        [
          [
            0,
            '10000000000000000000000000000001',
            '合成专辑一',
            '20000000000000000000000000000001',
            10,
            20,
          ],
          [
            1,
            '10000000000000000000000000000001',
            '合成专辑一',
            '20000000000000000000000000000002',
            38,
            40,
          ],
          [
            2,
            '10000000000000000000000000000002',
            '合成专辑二',
            '20000000000000000000000000000003',
            4,
            12,
          ],
        ],
      )
      clearWechat4StoreEmoticonCatalog(storeCatalog.records)
      assert.equal(storeCatalog.records.length, 0)
    }

    const catalogFrame = encodeSyntheticCandidateFrame({ salt, key })
    const catalog = await runWechat4HelperForPersonalEmoticons(
      {
        v: 1,
        id: `${architecture}-personal-emoticons`,
        method: 'personalEmoticonsFd',
        params: { databasePath: fixturePath },
      },
      catalogFrame,
      runner,
    )
    assert.equal(catalogFrame.equals(Buffer.alloc(56)), true)
    assert.equal(catalog.response.ok, true)
    if (catalog.response.ok) {
      assert.equal(catalog.response.result.verified, true)
      assert.equal(catalog.response.result.recordCount, 3)
      assert.equal(catalog.response.result.favoriteCount, 2)
      assert.equal(catalog.response.result.customCount, 1)
      assert.equal(JSON.stringify(catalog.response).includes('synthetic-caption'), false)
      assert.deepEqual(
        catalog.records.map((record) => [record.order, record.group, record.md5]),
        [
          [0, 'favorite', '00000000000000000000000000000002'],
          [1, 'favorite', '00000000000000000000000000000001'],
          [2, 'custom', '00000000000000000000000000000003'],
        ],
      )
      assert.equal(catalog.records[0]!.aesKey, '00112233445566778899aabbccddeeff')
      assert.equal(catalog.records[1]!.caption, 'synthetic-caption-one')
      clearWechat4PersonalEmoticonCatalog(catalog.records)
      assert.equal(catalog.records.length, 0)
    }

    const catalogWrongKey = Buffer.from(key)
    catalogWrongKey[0] = catalogWrongKey[0]! ^ 0xff
    const rejectedCatalog = await runWechat4HelperForPersonalEmoticons(
      {
        v: 1,
        id: `${architecture}-personal-emoticons-wrong-key`,
        method: 'personalEmoticonsFd',
        params: { databasePath: fixturePath },
      },
      encodeSyntheticCandidateFrame({ salt, key: catalogWrongKey }),
      runner,
    )
    catalogWrongKey.fill(0)
    assert.equal(rejectedCatalog.response.ok, false)
    if (!rejectedCatalog.response.ok) {
      assert.equal(rejectedCatalog.response.error.code, 'KEY_VALIDATION_FAILED')
    }
    assert.equal(rejectedCatalog.records.length, 0)

    const overviewWrongKey = Buffer.from(key)
    overviewWrongKey[0] = overviewWrongKey[0]! ^ 0xff
    const overviewWrongKeyFrame = encodeSyntheticCandidateFrame({ salt, key: overviewWrongKey })
    overviewWrongKey.fill(0)
    const overviewRejected = await runWechat4HelperWithCandidateFrame(
      {
        v: 1,
        id: `${architecture}-schema-overview-wrong-key`,
        method: 'schemaOverviewFd',
        params: { databasePath: fixturePath },
      },
      overviewWrongKeyFrame,
      runner,
    )
    assert.equal(overviewWrongKeyFrame.equals(Buffer.alloc(56)), true)
    assert.equal(overviewRejected.ok, false)
    if (!overviewRejected.ok) assert.equal(overviewRejected.error.code, 'KEY_VALIDATION_FAILED')

    const syntheticFile = join(temporaryDirectory, `not-a-database-${architecture}.db`)
    await writeFile(syntheticFile, 'synthetic only', { mode: 0o600 })
    const invalidKey = await runWechat4Helper(
      {
        v: 1,
        id: `${architecture}-invalid-key`,
        method: 'validateKey',
        params: { databasePath: syntheticFile, keyHex: 'not-a-key' },
      },
      runner,
    )
    assert.equal(invalidKey.ok, false)
    if (!invalidKey.ok) assert.equal(invalidKey.error.code, 'KEY_FORMAT_INVALID')
    assert.equal(JSON.stringify(invalidKey).includes('not-a-key'), false)
  }
} finally {
  key.fill(0)
  salt.fill(0)
  await rm(temporaryDirectory, { recursive: true, force: true })
}

console.log('WeChat 4 helper arm64/x86_64 SQLCipher and candidate-fd tests passed')
