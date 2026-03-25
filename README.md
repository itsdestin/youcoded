# DestinCode

**Claude Code on Android.** A native Android app that runs [Claude Code](https://github.com/anthropics/claude-code) on your phone with a touch-optimized chat and terminal interface.

> **Disclaimer:** DestinCode is an independent, community-built project. It is **not affiliated with, endorsed by, or officially supported by Anthropic.** "Claude" and "Claude Code" are trademarks of Anthropic, PBC.
>
> That said — huge thanks to the Anthropic team for building Claude Code. This project exists because of their work, and we're grateful for the incredible tool they've created.

---

## What is DestinCode?

DestinCode brings Claude Code — Anthropic's agentic coding tool — to Android. It bundles a Termux runtime, Node.js, and Claude Code into a single app with a native chat UI, full terminal emulator, and multi-session support.

You bring your own Anthropic API key. DestinCode handles everything else — bootstrapping the runtime, managing sessions, rendering tool use, and handling permissions — all on-device.

## Features

**Chat Interface**
- Structured message rendering with user bubbles, Claude responses, and tool cards
- Tool cards with Running, Awaiting Approval, Complete, and Failed states
- Markdown rendering with syntax highlighting
- Image attachment support, URL detection, quick action chips
- Activity indicators during Claude processing

**Terminal & Shell**
- Full terminal emulator via Termux with raw PTY access
- Terminal keyboard row (Ctrl, Esc, Tab, arrows)
- Permission mode cycling (Normal, Auto-Accept, Bypass, Plan Mode)
- Direct bash shell mode — independent from Claude Code

**Multi-Session**
- Up to 5 concurrent Claude Code sessions
- Color-coded status indicators (Active, Idle, Awaiting Approval, Dead)
- Per-session working directory selection
- Auto-titling from Claude Code session files

**Theming**
- Dark and Light themes
- Material You (Dynamic Color) support on Android 12+
- Cascadia Mono font throughout

**Architecture**
- 3-layer SELinux bypass routing binary execution through `/system/bin/linker64`
- Unix socket event bridge for structured hook events
- Bootstrap system with SHA256-verified Termux package extraction
- Foreground service keeps sessions alive in background

## Requirements

- Android 9+ (API 28) on arm64 devices
- An [Anthropic API key](https://console.anthropic.com/)
- ~100 MB of storage (35 MB APK + ~60 MB extracted runtime)

## Installation

### From GitHub Releases

1. Download the latest APK from the [Releases](https://github.com/itsdestin/destincode/releases) page
2. Install on your device (you may need to enable "Install from unknown sources")
3. Open the app and enter your Anthropic API key
4. Select a package tier (Core or Developer) and wait for bootstrap to complete

### Building from Source

```bash
git clone https://github.com/itsdestin/destincode.git
cd destincode
./gradlew assembleDebug
```

The debug APK will be at `app/build/outputs/apk/debug/app-debug.apk`.

For a release build, create a `keystore.properties` file at the project root:

```properties
storeFile=release-keystore.jks
storePassword=your_password
keyAlias=your_alias
keyPassword=your_password
```

Then run `./gradlew assembleRelease`.

## Known Issues

See [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for documented limitations, including:

- `export -f` bash functions invisible to non-bash processes (Go, Rust, Python subprocesses)
- ~20-50ms overhead per `bash -c` invocation from env sourcing
- Missing seccomp sandbox for arm64-android tool execution

## Contributing

Contributions are welcome! Whether it's bug fixes, feature ideas, documentation improvements, or testing on different devices — all help is appreciated.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Submit a pull request

Please note that this project uses a hooks-based architecture for Claude Code integration. See [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for architectural context before diving into the runtime code.

## License

This project is licensed under the **GNU General Public License v3.0** — see [LICENSE](LICENSE) for details.

### Third-Party Licenses

| Library | License | Source |
|---------|---------|--------|
| Termux terminal-emulator | GPLv3 | [termux/termux-app](https://github.com/termux/termux-app) |
| Termux terminal-view | GPLv3 | [termux/termux-app](https://github.com/termux/termux-app) |
| AndroidX / Jetpack Compose | Apache 2.0 | [developer.android.com](https://developer.android.com/jetpack/androidx) |
| Apache Commons Compress | Apache 2.0 | [commons.apache.org](https://commons.apache.org/proper/commons-compress/) |
| CommonMark | BSD 2-Clause | [commonmark/commonmark-java](https://github.com/commonmark/commonmark-java) |
| XZ for Java | Public Domain | [tukaani.org/xz](https://tukaani.org/xz/java.html) |
| Zstd-JNI | BSD | [luben/zstd-jni](https://github.com/luben/zstd-jni) |
| Cascadia Mono | SIL Open Font License | [microsoft/cascadia-code](https://github.com/microsoft/cascadia-code) |
