import UIKit

/// The loading screen: the app's name and a quiet spinner while the assistant starts. (Android: BrandLoading.kt.)
final class BrandLoadingView: UIView {
    private let spinner = UIActivityIndicatorView(style: .medium)

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemBackground

        let title = UILabel()
        title.text = "YouCoded"
        title.font = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: .systemFont(ofSize: 34, weight: .semibold))
        title.adjustsFontForContentSizeCategory = true
        title.textColor = .label

        let status = UILabel()
        status.text = "Starting your assistant…"
        status.font = .preferredFont(forTextStyle: .subheadline)
        status.adjustsFontForContentSizeCategory = true
        status.textColor = .secondaryLabel

        spinner.startAnimating()

        let stack = UIStackView(arrangedSubviews: [title, status, spinner])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.setCustomSpacing(20, after: status)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: layoutMarginsGuide.trailingAnchor),
        ])
        accessibilityIdentifier = "loading"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func stop() { spinner.stopAnimating() }
}

/// Shown when the assistant cannot run. Says what happened in plain words and what to do; the technical log is
/// one tap away for a bug report, never in the person's face.
///
/// WHY there is no "Try again" button (Android has one): on Android the assistant is a separate program the app can
/// start again. On an iPhone it runs inside the app and can be started once per launch, so the honest instruction
/// is to close and reopen the app.
final class FailedView: UIView {
    private let details: () -> String
    private let detailsText = UITextView()
    private var detailsButton: UIButton!

    init(message: String, details: @escaping () -> String) {
        self.details = details
        super.init(frame: .zero)
        backgroundColor = .systemBackground
        accessibilityIdentifier = "failed"

        let title = UILabel()
        title.text = "YouCoded couldn’t start"
        title.font = .preferredFont(forTextStyle: .title2)
        title.adjustsFontForContentSizeCategory = true
        title.numberOfLines = 0
        title.textAlignment = .center

        let body = UILabel()
        body.text = message
        body.font = .preferredFont(forTextStyle: .body)
        body.adjustsFontForContentSizeCategory = true
        body.textColor = .secondaryLabel
        body.numberOfLines = 0
        body.textAlignment = .center

        var config = UIButton.Configuration.plain()
        config.title = "Show details"
        detailsButton = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in self?.toggleDetails() })

        var copyConfig = UIButton.Configuration.gray()
        copyConfig.title = "Copy details"
        let copy = UIButton(configuration: copyConfig, primaryAction: UIAction { [weak self] _ in
            UIPasteboard.general.string = self?.details()
        })

        detailsText.isEditable = false
        detailsText.isHidden = true
        detailsText.font = UIFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        detailsText.backgroundColor = .secondarySystemBackground
        detailsText.layer.cornerRadius = 8
        detailsText.heightAnchor.constraint(equalToConstant: 220).isActive = true

        let buttons = UIStackView(arrangedSubviews: [detailsButton, copy])
        buttons.axis = .horizontal
        buttons.spacing = 12

        let stack = UIStackView(arrangedSubviews: [title, body, buttons, detailsText])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor, constant: -8),
            detailsText.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    private func toggleDetails() {
        detailsText.isHidden.toggle()
        if !detailsText.isHidden { detailsText.text = details() }
        detailsButton.configuration?.title = detailsText.isHidden ? "Show details" : "Hide details"
    }
}
