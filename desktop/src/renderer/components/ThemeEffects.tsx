import React, { useEffect, useRef } from 'react';
import { useTheme } from '../state/theme-context';

interface Particle {
  x: number; y: number; speed: number; opacity: number; length: number; size: number;
}

function drawRain(ctx: CanvasRenderingContext2D, particles: Particle[], w: number, h: number, rainColor: string) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = rainColor;
  ctx.lineWidth = 1;
  for (const p of particles) {
    ctx.globalAlpha = p.opacity;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - 1, p.y + p.length);
    ctx.stroke();
    p.y += p.speed;
    if (p.y > h) { p.y = -p.length; p.x = Math.random() * w; }
  }
  ctx.globalAlpha = 1;
}

function drawDust(ctx: CanvasRenderingContext2D, particles: Particle[], w: number, h: number, accent: string) {
  ctx.clearRect(0, 0, w, h);
  for (const p of particles) {
    ctx.globalAlpha = p.opacity;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1, 0, Math.PI * 2);
    ctx.fill();
    p.y -= p.speed * 0.3;
    p.x += Math.sin(p.y * 0.02) * 0.5;
    if (p.y < 0) { p.y = h; p.x = Math.random() * w; }
  }
  ctx.globalAlpha = 1;
}

function drawEmber(ctx: CanvasRenderingContext2D, particles: Particle[], w: number, h: number, accent: string) {
  ctx.clearRect(0, 0, w, h);
  const t = Date.now() * 0.001;
  for (const p of particles) {
    ctx.globalAlpha = p.opacity * 0.8;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    p.y -= p.speed;
    p.x += Math.sin(t + p.length) * 0.8;
    p.opacity -= 0.002;
    if (p.y < 0 || p.opacity <= 0) {
      p.y = h + 10; p.x = Math.random() * w;
      p.opacity = Math.random() * 0.5 + 0.2;
    }
  }
  ctx.globalAlpha = 1;
}

function drawSnow(ctx: CanvasRenderingContext2D, particles: Particle[], w: number, h: number, accent: string) {
  ctx.clearRect(0, 0, w, h);
  const t = Date.now() * 0.0005;
  for (const p of particles) {
    ctx.globalAlpha = p.opacity;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.length * 0.15 + 1, 0, Math.PI * 2);
    ctx.fill();
    p.y += p.speed * 0.4;
    p.x += Math.sin(t + p.length) * 0.6;
    if (p.y > h) { p.y = -5; p.x = Math.random() * w; }
  }
  ctx.globalAlpha = 1;
}

function drawCustom(
  ctx: CanvasRenderingContext2D,
  particles: Particle[],
  w: number, h: number,
  img: HTMLImageElement,
  drift: number,
) {
  ctx.clearRect(0, 0, w, h);
  const t = Date.now() * 0.001;
  for (const p of particles) {
    ctx.globalAlpha = p.opacity;
    ctx.drawImage(img, p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    p.y -= p.speed * 0.5;
    p.x += Math.sin(t + p.length) * drift;
    if (p.y < -p.size) {
      p.y = h + p.size;
      p.x = Math.random() * w;
    }
  }
  ctx.globalAlpha = 1;
}

const DEFAULT_PARTICLE_COUNT = 60;

export default function ThemeEffects() {
  const { activeTheme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const effects = activeTheme?.effects;
  const preset = effects?.particles ?? 'none';
  const accent = activeTheme?.tokens?.accent ?? '#888888';
  const particleCount = effects?.['particle-count'] ?? DEFAULT_PARTICLE_COUNT;
  const particleSpeed = effects?.['particle-speed'] ?? 1.0;
  const particleDrift = effects?.['particle-drift'] ?? 0.5;
  const sizeRange = effects?.['particle-size-range'] ?? [8, 16] as [number, number];
  const shapeSrc = effects?.['particle-shape'];

  // Load custom SVG particle image
  useEffect(() => {
    if (preset !== 'custom' || !shapeSrc) {
      imgRef.current = null;
      return;
    }
    const img = new Image();
    img.src = shapeSrc;
    img.onload = () => { imgRef.current = img; };
    img.onerror = () => { imgRef.current = null; };
  }, [preset, shapeSrc]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || preset === 'none') {
      cancelAnimationFrame(animRef.current);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    // Initialize particles
    particlesRef.current = Array.from({ length: particleCount }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      speed: (Math.random() * 2 + 1) * particleSpeed,
      opacity: Math.random() * 0.4 + 0.1,
      length: Math.random() * 15 + 5,
      size: Math.random() * (sizeRange[1] - sizeRange[0]) + sizeRange[0],
    }));

    const rainColor = accent + '40';
    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      if (preset === 'rain') drawRain(ctx, particlesRef.current, w, h, rainColor);
      else if (preset === 'dust') drawDust(ctx, particlesRef.current, w, h, accent);
      else if (preset === 'ember') drawEmber(ctx, particlesRef.current, w, h, accent);
      else if (preset === 'snow') drawSnow(ctx, particlesRef.current, w, h, accent);
      else if (preset === 'custom' && imgRef.current) {
        drawCustom(ctx, particlesRef.current, w, h, imgRef.current, particleDrift);
      }
      animRef.current = requestAnimationFrame(draw);
    };
    animRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', resize);
    };
  }, [preset, accent, particleCount, particleSpeed, particleDrift, sizeRange[0], sizeRange[1]]);

  if (preset === 'none') return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 0,
        pointerEvents: 'none',
        opacity: 0.6,
      }}
      aria-hidden="true"
    />
  );
}
