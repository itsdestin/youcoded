import AVFoundation
import Foundation
import Speech

/// Voice typing with the iPhone's own speech recognition, speaking the same events as Android's
/// VoiceRecognizer.kt so the shared message box needs no iPhone branch:
///   {type:"partial", committed, tail} · {type:"level", value 0…1} · {type:"final", text} · {type:"error", message}
///
/// The contract carried over from Android (each rule was a bug there once):
///  - exactly ONE `final` per turn — the message box only returns to normal when it arrives;
///  - on a failure the `final` goes FIRST, then the `error` (the box drops a final that follows an error, which
///    used to throw away words the person had watched appear);
///  - "heard nothing" is a normal final, not an error;
///  - `cancel` emits nothing at all;
///  - a recogniser that never answers a stop is given up on after 20 s, with what was already heard.
/// Main thread only.
final class VoiceRecognizer {
    static let stopDeadline: TimeInterval = 20
    static let stopTimeoutSentence = "Your phone's speech recognition stopped responding. Anything it had already heard is in the box."

    private let emit: ([String: Any]) -> Void
    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var listening = false
    private var finalSent = true
    private var heard = ""
    private var deadline: DispatchWorkItem?
    private var lastLevelSent = Date.distantPast
    /// Counts turns, so a finished turn's late callbacks can be told from the current one's.
    private var turn = 0

    init(emit: @escaping ([String: Any]) -> Void) {
        self.emit = emit
        // The phone's own language first; nil when the phone has no recogniser for it.
        self.recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    }

    /// What the mic button should show before anyone taps it.
    static func readiness() -> [String: Any] {
        let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        guard let recognizer else {
            return ["state": "unavailable", "reason": "This iPhone has no speech recognition for its language."]
        }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .denied:
            return ["state": "unavailable", "reason": "Speech recognition is turned off for YouCoded in the iPhone's Settings."]
        case .restricted:
            return ["state": "unavailable", "reason": "Speech recognition is restricted on this iPhone."]
        default:
            break
        }
        if AVAudioSession.sharedInstance().recordPermission == .denied {
            return ["state": "unavailable", "reason": "Microphone permission was not granted."]
        }
        if !recognizer.isAvailable {
            return ["state": "unavailable", "reason": "Speech recognition is not available right now."]
        }
        return ["state": "ready", "engine": "your phone's speech recognition"]
    }

    /// Ask for the microphone and speech recognition if needed. `done(nil)` means allowed; otherwise the sentence to show.
    static func requestPermissions(_ done: @escaping (String?) -> Void) {
        AVAudioSession.sharedInstance().requestRecordPermission { micGranted in
            guard micGranted else {
                DispatchQueue.main.async { done("Microphone permission was not granted.") }
                return
            }
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    done(status == .authorized ? nil : "Speech recognition permission was not granted.")
                }
            }
        }
    }

    func start() {
        guard !listening else { return }
        guard let recognizer, recognizer.isAvailable else {
            emit(["type": "error", "message": "Speech recognition is not available right now."])
            return
        }
        listening = true
        finalSent = false
        heard = ""

        do {
            let session = AVAudioSession.sharedInstance()
            // No options: `.record` already silences other audio, and `.duckOthers` belongs to the playback
            // categories (asking for it here makes the phone refuse the whole request).
            try session.setCategory(.record, mode: .measurement)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            // Punctuation, as Android's recogniser adds it.
            request.addsPunctuation = true
            self.request = request

            let input = audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            // WHY checked first: during a phone call or while the audio route is changing the microphone reports
            // "0 Hz, 0 channels", and installing a tap with that format raises an exception Swift cannot catch — the
            // app would close. It is reported as "could not be started" instead.
            guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain: "YouCoded.voice", code: 1) }
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                request.append(buffer)
                self?.reportLevel(buffer)
            }
            audioEngine.prepare()
            try audioEngine.start()

            // WHY the turn number: a cancelled turn's recogniser still reports "cancelled" a moment later. If the
            // person has already tapped the mic again, that late report must not be taken for the NEW turn's (it
            // used to end the new turn at once with nothing heard).
            turn += 1
            let thisTurn = turn
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                DispatchQueue.main.async {
                    guard let self, self.turn == thisTurn else { return }
                    self.handle(result: result, error: error)
                }
            }
        } catch {
            // The microphone could not be opened (a phone call in progress, another app holding it).
            stopAudio()
            deliverFinal()
            emit(["type": "error", "message": "The microphone could not be started."])
        }
    }

    /// Stop listening and deliver the words. The `final` is sent when the recogniser reports the outcome, so the
    /// last words spoken are included.
    func stop() {
        guard listening else { return }
        stopAudio()
        request?.endAudio()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.finalSent else { return }
            self.task?.cancel()
            self.deliverFinal()
            self.emit(["type": "error", "message": Self.stopTimeoutSentence])
        }
        deadline = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.stopDeadline, execute: work)
    }

    /// Throw the words away. Emits nothing.
    func cancel() {
        guard listening else { return }
        deadline?.cancel()
        listening = false
        finalSent = true
        heard = ""
        turn += 1 // whatever this turn's recogniser still reports belongs to nobody
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
    }

    func release() {
        cancel()
    }

    // MARK: - Recogniser callbacks

    private func handle(result: SFSpeechRecognitionResult?, error: Error?) {
        guard listening else { return }
        if let result {
            let text = result.bestTranscription.formattedString
            if !text.isEmpty { heard = text }
            if result.isFinal {
                deliverFinal()
                return
            }
            let split = Self.splitAtLastSentenceEnd(heard)
            emit(["type": "partial", "committed": split.committed, "tail": split.tail])
        }
        if let error {
            stopAudio()
            let nsError = error as NSError
            // "No speech detected" (1110) and a cancelled/ended request (203, 216, 301) are what happens when someone
            // taps the mic and says nothing, or stops: a normal final, not an alarming error.
            let quiet = nsError.domain == "kAFAssistantErrorDomain" && [203, 216, 301, 1110].contains(nsError.code)
            deliverFinal()
            if !quiet { emit(["type": "error", "message": "Speech recognition stopped unexpectedly."]) }
        }
    }

    private func deliverFinal() {
        guard !finalSent else { return }
        deadline?.cancel()
        finalSent = true
        listening = false
        stopAudio()
        task = nil
        request = nil
        emit(["type": "final", "text": heard.trimmingCharacters(in: .whitespacesAndNewlines)])
    }

    private func stopAudio() {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Microphone loudness for the ring around the mic button, 0…1, at most ~15 times a second.
    private func reportLevel(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }
        var sum: Float = 0
        for index in 0..<count { sum += channel[index] * channel[index] }
        let rms = (sum / Float(count)).squareRoot()
        // Speech sits around -45…-10 dBFS; map that span onto 0…1.
        let db = 20 * log10(max(rms, 0.000_01))
        let value = min(1, max(0, (db + 50) / 40))
        DispatchQueue.main.async { [weak self] in
            guard let self, self.listening, Date().timeIntervalSince(self.lastLevelSent) > 0.066 else { return }
            self.lastLevelSent = Date()
            self.emit(["type": "level", "value": Double(value)])
        }
    }

    /// Words so far, split into solid text (through the last sentence end) and a grey tail still being revised.
    static func splitAtLastSentenceEnd(_ text: String) -> (committed: String, tail: String) {
        guard let end = text.lastIndex(where: { ".!?".contains($0) }) else { return ("", text) }
        let after = text.index(after: end)
        return (String(text[..<after]), String(text[after...]))
    }
}
