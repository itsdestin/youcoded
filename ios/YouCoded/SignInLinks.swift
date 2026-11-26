import Foundation

/// Sign-in pages worth keeping inside the app (they open in an in-app browser page, so YouCoded stays in front and
/// can close the page when the sign-in finishes). Other links go to the person's browser.
/// The same list as Android's SignInReturn.isSignInLink, for the same sign-in flows. Unit tested.
enum SignInLinks {
    static func isSignInLink(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        let host = (components.host ?? "").lowercased()
        let path = components.percentEncodedPath
        let query = components.percentEncodedQuery ?? ""
        let known = ["claude.ai", "claude.com", "anthropic.com", "openai.com", "chatgpt.com"]
        if known.contains(where: { host == $0 || host.hasSuffix("." + $0) }),
           query.split(separator: "&").contains(where: { $0.hasPrefix("redirect_uri=") }) || path.contains("oauth") {
            return true
        }
        // OpenRouter's sign-in page (callback_url comes back to the phone's own loopback address).
        if (host == "openrouter.ai" || host.hasSuffix(".openrouter.ai")) && path.hasPrefix("/auth") { return true }
        // GitHub's "enter your code" page, used by the GitHub connect.
        if host == "github.com" && path.hasPrefix("/login/device") { return true }
        // The YouCoded account sign-in.
        return host == "api.youcoded.ai" && path.hasPrefix("/auth/")
    }
}
