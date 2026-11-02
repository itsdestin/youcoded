# youcoded

**Your personal AI assistant and open source everything app.**

<!-- WHY: screenshots are of the default YouCoded theme, taken with the workspace's shoot tool (practice data, no real accounts). Retake with: node scripts/shoot/shoot.mjs welcome office/spreadsheet 'pages/focus/page-home#site' 'pages/focus/page-money#site' --themes youcoded --width 1440 --height 900 -->
<p align="center">
  <img src="docs/readme/empty-chat.webp" alt="Youcoded's start screen: pick a folder and a model, then start a session" width="49%">
  <img src="docs/readme/spreadsheet.webp" alt="An Excel spreadsheet open in youcoded's built-in Office editor" width="49%">
</p>
<p align="center">
  <img src="docs/readme/home.webp" alt="A Home page showing lights, a thermostat and speakers" width="49%">
  <img src="docs/readme/finance.webp" alt="A Finance page showing net worth, upcoming bills and accounts" width="49%">
</p>
## What is youcoded?

Well.... kind of everything? Youcoded is an AI assistant at its core, but it's also designed from the ground up to become anything you want it to be. Much like Claude Cowork or ChatGPT, youcoded can perform advanced agentic tasks on your computer like managing your files, searching the web, or reading and writing documents. Unlike those proprietary projects, however, youcoded is completely open source, meaning anyone can see the source code and modify it themselves. It is also built to be fully modular, meaning you can add, combine, or reorganize features and app pages as you please. Ask for a new look, a new feature, an app page to manage your smarthome or track your finances, and watch youcoded build it for you (the home and money pages above are tested, fully-functional examples, but not yet built-in - try making your own!). It also runs on whichever AI you choose: Claude or ChatGPT on the plan you already have, hundreds of cheap or expensive models through OpenRouter, or a small free model running offline on your own computer. It will always ask before it acts.

Free and open source for Windows, macOS, Linux and Android, plus any web browser through remote access. iOS/iPadOS in exploration. **[Download at youcoded.ai](https://youcoded.ai)**

## What's inside

- Themes, Pages and skills you create by describing them, and a community marketplace to share them
- Word, Excel and PowerPoint editing, plus a browser the assistant can use with your permission (desktop)
- Sync across devices through your own private GitHub; on Android the assistant runs on the phone itself
- Chess, Connect Four, Flappy and 2048 to play while it works

Every line of youcoded was written through conversation with AI. [Read the story](https://youcoded.ai/#story).

## Help build it

You don't need to code to help. Report bugs and ideas in [Issues](https://github.com/itsdestin/youcoded/issues), share skills and themes from inside the app, or open a pull request (see [CONTRIBUTING.md](./CONTRIBUTING.md)). Feel free to ask your assistant to try taking a crack at your youcoded bug! Report security problems privately through [SECURITY.md](./SECURITY.md).

To build the desktop app:

```bash
git clone https://github.com/itsdestin/youcoded.git
cd youcoded/desktop
npm ci
npm run dev
```

The Android app builds with `./gradlew assembleDebug` on Linux x64; see [Android runtime](docs/android-runtime.md) for what it needs.

## License

Youcoded's own code is **MIT** ([LICENSE](LICENSE), [NOTICE](NOTICE)). Bundled third-party components, including the Android runtime, keep their own licenses; see [Android redistribution](docs/android-redistribution.md). [Privacy Policy](./PRIVACY.md) · [Terms](./TERMS.md)

Youcoded is an independent, community-built project, not affiliated with, endorsed by, or supported by Anthropic, OpenAI or OpenRouter.
