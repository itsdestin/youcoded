import AVFoundation
import UIKit

/// The camera screen for pairing with a computer: reads one QR code and hands back its text.
/// (Android: QrScannerOverlay.kt.) `done(nil)` when the person closes it or the camera is not allowed.
final class QrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let done: (String?) -> Void
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.youcoded.qr-session")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var finished = false
    private let message = UILabel()

    init(done: @escaping (String?) -> Void) {
        self.done = done
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        message.textColor = .white
        message.font = .preferredFont(forTextStyle: .body)
        message.adjustsFontForContentSizeCategory = true
        message.numberOfLines = 0
        message.textAlignment = .center
        message.text = "Point the camera at the code on your computer."
        message.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(message)

        var closeConfig = UIButton.Configuration.filled()
        closeConfig.title = "Cancel"
        closeConfig.cornerStyle = .capsule
        closeConfig.baseBackgroundColor = UIColor.white.withAlphaComponent(0.22)
        closeConfig.baseForegroundColor = .white
        let close = UIButton(configuration: closeConfig, primaryAction: UIAction { [weak self] _ in self?.finish(nil) })
        close.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(close)

        NSLayoutConstraint.activate([
            message.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            message.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            message.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            close.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            close.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            close.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])

        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                if granted { self.startCamera() } else {
                    self.message.text = "YouCoded is not allowed to use the camera. Turn it on in Settings › YouCoded, or type the computer's address instead."
                }
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        sessionQueue.async { if self.session.isRunning { self.session.stopRunning() } }
        // Swiped away rather than tapped Cancel: still answer, or the page waits for the scan forever.
        finish(nil, dismissing: false)
    }

    private func startCamera() {
        // The person may have cancelled while iOS was still asking about the camera: nothing to start then.
        guard !finished else { return }
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            message.text = "This device has no camera YouCoded can use. Type the computer's address instead."
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        previewLayer = layer
        sessionQueue.async { self.session.startRunning() }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
              let text = code.stringValue, !text.isEmpty else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        finish(text)
    }

    private func finish(_ text: String?, dismissing: Bool = true) {
        guard !finished else { return }
        finished = true
        done(text)
        if dismissing { dismiss(animated: true) }
    }
}
