# YouCoded

**Your AI assistant, on your terms.** An open-source, cross-platform agent for Windows, macOS, Linux, and Android — with remote access from any web browser.

> Built entirely without coding experience, using Claude Code itself. Download the app at https://youcoded.ai.

---

## What is YouCoded?

YouCoded is an open-source, multi-model AI assistant that helps you work with files, projects, research, and everyday tasks. Its own permission-based agent can use tools, skills, and specialists; you choose the AI behind it: a local model on your computer, a cloud provider or API key, a ChatGPT plan, or [Claude Code](https://docs.anthropic.com/en/docs/claude-code) as a first-class integration.

It's designed for students, professionals, and anyone who uses AI regularly — not just developers.

**Disclaimer:** YouCoded is an independent, community-built project. It is not affiliated with, endorsed by, or officially supported by Anthropic, OpenAI, or OpenRouter.

## Features

**Chat & Terminal**
- Chat interface with structured message rendering, tool cards, and markdown
- Full terminal emulator for direct shell access
- Multiple concurrent sessions with color-coded status
- Model selector — choose Claude Code, ChatGPT, OpenRouter and compatible cloud providers, or local models
- Folder switcher — quick-access saved directories for session creation
- Permission mode cycling (Normal, Auto-Accept, Plan Mode)

**Documents, Pages & Browser**
- Edit Word (`.docx`), Excel (`.xlsx`) and PowerPoint (`.pptx`) files inside the desktop app, with autosave, version history and PDF export
- Let the assistant add comments to documents and spreadsheets, including files open in the built-in Office editors
- Build personal or project Pages with `/page-builder` and pin them in the header
- Give the assistant a browser on desktop: read pages, click and type, with its own permission cards and a view you can follow
- Office editing and the assistant's browser are desktop-only, not available through remote access

**Social AI**
- Create custom skills and share them with friends, classmates, or coworkers
- Play multiplayer games (Connect Four and chess) while your assistant works
- Build and share custom theme packs with the community

**Skill Marketplace**
- Browse and install community skills and tools from the marketplace
- Create your own prompt skills and share them via deep links
- Quick-launch chips for your most-used skills
- Theme Builder, Marketplace Publisher, Conversation Search and Page Builder are bundled (automatically installed if missing and not removable through the app)

**Commands**
- Browse and search slash commands directly in the command drawer
- Three sources: YouCoded-handled (clickable, dispatched in-app), filesystem-scanned user/project/plugin commands (forwarded to the terminal), and Claude Code built-ins (visible reference, run in Terminal View)

**Themes**
- 6 built-in themes (YouCoded, YouCoded Night, Light, Dark, Midnight, Crème) + community theme packs
- Custom wallpapers, particle effects, mascot characters, and icon overrides
- Build your own themes with `/theme-builder`

**Announcements**
- Maintainer announcements (release notices, status updates) are fetched hourly and shown in the status bar
- Source: [`announcements.txt`](https://github.com/itsdestin/youcoded/blob/master/announcements.txt) in this repo

**Remote Access**
- Access YouCoded from any web browser on your network
- Use it from your phone, tablet, or another computer
- Same full UI — just open a URL
- The Android app permits cleartext WebSocket connections to paired desktop hosts on your LAN or Tailscale network. Use Tailscale (WireGuard encryption) for sensitive traffic — every connection is still gated by a bcrypt password handshake regardless

**Multiplayer Lobby (Privacy Note)**
- The multiplayer game lobby (powered by [PartyKit](https://www.partykit.io/) on Cloudflare Durable Objects) shares your GitHub username and idle/in-game status with other signed-in YouCoded users so they can challenge you
- Toggle **Incognito** in the multiplayer settings to stay hidden — no presence is broadcast in incognito mode

**Personalization**
- Community plugins from the [YouCoded marketplace](https://github.com/itsdestin/wecoded-marketplace) add journaling, a personal encyclopedia, task inbox processing, and text messaging — browse and install them from inside the app
- Cross-device sync is built into the app — no plugin required

## Platforms

| Platform | Status | Install |
|----------|--------|---------|
| Windows | Available | Download `.exe` from [Releases](https://github.com/itsdestin/youcoded/releases) |
| macOS | Available | Download `.dmg` from [Releases](https://github.com/itsdestin/youcoded/releases) |
| Linux | Available | Download `.AppImage`, `.deb`, `.rpm` or `.pacman` from [Releases](https://github.com/itsdestin/youcoded/releases) |
| Android | Available | Download `.apk` from [Releases](https://github.com/itsdestin/youcoded/releases) |
| Web browser | Via remote access | Open the app on any device, then access from any browser on your network |

## Requirements

Choose a model path that works for you:

- A local model you download and run on your computer
- An [OpenRouter](https://openrouter.ai/) account or a supported provider API key
- A ChatGPT plan
- A [Claude Pro or Max plan](https://claude.ai/) for Claude Code

The app itself is free and open source. Android requires Android 9+ (arm64); desktop requires Windows 10+, macOS 11+, or Linux (x64).

## Building from Source

### Desktop (Electron)

```bash
git clone https://github.com/itsdestin/youcoded.git
cd youcoded/desktop
npm ci
npm run dev       # Development mode with hot reload
npm test          # Run tests
npm run build     # Build distributable installer
```

### Android

The Android runtime currently builds on **Linux x64**; on Windows or macOS, use a Linux x64 environment such as WSL or a VM. It needs an Android SDK, JDK 21, Node.js/npm, Bash, Python 3, curl, tar, make, clang and lld. Gradle builds the shared React UI and desktop backend and downloads the pinned runtime programs. See [Android runtime](docs/android-runtime.md) for details and side-by-side development builds.

```bash
git clone https://github.com/itsdestin/youcoded.git
cd youcoded
./gradlew assembleDebug
```

Debug APK at `app/build/outputs/apk/debug/app-debug.apk`.

## Project Structure

```
youcoded/
  desktop/     # Electron app (Windows, macOS, Linux)
  app/         # Android shell, WebView and bundled headless desktop backend
  scripts/     # Shared build scripts
```

## Contributing

Contributions welcome — bug fixes, features, documentation, testing on different devices.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

Commits need a sign-off line (`git commit -s`) — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the how and why.

## Related Projects

- [YouCoded Core](https://github.com/itsdestin/youcoded-core) — Archived legacy plugin; current apps bundle their own safety hooks
- [YouCoded Themes](https://github.com/itsdestin/wecoded-themes) — Community theme registry
- [YouCoded Marketplace](https://github.com/itsdestin/wecoded-marketplace) — Skill marketplace registry

## Policies

- [Privacy Policy](./PRIVACY.md)
- [Terms of Service](./TERMS.md)
- [Security Policy](./SECURITY.md)

## License

YouCoded-authored code, shared UI, scripts and docs are **MIT** unless stated otherwise. See the root [LICENSE](LICENSE) and its scope note in [NOTICE](NOTICE); copies also live at [desktop/LICENSE](desktop/LICENSE) and [app/LICENSE](app/LICENSE).

Bundled third-party components retain their own licenses. Android includes Alpine programs and libraries (including GPL/LGPL components), modified musl, npm packages and Claude Code under separate terms. The release-specific inventory, offline notices and corresponding-source materials must accompany redistribution; the app's MIT license does not replace their requirements. See [Android redistribution](docs/android-redistribution.md) for the fail-closed packaging gate and unresolved review requirements.
