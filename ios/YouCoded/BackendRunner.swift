import Foundation
import NodeMobile

/// Starts the desktop backend inside this app and reports when it is ready.
///
/// WHY in-process (the one big difference from Android): Android starts `node` as a separate program
/// (BackendService.kt). iOS does not let an app start programs at all, so Node runs as a library on its own thread
/// (nodejs-mobile's `node_start`). Three consequences this file handles:
///   1. Node can be started ONCE per app launch. There is no "restart the backend": if it stops, the screen says
///      to reopen the app (RootViewController's failed state).
///   2. Node's console is this process's own stdout/stderr, so those are pointed at a pipe that is copied to
///      `backend.log` and watched for the backend's "ready" line.
///   3. The owner token and the secrets key are handed over on stdin (one JSON line), exactly as on Android — the
///      backend already reads them that way (headless-main.ts) and keeps them out of its environment.
final class BackendRunner {
    enum State: Equatable {
        case starting
        case ready(port: Int, token: String)
        case failed(String)
    }

    static let shared = BackendRunner()

    /// Called on the main thread whenever the state changes.
    var onState: ((State) -> Void)?
    private(set) var state: State = .starting

    private var started = false
    private var token = ""
    private var port = 0
    private var logHandle: FileHandle?
    private var timedOut = false
    /// Long enough for a cold first launch on an old phone (the JIT-less engine parses ~12 MB of JavaScript);
    /// short enough that a backend that will never answer does not leave the loading screen up for good.
    private let readyTimeout: TimeInterval = 90

    /// `hostPort` / `hostToken`: the app's own socket the backend calls back on (HostSocketServer).
    func start(hostPort: UInt16, hostToken: String) {
        guard !started else { return }
        started = true
        AppPaths.ensureDirectories()

        // ios-boot.js loads the real bundle (ios-main.js) inside a try: see ios/runtime/build-backend.mjs.
        let entry = AppPaths.backendDir.appendingPathComponent("dist/main/headless/ios-boot.js")
        guard FileManager.default.fileExists(atPath: entry.path) else {
            setState(.failed("The app is missing its assistant files. Reinstalling YouCoded should fix this."))
            return
        }
        guard let secretKey = SecretKeyStore.backendKeyHex() else {
            setState(.failed("The iPhone's Keychain did not answer, so saved sign-ins cannot be protected. Restart the phone and open YouCoded again."))
            return
        }
        guard let freePort = Self.freeLoopbackPort() else {
            setState(.failed("The app could not open a local connection for the assistant."))
            return
        }
        port = freePort
        token = SecretKeyStore.randomTokenHex()

        rotateLog()
        guard redirectConsole() else {
            setState(.failed("The app could not open the assistant's log."))
            return
        }
        // `keyStore` names what protects the key; YouCoded Mesh starts only when a real secret store holds it.
        guard handSecretsOnStdin(["token": token, "key": secretKey, "keyStore": "ios_keychain"]) else {
            setState(.failed("The app could not hand the assistant its keys."))
            return
        }

        let env: [String: String] = [
            "HOME": AppPaths.home.path,
            "TMPDIR": AppPaths.tmp.path,
            "YOUCODED_USER_DATA": AppPaths.userData.path,
            "YOUCODED_HEADLESS_PORT": String(port),
            "YOUCODED_SECRETS_ON_STDIN": "1",
            "YOUCODED_APP_VERSION": AppPaths.appVersion,
            "YOUCODED_HOST_SOCKET": "tcp:\(hostPort)",
            "YOUCODED_HOST_TOKEN": hostToken,
            "YOUCODED_HOST_OS": "ios",
            // The backend shares this app's process: it must never call exit (ios-compat.ts installInProcessGuards).
            "YOUCODED_IN_PROCESS": "1",
            "YOUCODED_DEVICE_NAME": Self.deviceName(),
            // Nothing on an iPhone can update a bundled program; the App Store updates the whole app.
            "DISABLE_AUTOUPDATER": "1",
        ]
        for (key, value) in env { setenv(key, value, 1) }
        FileManager.default.changeCurrentDirectoryPath(AppPaths.home.path)

        let thread = Thread { [entryPath = entry.path] in
            Self.runNode(arguments: ["node", entryPath])
            // node_start returning means the backend's event loop ended; nothing can restart it in this launch.
            DispatchQueue.main.async {
                if case .failed = BackendRunner.shared.state { return }
                BackendRunner.shared.setState(.failed("The assistant stopped. Close YouCoded and open it again."))
            }
        }
        thread.name = "youcoded-node"
        // Node's main thread expects a deep stack; a secondary thread's default (512 KB) overflows while loading.
        thread.stackSize = 4 * 1024 * 1024
        thread.qualityOfService = .userInitiated
        thread.start()

        DispatchQueue.main.asyncAfter(deadline: .now() + readyTimeout) { [weak self] in
            guard let self, case .starting = self.state else { return }
            self.timedOut = true
            self.setState(.failed("The assistant did not start. Close YouCoded and open it again."))
        }
    }

    /// The last lines of the backend's log, for the failed screen's details.
    func logTail(maxBytes: Int = 4000) -> String {
        guard let data = try? Data(contentsOf: AppPaths.backendLog) else { return "" }
        let tail = data.suffix(maxBytes)
        return String(decoding: tail, as: UTF8.self)
    }

    // MARK: - Node

    /// `node_start` wants C strings laid out in ONE block of memory, argv pointing into it (libuv reads past
    /// argv[0] to find the others), so the arguments are packed by hand.
    private static func runNode(arguments: [String]) {
        let total = arguments.reduce(0) { $0 + $1.utf8.count + 1 }
        let buffer = UnsafeMutablePointer<CChar>.allocate(capacity: total)
        buffer.initialize(repeating: 0, count: total)
        var argv: [UnsafeMutablePointer<CChar>?] = []
        var cursor = buffer
        for argument in arguments {
            let bytes = Array(argument.utf8CString) // includes the trailing NUL
            bytes.withUnsafeBufferPointer { cursor.update(from: $0.baseAddress!, count: bytes.count) }
            argv.append(cursor)
            cursor += bytes.count
        }
        argv.append(nil)
        argv.withUnsafeMutableBufferPointer { pointer in
            _ = node_start(Int32(arguments.count), pointer.baseAddress)
        }
        buffer.deallocate()
    }

    // MARK: - Console and stdin

    private func rotateLog() {
        let fm = FileManager.default
        let path = AppPaths.backendLog.path
        if let size = (try? fm.attributesOfItem(atPath: path))?[.size] as? NSNumber, size.intValue > 2_000_000 {
            let old = AppPaths.backendLog.deletingLastPathComponent().appendingPathComponent("backend.1.log")
            try? fm.removeItem(at: old)
            try? fm.moveItem(at: AppPaths.backendLog, to: old)
        }
        if !fm.fileExists(atPath: path) { fm.createFile(atPath: path, contents: nil) }
        logHandle = try? FileHandle(forWritingTo: AppPaths.backendLog)
        _ = try? logHandle?.seekToEnd()
        let stamp = ISO8601DateFormatter().string(from: Date())
        try? logHandle?.write(contentsOf: Data("\n--- YouCoded \(AppPaths.appVersion) (\(AppPaths.buildNumber)) started \(stamp) ---\n".utf8))
    }

    /// Point stdout and stderr at a pipe, and copy what arrives to the log while watching for the ready line.
    private func redirectConsole() -> Bool {
        var fds: [Int32] = [0, 0]
        guard pipe(&fds) == 0 else { return false }
        let readEnd = fds[0], writeEnd = fds[1]
        // Unbuffered, or Node's lines would sit in a C buffer and "ready" would arrive late or never.
        setvbuf(stdout, nil, _IONBF, 0)
        setvbuf(stderr, nil, _IONBF, 0)
        guard dup2(writeEnd, STDOUT_FILENO) >= 0, dup2(writeEnd, STDERR_FILENO) >= 0 else { return false }
        close(writeEnd)

        let reader = Thread { [weak self] in
            var pending = Data()
            var chunk = [UInt8](repeating: 0, count: 16 * 1024)
            while true {
                let count = read(readEnd, &chunk, chunk.count)
                if count <= 0 { break }
                let data = Data(chunk[0..<count])
                // `try?`: a full disk must cost a log line, not the app (the non-throwing write raises an exception).
                try? self?.logHandle?.write(contentsOf: data)
                pending.append(data)
                while let newline = pending.firstIndex(of: 0x0A) {
                    let line = String(decoding: pending[pending.startIndex..<newline], as: UTF8.self)
                    pending.removeSubrange(pending.startIndex...newline)
                    self?.handleConsoleLine(line)
                }
                // A runaway line with no newline must not grow without limit.
                if pending.count > 1_000_000 { pending.removeAll() }
            }
        }
        reader.name = "youcoded-node-console"
        reader.start()
        return true
    }

    private func handleConsoleLine(_ line: String) {
        // WHY nothing is logged from here (found in the first simulator runs): this process's stderr IS the pipe
        // being read, and the system log echoes to stderr under Xcode — so logging a line here fed it straight back
        // in, each copy longer than the last, until the log file was megabytes of one line. backend.log is the record.
        if line.hasPrefix("YOUCODED_HEADLESS_READY") {
            DispatchQueue.main.async { self.setState(.ready(port: self.port, token: self.token)) }
        } else if line.hasPrefix("YOUCODED_HEADLESS_EXIT") {
            // ios-compat.ts prints this instead of exiting: an exit would end the whole app without a word.
            DispatchQueue.main.async {
                self.setState(.failed("The assistant stopped. Close YouCoded and open it again."))
            }
        }
    }

    private func handSecretsOnStdin(_ secrets: [String: String]) -> Bool {
        guard let json = try? JSONSerialization.data(withJSONObject: secrets) else { return false }
        var fds: [Int32] = [0, 0]
        guard pipe(&fds) == 0 else { return false }
        let line = json + Data([0x0A])
        let written = line.withUnsafeBytes { write(fds[1], $0.baseAddress, line.count) }
        close(fds[1])
        guard written == line.count, dup2(fds[0], STDIN_FILENO) >= 0 else { return false }
        close(fds[0])
        return true
    }

    // MARK: - Helpers

    private func setState(_ next: State) {
        dispatchPrecondition(condition: .onQueue(.main))
        // "failed" is final for this launch, with one exception: a slow first start that only LOOKED failed (the
        // wait ran out) and then became ready is ready — the screen comes back to the app.
        if case .failed = state {
            guard timedOut, case .ready = next else { return }
            timedOut = false
        }
        state = next
        onState?(next)
    }

    /// Ask the system for a free port on the loopback address. (A tiny window exists between closing this socket
    /// and Node binding the port; the per-run token makes a squatter useless, and a clash shows the failed screen.)
    private static func freeLoopbackPort() -> Int? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { return nil }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard named == 0 else { return nil }
        return Int(UInt16(bigEndian: addr.sin_port))
    }

    /// The name other devices see for this phone. iOS 16+ only tells an app "iPhone" (the person's own device name
    /// needs a special permission from Apple), so the model word is what there is.
    private static func deviceName() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafePointer(to: &info.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }.hasPrefix("iPad") ? "iPad" : "iPhone"
    }
}
