import CSQLCipher
import Darwin
import Foundation

private struct Request: Decodable {
  let databasePath: String
  let keyHex: String?
  let mode: String?
}

private func isHexKey(_ value: String) -> Bool {
  value.utf8.count == 64 && value.utf8.allSatisfy { byte in
    (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)
  }
}

private func applyRawKey(_ database: OpaquePointer?, keyHex: String) throws {
  guard isHexKey(keyHex) else { throw NSError(domain: "FixtureMaker", code: 2) }
  var literal = Array("x'\(keyHex.lowercased())'".utf8)
  defer { for index in literal.indices { literal[index] = 0 } }
  let status = literal.withUnsafeBytes { bytes in
    sqlite3_key(database, bytes.baseAddress, Int32(bytes.count))
  }
  guard status == SQLITE_OK else { throw NSError(domain: "FixtureMaker", code: 3) }
}

private func applySyntheticInstrumentationPassword(_ database: OpaquePointer?) throws {
  // Clearly synthetic test-only bytes, created directly as the short-lived wipeable buffer.
  var password: [UInt8] = [
    0x63, 0x6e, 0x2d, 0x6d, 0x65, 0x6d, 0x65, 0x73, 0x2d, 0x73, 0x79,
    0x6e, 0x74, 0x68, 0x65, 0x74, 0x69, 0x63, 0x2d, 0x69, 0x6e, 0x73,
    0x74, 0x72, 0x75, 0x6d, 0x65, 0x6e, 0x74, 0x61, 0x74, 0x69, 0x6f,
    0x6e, 0x2d, 0x70, 0x61, 0x73, 0x73, 0x77, 0x6f, 0x72, 0x64,
  ]
  defer { for index in password.indices { password[index] = 0 } }
  let status = password.withUnsafeBytes { bytes in
    sqlite3_key(database, bytes.baseAddress, Int32(bytes.count))
  }
  guard status == SQLITE_OK else { throw NSError(domain: "FixtureMaker", code: 5) }
}

private func execute(_ database: OpaquePointer?, _ sql: String) throws {
  var rawError: UnsafeMutablePointer<CChar>?
  let status = sqlite3_exec(database, sql, nil, nil, &rawError)
  sqlite3_free(rawError)
  guard status == SQLITE_OK else { throw NSError(domain: "FixtureMaker", code: 4) }
}

private func safeTemporaryOutput(_ path: String) -> String? {
  let requested = URL(fileURLWithPath: path).standardizedFileURL
  let filename = requested.lastPathComponent
  guard filename.hasSuffix(".db") else { return nil }
  var resolvedParent = [CChar](repeating: 0, count: Int(PATH_MAX))
  var resolvedTemporary = [CChar](repeating: 0, count: Int(PATH_MAX))
  let requestedParent = requested.deletingLastPathComponent().path
  guard requestedParent.withCString({ realpath($0, &resolvedParent) }) != nil,
        NSTemporaryDirectory().withCString({ realpath($0, &resolvedTemporary) }) != nil
  else { return nil }
  let parent = String(cString: resolvedParent)
  let temporary = String(cString: resolvedTemporary)
  guard parent.hasPrefix(temporary + "/") else { return nil }
  let output = URL(fileURLWithPath: parent).appendingPathComponent(filename).path
  var parentDetails = stat()
  guard parent.withCString({ lstat($0, &parentDetails) }) == 0 else { return nil }
  guard (parentDetails.st_mode & S_IFMT) == S_IFDIR,
        (parentDetails.st_mode & 0o077) == 0,
        parentDetails.st_uid == geteuid()
  else { return nil }
  return output
}

private func respond(_ success: Bool, errorCode: Int? = nil) {
  let result: String
  if success {
    result = "{\"ok\":true}\n"
  } else {
    result = "{\"ok\":false,\"code\":\(errorCode ?? 0)}\n"
  }
  FileHandle.standardOutput.write(Data(result.utf8))
}

private func removeFixtureFiles(_ path: String) {
  for suffix in ["", "-journal", "-wal", "-shm"] {
    _ = (path + suffix).withCString { unlink($0) }
  }
}

var databaseHandle: OpaquePointer?
var reservation: Int32 = -1
var createdOutput: String?
do {
  guard let line = readLine(strippingNewline: true), line.utf8.count <= 4_096 else {
    throw NSError(domain: "FixtureMaker", code: 1)
  }
  let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
  guard let output = safeTemporaryOutput(request.databasePath) else {
    throw NSError(domain: "FixtureMaker", code: 2)
  }
  reservation = output.withCString {
    open($0, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
  }
  guard reservation >= 0 else { throw NSError(domain: "FixtureMaker", code: 30) }
  createdOutput = output

  var reservedDetails = stat()
  guard fstat(reservation, &reservedDetails) == 0,
        (reservedDetails.st_mode & S_IFMT) == S_IFREG,
        reservedDetails.st_nlink == 1,
        reservedDetails.st_uid == geteuid(),
        fchmod(reservation, S_IRUSR | S_IWUSR) == 0
  else { throw NSError(domain: "FixtureMaker", code: 31) }

  let openStatus = sqlite3_open_v2(
    output,
    &databaseHandle,
    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX | SQLITE_OPEN_NOFOLLOW,
    nil
  )
  guard openStatus == SQLITE_OK, let database = databaseHandle else {
    let extendedStatus = databaseHandle.map { sqlite3_extended_errcode($0) } ?? openStatus
    throw NSError(domain: "FixtureMaker", code: 3_200 + Int(extendedStatus))
  }

  var linkedDetails = stat()
  guard output.withCString({ lstat($0, &linkedDetails) }) == 0,
        (linkedDetails.st_mode & S_IFMT) == S_IFREG,
        linkedDetails.st_nlink == 1,
        linkedDetails.st_dev == reservedDetails.st_dev,
        linkedDetails.st_ino == reservedDetails.st_ino
  else { throw NSError(domain: "FixtureMaker", code: 33) }

  guard close(reservation) == 0 else { throw NSError(domain: "FixtureMaker", code: 34) }
  reservation = -1
  switch request.mode ?? "raw-key" {
  case "raw-key":
    guard let keyHex = request.keyHex else { throw NSError(domain: "FixtureMaker", code: 2) }
    try applyRawKey(database, keyHex: keyHex)
  case "synthetic-instrumentation":
    guard request.keyHex == nil else { throw NSError(domain: "FixtureMaker", code: 2) }
    try applySyntheticInstrumentationPassword(database)
    // Pin the test KDF to the same public parameters used by SyntheticHost. SQLCipher owns and
    // clears its internal derived-key state when the database handle is closed; this process does
    // not export or retain a second derived-key buffer.
    try execute(database, "PRAGMA cipher_compatibility=4;")
    try execute(database, "PRAGMA kdf_iter=256000;")
    try execute(database, "PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512;")
    try execute(database, "PRAGMA cipher_hmac_algorithm=HMAC_SHA512;")
  default:
    throw NSError(domain: "FixtureMaker", code: 2)
  }
  try execute(database, "PRAGMA cipher_page_size=4096;")
  try execute(database, "CREATE TABLE fixture_marker(id INTEGER PRIMARY KEY, value TEXT NOT NULL);")
  try execute(database, "INSERT INTO fixture_marker(value) VALUES('synthetic-pipe-test');")
  if request.mode ?? "raw-key" == "raw-key" {
    // Additional objects exercise the schema-overview branches (second table, index, view).
    // The instrumentation mode keeps its minimal single-table shape.
    try execute(
      database,
      "CREATE TABLE fixture_second(id INTEGER PRIMARY KEY, label TEXT, score INTEGER);"
    )
    try execute(database, "CREATE INDEX fixture_second_label_idx ON fixture_second(label);")
    try execute(database, "CREATE VIEW fixture_view AS SELECT id, label FROM fixture_second;")
    try execute(
      database,
      "INSERT INTO fixture_second(label, score) VALUES('synthetic-overview-a', 1),"
        + "('synthetic-overview-b', 2);"
    )
    try execute(
      database,
      "CREATE TABLE kNonStoreEmoticonTable("
        + "type INTEGER,md5 TEXT,caption TEXT,thumb_url TEXT,tp_url TEXT,cdn_url TEXT,"
        + "extern_url TEXT,encrypt_url TEXT,aes_key TEXT,auth_key TEXT);"
    )
    try execute(database, "CREATE TABLE kFavEmoticonOrderTable(md5 TEXT);")
    try execute(database, "CREATE TABLE kCustomEmoticonOrderTable(md5 TEXT);")
    try execute(
      database,
      "CREATE TABLE kStoreEmoticonPackageTable("
        + "package_id_ TEXT,download_status_ INTEGER,remove_time_ INTEGER,sort_order_ INTEGER);"
    )
    try execute(
      database,
      "CREATE TABLE kStoreEmoticonFilesTable("
        + "package_id_ TEXT,md5_ TEXT,type_ INTEGER,sort_order_ INTEGER,"
        + "emoticon_size_ INTEGER,emoticon_offset_ INTEGER,"
        + "thumb_size_ INTEGER,thumb_offset_ INTEGER);"
    )
    try execute(
      database,
      "INSERT INTO kNonStoreEmoticonTable VALUES"
        + "(1,'00000000000000000000000000000001','synthetic-caption-one',"
        + "'https://synthetic.invalid/thumb-one','','https://synthetic.invalid/cdn-one',"
        + "'','','','synthetic-auth-one'),"
        + "(2,'00000000000000000000000000000002','synthetic-caption-two',"
        + "'','','','','https://synthetic.invalid/encrypted-two',"
        + "'00112233445566778899aabbccddeeff','synthetic-auth-two'),"
        + "(3,'00000000000000000000000000000003','synthetic-caption-three',"
        + "'','https://synthetic.invalid/tp-three','','','','','');"
    )
    try execute(
      database,
      "INSERT INTO kFavEmoticonOrderTable(md5) VALUES"
        + "('00000000000000000000000000000002'),"
        + "('00000000000000000000000000000001');"
    )
    try execute(
      database,
      "INSERT INTO kCustomEmoticonOrderTable(md5) VALUES"
        + "('00000000000000000000000000000001'),"
        + "('00000000000000000000000000000003');"
    )
    try execute(
      database,
      "INSERT INTO kStoreEmoticonPackageTable VALUES"
        + "('10000000000000000000000000000001',2,0,4),"
        + "('10000000000000000000000000000002',2,0,5);"
    )
    try execute(
      database,
      "INSERT INTO kStoreEmoticonFilesTable VALUES"
        + "('10000000000000000000000000000001','20000000000000000000000000000001',1,1,20,10,8,30),"
        + "('10000000000000000000000000000001','20000000000000000000000000000002',2,2,40,38,6,78),"
        + "('10000000000000000000000000000002','20000000000000000000000000000003',1,1,12,4,5,16);"
    )
  }
  guard sqlite3_close_v2(database) == SQLITE_OK else {
    throw NSError(domain: "FixtureMaker", code: 4)
  }
  databaseHandle = nil
  createdOutput = nil
  respond(true)
} catch {
  if let database = databaseHandle {
    sqlite3_close_v2(database)
    databaseHandle = nil
  }
  if reservation >= 0 {
    close(reservation)
    reservation = -1
  }
  if let output = createdOutput { removeFixtureFiles(output) }
  respond(false, errorCode: (error as NSError).code)
  exit(2)
}
