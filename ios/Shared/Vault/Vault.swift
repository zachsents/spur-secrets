import CryptoKit
import Foundation

/// A device or spur of the vault, as sync lists them.
nonisolated struct Member: Identifiable, Hashable, Sendable {
  let id: String
  let name: String
  let kind: String
  let key: String
  let pending: Bool

  init(device j: JSON) {
    id = j["id"].string ?? j["device"].str
    name = j["name"].str
    kind = j["kind"].str
    key = j["key"].str
    pending = Self.pending(j)
  }

  init(spur j: JSON) {
    id = j["spur"].string ?? j["name"].str
    name = id
    kind = "spur"
    key = j["key"].str
    pending = Self.pending(j)
  }

  private static func pending(_ j: JSON) -> Bool {
    if let approved = j["approved"].bool { return !approved }
    if j["approved"].number != nil { return false }
    let state = j["state"].string ?? j["status"].str
    return ["pending", "waiting", "enrolling"].contains(state)
  }

  var code: String { Crypto.code(of: key) }
}

/// One past version of an item (`history`).
nonisolated struct Version: Identifiable, Hashable, Sendable {
  let id: Int
  let item: Item
}

/// The vault on this device: enrolling, syncing blobs, unlocking with Face ID, and every read and
/// write. The vault key and the items opened with it are only in memory, and only while unlocked.
@MainActor @Observable
final class Vault {
  enum Phase: Equatable { case fresh, waiting, locked, open }

  let core: Core
  private(set) var cache = Cache.load()
  /// Every item, opened: only while unlocked.
  private(set) var items: [Item] = []
  /// What the last sync said went wrong.
  private(set) var problem: String?
  private(set) var syncing = false
  private var keys: Crypto.Keys?
  @ObservationIgnored private var secret: Curve25519.KeyAgreement.PrivateKey?
  @ObservationIgnored private var pendingSync = false
  /// Read every blob again on the next sync.
  @ObservationIgnored private var full = false

  init(core: Core) {
    self.core = core
  }

  var phase: Phase {
    if cache.device.isEmpty { return .fresh }
    if cache.sealed == nil { return .waiting }
    return keys == nil ? .locked : .open
  }

  var devices: [Member] { cache.devices.array.map(Member.init(device:)) }
  var spurs: [Member] { cache.spurs.array.map(Member.init(spur:)) }

  // MARK: Enrolling

  func enroll(name: String) async throws {
    let secret = Curve25519.KeyAgreement.PrivateKey()
    try Keychain.save(secret)
    let key = secret.publicKey.rawRepresentation.base64EncodedString()
    let r = try await core.call("device_enroll", ["name": .string(name), "kind": "iphone", "key": .string(key)])
    var fresh = Cache()
    fresh.device = r["device"].string ?? r["device"]["id"].str
    fresh.key = key
    fresh.code = r["code"].string ?? Crypto.code(of: key)
    guard !fresh.device.isEmpty else { throw Failure(message: "The vault gave no device") }
    cache = fresh
    cache.save()
  }

  /// Leaves the vault on this device: its key, its cache and what AutoFill knew.
  func forget() async {
    lock()
    Keychain.delete()
    cache = Cache()
    cache.save()
    await Identities.clear()
  }

  // MARK: Sync

  /// Everything changed since the last sync: blobs kept, the vault key when it comes, and, while
  /// unlocked, every item opened again.
  func sync() async {
    guard !cache.device.isEmpty else { return }
    if syncing {
      pendingSync = true
      return
    }
    syncing = true
    defer { syncing = false }
    repeat {
      pendingSync = false
      await syncOnce()
    } while pendingSync
  }

  private func syncOnce() async {
    let since = full || cache.sealed == nil || cache.vault.isEmpty ? 0 : cache.seq
    full = false
    let r: JSON
    do {
      r = try await core.call("sync", ["device": .string(cache.device), "since": .number(Double(since))])
      problem = nil
    } catch {
      // Waiting to be approved isn't a problem to show.
      if cache.sealed != nil { problem = error.localizedDescription }
      return
    }
    var next = cache
    next.vault = r["vault"].string ?? next.vault
    let version = Int(r["keyVersion"].number ?? Double(next.keyVersion))
    let moved = version != next.keyVersion
    next.keyVersion = version
    next.seq = Int(r["seq"].number ?? Double(next.seq))
    if case .object = r["key"], !r["key"]["enc"].str.isEmpty {
      next.sealed = Cache.Sealed(enc: r["key"]["enc"].str, ct: r["key"]["ct"].str)
    }
    if since == 0 { next.items = [:] }
    for e in r["items"].array {
      let id = e["id"].str
      if e["deleted"].bool == true || e["blob"].str.isEmpty {
        next.items[id] = nil
      } else {
        next.items[id] = Cache.Entry(seq: Int(e["seq"].number ?? 0), blob: e["blob"].str)
      }
    }
    for key in ["devices", "spurs", "grants"] where !r[key].isNull {
      switch key {
      case "devices": next.devices = r[key]
      case "spurs": next.spurs = r[key]
      default: next.grants = r[key]
      }
    }
    cache = next
    cache.save()
    // The key was rotated: read every blob again under the new version.
    if moved && since > 0 {
      full = true
      pendingSync = true
    }
    if let secret, keys == nil || keys?.version != cache.keyVersion || moved {
      try? open(secret)
    } else if keys != nil {
      openItems()
    }
  }

  // MARK: Unlocking

  /// Face ID, then the vault key opened from its seal.
  func unlock() async throws {
    guard let context = await Auth.confirm("Unlock") else { throw Failure(message: "Not unlocked") }
    let secret = try Keychain.load(context)
    try open(secret)
    self.secret = secret
  }

  private func open(_ secret: Curve25519.KeyAgreement.PrivateKey) throws {
    guard let sealed = cache.sealed else { throw Failure(message: "Not approved yet") }
    let text = try Crypto.open(
      sealed.enc, sealed.ct, with: secret, item: "device:\(cache.device)", use: "vault-key:\(cache.vault):\(cache.keyVersion)")
    guard let raw = Data(base64Encoded: text), raw.count == 32 else { throw Failure(message: "The vault key didn't read") }
    keys = Crypto.Keys(vault: cache.vault, version: cache.keyVersion, raw: raw)
    openItems()
  }

  private func openItems() {
    guard let keys else { return }
    items = cache.items.compactMap { id, entry in
      (try? Crypto.openItem(keys, id: id, blob: entry.blob)).flatMap(Item.from)
    }
    .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    Task { await Identities.replace(items) }
  }

  func lock() {
    keys = nil
    secret = nil
    items = []
  }

  func item(_ id: String) -> Item? { items.first { $0.id == id } }

  // MARK: Writing

  /// Seals the whole item and puts it.
  func put(_ item: Item) async throws {
    guard let keys else { throw Failure(message: "Locked") }
    var item = item
    item.updated = Date().timeIntervalSince1970 * 1000
    let blob = try Crypto.sealItem(keys, id: item.id, json: item.json)
    let r = try await core.call("put", ["device": .string(cache.device), "id": .string(item.id), "blob": .string(blob)])
    cache.items[item.id] = Cache.Entry(seq: Int(r["seq"].number ?? 0), blob: blob)
    cache.save()
    if let at = items.firstIndex(where: { $0.id == item.id }) { items[at] = item } else { items.append(item) }
    await sync()
  }

  /// Every version it was before, newest first.
  func history(_ id: String) async throws -> [Version] {
    guard let keys else { throw Failure(message: "Locked") }
    let r = try await core.call("history", ["device": .string(cache.device), "id": .string(id)])
    let rows = [r["history"], r["versions"], r["blobs"], r].first { !$0.array.isEmpty }?.array ?? []
    return rows.enumerated().compactMap { n, row in
      let blob = row.string ?? row["blob"].str
      guard let json = try? Crypto.openItem(keys, id: id, blob: blob), let item = Item.from(json) else { return nil }
      return Version(id: n, item: item)
    }
    .sorted { $0.item.updated > $1.item.updated }
  }

  /// To the trash, back from it, or gone with its history (which takes a proof).
  func remove(_ id: String, restore: Bool = false, purge: Bool = false) async throws {
    var args: JSON = ["device": .string(cache.device), "id": .string(id)]
    if restore { args = merge(args, ["restore": true]) }
    if purge {
      guard let keys else { throw Failure(message: "Locked") }
      args = merge(args, ["purge": true, "proof": .string(Crypto.prove(keys, Crypto.statement("purge", id)))])
    }
    _ = try await core.call("remove", args)
    await sync()
  }

  // MARK: Devices and spurs

  func approve(_ member: Member) async throws {
    guard let keys else { throw Failure(message: "Locked") }
    if member.kind == "spur" {
      let proof = Crypto.prove(keys, Crypto.statement("approve-spur", member.id, member.key))
      _ = try await core.call("spur_approve", ["device": .string(cache.device), "spur": .string(member.id), "proof": .string(proof)])
    } else {
      let proof = Crypto.prove(keys, Crypto.statement("approve-device", member.id, member.key))
      _ = try await core.call("device_approve", ["device": .string(member.id), "proof": .string(proof)])
    }
    await sync()
  }

  func revoke(_ member: Member) async throws {
    guard let keys else { throw Failure(message: "Locked") }
    let proof = Crypto.prove(keys, Crypto.statement("revoke-device", member.id))
    _ = try await core.call("device_revoke", ["device": .string(member.id), "proof": .string(proof)])
    await sync()
  }

  /// What the user did with a secret here, for the audit: best effort.
  func used(_ item: Item, _ field: String, _ use: String) {
    let args: JSON = ["device": .string(cache.device), "item": .string(item.id), "field": .string(field), "use": .string(use)]
    Task { _ = try? await core.call("used", args) }
  }

  private func merge(_ a: JSON, _ b: JSON) -> JSON {
    .object(a.object.merging(b.object) { _, new in new })
  }
}
