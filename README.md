# YouCoded

**Your AI assistant, on your terms.** An open-source, cross-platform agent for Windows, macOS, Linux, and Android — with remote access from any web browser.

> Built entirely without coding experience, using Claude Code itself.

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

**Social AI**
- Create custom skills and share them with friends, classmates, or coworkers
- Play multiplayer games (Connect Four and chess) while your assistant works
- Build and share custom theme packs with the community

**Skill Marketplace**
- Browse and install community skills and tools from the marketplace
- Create your own prompt skills and share them via deep links
- Quick-launch chips for your most-used skills
- Theme Builder and Marketplace Publisher ship pre-installed (auto-installed on every launch and not removable) so `/theme-builder` and plugin-publishing flows work out of the box

**Commands**
- Browse and search slash commands directly in the command drawer
- Three sources: YouCoded-handled (clickable, dispatched in-app), filesystem-scanned user/project/plugin commands (forwarded to the terminal), and Claude Code built-ins (visible reference, run in Terminal View)

**Themes**
- 4 built-in themes (Light, Dark, Midnight, Creme) + community theme packs
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
- Community plugins from the [WeCoded marketplace](https://github.com/itsdestin/wecoded-marketplace) add journaling, a personal encyclopedia, task inbox processing, and text messaging — browse and install them from inside the app
- Cross-device sync is built into the app — no plugin required

## Platforms

| Platform | Status | Install |
|----------|--------|---------|
| Windows | Available | Download `.exe` from [Releases](https://github.com/itsdestin/youcoded/releases) |
| macOS | Available | Download `.dmg` from [Releases](https://github.com/itsdestin/youcoded/releases) |
| Linux | Available | Download `.AppImage` from [Releases](https://github.com/itsdestin/youcoded/releases) |
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
  app/         # Android app (Kotlin + Jetpack Compose)
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

- [YouCoded Core](https://github.com/itsdestin/youcoded-core) — Legacy bundled plugin (safety hooks + setup skills), currently being phased out
- [YouCoded Themes](https://github.com/itsdestin/wecoded-themes) — Community theme registry
- [YouCoded Marketplace](https://github.com/itsdestin/wecoded-marketplace) — Skill marketplace registry

## Policies

- [Privacy Policy](./PRIVACY.md)
- [Terms of Service](./TERMS.md)
- [Security Policy](./SECURITY.md)

## License

YouCoded is **MIT** — desktop, Android, shared UI, scripts, and docs. See the root [LICENSE](LICENSE); copies also live at [desktop/LICENSE](desktop/LICENSE) and [app/LICENSE](app/LICENSE).

One exception: `terminal-emulator-vendored/` is a vendored copy of Termux's terminal-emulator library (Apache License 2.0, upstream Termux / jackpal). Its [LICENSE](terminal-emulator-vendored/LICENSE) and [NOTICE](terminal-emulator-vendored/NOTICE) stay with it, and Apache 2.0 requires the NOTICE to accompany redistributions of the Android app.
