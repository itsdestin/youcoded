import Foundation
import Network

/// The backend's line to the app: what only the phone can do (open a link, keep awake, notify, show status).
///
/// The same protocol as Android's HostSocketServer.kt — one JSON object per line, `{id, method, params}` in,
/// `{id, result}` or `{id, error}` out, and `{event, params}` pushed by the app — over a loopback TCP port instead
/// of a Linux abstract socket (iOS has none; see desktop/src/main/headless/host-bridge.ts for why not a socket file).
/// Any app on the phone can reach a loopback port, so a connection must open with `{hello: <token>}`; one that
/// does not is dropped.
final class HostSocketServer {
    typealias Reply = (Result<Any?, Error>) -> Void
    /// Called on the main queue for each backend request.
    var handler: ((_ method: String, _ params: [String: Any], _ reply: @escaping Reply) -> Void)?

    private let token: String
    private let queue = DispatchQueue(label: "com.youcoded.host-socket")
    private var listener: NWListener?
    private var clients: [ObjectIdentifier: Client] = [:]

    private final class Client {
        let connection: NWConnection
        var buffer = Data()
        var authenticated = false
        init(_ connection: NWConnection) { self.connection = connection }
    }

    struct HostError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    init(token: String) {
        self.token = token
    }

    /// Starts listening on 127.0.0.1 and returns the port, or nil when the phone refused.
    func start() -> UInt16? {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
        parameters.allowLocalEndpointReuse = true
        guard let listener = try? NWListener(using: parameters) else { return nil }
        self.listener = listener

        let ready = DispatchSemaphore(value: 0)
        var port: UInt16?
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                port = listener.port?.rawValue
                ready.signal()
            case .failed, .cancelled:
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
        // Binding a loopback port takes milliseconds; the wait only guards against a listener that never reports.
        _ = ready.wait(timeout: .now() + 5)
        return port
    }

    /// Push an event to the backend (for example `foreground`, `{on: true}`).
    func emit(event: String, params: [String: Any]) {
        queue.async {
            for client in self.clients.values where client.authenticated {
                self.send(["event": event, "params": params], to: client)
            }
        }
    }

    // MARK: - Connections

    private func accept(_ connection: NWConnection) {
        let client = Client(connection)
        clients[ObjectIdentifier(client)] = client
        connection.stateUpdateHandler = { [weak self, weak client] state in
            guard let self, let client else { return }
            switch state {
            case .failed, .cancelled:
                self.clients.removeValue(forKey: ObjectIdentifier(client))
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive(client)
    }

    private func receive(_ client: Client) {
        client.connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self, weak client] data, _, isComplete, error in
            guard let self, let client else { return }
            if let data, !data.isEmpty {
                client.buffer.append(data)
                // A line this long is not something the backend sends; stop reading rather than hold it.
                if client.buffer.count > 4_000_000 { client.connection.cancel(); return }
                while let newline = client.buffer.firstIndex(of: 0x0A) {
                    let line = client.buffer[client.buffer.startIndex..<newline]
                    client.buffer.removeSubrange(client.buffer.startIndex...newline)
                    self.handleLine(Data(line), from: client)
                }
            }
            if isComplete || error != nil {
                client.connection.cancel()
                return
            }
            self.receive(client)
        }
    }

    private func handleLine(_ line: Data, from client: Client) {
        guard !line.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }

        if !client.authenticated {
            let hello = object["hello"] as? String ?? ""
            // Constant-time: a neighbouring app must learn nothing from how fast a wrong token is refused.
            if Self.constantTimeEquals(hello, token) {
                client.authenticated = true
            } else {
                client.connection.cancel()
            }
            return
        }

        guard let method = object["method"] as? String else { return }
        let id = object["id"]
        let params = object["params"] as? [String: Any] ?? [:]
        DispatchQueue.main.async { [weak self, weak client] in
            let reply: Reply = { result in
                guard let self, let client, let id else { return }
                self.queue.async {
                    switch result {
                    case .success(let value):
                        self.send(["id": id, "result": value ?? NSNull()], to: client)
                    case .failure(let error):
                        self.send(["id": id, "error": error.localizedDescription], to: client)
                    }
                }
            }
            guard let handler = self?.handler else {
                reply(.failure(HostError(message: "The phone has no '\(method)'.")))
                return
            }
            handler(method, params, reply)
        }
    }

    private func send(_ object: [String: Any], to client: Client) {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object) else { return }
        data.append(0x0A)
        client.connection.send(content: data, completion: .contentProcessed { _ in })
    }

    static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count, !x.isEmpty else { return false }
        var difference: UInt8 = 0
        for index in 0..<x.count { difference |= x[index] ^ y[index] }
        return difference == 0
    }
}
