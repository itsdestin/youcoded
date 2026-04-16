import { BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';

const PREVIEW_WIDTH = 800;
const PREVIEW_HEIGHT = 500;

/**
 * Generates a preview PNG for a theme by rendering a mock YouCoded UI
 * with the theme's tokens applied, then capturing it as an image.
 *
 * Uses Electron's offscreen rendering to avoid flashing a visible window.
 * Returns the path to the generated preview.png.
 */
export async function generateThemePreview(
  themeDir: string,
  manifest: Record<string, any>,
): Promise<string> {
  const slug = path.basename(themeDir);
  const t0 = Date.now();
  const log = (msg: string, extra?: Record<string, any>) => {
    const suffix = extra ? ' ' + JSON.stringify(extra) : '';
    console.log(`[theme-preview:${slug}] +${Date.now() - t0}ms ${msg}${suffix}`);
  };
  log('start', {
    hasWallpaper: manifest.background?.type === 'image',
    hasGradient: manifest.background?.type === 'gradient',
    hasPattern: !!manifest.background?.pattern,
  });
  const html = buildPreviewHTML(manifest, themeDir);
  const outputPath = path.join(themeDir, 'preview.png');

  // Use a real hidden window (show: false) rather than offscreen rendering.
  // capturePage() on offscreen windows is racy: the JS event loop (and our
  // __previewReady flag) runs independently from the offscreen compositor, so
  // capture can fire before the GPU has committed a frame — producing empty
  // or corrupt PNGs that render as a broken-image icon in the share sheet.
  // Real hidden windows paint on the normal compositor schedule and
  // capturePage() is reliable once the JS ready gate has fired.
  const win = new BrowserWindow({
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Hidden windows skip paints by default in Electron 20+ — without this,
      // capturePage returns empty buffers because no frame was ever composited.
      // Option is real but missing from this Electron version's type defs.
      ...({ paintWhenInitiallyHidden: true } as any),
    },
  });

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    log('loaded');

    // Wait for an event-based ready signal (fonts + wallpaper/pattern decoded).
    // The old 300ms fixed delay raced large base64 wallpapers — Chromium's
    // image decode can easily exceed that, producing previews that were either
    // missing the wallpaper or captured mid-paint.
    const readyResult = await waitForPreviewReady(win, 3000);
    log('ready-gate', readyResult);

    // One frame of settle after decode so layout + any reflow from late
    // background-size:cover computation has flushed.
    await new Promise(r => setTimeout(r, 50));

    // Capture the page. On hidden (non-offscreen) windows, capturePage produces
    // a valid frame as long as the window has a compositor surface — which it
    // does by default for BrowserWindow with show:false + paintWhenInitiallyHidden.
    const image = await win.webContents.capturePage();
    const size = image.getSize();
    const pngBuffer = image.toPNG();
    log('captured', { pngBytes: pngBuffer.length, w: size.width, h: size.height, empty: image.isEmpty() });

    // Validate: a zero-byte or tiny PNG means capture fired before paint.
    // 800x500 solid color still compresses to ~200-400 bytes, so 150 is a safe
    // "something went wrong" floor without false positives on clean themes.
    if (image.isEmpty() || pngBuffer.length < 150) {
      throw new Error(`Preview capture produced empty/tiny PNG (${pngBuffer.length} bytes, isEmpty=${image.isEmpty()}) — window did not paint in time.`);
    }

    await fs.promises.writeFile(outputPath, pngBuffer);
    log('written', { path: outputPath });
    return outputPath;
  } catch (err: any) {
    log('FAILED', { error: err?.message ?? String(err) });
    throw err;
  } finally {
    win.destroy();
  }
}

/**
 * Poll the offscreen window for a `window.__previewReady` flag that the
 * injected preview HTML sets once fonts + wallpaper + pattern images have all
 * resolved their decode() promises. Returns as soon as the flag is true, or
 * after `capMs` as a hard fallback so a broken theme can't hang publish.
 */
async function waitForPreviewReady(
  win: BrowserWindow,
  capMs: number,
): Promise<{ ready: boolean; elapsedMs: number; pollErrors: number }> {
  const start = Date.now();
  let pollErrors = 0;
  while (Date.now() - start < capMs) {
    try {
      const ready = await win.webContents.executeJavaScript('window.__previewReady === true');
      if (ready) return { ready: true, elapsedMs: Date.now() - start, pollErrors };
    } catch {
      // Page not navigated yet or window destroyed — loop and recheck
      pollErrors++;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  // Cap hit — proceed anyway with whatever's rendered. Validation below will
  // reject if the result is obviously empty.
  return { ready: false, elapsedMs: Date.now() - start, pollErrors };
}

/**
 * Builds a self-contained HTML string that mocks the YouCoded UI
 * using the theme's color tokens.
 */
function buildPreviewHTML(manifest: Record<string, any>, themeDir: string): string {
  const tokens = manifest.tokens || {};
  const dark = manifest.dark ?? true;
  const name = manifest.name || 'Theme';
  const bubbleStyle = manifest.layout?.['bubble-style'] || 'default';
  const inputStyle = manifest.layout?.['input-style'] || 'default';

  // Build CSS variables from tokens
  const cssVars = Object.entries(tokens)
    .map(([key, val]) => `--${key}: ${val};`)
    .join('\n      ');

  // Shape variables
  const shape = manifest.shape || {};
  const shapeVars = Object.entries(shape)
    .map(([key, val]) => `--${key}: ${val};`)
    .join('\n      ');

  const isPill = bubbleStyle === 'pill';
  const isFloating = inputStyle === 'floating';

  // Wallpaper support: embed image as base64 data URI if available
  const bg = manifest.background || {};
  let wallpaperDataUri = '';
  if (bg.type === 'image' && bg.value) {
    // Resolve asset path — strip theme-asset:// protocol or use relative path
    let assetRelPath = bg.value;
    if (assetRelPath.startsWith('theme-asset://')) {
      const url = new URL(assetRelPath);
      assetRelPath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    }
    const wallpaperPath = path.join(themeDir, assetRelPath);
    if (fs.existsSync(wallpaperPath)) {
      const ext = path.extname(wallpaperPath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const b64 = fs.readFileSync(wallpaperPath).toString('base64');
      wallpaperDataUri = `data:${mime};base64,${b64}`;
    }
  } else if (bg.type === 'gradient' && bg.value) {
    wallpaperDataUri = ''; // handled via CSS background property
  }

  const hasWallpaper = !!wallpaperDataUri;
  const hasGradient = bg.type === 'gradient' && bg.value;
  const panelsBlur = bg['panels-blur'] || 0;
  const panelsOpacity = bg['panels-opacity'] ?? 1;
  const hasGlass = panelsBlur > 0 && (hasWallpaper || hasGradient);

  // Compute semi-transparent panel color for glassmorphism
  const panelColor = tokens.panel || '#1a1a1a';
  const glassPanel = hasGlass
    ? `color-mix(in srgb, ${panelColor} ${Math.round(panelsOpacity * 100)}%, transparent)`
    : 'var(--panel)';
  const blurCSS = hasGlass
    ? `backdrop-filter: blur(${panelsBlur}px) saturate(1.2); -webkit-backdrop-filter: blur(${panelsBlur}px) saturate(1.2);`
    : '';

  // Pattern overlay: embed SVG as base64 data URI if available
  let patternDataUri = '';
  const patternPath = bg.pattern;
  if (patternPath) {
    let patternRelPath = patternPath;
    if (patternRelPath.startsWith('theme-asset://')) {
      const url = new URL(patternRelPath);
      patternRelPath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    }
    const patternFullPath = path.join(themeDir, patternRelPath);
    if (fs.existsSync(patternFullPath)) {
      const svgB64 = fs.readFileSync(patternFullPath).toString('base64');
      patternDataUri = `data:image/svg+xml;base64,${svgB64}`;
    }
  }
  const patternOpacity = bg['pattern-opacity'] ?? 0.06;

  // Body background: wallpaper image, gradient, or solid canvas
  let bodyBg = 'var(--canvas)';
  if (hasWallpaper) {
    bodyBg = `url("${wallpaperDataUri}") center/cover no-repeat`;
  } else if (hasGradient) {
    bodyBg = bg.value;
  }

  // Inject custom_css for body::after overlays (patterns, etc.)
  const customCss = manifest.custom_css || '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root {
      ${cssVars}
      ${shapeVars}
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: ${PREVIEW_WIDTH}px;
      height: ${PREVIEW_HEIGHT}px;
      background: ${bodyBg};
      font-family: system-ui, -apple-system, sans-serif;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    ${patternDataUri ? `
    /* Pattern overlay — rendered even if custom_css doesn't include body::after */
    body::after {
      content: ''; position: fixed; inset: 0;
      background-image: url("${patternDataUri}");
      background-size: 30px 30px; background-repeat: repeat;
      opacity: ${patternOpacity};
      pointer-events: none; z-index: 0;
    }` : ''}
    ${customCss ? `/* Theme custom CSS */ ${customCss}` : ''}

    /* Header */
    .header {
      height: 44px;
      background: ${hasGlass ? glassPanel : 'var(--panel)'};
      ${blurCSS}
      border-bottom: 1px solid var(--edge);
      display: flex;
      align-items: center;
      padding: 0 16px;
      gap: 10px;
      flex-shrink: 0;
    }
    .header-dot {
      width: 8px; height: 8px; border-radius: 50%;
    }
    .header-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
      flex: 1;
    }
    .header-badge {
      font-size: 9px;
      padding: 2px 8px;
      border-radius: 9999px;
      background: var(--accent);
      color: var(--on-accent);
      font-weight: 600;
    }

    /* Chat area */
    .chat {
      flex: 1;
      padding: 20px 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      overflow: hidden;
      ${hasGlass ? 'background: transparent;' : ''}
    }

    /* Bubbles */
    .bubble {
      max-width: 70%;
      padding: ${isPill ? '10px 18px' : '12px 16px'};
      font-size: 12px;
      line-height: 1.6;
      border-radius: ${isPill ? '20px' : 'var(--radius-lg, 12px)'};
    }
    .bubble.user {
      align-self: flex-end;
      background: var(--accent);
      color: var(--on-accent);
    }
    .bubble.assistant {
      align-self: flex-start;
      background: ${hasGlass ? glassPanel : 'var(--panel)'};
      ${blurCSS}
      color: var(--fg);
      border: 1px solid var(--edge-dim);
    }
    .bubble .meta {
      font-size: 9px;
      color: var(--fg-muted);
      margin-bottom: 4px;
    }
    .bubble.user .meta {
      color: var(--on-accent);
      opacity: 0.7;
    }

    /* Tool card */
    .tool-card {
      align-self: flex-start;
      background: var(--inset);
      border: 1px solid var(--edge-dim);
      border-radius: var(--radius-md, 8px);
      padding: 10px 14px;
      max-width: 60%;
    }
    .tool-card .tool-name {
      font-size: 10px;
      font-weight: 600;
      color: var(--accent);
      margin-bottom: 4px;
    }
    .tool-card .tool-body {
      font-size: 11px;
      color: var(--fg-dim);
      font-family: monospace;
    }

    /* Input bar */
    .input-bar {
      padding: 12px 16px;
      background: ${isFloating ? 'transparent' : (hasGlass ? glassPanel : 'var(--panel)')};
      ${!isFloating && hasGlass ? blurCSS : ''}
      border-top: ${isFloating ? 'none' : '1px solid var(--edge)'};
      flex-shrink: 0;
    }
    .input-inner {
      display: flex;
      align-items: center;
      gap: 8px;
      background: ${isFloating ? (hasGlass ? glassPanel : 'var(--panel)') : 'var(--well)'};
      ${isFloating && hasGlass ? blurCSS : ''}
      border: 1px solid var(--edge-dim);
      border-radius: ${isFloating ? 'var(--radius-xl, 16px)' : 'var(--radius-md, 8px)'};
      padding: 10px 14px;
      ${isFloating ? 'box-shadow: 0 2px 12px rgba(0,0,0,0.15);' : ''}
    }
    .input-placeholder {
      font-size: 12px;
      color: var(--fg-faint);
      flex: 1;
    }
    .send-btn {
      width: 28px; height: 28px;
      border-radius: 50%;
      background: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .send-btn svg { width: 14px; height: 14px; }

    /* Status bar */
    .status-bar {
      height: 28px;
      background: ${hasGlass ? glassPanel : 'var(--panel)'};
      ${blurCSS}
      border-top: 1px solid var(--edge);
      display: flex;
      align-items: center;
      padding: 0 12px;
      gap: 8px;
      flex-shrink: 0;
    }
    .status-pill {
      font-size: 9px;
      padding: 2px 8px;
      border-radius: 9999px;
      background: var(--well);
      color: var(--fg-dim);
    }
    .status-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #34c759;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-dot" style="background: var(--accent)"></div>
    <div class="header-title">${escapeHtml(name)}</div>
    <div class="header-badge">Theme Preview</div>
  </div>

  <div class="chat">
    <div class="bubble user">
      <div class="meta">You</div>
      Can you help me build a new feature?
    </div>
    <div class="bubble assistant">
      <div class="meta">Claude</div>
      Of course! I'd be happy to help. Let me take a look at the codebase first to understand the architecture.
    </div>
    <div class="tool-card">
      <div class="tool-name">Read src/main/app.ts</div>
      <div class="tool-body">export function createApp() { ... }</div>
    </div>
    <div class="bubble assistant">
      <div class="meta">Claude</div>
      I can see the entry point. Here's what I'd recommend for the implementation...
    </div>
  </div>

  <div class="input-bar">
    <div class="input-inner">
      <span class="input-placeholder">Message Claude...</span>
      <div class="send-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--on-accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12h14M12 5l7 7-7 7"/>
        </svg>
      </div>
    </div>
  </div>

  <div class="status-bar">
    <div class="status-dot"></div>
    <span class="status-pill">sonnet</span>
    <span class="status-pill">42% context</span>
    <span style="flex:1"></span>
    <span class="status-pill">${dark ? 'Dark' : 'Light'}</span>
  </div>
  <script>
    // Signal to the main-process capture loop that fonts + wallpaper + pattern
    // have all finished decoding. Main process polls window.__previewReady
    // every 50ms and captures as soon as it's true (or after a 3s cap).
    // Without this the old fixed 300ms delay raced large wallpapers.
    (async () => {
      const wait = [];
      if (document.fonts && document.fonts.ready) wait.push(document.fonts.ready);
      ${wallpaperDataUri ? `{
        const img = new Image();
        img.src = ${JSON.stringify(wallpaperDataUri)};
        wait.push(img.decode().catch(() => {}));
      }` : ''}
      ${patternDataUri ? `{
        const img = new Image();
        img.src = ${JSON.stringify(patternDataUri)};
        wait.push(img.decode().catch(() => {}));
      }` : ''}
      try { await Promise.all(wait); } catch {}
      // Double-rAF so Chromium has actually painted the decoded frames before
      // we let capturePage fire.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      window.__previewReady = true;
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
