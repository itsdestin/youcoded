import { BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';

const PREVIEW_WIDTH = 800;
const PREVIEW_HEIGHT = 500;

/**
 * Generates a preview PNG for a theme by rendering a mock DestinCode UI
 * with the theme's tokens applied, then capturing it as an image.
 *
 * Uses Electron's offscreen rendering to avoid flashing a visible window.
 * Returns the path to the generated preview.png.
 */
export async function generateThemePreview(
  themeDir: string,
  manifest: Record<string, any>,
): Promise<string> {
  const html = buildPreviewHTML(manifest, themeDir);
  const outputPath = path.join(themeDir, 'preview.png');

  // Create an offscreen window
  const win = new BrowserWindow({
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    // Load the HTML content
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    // Wait for fonts/rendering to settle
    await new Promise(r => setTimeout(r, 300));

    // Capture the page
    const image = await win.webContents.capturePage();
    const pngBuffer = image.toPNG();

    await fs.promises.writeFile(outputPath, pngBuffer);
    return outputPath;
  } finally {
    win.destroy();
  }
}

/**
 * Builds a self-contained HTML string that mocks the DestinCode UI
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
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
