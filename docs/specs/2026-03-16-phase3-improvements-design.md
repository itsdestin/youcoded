# Phase 3 Improvements Design: Markdown, Git, Image Input

**Date:** 2026-03-16
**Version:** 1.2
**Status:** Approved

## Overview

Three improvements to DestinCode addressing the highest-impact gaps between mobile and desktop Claude Code usage:

1. **Markdown rendering** in chat view responses
2. **Git bundled at bootstrap** instead of on-demand
3. **Image input** via Android photo picker

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Markdown scope | Standard (bold, italic, code, headers, lists, blockquotes, HR) | Covers 95% of Claude output; tables/task lists are rare and hard on narrow screens |
| Markdown parser | commonmark-java library + Compose-native rendering | Reliable parsing without fighting Compose theme/font system |
| Git install timing | Bundle at bootstrap | Simple, reliable; 15-20MB overhead is acceptable for first-run |
| Image source | Photo library only (PickVisualMedia) | Simplest path; screenshots cover most use cases; camera adds complexity for marginal gain |
| Attachment button | Inside text field, trailing edge | Clean look, doesn't add visual clutter outside the field |
| Image delivery to Claude | Copy to $HOME/attachments/ + inject file path in prompt | Works with Claude Code's existing Read tool; no special protocol needed |

## Feature 1: Markdown Rendering

### Architecture

- **Parser:** commonmark-java (`org.commonmark:commonmark:0.24.0`, ~100KB)
- **Renderer:** New `MarkdownRenderer.kt` composable that walks the commonmark AST and emits Compose UI
- **Integration:** Replaces `LinkableText` in `MessageBubble.kt` for `MessageContent.Response` messages only. User messages remain plain `LinkableText`.

### Rendering Strategy

Inline nodes (bold, italic, inline code, links) are rendered as `AnnotatedString` spans within `ClickableText`, extending the existing `LinkableText` URL detection pattern. Inline spans compose naturally within block containers (e.g., bold inside a list item) since the AST walker applies inline styles recursively within each block node's text content.

**URL handling:** commonmark-java parses explicit `[text](url)` links into `Link` nodes. For bare URLs (which Claude frequently outputs), apply the same regex detection from `LinkableText` as a post-processing pass on `Text` nodes that aren't already inside a `Link`. This preserves the current behavior where bare `https://...` URLs are clickable.

Block nodes (headers, paragraphs, lists, blockquotes, horizontal rules) are rendered as a `Column` of Compose elements with appropriate padding and styling.

Fenced and indented code blocks route to the existing `CodeCard` composable, reusing its syntax highlighting infrastructure.

### Styling

| Element | Style |
|---------|-------|
| `**bold**` | `FontWeight.Bold`, inherits color |
| `*italic*` | `FontStyle.Italic` |
| `` `inline code` `` | `#c96442` text, `#222` background, Cascadia Mono |
| `# Header` (h1/h2/h3) | 18sp / 16sp / 14sp, `FontWeight.Bold` |
| `- list item` | 8dp left padding, bullet character prefix |
| `1. numbered` | 8dp left padding, number prefix |
| `> blockquote` | 2dp left border in `#c96442`, 12dp left padding, `#999` text |
| `---` | 1dp `Divider` in `#333` |
| Code blocks | Existing `CodeCard` component |

### Files

- **New:** `ui/MarkdownRenderer.kt`
- **Modified:** `MessageBubble.kt` (swap `LinkableText` → `MarkdownRenderer` for Response content)
- **Modified:** `build.gradle.kts` (add commonmark dependency)

## Feature 2: Git at Bootstrap

### Change

Move the 7 git dependency `.deb` package URLs from the on-demand `installGit()` function into the existing `installPackages()` call in `Bootstrap.kt`.

### Package Install Order

1. c-ares, libicu, libsqlite (existing)
2. termux-exec (existing)
3. nodejs, npm (existing)
4. openssl, libcurl, libexpat, libiconv, pcre2, zlib, git (moved from `installGit()`)
5. Claude Code npm install (existing)

### Progress Reporting

The existing `Progress.Installing(packageName)` callback handles this automatically — each package name appears on the setup screen as it downloads and extracts.

### Cleanup

- Remove `installGit()` function (dead code). No external callers exist — `installGit()` is only defined and referenced within `Bootstrap.kt`.
- Remove sentinel file checks (`libssl.so` existence, etc.) that guarded on-demand install
- Carry forward existing TODO comments about resolving `.deb` paths from Termux API (currently hardcoded URLs)

### Impact

- Adds ~15-20MB download to first-run setup (5-15 seconds on typical mobile connection)
- No changes to runtime behavior

### Files

- **Modified:** `Bootstrap.kt` (move deb URLs, remove `installGit()`)

## Feature 3: Image Input

### Components

#### 1. Photo Picker Launcher

- Register `ActivityResultContracts.PickVisualMedia()` in `ChatScreen.kt`
- On image selection: copy from content URI to `$HOME/attachments/<timestamp>.png` via `ContentResolver.openInputStream()` + file write
- Store local file path and `Bitmap` thumbnail in composable state

#### 2. Input Bar Modification

- Inside the `BasicTextField`'s `decorationBox` lambda, wrap `innerTextField()` in a `Row` with `Icons.Outlined.Image` aligned to `CenterVertically` at the trailing edge. The `innerTextField()` gets `Modifier.weight(1f)` so it fills remaining space without overlapping the icon.
- Icon color: `#555` idle, `#c96442` when image attached
- Tapping launches photo picker
- When image attached: show 48dp rounded thumbnail row above input bar with `Icons.Close` remove button
- Attachment path stored via `rememberSaveable` so it survives configuration changes; thumbnail `Bitmap` loaded from saved path via `BitmapFactory.decodeFile()` in a `LaunchedEffect` on restore (not stored in state directly)

#### 3. Prompt Injection

When sending a message with an attached image, use the absolute path (not `~`) since Claude Code's Read tool needs a resolvable path:
```
[Image attached: /data/data/com.destins.claudemobile/files/home/attachments/<timestamp>.png]

<user's message text>
```

The absolute path is constructed from `homeDir.absolutePath + "/attachments/<timestamp>.png"` at copy time.

Send combined string via `bridge.writeInput()`. Clear attachment state after send. Claude Code's Read tool natively reads image files.

### Limitations

- Single image attachment at a time (v1 scope). Multiple images would require a list UI and more complex prompt formatting.

### Permissions

None required. `PickVisualMedia` on API 28+ grants temporary read access via the system picker. Image bytes are copied into the app's private directory immediately.

### File Cleanup

No automatic cleanup of `$HOME/attachments/`. Phone photos are ~2-5MB each; users can manage via shell if needed.

### Files

- **Modified:** `ChatScreen.kt` (picker launcher, input bar icon, thumbnail preview, prompt injection)
- **No manifest changes** (no new permissions needed)
