// Marketplace fixture for the UI Workbench — a SAMPLE of the real registries, not
// the catalogue. Regenerate with the script in the header of
// scripts/ui-review/README.md (youcoded-dev) when card shapes change.
//
// WHY: Marketplace, Library, the plugin detail overlay and the skills drawer all
// rendered EMPTY in the workbench (the mock answered every registry channel with
// []), so none of them could be reviewed in the six themes — the 2026-08-25 UI
// audit had to fall back to a real Electron instance for one theme. Source:
// wecoded-marketplace/index.json + featured.json, wecoded-themes/registry/
// theme-registry.json, sampled 2026-08-25: every featured hero/rail id, two
// plugins per category, one deprecated and one integration-only entry (so the
// context's filter path runs), all seven themes (three marked installed).
//
// Shapes mirror what main returns over IPC today (index entries pass through
// `skills.listMarketplace` unchanged; `theme.marketplace.list` adds `installed`).
/* eslint-disable */
export const MARKETPLACE_PLUGINS = [
  {
    "id": "civic-report",
    "type": "plugin",
    "displayName": "Civic Report",
    "description": "Generate a source-linked report on your federal representatives from your address, personalized by angle/tone/depth.",
    "category": "personal",
    "author": "@destin",
    "tags": [
      "research",
      "personal",
      "ai"
    ],
    "version": "1.0.2",
    "publishedAt": "2026-04-21T00:00:00Z",
    "tagline": "Know your federal reps, tailored to what you care about.",
    "longDescription": "Drop in your address and Claude generates a personalized briefing on every federal official who represents you — President, VP, both U.S. Senators, and your House Rep — with state-level officials included as named stubs. Pick the angle you care about (housing, climate, immigration, foreign policy, or anything you type), choose a tone (neutral, critical, positive, civic, friendly, deep-research), and decide whether you want the full eight-section report per rep or a custom subset.\n\nEvery factual claim in the output is footnoted with a source URL you can click through to verify, and reports are saved to your Encyclopedia by default so you can reread them before voting, calling an office, or writing a letter. The first-time setup runs a one-line interactive prompt to capture an API key for the data source; everything after that is just conversation.",
    "components": {
      "skills": [
        "civic-report"
      ],
      "hooks": [],
      "commands": [
        "civic-report"
      ],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "lifeArea": [
      "personal"
    ],
    "audience": "general"
  },
  {
    "id": "youcoded-encyclopedia",
    "type": "plugin",
    "displayName": "Encyclopedia",
    "description": "Personal knowledge system — journaling, encyclopedia, interviewer, librarian, compiler",
    "category": "personal",
    "author": "@destin",
    "tags": [
      "personal",
      "journal",
      "reference",
      "research"
    ],
    "version": "1.0.1",
    "publishedAt": "2026-04-21T00:00:00Z",
    "tagline": "Your life, written down and searchable.",
    "longDescription": "Your life, written down once and reachable forever. The Encyclopedia bundle is four skills working together: `journaling-assistant` runs a daily check-in that prompts you through the parts of your day worth remembering; `encyclopedia-update` routes new journal content into eight modular source files (people, places, beliefs, goals, work, etc.); `encyclopedia-interviewer` proactively notices gaps and runs targeted interviews to fill them; and `encyclopedia-librarian` produces purpose-built briefings — \"prep me for tomorrow's meeting with X\", \"review my last six months\", \"pull together everything I've said about Y\".\n\nThe whole system is plain markdown stored locally in `~/.claude/encyclopedia/` — you own every word, you can read and edit it in any text editor, and sync it across devices via the YouCoded app's built-in sync (Settings → Sync). Four detail levels (Full, Personal, Professional, Public) let you control how much intimate context appears in any given output, so the same encyclopedia can power both deeply personal reflection and cleanly shareable professional summaries.",
    "components": {
      "skills": [
        "encyclopedia-compile",
        "encyclopedia-interviewer",
        "encyclopedia-librarian",
        "encyclopedia-update",
        "journaling-assistant"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "lifeArea": [
      "personal"
    ],
    "audience": "general"
  },
  {
    "id": "superpowers",
    "type": "plugin",
    "displayName": "Superpowers",
    "description": "Superpowers teaches Claude brainstorming, subagent driven development with built in code review, systematic debugging, and red/green TDD. Additionally, it teaches Claude how to author and test new skills.",
    "category": "development",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.1",
    "publishedAt": "2026-08-06T00:00:00Z",
    "components": {
      "skills": [
        "brainstorming",
        "dispatching-parallel-agents",
        "executing-plans",
        "finishing-a-development-branch",
        "receiving-code-review",
        "requesting-code-review",
        "subagent-driven-development",
        "systematic-debugging",
        "test-driven-development",
        "using-git-worktrees",
        "using-superpowers",
        "verification-before-completion",
        "writing-plans",
        "writing-skills"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/obra/superpowers.git"
  },
  {
    "id": "youcoded-inbox",
    "type": "plugin",
    "displayName": "Inbox",
    "description": "Process notes and screenshots from Todoist, Drive, Gmail, and more",
    "category": "personal",
    "author": "@destin",
    "tags": [
      "personal",
      "productivity",
      "automation"
    ],
    "version": "1.0.1",
    "publishedAt": "2026-04-21T00:00:00Z",
    "tagline": "Triage captured notes into something useful.",
    "longDescription": "Pulls items from every inbox you actually use — Todoist tasks, Google Drive notes, Gmail, Apple Notes, Apple Reminders, iCloud Drive, even local screenshots dropped in a staging folder — and triages them in one conversation. Claude isn't just routing items; it actively *resolves* them: answering questions, applying feedback, creating tasks, deleting noise, filing screenshots into your journal or encyclopedia.\n\nProvider-agnostic by design — pick the sources you actually use during setup, leave the rest off. The session-start hook quietly counts unprocessed items and surfaces a reminder when there's something to look at, so you never have to remember to open your inbox; it comes to you. Works hand-in-glove with `youcoded-encyclopedia` (journal entries get filed) and the YouCoded app's built-in sync (multi-device captures all flow into one queue).",
    "components": {
      "skills": [
        "claudes-inbox"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "lifeArea": [
      "personal",
      "work"
    ],
    "audience": "general"
  },
  {
    "id": "wecoded-themes-plugin",
    "type": "plugin",
    "displayName": "Theme Builder",
    "description": "Build and share custom themes — AI-generated or from scratch",
    "category": "design",
    "author": "@destin",
    "tags": [
      "design"
    ],
    "version": "1.0.1",
    "publishedAt": "2026-04-21T00:00:00Z",
    "tagline": "Make the app look like you.",
    "longDescription": "The `/theme-builder` skill — describe a vibe, drop in a wallpaper, or write a detailed brief, and Claude generates three full YouCoded theme concepts in a side-by-side browser preview. Pick one and you land on a single-page kit refiner where palette, chrome, bubbles, fonts, effects, wallpaper, mascots, and icons are all swappable columns; iterate until it feels like you, then build the pack and the app hot-reloads with your new look.\n\nFinished themes are real YouCoded theme packs (manifest + assets + custom CSS) you can install locally, share with friends via QR/link, or publish to the community theme registry where they get an auto-generated preview PNG. The skill enforces the 15 required theme tokens and runs contrast validation on the way out, so anything you publish is guaranteed legible.",
    "components": {
      "skills": [
        "theme-builder"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "lifeArea": [
      "creative"
    ],
    "audience": "general"
  },
  {
    "id": "remember",
    "type": "plugin",
    "displayName": "Remember",
    "description": "Continuous memory for Claude Code. Extracts, summarizes, and compresses conversations into tiered daily logs. Claude remembers what you did yesterday.",
    "category": "other",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.2",
    "publishedAt": "2026-08-12T00:00:00Z",
    "components": {
      "skills": [
        "remember"
      ],
      "hooks": [],
      "commands": [
        "doctor"
      ],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/Digital-Process-Tools/claude-remember"
  },
  {
    "id": "notion",
    "type": "plugin",
    "displayName": "Notion",
    "description": "Notion workspace integration. Search pages, create and update documents, manage databases, and access your team's knowledge base directly from Claude Code for seamless documentation workflows.",
    "category": "productivity",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.1",
    "publishedAt": "2026-08-06T00:00:00Z",
    "components": {
      "skills": [],
      "hooks": [],
      "commands": [
        "create-database-row",
        "create-page",
        "create-task",
        "database-query",
        "find",
        "search"
      ],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": true
    },
    "repoUrl": "https://github.com/makenotion/claude-code-notion-plugin"
  },
  {
    "id": "youcoded-messaging",
    "type": "plugin",
    "displayName": "Messaging",
    "description": "Send and read SMS/iMessage via MCP servers",
    "category": "personal",
    "author": "@destin",
    "tags": [
      "communication"
    ],
    "version": "1.0.1",
    "publishedAt": "2026-04-21T00:00:00Z",
    "tagline": "Text from Claude. Yes, really.",
    "longDescription": "Send and read SMS and iMessage from inside Claude. Drafts replies in your voice, sends from the phone number bridged through the configured MCP server, and surfaces incoming messages so Claude can react to them in your normal chat session. Useful for catching up on a thread without picking up your phone, or for asking Claude to draft something tricky and then send it for you.\n\nThe heavy lifting is in the bundled MCP servers — `gmessages` for Android/Google Messages, `imessage` for macOS — both of which the plugin will configure during install. Pairs naturally with `youcoded-inbox` for inbound triage, and with `youcoded-encyclopedia`'s deep-search mode for \"go find that thing I texted Mom about in October\" queries.",
    "components": {
      "skills": [],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "lifeArea": [
      "personal"
    ],
    "audience": "general"
  },
  {
    "id": "skill-creator",
    "type": "plugin",
    "displayName": "Skill Creator",
    "description": "Create new skills, improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, update or optimize an existing skill, run evals to test a skill, or benchmark skill performance with variance analysis.",
    "category": "development",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.1",
    "publishedAt": "2026-04-14T00:00:00Z",
    "components": {
      "skills": [
        "skill-creator"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/skill-creator"
  },
  {
    "id": "plugin-dev",
    "type": "plugin",
    "displayName": "Plugin Dev",
    "description": "Comprehensive toolkit for developing Claude Code plugins. Includes 7 expert skills covering hooks, MCP integration, commands, agents, and best practices. AI-assisted plugin creation and validation.",
    "category": "development",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-04-08T00:00:00Z",
    "components": {
      "skills": [
        "agent-development",
        "command-development",
        "hook-development",
        "mcp-integration",
        "plugin-settings",
        "plugin-structure",
        "skill-development"
      ],
      "hooks": [],
      "commands": [
        "create-plugin"
      ],
      "agents": [
        "agent-creator",
        "plugin-validator",
        "skill-reviewer"
      ],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/anthropics/claude-plugins-public/tree/main/plugins/plugin-dev"
  },
  {
    "id": "mcp-server-dev",
    "type": "plugin",
    "displayName": "MCP Server Dev",
    "description": "Skills for designing and building MCP servers that work seamlessly with Claude. Guides you through deployment models (remote HTTP, MCPB, local), tool design patterns, auth, and interactive MCP apps.",
    "category": "development",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-04-08T00:00:00Z",
    "components": {
      "skills": [
        "build-mcp-app",
        "build-mcp-server",
        "build-mcpb"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/mcp-server-dev"
  },
  {
    "id": "wecoded-marketplace-publisher",
    "type": "plugin",
    "displayName": "WeCoded Marketplace Publisher",
    "description": "Publish your plugins to the WeCoded marketplace — conversational, non-technical-user friendly.",
    "category": "productivity",
    "author": "@destin",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-04-21T00:00:00Z",
    "components": {
      "skills": [
        "marketplace-publisher"
      ],
      "hooks": [],
      "commands": [
        "publish-to-marketplace"
      ],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    }
  },
  {
    "id": "claude-md-management",
    "type": "plugin",
    "displayName": "Claude Md Management",
    "description": "Tools to maintain and improve CLAUDE.md files - audit quality, capture session learnings, and keep project memory current.",
    "category": "productivity",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-04-08T00:00:00Z",
    "components": {
      "skills": [
        "claude-md-improver"
      ],
      "hooks": [],
      "commands": [
        "revise-claude-md"
      ],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-md-management"
  },
  {
    "id": "hookify",
    "type": "plugin",
    "displayName": "Hookify",
    "description": "Easily create custom hooks to prevent unwanted behaviors by analyzing conversation patterns or from explicit instructions. Define rules via simple markdown files.",
    "category": "productivity",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-04-08T00:00:00Z",
    "components": {
      "skills": [
        "writing-rules"
      ],
      "hooks": [],
      "commands": [
        "configure",
        "help",
        "hookify",
        "list"
      ],
      "agents": [
        "conversation-analyzer"
      ],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/anthropics/claude-plugins-public/tree/main/plugins/hookify"
  },
  {
    "id": "math-olympiad",
    "type": "plugin",
    "displayName": "Math Olympiad",
    "description": "Solve competition math (IMO, Putnam, USAMO) with adversarial verification that catches what self-verification misses. Fresh-context verifiers attack proofs with specific failure patterns. Calibrated abstention over bluffing.",
    "category": "math",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-04-08T00:00:00Z",
    "components": {
      "skills": [
        "math-olympiad"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/math-olympiad"
  },
  {
    "id": "session-report",
    "type": "plugin",
    "displayName": "Session Report",
    "description": "Generate an explorable HTML report of Claude Code session usage — tokens, cache efficiency, subagents, skills, and the most expensive prompts — from local ~/.claude/projects transcripts.",
    "category": "productivity",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.1",
    "publishedAt": "2026-04-21T00:00:00Z",
    "components": {
      "skills": [
        "session-report"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/anthropics/claude-plugins-official/tree/main/plugins/session-report"
  },
  {
    "id": "ralph-loop",
    "type": "plugin",
    "displayName": "Ralph Loop",
    "description": "Interactive self-referential AI loops for iterative development, implementing the Ralph Wiggum technique. Claude works on the same task repeatedly, seeing its previous work, until completion.",
    "category": "development",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-04-08T00:00:00Z",
    "components": {
      "skills": [],
      "hooks": [
        "stop-hook"
      ],
      "commands": [
        "cancel-ralph",
        "help",
        "ralph-loop"
      ],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/anthropics/claude-plugins-public/tree/main/plugins/ralph-loop"
  },
  {
    "id": "code-review",
    "type": "plugin",
    "displayName": "Code Review",
    "description": "Automated code review for pull requests using multiple specialized agents with confidence-based scoring to filter false positives",
    "category": "productivity",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-04-08T00:00:00Z",
    "components": {
      "skills": [],
      "hooks": [],
      "commands": [
        "code-review"
      ],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/anthropics/claude-plugins-public/tree/main/plugins/code-review"
  },
  {
    "id": "browser-use",
    "type": "plugin",
    "displayName": "Browser Use",
    "description": "Give Claude a real browser — your Chrome or a Browser Use Cloud browser. Use it whenever a task involves a website or web app: browsing, scraping and data extraction, filling forms, testing sites, taking screenshots, automating web workflows.",
    "category": "automation",
    "author": "Browser Use",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-08-06T00:00:00Z",
    "components": {
      "skills": [],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": true
    },
    "repoUrl": "https://browser-use.com"
  },
  {
    "id": "synthflow",
    "type": "plugin",
    "displayName": "Synthflow",
    "description": "Connects Claude Code to the Synthflow AI voice-agent platform through its hosted MCP server, with skills for reviewing calls and auditing agent prompts, plus a docs-search connector.",
    "category": "automation",
    "author": "Synthflow",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-08-12T00:00:00Z",
    "components": {
      "skills": [
        "call-review",
        "prompt-review"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": true
    },
    "repoUrl": "https://synthflow.ai"
  },
  {
    "id": "aiven",
    "type": "plugin",
    "displayName": "Aiven",
    "description": "Easily deploy managed PostgreSQL (pg), Kafka, OpenSearch, Clickhouse and other databases, streaming and apps. Free tier available, up and running in minutes.",
    "category": "database",
    "author": "Aiven",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-08-12T00:00:00Z",
    "components": {
      "skills": [
        "aiven-getting-started"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": true
    },
    "repoUrl": "https://aiven.io"
  },
  {
    "id": "alloydb",
    "type": "plugin",
    "displayName": "Alloydb",
    "description": "Create, connect, and interact with an AlloyDB for PostgreSQL database and data.",
    "category": "database",
    "author": "Google LLC",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-08-06T00:00:00Z",
    "components": {
      "skills": [
        "alloydb-postgres-access-management",
        "alloydb-postgres-admin",
        "alloydb-postgres-data",
        "alloydb-postgres-health",
        "alloydb-postgres-monitor",
        "alloydb-postgres-optimize",
        "alloydb-postgres-replication"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://cloud.google.com/alloydb"
  },
  {
    "id": "azure",
    "type": "plugin",
    "displayName": "Azure",
    "description": "Transform Claude into an Azure expert. This plugin integrates the Azure MCP server and specialized Azure skills to move beyond generic advice. It enables Claude to perform real-world tasks: listing resources, validating deployments, diagnosing infrastructure issues, and optimizing costs across 50+ Azure services.",
    "category": "deployment",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.1",
    "publishedAt": "2026-08-12T00:00:00Z",
    "components": {
      "skills": [
        "airunway-aks-setup",
        "appinsights-instrumentation",
        "azure-ai",
        "azure-aigateway",
        "azure-app-onboard",
        "azure-app-onboard-prereq",
        "azure-cloud-migrate",
        "azure-compliance",
        "azure-compute",
        "azure-cost",
        "azure-deploy",
        "azure-diagnostics",
        "azure-enterprise-infra-planner",
        "azure-kubernetes",
        "azure-kusto",
        "azure-messaging",
        "azure-prepare",
        "azure-quotas",
        "azure-reliability",
        "azure-resource-lookup",
        "azure-resource-visualizer",
        "azure-storage",
        "azure-upgrade",
        "azure-validate",
        "entra-agent-id",
        "entra-app-registration",
        "microsoft-foundry",
        "python-appservice-deploy"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": true
    },
    "repoUrl": "https://github.com/microsoft/azure-skills"
  },
  {
    "id": "cloudflare",
    "type": "plugin",
    "displayName": "Cloudflare",
    "description": "Skills for the Cloudflare developer platform: Workers, Durable Objects, Agents SDK, MCP servers, Wrangler CLI, and web performance.",
    "category": "deployment",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.2",
    "publishedAt": "2026-08-12T00:00:00Z",
    "components": {
      "skills": [
        "agents-sdk",
        "cloudflare",
        "cloudflare-email-service",
        "cloudflare-one",
        "cloudflare-one-migrations",
        "durable-objects",
        "sandbox-migrate-to-next",
        "sandbox-next",
        "sandbox-stable",
        "turnstile-spin",
        "web-perf",
        "workers-best-practices",
        "wrangler"
      ],
      "hooks": [],
      "commands": [
        "build-agent",
        "build-mcp"
      ],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": true
    },
    "repoUrl": "https://github.com/cloudflare/skills"
  },
  {
    "id": "adobe-for-creativity",
    "type": "plugin",
    "displayName": "Adobe For Creativity",
    "description": "Harness Adobe's creative AI-powered tools to edit images, automate design workflows, and bring creative visions to life — from background removal to vectorization and professional retouching.",
    "category": "design",
    "author": "Adobe",
    "tags": [],
    "version": "1.0.1",
    "publishedAt": "2026-08-12T00:00:00Z",
    "components": {
      "skills": [
        "adobe-batch-edit-photos",
        "adobe-create-pdfs-from-data",
        "adobe-create-social-variations",
        "adobe-design-from-template",
        "adobe-edit-quick-cut",
        "adobe-resize-photos-and-videos",
        "adobe-retouch-portraits"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": true
    },
    "repoUrl": "https://github.com/adobe/skills/tree/main/plugins/creative-cloud/adobe-for-creativity"
  },
  {
    "id": "agent-sdk-dev",
    "type": "plugin",
    "displayName": "Agent SDK Dev",
    "description": "Development kit for working with the Claude Agent SDK",
    "category": "development",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-04-08T00:00:00Z",
    "components": {
      "skills": [],
      "hooks": [],
      "commands": [
        "new-sdk-app"
      ],
      "agents": [
        "agent-sdk-verifier-py",
        "agent-sdk-verifier-ts"
      ],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/anthropics/claude-plugins-public/tree/main/plugins/agent-sdk-dev"
  },
  {
    "id": "agentforce-adlc",
    "type": "plugin",
    "displayName": "Agentforce Adlc",
    "description": "Agentforce Agent Development Life Cycle — author, discover, scaffold, deploy, test, and optimize .agent files",
    "category": "development",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-08-06T00:00:00Z",
    "components": {
      "skills": [
        "agentforce-generate",
        "agentforce-observe",
        "agentforce-test"
      ],
      "hooks": [],
      "commands": [],
      "agents": [
        "adlc-author",
        "adlc-engineer",
        "adlc-orchestrator",
        "adlc-qa"
      ],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    },
    "repoUrl": "https://github.com/SalesforceAIResearch/agentforce-adlc"
  },
  {
    "id": "apple-services",
    "type": "plugin",
    "displayName": "Apple Services",
    "description": "Calendar, Reminders, Contacts, Notes, Mail, and iCloud Drive — one setup. macOS only.",
    "category": "integrations",
    "author": "YouCoded",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-04-21T00:00:00Z",
    "components": {
      "skills": [
        "apple-calendar",
        "apple-calendar-agenda",
        "apple-calendar-create",
        "apple-contacts",
        "apple-contacts-find",
        "apple-mail",
        "apple-mail-search",
        "apple-mail-send",
        "apple-notes",
        "apple-notes-search",
        "apple-notes-write",
        "apple-reminders",
        "apple-reminders-add",
        "apple-reminders-list",
        "icloud-drive"
      ],
      "hooks": [],
      "commands": [
        "apple-services-setup"
      ],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": false
    }
  },
  {
    "id": "claudes-inbox",
    "type": "prompt",
    "displayName": "Inbox",
    "description": "Process notes and screenshots from Todoist, Drive, Gmail, and more",
    "category": "personal",
    "author": "@destin",
    "authorGithub": "destinationunknown",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-04-08T00:00:00Z",
    "deprecated": true,
    "prompt": "check my inbox"
  },
  {
    "id": "imessage",
    "type": "plugin",
    "displayName": "Imessage",
    "description": "iMessage messaging bridge with built-in access control. Reads chat.db directly, sends via AppleScript. Manage pairing, allowlists, and policy via /imessage:access.",
    "category": "productivity",
    "author": "Anthropic",
    "tags": [],
    "version": "1.0.0",
    "publishedAt": "2026-04-08T00:00:00Z",
    "tagline": "Read your iMessage threads, send texts from chat.",
    "longDescription": "Surfaced through the iMessage integration tile rather than the plugins grid. Installs the Anthropic imessage plugin under the hood. macOS only.",
    "components": {
      "skills": [
        "access",
        "configure"
      ],
      "hooks": [],
      "commands": [],
      "agents": [],
      "mcpServers": [],
      "hasHooksManifest": false,
      "hasMcpConfig": true
    },
    "integrationOnly": true,
    "lifeArea": [
      "personal"
    ],
    "audience": "general"
  }
] as const;

export const MARKETPLACE_THEMES = [
  {
    "slug": "cotton-candy-sky",
    "name": "Cotton Candy Sky",
    "author": "claude",
    "dark": false,
    "description": null,
    "preview": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/cotton-candy-sky/preview.png",
    "previewTokens": {
      "canvas": "#FBF5FC",
      "panel": "#ECDDF0",
      "accent": "#8B47B8",
      "on-accent": "#FFFFFF",
      "fg": "#21152C",
      "fg-muted": "#695775",
      "edge": "#B597C6"
    },
    "version": "1.0.0",
    "created": "2026-06-19",
    "updated": "2026-07-24",
    "source": "community",
    "features": [
      "wallpaper",
      "glassmorphism",
      "particles",
      "custom-font",
      "custom-css"
    ],
    "manifestUrl": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/cotton-candy-sky/manifest.json",
    "assetUrls": {
      "assets/wallpaper-terminal.webp": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/cotton-candy-sky/assets/wallpaper-terminal.webp",
      "assets/wallpaper.jpg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/cotton-candy-sky/assets/wallpaper.jpg"
    },
    "contentHash": "sha256:5305d87a1a4a634dfba1a459657748dc251c473ddac6634a03ac06bc5903d720",
    "installed": false
  },
  {
    "slug": "devils-garden",
    "name": "Devil's Garden",
    "author": "claude",
    "dark": true,
    "description": null,
    "preview": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/devils-garden/preview.png",
    "previewTokens": {
      "canvas": "#140810",
      "panel": "#221020",
      "accent": "#FFC627",
      "on-accent": "#140810",
      "fg": "#FBE9C9",
      "fg-muted": "#A28E6D",
      "edge": "#7A3048"
    },
    "version": "1.0.0",
    "created": "2026-04-12",
    "updated": "2026-07-24",
    "source": "community",
    "features": [
      "wallpaper",
      "glassmorphism",
      "particles",
      "custom-font",
      "custom-css"
    ],
    "manifestUrl": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/devils-garden/manifest.json",
    "assetUrls": {
      "assets/wallpaper.jpg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/devils-garden/assets/wallpaper.jpg"
    },
    "contentHash": "sha256:fb2a7a0b1bc9e20f595d35314feb6a2ff4e593043669933faab0c30f8682a6fa",
    "installed": false
  },
  {
    "slug": "golden-sunbreak",
    "name": "Golden Sunbreak",
    "author": "itsdestin",
    "dark": true,
    "description": "Weathering With You — Tokyo bathed in god-ray light. Deep violet-black panels, warm amber gold, soft dust-mote particles.",
    "preview": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/preview.png",
    "previewTokens": {
      "canvas": "#08080e",
      "panel": "#140e1a",
      "accent": "#ffc030",
      "on-accent": "#000000",
      "fg": "#F8E8C8",
      "fg-muted": "#917950",
      "edge": "#3C3223"
    },
    "version": "1.2.0",
    "created": "2026-03-28",
    "updated": "2026-07-24",
    "source": "youcoded-core",
    "features": [
      "wallpaper",
      "glassmorphism",
      "particles",
      "custom-icons",
      "mascot",
      "custom-css"
    ],
    "manifestUrl": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/manifest.json",
    "assetUrls": {
      "assets/companions/mote-amber.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/companions/mote-amber.svg",
      "assets/companions/mote-pale.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/companions/mote-pale.svg",
      "assets/companions/mote-soft.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/companions/mote-soft.svg",
      "assets/companions/sun.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/companions/sun.svg",
      "assets/dust.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/dust.svg",
      "assets/icon-send.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/icon-send.svg",
      "assets/mascot-idle.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/mascot-idle.svg",
      "assets/mascot-inquisitive.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/mascot-inquisitive.svg",
      "assets/mascot-rig.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/mascot-rig.svg",
      "assets/mascot-welcome.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/mascot-welcome.svg",
      "assets/pattern.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/pattern.svg",
      "assets/wallpaper-terminal.webp": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/wallpaper-terminal.webp",
      "assets/wallpaper.jpg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/assets/wallpaper.jpg"
    },
    "contentHash": null,
    "installed": true
  },
  {
    "slug": "halftone-dimension",
    "name": "Halftone Dimension",
    "author": "claude",
    "dark": true,
    "description": "Cyberpunk manga print shop — deep purple-black with hot pink accent, cyan secondary, misregistered CMY halftone dots, scanlines, and floating chrome.",
    "preview": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/preview.png",
    "previewTokens": {
      "canvas": "#08060e",
      "panel": "#100e1c",
      "accent": "#E51F48",
      "on-accent": "#ffffff",
      "fg": "#F0E8F8",
      "fg-muted": "#7468A0",
      "edge": "#372D56"
    },
    "version": "1.2.2",
    "created": "2026-04-05",
    "updated": "2026-07-24",
    "source": "community",
    "features": [
      "glassmorphism",
      "particles",
      "custom-icons",
      "mascot",
      "custom-css"
    ],
    "manifestUrl": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/manifest.json",
    "assetUrls": {
      "assets/companions/bar-cyan.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/assets/companions/bar-cyan.svg",
      "assets/companions/bar-red.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/assets/companions/bar-red.svg",
      "assets/companions/ghost.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/assets/companions/ghost.svg",
      "assets/icon-send.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/assets/icon-send.svg",
      "assets/mascot-idle.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/assets/mascot-idle.svg",
      "assets/mascot-inquisitive.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/assets/mascot-inquisitive.svg",
      "assets/mascot-rig.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/assets/mascot-rig.svg",
      "assets/mascot-welcome.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/assets/mascot-welcome.svg",
      "assets/particle.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/assets/particle.svg",
      "assets/pattern.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/assets/pattern.svg",
      "assets/scrollbar-thumb.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/halftone-dimension/assets/scrollbar-thumb.svg"
    },
    "contentHash": null,
    "installed": true
  },
  {
    "slug": "kuromi-dreamer",
    "name": "Kuromi Dreamer",
    "author": "claude",
    "dark": false,
    "description": "Darker purple Hello Kitty x Kuromi crossover — lavender dusk, floating chrome, pill bubbles, dust drift over a pastel gothic wallpaper.",
    "preview": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/preview.png",
    "previewTokens": {
      "canvas": "#C9B8E0",
      "panel": "#D4C5E6",
      "accent": "#8158ad",
      "on-accent": "#FFFFFF",
      "fg": "#190E27",
      "fg-muted": "#65507F",
      "edge": "#8466A8"
    },
    "version": "1.2.1",
    "created": "2026-04-12",
    "updated": "2026-07-24",
    "source": "community",
    "features": [
      "wallpaper",
      "glassmorphism",
      "particles",
      "custom-font",
      "mascot",
      "custom-css"
    ],
    "manifestUrl": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/manifest.json",
    "assetUrls": {
      "assets/companions/spark-pink-soft.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/assets/companions/spark-pink-soft.svg",
      "assets/companions/spark-pink.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/assets/companions/spark-pink.svg",
      "assets/companions/spark-white.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/assets/companions/spark-white.svg",
      "assets/mascot-dizzy.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/assets/mascot-dizzy.svg",
      "assets/mascot-idle.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/assets/mascot-idle.svg",
      "assets/mascot-rig.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/assets/mascot-rig.svg",
      "assets/mascot-shocked.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/assets/mascot-shocked.svg",
      "assets/mascot-welcome.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/assets/mascot-welcome.svg",
      "assets/pattern.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/assets/pattern.svg",
      "assets/wallpaper-terminal.webp": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/assets/wallpaper-terminal.webp",
      "assets/wallpaper.webp": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/kuromi-dreamer/assets/wallpaper.webp"
    },
    "contentHash": null,
    "installed": false
  },
  {
    "slug": "meadow-mist",
    "name": "Meadow Mist",
    "author": "claude",
    "dark": false,
    "description": null,
    "preview": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/meadow-mist/preview.png",
    "previewTokens": {
      "canvas": "#F6FAF5",
      "panel": "#DDE9DA",
      "accent": "#2F7D55",
      "on-accent": "#FFFFFF",
      "fg": "#041008",
      "fg-muted": "#465B4E",
      "edge": "#8FB191"
    },
    "version": "1.0.0",
    "created": "2026-06-19",
    "updated": "2026-07-24",
    "source": "community",
    "features": [
      "wallpaper",
      "glassmorphism",
      "custom-font",
      "custom-css"
    ],
    "manifestUrl": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/meadow-mist/manifest.json",
    "assetUrls": {
      "assets/wallpaper-terminal.webp": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/meadow-mist/assets/wallpaper-terminal.webp",
      "assets/wallpaper.jpg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/meadow-mist/assets/wallpaper.jpg"
    },
    "contentHash": "sha256:168d293f2304c089afb639d1087c2c57c65c82db4776d36955bcec3dfc3a4ff1",
    "installed": true
  },
  {
    "slug": "strawberry-kitty",
    "name": "Strawberry Kitty",
    "author": "claude",
    "dark": false,
    "description": "Lighter pink Hello Kitty x strawberry shortcake — pastel rose canvas, floating chrome, pill bubbles, dust drift over a sweet berry wallpaper.",
    "preview": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/strawberry-kitty/preview.png",
    "previewTokens": {
      "canvas": "#F8D7DE",
      "panel": "#FCE4E9",
      "accent": "#CC4060",
      "on-accent": "#FFFFFF",
      "fg": "#3A1420",
      "fg-muted": "#A26179",
      "edge": "#E09AA8"
    },
    "version": "1.2.1",
    "created": "2026-04-12",
    "updated": "2026-07-24",
    "source": "community",
    "features": [
      "wallpaper",
      "glassmorphism",
      "particles",
      "custom-font",
      "mascot",
      "custom-css"
    ],
    "manifestUrl": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/strawberry-kitty/manifest.json",
    "assetUrls": {
      "assets/companions/berry.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/strawberry-kitty/assets/companions/berry.svg",
      "assets/companions/spark-red.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/strawberry-kitty/assets/companions/spark-red.svg",
      "assets/mascot-dizzy.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/strawberry-kitty/assets/mascot-dizzy.svg",
      "assets/mascot-idle.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/strawberry-kitty/assets/mascot-idle.svg",
      "assets/mascot-rig.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/strawberry-kitty/assets/mascot-rig.svg",
      "assets/mascot-shocked.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/strawberry-kitty/assets/mascot-shocked.svg",
      "assets/mascot-welcome.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/strawberry-kitty/assets/mascot-welcome.svg",
      "assets/pattern.svg": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/strawberry-kitty/assets/pattern.svg",
      "assets/wallpaper-terminal.webp": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/strawberry-kitty/assets/wallpaper-terminal.webp",
      "assets/wallpaper.png": "https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/strawberry-kitty/assets/wallpaper.png"
    },
    "contentHash": null,
    "installed": false
  }
] as const;

export const INSTALLED_SKILLS = [
  {
    "id": "civic-report",
    "displayName": "Civic Report",
    "description": "Use when the user asks for a report on their representatives, wants to research candidates before voting, or wants to understand who represents their address. Handles federal reps deeply, state officials as name-level stubs.",
    "category": "personal",
    "prompt": "/civic-report",
    "source": "marketplace",
    "pluginName": "civic-report",
    "type": "plugin",
    "author": "@destin",
    "version": "1.0.2",
    "visibility": "published",
    "installedAt": "2026-08-01T12:00:00Z"
  },
  {
    "id": "encyclopedia-compile",
    "displayName": "Encyclopedia Compile",
    "description": "Compiles the user's Encyclopedia — a single, narratively coherent life history document — from eight modular source files. Invoke when the user says \"compile my encyclopedia\", \"build the encyclopedia\", or similar. Supports four detail levels to control how much intimate personal detail appears in the output.",
    "category": "personal",
    "prompt": "/encyclopedia-compile",
    "source": "marketplace",
    "pluginName": "youcoded-encyclopedia",
    "type": "plugin",
    "author": "@destin",
    "version": "1.0.1",
    "visibility": "published",
    "installedAt": "2026-08-01T12:00:00Z"
  },
  {
    "id": "encyclopedia-interviewer",
    "displayName": "Encyclopedia Interviewer",
    "description": "Conducts focused interview sessions to fill gaps in the Encyclopedia system's modular source files. Proactively identifies missing backstory, stale data, and contradictions, then runs a structured interview to address them.",
    "category": "personal",
    "prompt": "/encyclopedia-interviewer",
    "source": "marketplace",
    "pluginName": "youcoded-encyclopedia",
    "type": "plugin",
    "author": "@destin",
    "version": "1.0.1",
    "visibility": "published",
    "installedAt": "2026-08-01T12:00:00Z"
  },
  {
    "id": "encyclopedia-librarian",
    "displayName": "Encyclopedia Librarian",
    "description": "Produces purpose-built reports and briefings from the Encyclopedia system's modular source files — career briefs, person briefings, period reviews, political profiles, and topic syntheses, with an optional deep-search mode.",
    "category": "personal",
    "prompt": "/encyclopedia-librarian",
    "source": "marketplace",
    "pluginName": "youcoded-encyclopedia",
    "type": "plugin",
    "author": "@destin",
    "version": "1.0.1",
    "visibility": "published",
    "installedAt": "2026-08-01T12:00:00Z"
  },
  {
    "id": "brainstorming",
    "displayName": "Brainstorming",
    "description": "Use this before any creative work — creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation.",
    "category": "development",
    "prompt": "/brainstorming",
    "source": "marketplace",
    "pluginName": "superpowers",
    "type": "plugin",
    "author": "Anthropic",
    "version": "1.0.1",
    "visibility": "published",
    "installedAt": "2026-08-01T12:00:00Z"
  },
  {
    "id": "dispatching-parallel-agents",
    "displayName": "Dispatching Parallel Agents",
    "description": "Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies.",
    "category": "development",
    "prompt": "/dispatching-parallel-agents",
    "source": "marketplace",
    "pluginName": "superpowers",
    "type": "plugin",
    "author": "Anthropic",
    "version": "1.0.1",
    "visibility": "published",
    "installedAt": "2026-08-01T12:00:00Z"
  },
  {
    "id": "executing-plans",
    "displayName": "Executing Plans",
    "description": "Use when you have a written implementation plan to execute in a separate session with review checkpoints.",
    "category": "development",
    "prompt": "/executing-plans",
    "source": "marketplace",
    "pluginName": "superpowers",
    "type": "plugin",
    "author": "Anthropic",
    "version": "1.0.1",
    "visibility": "published",
    "installedAt": "2026-08-01T12:00:00Z"
  },
  {
    "id": "theme-builder",
    "displayName": "Theme Builder",
    "description": "Build immersive YouCoded theme packs. Invoke as /theme-builder \"your vibe description\" — start from a general vibe, a detailed brief, or your own wallpaper.",
    "category": "personal",
    "prompt": "/theme-builder",
    "source": "marketplace",
    "pluginName": "wecoded-themes-plugin",
    "type": "plugin",
    "author": "@destin",
    "version": "1.0.1",
    "visibility": "published",
    "installedAt": "2026-08-01T12:00:00Z"
  },
  {
    "id": "marketplace-publisher",
    "displayName": "Marketplace Publisher",
    "description": "Conversational assistant that helps users publish their plugins (skills, commands, hooks, MCPs, agents) to the WeCoded marketplace — disk discovery, plugin rebuild, secret sanitization, and PR creation.",
    "category": "personal",
    "prompt": "/marketplace-publisher",
    "source": "marketplace",
    "pluginName": "wecoded-marketplace-publisher",
    "type": "plugin",
    "author": "@destin",
    "version": "1.0.0",
    "visibility": "published",
    "installedAt": "2026-08-01T12:00:00Z"
  }
] as const;

export const INSTALLED_PACKAGES = {
  "civic-report": {
    "version": "1.0.2",
    "source": "marketplace",
    "installedAt": "2026-08-01T12:00:00Z",
    "removable": true,
    "components": [],
    "status": "installed"
  },
  "youcoded-encyclopedia": {
    "version": "1.0.1",
    "source": "marketplace",
    "installedAt": "2026-08-01T12:00:00Z",
    "removable": true,
    "components": [],
    "status": "installed"
  },
  "superpowers": {
    "version": "1.0.1",
    "source": "marketplace",
    "installedAt": "2026-08-01T12:00:00Z",
    "removable": true,
    "components": [],
    "status": "installed"
  },
  "wecoded-themes-plugin": {
    "version": "1.0.1",
    "source": "marketplace",
    "installedAt": "2026-08-01T12:00:00Z",
    "removable": true,
    "components": [],
    "status": "installed"
  },
  "wecoded-marketplace-publisher": {
    "version": "1.0.0",
    "source": "marketplace",
    "installedAt": "2026-08-01T12:00:00Z",
    "removable": true,
    "components": [],
    "status": "installed"
  },
  "theme:golden-sunbreak": {
    "version": "1.2.0",
    "source": "marketplace",
    "installedAt": "2026-08-01T12:00:00Z",
    "removable": true,
    "components": [],
    "status": "installed"
  },
  "theme:meadow-mist": {
    "version": "1.0.0",
    "source": "marketplace",
    "installedAt": "2026-08-01T12:00:00Z",
    "removable": true,
    "components": [],
    "status": "installed"
  },
  "theme:halftone-dimension": {
    "version": "1.2.2",
    "source": "marketplace",
    "installedAt": "2026-08-01T12:00:00Z",
    "removable": true,
    "components": [],
    "status": "installed"
  }
} as const;

export const FEATURED = {
  "hero": [
    {
      "id": "civic-report",
      "blurb": "Source-linked report on your federal reps, tuned to your angle and depth.",
      "accentColor": "#d8a84b"
    },
    {
      "id": "youcoded-encyclopedia",
      "blurb": "Your personal knowledge graph — facts, notes, and memories that persist across sessions.",
      "accentColor": "#6b8ecf"
    },
    {
      "id": "superpowers",
      "blurb": "Teach Claude brainstorming, planning, TDD, and subagent-driven development — built-in.",
      "accentColor": "#7bc56b"
    }
  ],
  "rails": [
    {
      "title": "Destin's picks",
      "description": "What I'm using this week.",
      "slugs": [
        "civic-report",
        "youcoded-encyclopedia",
        "youcoded-inbox",
        "wecoded-themes-plugin",
        "superpowers"
      ]
    },
    {
      "title": "If you journal",
      "description": "Capture, recall, connect.",
      "slugs": [
        "youcoded-encyclopedia",
        "youcoded-inbox",
        "remember",
        "notion"
      ]
    },
    {
      "title": "For everyday life",
      "description": "Not just for coders.",
      "slugs": [
        "civic-report",
        "youcoded-messaging"
      ]
    },
    {
      "title": "Build your own",
      "description": "Build with conversation, not code.",
      "slugs": [
        "skill-creator",
        "plugin-dev",
        "mcp-server-dev",
        "wecoded-marketplace-publisher",
        "wecoded-themes-plugin"
      ]
    },
    {
      "title": "Make Claude better",
      "description": "Meta-skills that level up every workflow.",
      "slugs": [
        "superpowers",
        "remember",
        "claude-md-management",
        "hookify"
      ]
    },
    {
      "title": "For fun",
      "description": "Quirkier picks worth a try.",
      "slugs": [
        "math-olympiad",
        "session-report",
        "ralph-loop"
      ]
    }
  ],
  "skills": [
    {
      "id": "code-review",
      "tagline": "AI-powered PR analysis with specialized review agents"
    }
  ],
  "themes": [
    {
      "slug": "golden-sunbreak",
      "tagline": "Weathering With You — Tokyo bathed in god-ray light"
    }
  ]
} as const;
