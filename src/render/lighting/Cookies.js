import * as THREE from 'three';

/**
 * Procedural spot-light cookies. Every pooled spot always carries a map so the
 * shader's `NUM_SPOT_LIGHT_MAPS` never changes and no program recompiles when a
 * light swaps its projection — the default cookie is a plain soft disc, which
 * also gives a nicer cone edge than three's smoothstep penumbra alone.
 */

const SIZE = 256;
const cache = new Map();

function makeTexture(draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, SIZE, SIZE);
  draw(g);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function vignette(g, inner = 0.18, outer = 0.5) {
  const grad = g.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * inner, SIZE / 2, SIZE / 2, SIZE * outer);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.72, 'rgba(255,255,255,0.72)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = grad;
  g.fillRect(0, 0, SIZE, SIZE);
  g.globalCompositeOperation = 'source-over';
}

const RECIPES = {
  soft(g) {
    const grad = g.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE * 0.5);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.55, '#f2f2f2');
    grad.addColorStop(0.86, '#8a8a8a');
    grad.addColorStop(1, '#000000');
    g.fillStyle = grad;
    g.fillRect(0, 0, SIZE, SIZE);
  },

  /** Bar-and-lens fixture: two bright lobes with a dark filament gap. */
  fixture(g) {
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(SIZE / 2, SIZE / 2, SIZE * 0.44, SIZE * 0.30, 0, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 0.35;
    g.fillStyle = '#000000';
    for (let i = 0; i < 5; i++) {
      const y = SIZE * (0.36 + i * 0.07);
      g.fillRect(SIZE * 0.1, y, SIZE * 0.8, SIZE * 0.012);
    }
    g.globalAlpha = 1;
    vignette(g, 0.1, 0.5);
  },

  /** Four-pane window: the classic interior shaft pattern. */
  window(g) {
    g.fillStyle = '#ffffff';
    g.fillRect(SIZE * 0.1, SIZE * 0.06, SIZE * 0.8, SIZE * 0.88);
    g.fillStyle = '#0a0a0a';
    g.fillRect(SIZE * 0.48, SIZE * 0.06, SIZE * 0.04, SIZE * 0.88);
    g.fillRect(SIZE * 0.1, SIZE * 0.46, SIZE * 0.8, SIZE * 0.05);
    g.filter = 'blur(3px)';
    g.drawImage(g.canvas, 0, 0);
    g.filter = 'none';
    vignette(g, 0.22, 0.62);
  },

  /** Horizontal blinds — reads instantly as an interior even in stills. */
  blinds(g) {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, SIZE, SIZE);
    g.fillStyle = '#000000';
    for (let i = 0; i < 9; i++) {
      g.fillRect(0, SIZE * (i / 9 + 0.055), SIZE, SIZE * 0.052);
    }
    g.filter = 'blur(2px)';
    g.drawImage(g.canvas, 0, 0);
    g.filter = 'none';
    vignette(g, 0.16, 0.55);
  },

  /** Dappled foliage break-up for outdoor lamps under trees. */
  dapple(g) {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, SIZE, SIZE);
    g.fillStyle = '#000000';
    let s = 1337;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 90; i++) {
      const x = rnd() * SIZE;
      const y = rnd() * SIZE;
      const r = SIZE * (0.02 + rnd() * 0.07);
      g.globalAlpha = 0.35 + rnd() * 0.5;
      g.beginPath();
      g.ellipse(x, y, r, r * (0.5 + rnd()), rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.filter = 'blur(3px)';
    g.drawImage(g.canvas, 0, 0);
    g.filter = 'none';
    vignette(g, 0.1, 0.5);
  },
};

export function cookie(name = 'soft') {
  const key = RECIPES[name] ? name : 'soft';
  let tex = cache.get(key);
  if (!tex) {
    tex = makeTexture(RECIPES[key]);
    tex.name = `cookie_${key}`;
    cache.set(key, tex);
  }
  return tex;
}

export function disposeCookies() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
