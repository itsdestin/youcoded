import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const site = fs.readFileSync(path.resolve(__dirname, '../../docs/index.html'), 'utf8');

describe('landing demo fade', () => {
  it('clears and centers the demo exactly once on wide-screen activation', () => {
    expect(site).toContain('var demoActivated = false');
    expect(site).toContain('function activateDemo(){');
    expect(site).toContain('embedFade = 1; setFadeStop(1);');
    expect(site).toContain("embed.classList.add('interactive')");
    expect(site).toContain("document.querySelector('.hero-app').classList.add('revealed')");
    expect(site).toContain('if (!wideMQ.matches || demoActivated) return;');
    expect(site).toContain("behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'");
    expect(site).toContain('top: scrollY + er.top + er.height / 2 - innerHeight / 2');
  });

  it('finishes the passive reveal before the demo top leaves the viewport', () => {
    expect(site).toContain('var FADE_REVEAL_START = 240;');
    expect(site).toContain('var FADE_REVEAL_SPAN = 180;');
    expect(site).toContain('((FADE_REVEAL_START - er.top) / FADE_REVEAL_SPAN)');
    expect(site).toContain("embed.style.maskComposite = 'intersect'");
    expect(site).not.toContain('.frame.embed{overflow:hidden');
    expect(site).not.toContain('.frame.embed{clip-path:');
  });
});
