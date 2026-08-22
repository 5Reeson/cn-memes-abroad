import CSQLCipher
import Darwin
import Foundation
import Security

private let protocolVersion = 1
private let maximumLineBytes = 64 * 1024
private let candidateFrameBytes = 56
private let maximumCatalogFieldBytes = 16 * 1024
private let maximumCatalogRecords = 100_000

private enum ErrorCode: String {
  case permissionDenied = "PERMISSION_DENIED"
  case databaseNotFound = "DATABASE_NOT_FOUND"
  case snapshotChanged = "SNAPSHOT_CHANGED"
  case keyFormatInvalid = "KEY_FORMAT_INVALID"
  case keyAcquisitionFailed = "KEY_ACQUISITION_FAILED"
  case keyValidationFailed = "KEY_VALIDATION_FAILED"
  case unsupportedWechatVersion = "UNSUPPORTED_WECHAT_VERSION"
  case invalidRequest = "INVALID_REQUEST"
  case internalError = "INTERNAL"
}

private struct HelperFailure: Error {
  let code: ErrorCode
  let message: String
  let retryable: Bool

  init(_ code: ErrorCode, _ message: String, retryable: Bool = false) {
    self.code = code
    self.message = message
    self.retryable = retryable
  }
}

private struct Request: Decodable {
  let v: Int
  let id: String
  let method: String
  let params: [String: String]?
}

private func architecture() -> String {
  #if arch(arm64)
    return "arm64"
  #elseif arch(x86_64)
    return "x86_64"
  #else
    return "unsupported"
  #endif
}

private func writeJSON(_ object: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(object),
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  else {
    return
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

private func writeSuccess(id: String, result: [String: Any]) {
  writeJSON(["v": protocolVersion, "id": id, "ok": true, "result": result])
}

private func writeFailure(id: String, failure: HelperFailure) {
  writeJSON([
    "v": protocolVersion,
    "id": id,
    "ok": false,
    "error": [
      "code": failure.code.rawValue,
      "message": failure.message,
      "retryable": failure.retryable,
    ],
  ])
}

private func writeCatalogJSON(_ object: [String: Any]) throws {
  guard JSONSerialization.isValidJSONObject(object) else {
    throw HelperFailure(.internalError, "Could not encode personal emoticon catalog")
  }
  var data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  data.append(0x0a)
  defer { data.resetBytes(in: 0..<data.count) }
  guard data.count <= maximumCatalogFieldBytes * 9 + 512 else {
    throw HelperFailure(.unsupportedWechatVersion, "Personal emoticon metadata exceeded its limit")
  }

  try data.withUnsafeBytes { bytes in
    guard let base = bytes.baseAddress else { return }
    var offset = 0
    while offset < bytes.count {
      let count = Darwin.write(4, base.advanced(by: offset), bytes.count - offset)
      if count < 0 && errno == EINTR { continue }
      guard count > 0 else {
        throw HelperFailure(.internalError, "Personal emoticon catalog pipe failed")
      }
      offset += count
    }
  }
}

private func sqliteMessage(_ database: OpaquePointer?) -> String {
  guard let database = database, let message = sqlite3_errmsg(database) else {
    return "SQLite error"
  }
  return String(cString: message)
}

private func execute(_ database: OpaquePointer?, _ sql: String) throws {
  var rawError: UnsafeMutablePointer<CChar>?
  let status = sqlite3_exec(database, sql, nil, nil, &rawError)
  if status != SQLITE_OK {
    sqlite3_free(rawError)
    throw HelperFailure(.keyValidationFailed, "Encrypted database validation failed")
  }
}

private func querySingleText(_ database: OpaquePointer?, _ sql: String) throws -> String {
  var statement: OpaquePointer?
  guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
    throw HelperFailure(.keyValidationFailed, "Encrypted database validation failed")
  }
  defer { sqlite3_finalize(statement) }
  guard sqlite3_step(statement) == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else {
    throw HelperFailure(.keyValidationFailed, "Encrypted database validation failed")
  }
  return String(cString: text)
}

private func querySingleInt(_ database: OpaquePointer?, _ sql: String) throws -> Int64 {
  var statement: OpaquePointer?
  guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
    throw HelperFailure(.keyValidationFailed, "Encrypted database validation failed")
  }
  defer { sqlite3_finalize(statement) }
  guard sqlite3_step(statement) == SQLITE_ROW else {
    throw HelperFailure(.keyValidationFailed, "Encrypted database validation failed")
  }
  return sqlite3_column_int64(statement, 0)
}

private func isHexKey(_ value: String) -> Bool {
  guard value.utf8.count == 64 else { return false }
  return value.utf8.allSatisfy { byte in
    (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)
  }
}

private func applyRawKey(_ database: OpaquePointer?, keyHex: String) throws {
  guard isHexKey(keyHex) else {
    throw HelperFailure(.keyFormatInvalid, "The database key must be exactly 64 hexadecimal characters")
  }

  // SQLCipher raw-key semantics require the ASCII blob literal, not 32 binary bytes passed directly
  // to sqlite3_key(). Keep this short-lived buffer off argv/env and wipe it after sqlite3_key returns.
  var literal = Array("x'\(keyHex.lowercased())'".utf8)
  defer {
    for index in literal.indices { literal[index] = 0 }
  }
  let status = literal.withUnsafeBytes { bytes in
    sqlite3_key(database, bytes.baseAddress, Int32(bytes.count))
  }
  guard status == SQLITE_OK else {
    throw HelperFailure(.keyValidationFailed, "Encrypted database validation failed")
  }
}

private func applyRawKey(_ database: OpaquePointer?, keyBytes: [UInt8]) throws {
  guard keyBytes.count == 32 else {
    throw HelperFailure(.keyFormatInvalid, "The database key must be exactly 32 bytes")
  }
  let hex = Array("0123456789abcdef".utf8)
  var literal = [UInt8](repeating: 0, count: 67)
  literal[0] = Character("x").asciiValue!
  literal[1] = Character("'").asciiValue!
  for (index, byte) in keyBytes.enumerated() {
    literal[2 + index * 2] = hex[Int(byte >> 4)]
    literal[3 + index * 2] = hex[Int(byte & 0x0f)]
  }
  literal[66] = Character("'").asciiValue!
  defer { for index in literal.indices { literal[index] = 0 } }
  let status = literal.withUnsafeBytes { bytes in
    sqlite3_key(database, bytes.baseAddress, Int32(bytes.count))
  }
  guard status == SQLITE_OK else {
    throw HelperFailure(.keyValidationFailed, "Encrypted database validation failed")
  }
}

private func assertRegularFileWithoutSymlink(_ path: String) throws {
  guard path.hasPrefix("/") else {
    throw HelperFailure(.invalidRequest, "databasePath must be absolute")
  }

  var details = stat()
  let result = path.withCString { lstat($0, &details) }
  if result != 0 {
    if errno == ENOENT {
      throw HelperFailure(.databaseNotFound, "Database snapshot was not found")
    }
    if errno == EACCES || errno == EPERM {
      throw HelperFailure(.permissionDenied, "Database snapshot is not readable")
    }
    throw HelperFailure(.internalError, "Could not inspect database snapshot")
  }
  if (details.st_mode & S_IFMT) == S_IFLNK || (details.st_mode & S_IFMT) != S_IFREG {
    throw HelperFailure(.invalidRequest, "databasePath must be a regular file and not a symbolic link")
  }
}

private func openDatabase(path: String, flags: Int32) throws -> OpaquePointer {
  var database: OpaquePointer?
  let status = sqlite3_open_v2(path, &database, flags, nil)
  guard status == SQLITE_OK, let database = database else {
    let failure: HelperFailure
    if status == SQLITE_CANTOPEN {
      failure = HelperFailure(.permissionDenied, "Database snapshot could not be opened read-only")
    } else {
      failure = HelperFailure(.internalError, "Database open failed")
    }
    if database != nil { sqlite3_close_v2(database) }
    throw failure
  }
  return database
}

private func withValidatedDatabase<T>(
  path: String,
  applyKey: (OpaquePointer?) throws -> Void,
  _ body: (_ database: OpaquePointer?, _ schemaObjects: Int64) throws -> T
) throws -> T {
  try assertRegularFileWithoutSymlink(path)
  let database = try openDatabase(path: path, flags: SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX)
  defer { sqlite3_close_v2(database) }

  try applyKey(database)
  try execute(database, "PRAGMA query_only=ON; PRAGMA temp_store=MEMORY;")

  var integrity: OpaquePointer?
  guard sqlite3_prepare_v2(database, "PRAGMA cipher_integrity_check;", -1, &integrity, nil) == SQLITE_OK else {
    throw HelperFailure(.keyValidationFailed, "Database HMAC validation could not start")
  }
  defer { sqlite3_finalize(integrity) }
  let integrityStatus = sqlite3_step(integrity)
  guard integrityStatus == SQLITE_DONE else {
    throw HelperFailure(.keyValidationFailed, "Database HMAC validation failed")
  }

  let schemaObjects = try querySingleInt(database, "SELECT count(*) FROM sqlite_schema;")
  let quickCheck = try querySingleText(database, "PRAGMA quick_check;")
  guard quickCheck == "ok" else {
    throw HelperFailure(.keyValidationFailed, "Database quick check failed")
  }
  return try body(database, schemaObjects)
}

private func validateDatabase(
  path: String,
  applyKey: (OpaquePointer?) throws -> Void
) throws -> Int64 {
  try withValidatedDatabase(path: path, applyKey: applyKey) { _, schemaObjects in
    schemaObjects
  }
}

private func validateDatabase(path: String, keyHex: String) throws -> Int64 {
  try validateDatabase(path: path) { database in
    try applyRawKey(database, keyHex: keyHex)
  }
}

private func validateDatabase(path: String, keyBytes: [UInt8]) throws -> Int64 {
  try validateDatabase(path: path) { database in
    try applyRawKey(database, keyBytes: keyBytes)
  }
}

private func quoteIdentifier(_ name: String) -> String {
  "\"" + name.replacingOccurrences(of: "\"", with: "\"\"") + "\""
}

private func tableColumns(_ database: OpaquePointer?, name: String) throws -> [[String: Any]] {
  var statement: OpaquePointer?
  guard sqlite3_prepare_v2(
    database,
    "PRAGMA table_info(\(quoteIdentifier(name)));",
    -1, &statement, nil
  ) == SQLITE_OK else {
    throw HelperFailure(.keyValidationFailed, "Encrypted database validation failed")
  }
  defer { sqlite3_finalize(statement) }
  var columns: [[String: Any]] = []
  while sqlite3_step(statement) == SQLITE_ROW {
    guard let columnName = sqlite3_column_text(statement, 1) else { continue }
    let columnType = sqlite3_column_text(statement, 2).map { String(cString: $0) } ?? ""
    columns.append([
      "name": String(cString: columnName),
      "type": columnType,
      "notNull": sqlite3_column_int(statement, 3) != 0,
      "primaryKey": sqlite3_column_int(statement, 5) != 0,
    ])
  }
  return columns
}

private func schemaOverviewOf(_ database: OpaquePointer?) throws -> [String: Any] {
  // Sanitized by construction: only object names, column names/types, and aggregate row counts.
  // Row content never crosses this boundary.
  var objects: [(name: String, kind: String)] = []
  var statement: OpaquePointer?
  guard sqlite3_prepare_v2(
    database,
    "SELECT name, type FROM sqlite_schema"
      + " WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    -1, &statement, nil
  ) == SQLITE_OK else {
    throw HelperFailure(.keyValidationFailed, "Encrypted database validation failed")
  }
  defer { sqlite3_finalize(statement) }
  while sqlite3_step(statement) == SQLITE_ROW {
    guard let name = sqlite3_column_text(statement, 0),
          let kind = sqlite3_column_text(statement, 1)
    else { continue }
    objects.append((String(cString: name), String(cString: kind)))
  }

  var tables: [[String: Any]] = []
  var views: [[String: Any]] = []
  for object in objects {
    let columns = try tableColumns(database, name: object.name)
    if object.kind == "table" {
      let rowCount = try querySingleInt(
        database,
        "SELECT count(*) FROM \(quoteIdentifier(object.name));"
      )
      tables.append(["name": object.name, "rowCount": rowCount, "columns": columns])
    } else {
      views.append(["name": object.name, "columns": columns.map { $0["name"] ?? "" }])
    }
  }
  let indexCount = try querySingleInt(database, "SELECT count(*) FROM sqlite_schema WHERE type='index';")
  let triggerCount = try querySingleInt(database, "SELECT count(*) FROM sqlite_schema WHERE type='trigger';")
  return [
    "tableCount": tables.count,
    "viewCount": views.count,
    "indexCount": indexCount,
    "triggerCount": triggerCount,
    "tables": tables,
    "views": views,
  ]
}

private func boundedColumnText(_ statement: OpaquePointer?, _ index: Int32) throws -> String {
  guard sqlite3_column_type(statement, index) != SQLITE_NULL else { return "" }
  let count = Int(sqlite3_column_bytes(statement, index))
  guard count >= 0, count <= maximumCatalogFieldBytes,
        let text = sqlite3_column_text(statement, index)
  else {
    throw HelperFailure(.unsupportedWechatVersion, "Personal emoticon metadata exceeded its limit")
  }
  return String(decoding: UnsafeBufferPointer(start: text, count: count), as: UTF8.self)
}

private func isMD5(_ value: String) -> Bool {
  value.utf8.count == 32 && value.utf8.allSatisfy { byte in
    (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)
  }
}

private func streamPersonalEmoticonGroup(
  _ database: OpaquePointer?,
  orderTable: String,
  group: String,
  seen: inout Set<String>,
  order: inout Int
) throws -> Int {
  let nonStoreTable = quoteIdentifier("kNonStoreEmoticonTable")
  let sql = "SELECT e.type,e.md5,e.caption,e.thumb_url,e.tp_url,e.cdn_url,"
    + "e.extern_url,e.encrypt_url,e.aes_key,e.auth_key "
    + "FROM \(quoteIdentifier(orderTable)) AS o "
    + "JOIN \(nonStoreTable) AS e "
    + "ON lower(e.md5)=lower(o.md5) ORDER BY o.rowid;"
  var statement: OpaquePointer?
  guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
    throw HelperFailure(.unsupportedWechatVersion, "Personal emoticon schema is unsupported")
  }
  defer { sqlite3_finalize(statement) }

  var count = 0
  while true {
    let status = sqlite3_step(statement)
    if status == SQLITE_DONE { break }
    guard status == SQLITE_ROW else {
      throw HelperFailure(.keyValidationFailed, "Encrypted database query failed")
    }
    let md5 = try boundedColumnText(statement, 1).lowercased()
    guard isMD5(md5) else {
      throw HelperFailure(.unsupportedWechatVersion, "Personal emoticon identifier is unsupported")
    }
    if seen.contains(md5) { continue }
    guard order < maximumCatalogRecords else {
      throw HelperFailure(.unsupportedWechatVersion, "Personal emoticon catalog exceeded its limit")
    }
    seen.insert(md5)
    let record: [String: Any] = [
      "order": order,
      "group": group,
      "type": Int(sqlite3_column_int64(statement, 0)),
      "md5": md5,
      "caption": try boundedColumnText(statement, 2),
      "thumbUrl": try boundedColumnText(statement, 3),
      "tpUrl": try boundedColumnText(statement, 4),
      "cdnUrl": try boundedColumnText(statement, 5),
      "externUrl": try boundedColumnText(statement, 6),
      "encryptUrl": try boundedColumnText(statement, 7),
      "aesKey": try boundedColumnText(statement, 8),
      "authKey": try boundedColumnText(statement, 9),
    ]
    try writeCatalogJSON(record)
    order += 1
    count += 1
  }
  return count
}

private func streamPersonalEmoticons(_ database: OpaquePointer?) throws -> [String: Any] {
  var seen = Set<String>()
  var order = 0
  let favoriteCount = try streamPersonalEmoticonGroup(
    database,
    orderTable: "kFavEmoticonOrderTable",
    group: "favorite",
    seen: &seen,
    order: &order
  )
  let customCount = try streamPersonalEmoticonGroup(
    database,
    orderTable: "kCustomEmoticonOrderTable",
    group: "custom",
    seen: &seen,
    order: &order
  )
  return [
    "recordCount": order,
    "favoriteCount": favoriteCount,
    "customCount": customCount,
  ]
}

private func nonNegativeBoundedInt(_ statement: OpaquePointer?, _ index: Int32) throws -> Int64 {
  let value = sqlite3_column_int64(statement, index)
  // Keep values exactly representable after JSON crosses into JavaScript.
  guard value >= 0, value <= 9_007_199_254_740_991 else {
    throw HelperFailure(.unsupportedWechatVersion, "Store emoticon range is unsupported")
  }
  return value
}

private func streamStoreEmoticons(_ database: OpaquePointer?) throws -> [String: Any] {
  // Store packs are held in PersistStore container files. Only the identifiers and byte ranges
  // needed to address those containers cross fd 4; package descriptions and URLs stay in SQLite.
  let sql = "SELECT p.package_id_,p.download_status_,p.remove_time_,"
    + "f.md5_,f.type_,f.sort_order_,f.emoticon_size_,f.emoticon_offset_,"
    + "f.thumb_size_,f.thumb_offset_,"
    + "EXISTS(SELECT 1 FROM kNonStoreEmoticonTable AS n "
    + "WHERE lower(n.md5)=lower(f.md5_) AND length(n.encrypt_url)>0 AND length(n.aes_key)>0),"
    + "EXISTS(SELECT 1 FROM kNonStoreEmoticonTable AS n "
    + "WHERE lower(n.md5)=lower(f.md5_) AND (length(n.thumb_url)>0 OR length(n.tp_url)>0 "
    + "OR length(n.cdn_url)>0 OR length(n.extern_url)>0 OR length(n.encrypt_url)>0)) "
    + "FROM kStoreEmoticonPackageTable AS p "
    + "JOIN kStoreEmoticonFilesTable AS f ON p.package_id_=f.package_id_ "
    + "ORDER BY p.sort_order_,p.rowid,f.sort_order_,f.rowid;"
  var statement: OpaquePointer?
  guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
    throw HelperFailure(.unsupportedWechatVersion, "Store emoticon schema is unsupported")
  }
  defer { sqlite3_finalize(statement) }

  var order = 0
  var packages = Set<String>()
  while true {
    let status = sqlite3_step(statement)
    if status == SQLITE_DONE { break }
    guard status == SQLITE_ROW else {
      throw HelperFailure(.keyValidationFailed, "Encrypted database query failed")
    }
    guard order < maximumCatalogRecords else {
      throw HelperFailure(.unsupportedWechatVersion, "Store emoticon catalog exceeded its limit")
    }
    let packageId = try boundedColumnText(statement, 0)
    let md5 = try boundedColumnText(statement, 3).lowercased()
    guard !packageId.isEmpty, isMD5(md5) else {
      throw HelperFailure(.unsupportedWechatVersion, "Store emoticon identifier is unsupported")
    }
    let record: [String: Any] = [
      "order": order,
      "packageId": packageId,
      "downloadStatus": Int(sqlite3_column_int64(statement, 1)),
      "removeTime": try nonNegativeBoundedInt(statement, 2),
      "md5": md5,
      "type": Int(sqlite3_column_int64(statement, 4)),
      "sortOrder": Int(sqlite3_column_int64(statement, 5)),
      "emoticonSize": try nonNegativeBoundedInt(statement, 6),
      "emoticonOffset": try nonNegativeBoundedInt(statement, 7),
      "thumbSize": try nonNegativeBoundedInt(statement, 8),
      "thumbOffset": try nonNegativeBoundedInt(statement, 9),
      "hasEncryptedRemote": sqlite3_column_int(statement, 10) != 0,
      "hasAnyRemote": sqlite3_column_int(statement, 11) != 0,
    ]
    try writeCatalogJSON(record)
    packages.insert(packageId)
    order += 1
  }
  return ["recordCount": order, "packageCount": packages.count]
}

private func readCandidateFrame(databasePath: String) throws -> [UInt8] {
  var frame = [UInt8](repeating: 0, count: candidateFrameBytes)
  defer { for index in frame.indices { frame[index] = 0 } }
  defer { close(3) }
  let totalBytes = frame.count
  var offset = 0
  while offset < totalBytes {
    let count = frame.withUnsafeMutableBytes { bytes in
      read(3, bytes.baseAddress!.advanced(by: offset), totalBytes - offset)
    }
    if count < 0 && errno == EINTR { continue }
    guard count > 0 else {
      throw HelperFailure(.keyAcquisitionFailed, "Candidate key pipe closed before a complete frame")
    }
    offset += count
  }

  guard frame[0] == 0x43, frame[1] == 0x4d, frame[2] == 0x4b, frame[3] == 0x31,
        frame[4] == 1, frame[5] == 1, frame[6] == 0, frame[7] == 0
  else {
    throw HelperFailure(.keyFormatInvalid, "Candidate key frame was invalid")
  }

  let databaseDescriptor = databasePath.withCString { open($0, O_RDONLY | O_NOFOLLOW) }
  guard databaseDescriptor >= 0 else {
    throw HelperFailure(.databaseNotFound, "Database snapshot was not found")
  }
  defer { close(databaseDescriptor) }
  var databaseSalt = [UInt8](repeating: 0, count: 16)
  defer { for index in databaseSalt.indices { databaseSalt[index] = 0 } }
  let saltBytes = databaseSalt.withUnsafeMutableBytes { bytes in
    pread(databaseDescriptor, bytes.baseAddress, bytes.count, 0)
  }
  guard saltBytes == databaseSalt.count,
        databaseSalt.elementsEqual(frame[8..<24])
  else {
    throw HelperFailure(.keyValidationFailed, "Candidate key did not match the target database")
  }
  return Array(frame[24..<56])
}

private func randomHexKey() throws -> String {
  var bytes = [UInt8](repeating: 0, count: 32)
  guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
    throw HelperFailure(.internalError, "Secure random generation failed")
  }
  defer { for index in bytes.indices { bytes[index] = 0 } }
  return bytes.map { String(format: "%02x", $0) }.joined()
}

private func createEncryptedFixture(path: String, keyHex: String, wal: Bool) throws -> OpaquePointer {
  let database = try openDatabase(
    path: path,
    flags: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
  )
  do {
    try applyRawKey(database, keyHex: keyHex)
    try execute(database, "PRAGMA cipher_page_size=4096;")
    if wal { try execute(database, "PRAGMA journal_mode=WAL;") }
    try execute(database, "CREATE TABLE fixture_marker(id INTEGER PRIMARY KEY, value TEXT NOT NULL);")
    try execute(database, "INSERT INTO fixture_marker(value) VALUES('synthetic-only');")
    return database
  } catch {
    sqlite3_close_v2(database)
    throw error
  }
}

private func runSelfTest() throws -> [String: Any] {
  let fileManager = FileManager.default
  let directory = fileManager.temporaryDirectory
    .appendingPathComponent("cn-memes-wechat4-helper-\(UUID().uuidString)", isDirectory: true)
  try fileManager.createDirectory(
    at: directory,
    withIntermediateDirectories: false,
    attributes: [.posixPermissions: 0o700]
  )
  defer { try? fileManager.removeItem(at: directory) }

  let keyHex = try randomHexKey()
  let wrongKeyHex = String(repeating: keyHex.hasPrefix("0") ? "1" : "0", count: 64)
  let fixture = directory.appendingPathComponent("fixture.db").path
  let writer = try createEncryptedFixture(path: fixture, keyHex: keyHex, wal: false)
  sqlite3_close_v2(writer)
  chmod(fixture, 0o600)

  let correctKey = (try validateDatabase(path: fixture, keyHex: keyHex)) > 0
  var wrongKeyRejected = false
  do {
    _ = try validateDatabase(path: fixture, keyHex: wrongKeyHex)
  } catch let failure as HelperFailure {
    wrongKeyRejected = failure.code == .keyValidationFailed
  }

  let tampered = directory.appendingPathComponent("tampered.db")
  try fileManager.copyItem(atPath: fixture, toPath: tampered.path)
  let handle = try FileHandle(forUpdating: tampered)
  try handle.seek(toOffset: 128)
  let original = try handle.read(upToCount: 1) ?? Data()
  guard original.count == 1 else {
    try handle.close()
    throw HelperFailure(.internalError, "Synthetic tamper test could not read a page byte")
  }
  try handle.seek(toOffset: 128)
  try handle.write(contentsOf: Data([original[0] ^ 0xff]))
  try handle.close()
  var tamperRejected = false
  do {
    _ = try validateDatabase(path: tampered.path, keyHex: keyHex)
  } catch let failure as HelperFailure {
    tamperRejected = failure.code == .keyValidationFailed
  }

  let walFixture = directory.appendingPathComponent("wal-fixture.db").path
  let walWriter = try createEncryptedFixture(path: walFixture, keyHex: keyHex, wal: true)
  let walPresent = fileManager.fileExists(atPath: "\(walFixture)-wal")
  let walSnapshot = (try validateDatabase(path: walFixture, keyHex: keyHex)) > 0
  sqlite3_close_v2(walWriter)

  guard correctKey, wrongKeyRejected, tamperRejected, walPresent, walSnapshot else {
    throw HelperFailure(.internalError, "SQLCipher synthetic self-test failed")
  }
  return [
    "correctKeyValidated": correctKey,
    "wrongKeyRejected": wrongKeyRejected,
    "tamperRejected": tamperRejected,
    "walSnapshotValidated": walSnapshot,
  ]
}

private func cipherVersion() -> String {
  guard let database = try? openDatabase(path: ":memory:", flags: SQLITE_OPEN_READWRITE) else {
    return "unavailable"
  }
  defer { sqlite3_close_v2(database) }
  return (try? querySingleText(database, "PRAGMA cipher_version;")) ?? "unavailable"
}

private func handle(_ request: Request) throws -> [String: Any] {
  guard request.v == protocolVersion, !request.id.isEmpty, request.id.utf8.count <= 128 else {
    throw HelperFailure(.invalidRequest, "Unsupported protocol version or request id")
  }
  switch request.method {
  case "probe":
    return [
      "architecture": architecture(),
      "minimumMacOS": "13.0",
      "sqlcipherVersion": cipherVersion(),
      "keyAcquisition": "unavailable",
      "capabilities": [
        "selfTest", "validateKey", "validateCandidateFd", "schemaOverviewFd",
        "personalEmoticonsFd", "storeEmoticonsFd",
      ],
    ]
  case "selfTest":
    return try runSelfTest()
  case "validateKey":
    guard let path = request.params?["databasePath"],
          let keyHex = request.params?["keyHex"]
    else {
      throw HelperFailure(.invalidRequest, "validateKey requires databasePath and keyHex")
    }
    let schemaObjects = try validateDatabase(path: path, keyHex: keyHex)
    return ["verified": true, "schemaObjectCount": schemaObjects]
  case "validateCandidateFd":
    guard let path = request.params?["databasePath"] else {
      throw HelperFailure(.invalidRequest, "validateCandidateFd requires databasePath")
    }
    var keyBytes = try readCandidateFrame(databasePath: path)
    defer { for index in keyBytes.indices { keyBytes[index] = 0 } }
    _ = try validateDatabase(path: path, keyBytes: keyBytes)
    return [
      "verified": true,
      "formatValidated": true,
      "cipherIntegrityValidated": true,
      "schemaQueryValidated": true,
      "quickCheckValidated": true,
    ]
  case "schemaOverviewFd":
    guard let path = request.params?["databasePath"] else {
      throw HelperFailure(.invalidRequest, "schemaOverviewFd requires databasePath")
    }
    var overviewKeyBytes = try readCandidateFrame(databasePath: path)
    defer { for index in overviewKeyBytes.indices { overviewKeyBytes[index] = 0 } }
    let overview = try withValidatedDatabase(
      path: path,
      applyKey: { database in
        try applyRawKey(database, keyBytes: overviewKeyBytes)
      }
    ) { database, _ in
      try schemaOverviewOf(database)
    }
    return [
      "verified": true,
      "formatValidated": true,
      "cipherIntegrityValidated": true,
      "schemaQueryValidated": true,
      "quickCheckValidated": true,
      "overview": overview,
    ]
  case "personalEmoticonsFd":
    guard let path = request.params?["databasePath"] else {
      throw HelperFailure(.invalidRequest, "personalEmoticonsFd requires databasePath")
    }
    var catalogKeyBytes = try readCandidateFrame(databasePath: path)
    defer { for index in catalogKeyBytes.indices { catalogKeyBytes[index] = 0 } }
    defer { close(4) }
    let counts = try withValidatedDatabase(
      path: path,
      applyKey: { database in
        try applyRawKey(database, keyBytes: catalogKeyBytes)
      }
    ) { database, _ in
      try streamPersonalEmoticons(database)
    }
    return [
      "verified": true,
      "formatValidated": true,
      "cipherIntegrityValidated": true,
      "schemaQueryValidated": true,
      "quickCheckValidated": true,
      "recordCount": counts["recordCount"] ?? 0,
      "favoriteCount": counts["favoriteCount"] ?? 0,
      "customCount": counts["customCount"] ?? 0,
    ]
  case "storeEmoticonsFd":
    guard let path = request.params?["databasePath"] else {
      throw HelperFailure(.invalidRequest, "storeEmoticonsFd requires databasePath")
    }
    var storeCatalogKeyBytes = try readCandidateFrame(databasePath: path)
    defer { for index in storeCatalogKeyBytes.indices { storeCatalogKeyBytes[index] = 0 } }
    defer { close(4) }
    let counts = try withValidatedDatabase(
      path: path,
      applyKey: { database in
        try applyRawKey(database, keyBytes: storeCatalogKeyBytes)
      }
    ) { database, _ in
      try streamStoreEmoticons(database)
    }
    return [
      "verified": true,
      "formatValidated": true,
      "cipherIntegrityValidated": true,
      "schemaQueryValidated": true,
      "quickCheckValidated": true,
      "recordCount": counts["recordCount"] ?? 0,
      "packageCount": counts["packageCount"] ?? 0,
    ]
  case "acquireKey":
    throw HelperFailure(
      .keyAcquisitionFailed,
      "No validated non-invasive key acquisition method is available",
      retryable: false
    )
  default:
    throw HelperFailure(.invalidRequest, "Unknown helper method")
  }
}

private var fatalExitCode: Int32 = 0
signal(SIGPIPE, SIG_IGN)
while let line = readLine(strippingNewline: true) {
  if line.utf8.count > maximumLineBytes {
    writeFailure(
      id: "unknown",
      failure: HelperFailure(.invalidRequest, "JSONL request exceeds the 64 KiB limit")
    )
    fatalExitCode = 2
    break
  }
  do {
    let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
    do {
      writeSuccess(id: request.id, result: try handle(request))
    } catch let failure as HelperFailure {
      writeFailure(id: request.id, failure: failure)
    } catch {
      writeFailure(id: request.id, failure: HelperFailure(.internalError, "Internal helper error"))
    }
  } catch {
    writeFailure(id: "unknown", failure: HelperFailure(.invalidRequest, "Invalid JSONL request"))
    fatalExitCode = 2
    break
  }
}
exit(fatalExitCode)
