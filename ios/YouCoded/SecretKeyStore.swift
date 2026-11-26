import Foundation
import Security

/// Small values the app keeps in the iPhone's Keychain.
///
/// WHY the Keychain: the backend seals saved API keys and sign-in tokens with one 32-byte key
/// (desktop/src/main/headless/electron-headless.ts, `safeStorage`). On Android that key lives in the Android
/// Keystore; the Keychain is the iPhone's equivalent — encrypted by the phone, readable only by this app, and (with
/// the "this device only" class used here) never copied to another device or into an iCloud backup.
enum SecretKeyStore {
    private static let service = "com.youcoded.app.secrets"
    private static let backendKeyAccount = "backend-secret-key"
    private static let pairedDevicesAccount = "paired-devices"

    /// The backend's sealing key as 64 hex characters, created on first use.
    static func backendKeyHex() -> String? {
        if let data = read(backendKeyAccount), data.count == 32 { return hex(data) }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        let data = Data(bytes)
        guard write(backendKeyAccount, data) else { return nil }
        return hex(data)
    }

    /// The saved computers, as the JSON array text the page reads (`[{name, host, port, password}]`).
    static func pairedDevicesJSON() -> String {
        guard let data = read(pairedDevicesAccount), let text = String(data: data, encoding: .utf8) else { return "[]" }
        return text
    }

    @discardableResult
    static func setPairedDevicesJSON(_ json: String) -> Bool {
        write(pairedDevicesAccount, Data(json.utf8))
    }

    static func randomTokenHex(bytes count: Int = 32) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        // SecRandomCopyBytes failing means the phone's random source is broken; refuse to run on a guessable token.
        precondition(status == errSecSuccess, "No secure random bytes available")
        return hex(Data(bytes))
    }

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    private static func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func read(_ account: String) -> Data? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    private static func write(_ account: String, _ data: Data) -> Bool {
        let query = baseQuery(account)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var add = query
        add[kSecValueData as String] = data
        // AfterFirstUnlock: readable while the phone is locked once it has been unlocked since boot (a reply still
        // finishing in the background needs its key). ThisDeviceOnly: never synced or restored onto another phone.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
}
