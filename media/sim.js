/*
 * Stillwell — pixel faucet.
 *
 * A falling-sand cellular automaton on a low-resolution grid, upscaled with
 * nearest-neighbour so every cell is a crisp square pixel.
 *
 * Why a cellular automaton rather than a shader or tweened SVG:
 *   - Sediment is just another particle type, so contamination is emergent
 *     rather than painted on.
 *   - Each water cell carries the contamination level it was BORN with, so when
 *     occupancy changes you watch the new water travel down the stream. The same
 *     water gets dirty; it is not a colour swap.
 *   - ~9k cells is trivial CPU, and integer upscaling stays legible at narrow
 *     sidebar widths where a soft gradient would turn to mush.
 */
'use strict';

const EMPTY = 0, WATER = 1, SED = 2, SOLID = 3;

// ---------------------------------------------------------------- palettes
// Brass, lit from the upper left. Index 0 = highlight … 4 = deep shadow.
const BRASS = [
  [0xf2, 0xdc, 0xa8], [0xd2, 0xa9, 0x60], [0xa8, 0x7c, 0x38],
  [0x6f, 0x50, 0x23], [0x3d, 0x2b, 0x13],
];

// Water contamination ramp. Discrete stops; the renderer dithers BETWEEN
// neighbouring stops so the gradient reads as pixel art, not a smooth blend.
//
// Every contaminated stop is deliberately DARKER and LESS saturated than BRASS.
// An earlier golden-amber ramp sat on the same hue as the fixture, so dirty water
// read as "more brass" and the tap stopped being readable against its own stream.
const WATER_RAMP = [
  [0.00, [0xc6, 0xe9, 0xf2]], [0.14, [0x8e, 0xc8, 0xd8]],
  [0.28, [0x8f, 0xb5, 0xa8]], [0.42, [0x9c, 0xa0, 0x6a]],
  [0.56, [0x8a, 0x78, 0x40]], [0.70, [0x68, 0x51, 0x2a]],
  [0.84, [0x42, 0x2f, 0x19]], [1.00, [0x1e, 0x14, 0x0b]],
];
const SED_RAMP = [
  [0.00, [0x7e, 0x8c, 0x8a]], [0.35, [0x6d, 0x5a, 0x33]],
  [0.65, [0x43, 0x30, 0x18]], [1.00, [0x16, 0x0e, 0x07]],
];

// 4x4 Bayer matrix, normalised. Classic ordered dithering.
const BAYER = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
].map((r) => r.map((v) => (v + 0.5) / 16));

function rampLookup(ramp, t) {
  const c = Math.max(0, Math.min(1, t));
  for (let i = 0; i < ramp.length - 1; i++) {
    const [p0, c0] = ramp[i], [p1, c1] = ramp[i + 1];
    if (c >= p0 && c <= p1) {
      const f = p1 === p0 ? 0 : (c - p0) / (p1 - p0);
      return { lo: c0, hi: c1, f };
    }
  }
  const last = ramp[ramp.length - 1][1];
  return { lo: last, hi: last, f: 0 };
}

class Faucet {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d', { alpha: false });

    this.W = 0; this.H = 0;
    this.frame = 0;

    // Contamination: `target` is set from real data, `current` eases toward it so
    // a compaction glides clear instead of snapping.
    this.target = 0;
    this.current = 0;
    // Easing is for CHANGES. On the very first real reading we snap, otherwise the
    // opening frames show clean water that was never actually clean.
    this.primed = false;
    this.known = false;      // false => occupancy unknown, render as idle-ish
    this.flowing = true;     // false => idle trickle only
    this.paused = false;
    this.calm = false;       // reduced motion
    this.warn = false;

    this.rand = 0x2f6e2b1;
    this.resize();
  }

  // Cheap deterministic PRNG — avoids Math.random bias patterns in the sim.
  rnd() {
    let x = this.rand;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rand = x >>> 0;
    return this.rand / 4294967296;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(60, Math.floor(rect.width)) || 220;
    const cssH = Math.max(120, Math.floor(rect.height)) || 420;

    // The composition is inherently vertical (tap above, long fall, basin), so
    // the grid is driven by HEIGHT and width follows the aspect. Deriving it from
    // width instead made the tap swallow a wide panel.
    const H = Math.max(90, Math.min(190, Math.round(cssH / 3.2)));
    const W = Math.max(36, Math.min(150, Math.round(H * (cssW / cssH))));

    if (W === this.W && H === this.H) { this.fit(cssW, cssH); return; }
    this.W = W; this.H = H;
    const n = W * H;
    this.type = new Uint8Array(n);
    this.tint = new Uint8Array(n);
    this.shade = new Uint8Array(n);
    this.moved = new Uint8Array(n);
    this.off.width = W; this.off.height = H;
    this.img = this.offCtx.createImageData(W, H);
    this.buildFaucet();
    this.fit(cssW, cssH);
  }

  fit(cssW, cssH) {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(cssW * dpr);
    this.canvas.height = Math.floor(cssH * dpr);
    this.ctx.imageSmoothingEnabled = false;
  }

  idx(x, y) { return y * this.W + x; }
  inB(x, y) { return x >= 0 && x < this.W && y >= 0 && y < this.H; }

  /**
   * Shade across a cylinder cross-section. A linear ramp made the tap look like
   * flat cardboard; real tubing has a specular band just off the lit edge and
   * falls dark at BOTH edges.
   */
  cylShade(p) {
    if (p < 0.16) return 2;
    if (p < 0.34) return 0;   // specular band
    if (p < 0.54) return 1;
    if (p < 0.76) return 2;
    if (p < 0.90) return 3;
    return 4;
  }

  /** Stamp a shaded brass rectangle. `axis` picks the cylinder axis. */
  rect(x0, y0, x1, y1, axis, bias) {
    const b = bias || 0;
    const X0 = Math.round(x0), X1 = Math.round(x1);
    const Y0 = Math.round(y0), Y1 = Math.round(y1);
    for (let y = Math.max(0, Y0); y <= Math.min(this.H - 1, Y1); y++) {
      for (let x = Math.max(0, X0); x <= Math.min(this.W - 1, X1); x++) {
        const span = axis === 'x' ? X1 - X0 : Y1 - Y0;
        const pos = axis === 'x' ? x - X0 : y - Y0;
        const p = span <= 0 ? 0.3 : pos / span;
        const s = Math.max(0, Math.min(4, this.cylShade(p) + b));
        const i = this.idx(x, y);
        this.type[i] = SOLID;
        this.shade[i] = s;
      }
    }
  }

  /**
   * Procedural pixel-art tap: wall flange, horizontal feed pipe, valve body with
   * a lever on top, then a gooseneck dropping to a centred spout.
   * Built from shaded rects so proportions can be tuned without redrawing a bitmap.
   */
  buildFaucet() {
    this.type.fill(EMPTY); this.shade.fill(0); this.tint.fill(0);
    const W = this.W, H = this.H;
    const cx = Math.floor(W * 0.5);

    // Geometry is expressed as fractions of `span`, the tap's total height, so
    // the fixture keeps its proportions in a 36-wide sidebar and a 150-wide panel
    // alike. Earlier unit-grid sizing broke badly as the aspect changed.
    const top = Math.round(H * 0.045);
    const span = Math.round(H * 0.30);
    const y = (f) => top + Math.round(span * f);
    const wx = (f) => Math.max(1, Math.round(span * f));

    // Handle lever across the top, then the stem down into the valve body.
    this.rect(cx - wx(0.34), y(0.00), cx + wx(0.34), y(0.10), 'y', 0);
    this.rect(cx - wx(0.06), y(0.10), cx + wx(0.06), y(0.24), 'x', 0);
    // Wall flange and the horizontal feed pipe arriving from the left.
    this.rect(0, y(0.26), Math.max(1, Math.round(W * 0.045)), y(0.56), 'x', 1);
    this.rect(0, y(0.32), cx - wx(0.24), y(0.48), 'y', 0);
    // Valve body.
    this.rect(cx - wx(0.26), y(0.22), cx + wx(0.26), y(0.54), 'x', 0);
    // Gooseneck dropping to the spout, then the narrower tip.
    this.rect(cx - wx(0.19), y(0.54), cx + wx(0.19), y(0.86), 'x', 0);
    this.rect(cx - wx(0.14), y(0.86), cx + wx(0.14), y(1.00), 'x', 1);

    this.spoutX = cx;
    this.spoutY = y(1.00) + 1;
    this.spoutR = Math.max(1, wx(0.095));

    // Shallow basin, low enough that the fall dominates the composition.
    const bTop = Math.round(H * 0.88);
    this.basinTop = bTop;
    const lip = Math.max(1, Math.round(W * 0.03));
    this.rect(0, H - 2, W - 1, H - 1, 'y', 2);
    this.rect(0, bTop, lip, H - 1, 'x', 2);
    this.rect(W - 1 - lip, bTop, W - 1, H - 1, 'x', 2);
  }

  /** Clear all fluid but keep the fixture. Used on reset / session change. */
  clearWater() {
    for (let i = 0; i < this.type.length; i++) {
      if (this.type[i] === WATER || this.type[i] === SED) { this.type[i] = EMPTY; this.tint[i] = 0; }
    }
  }

  setUsage({ ratio, known, flowing, warn }) {
    this.known = !!known;
    this.flowing = flowing !== false;
    this.warn = !!warn;
    if (typeof ratio === 'number' && isFinite(ratio)) {
      this.target = Math.max(0, Math.min(1, ratio));
      if (!this.primed && this.known) {
        this.current = this.target;
        this.primed = true;
        this.clearWater(); // drop the stale column so it refills at the true colour
      }
    }
  }

  move(from, to) {
    this.type[to] = this.type[from]; this.tint[to] = this.tint[from];
    this.type[from] = EMPTY; this.tint[from] = 0;
    this.moved[to] = 1;
  }

  emit() {
    // Ease contamination toward target. Slow enough to feel deliberate; a
    // compaction visibly flushes clear over a couple of seconds.
    this.current += (this.target - this.current) * (this.calm ? 0.02 : 0.045);

    const y = this.spoutY;
    if (y + 1 >= this.H) return;

    if (!this.flowing || !this.known) {
      // Idle: an occasional single droplet, so the scene breathes without
      // implying a live reading.
      if (this.frame % (this.calm ? 150 : 90) === 0) {
        const i = this.idx(this.spoutX, y);
        if (this.type[i] === EMPTY) { this.type[i] = WATER; this.tint[i] = 0; }
      }
      return;
    }

    // Flow narrows and stutters slightly at very high occupancy — pressure
    // dropping as the tank fills. Subtle, never alarming.
    const c = this.current;
    const stutter = c > 0.9 && (this.frame % 11 === 0);
    if (stutter) return;
    const r = c > 0.82 ? Math.max(1, this.spoutR - 1) : this.spoutR;

    // The stream is emitted as a SOLID horizontal run whose width and centre vary
    // smoothly over time. Dropping individual edge cells at random looked like
    // falling sand: once a gap opens in free fall nothing closes it, because every
    // cell falls at the same speed. Varying the run instead keeps the column
    // packed while the silhouette travels down the stream organically.
    const wob = Math.sin(this.frame * 0.031) * 0.9 + Math.sin(this.frame * 0.013) * 0.6;
    const breathe = 1 + Math.sin(this.frame * 0.047) * 0.18;
    const half = Math.max(1, Math.round(r * breathe));
    const cxs = this.spoutX + Math.round(wob);

    for (let dx = -half; dx <= half; dx++) {
      const x = cxs + dx;
      if (!this.inB(x, y)) continue;
      const i = this.idx(x, y);
      if (this.type[i] !== EMPTY) continue;
      // Sediment replaces a cell INSIDE the column rather than flying alongside it,
      // so grit shows without punching holes in the water.
      const sedChance = c < 0.2 ? 0 : (c - 0.2) * 0.16;
      const isSed = this.rnd() < sedChance;
      this.type[i] = isSed ? SED : WATER;
      const j = (this.rnd() - 0.5) * 0.05;
      this.tint[i] = Math.max(0, Math.min(255, Math.round((c + j) * 255)));
    }
  }

  step() {
    this.moved.fill(0);
    this.emit();
    const W = this.W, H = this.H;

    for (let y = H - 2; y >= 0; y--) {
      // Alternate scan direction per row/frame so water doesn't drift one way.
      const ltr = ((this.frame + y) & 1) === 0;
      for (let k = 0; k < W; k++) {
        const x = ltr ? k : W - 1 - k;
        const i = this.idx(x, y);
        const t = this.type[i];
        if (t !== WATER && t !== SED) continue;
        if (this.moved[i]) continue;

        const below = this.idx(x, y + 1);
        if (this.type[below] === EMPTY) {
          // One cell per tick. Falling two cells made the stream visibly dashed,
          // because the emitter only fills one row per tick; speed comes from the
          // tick rate instead.
          // No lateral drift in free fall: it opened gaps that never closed,
          // turning the stream into a sparse spray.
          this.move(i, below);
          continue;
        }

        // Sediment sinks through water.
        if (t === SED && this.type[below] === WATER) {
          const tmpT = this.type[below], tmpC = this.tint[below];
          this.type[below] = SED; this.tint[below] = this.tint[i];
          this.type[i] = tmpT; this.tint[i] = tmpC;
          this.moved[below] = 1;
          continue;
        }

        // Diagonal slide.
        const dir = this.rnd() < 0.5 ? -1 : 1;
        let slid = false;
        for (const d of [dir, -dir]) {
          const nx = x + d;
          if (!this.inB(nx, y + 1)) continue;
          if (this.type[this.idx(nx, y + 1)] === EMPTY) {
            this.move(i, this.idx(nx, y + 1)); slid = true; break;
          }
        }
        if (slid) continue;

        // Water spreads sideways to level out; sediment mostly piles up.
        if (t === WATER) {
          const reach = 4;
          for (const d of [dir, -dir]) {
            for (let s = 1; s <= reach; s++) {
              const nx = x + d * s;
              if (!this.inB(nx, y)) break;
              const ni = this.idx(nx, y);
              if (this.type[ni] === SOLID) break;
              if (this.type[ni] === EMPTY) { this.move(i, ni); slid = true; break; }
            }
            if (slid) break;
          }
        }
      }
    }

    this.drain();
    this.frame++;
  }

  /**
   * Drain the basin so the pool holds a stable level instead of filling the
   * screen. Sediment drains more slowly, so sludge visibly lingers when the
   * water is dirty.
   */
  drain() {
    const W = this.W, H = this.H;
    const row = H - 3;
    if (row < 0) return;
    for (let x = 1; x < W - 1; x++) {
      const i = this.idx(x, row);
      const t = this.type[i];
      if (t === WATER && this.rnd() < 0.30) { this.type[i] = EMPTY; this.tint[i] = 0; }
      else if (t === SED && this.rnd() < 0.07) { this.type[i] = EMPTY; this.tint[i] = 0; }
    }
  }

  render(dim) {
    const W = this.W, H = this.H, d = this.img.data;
    const bg = dim ? [0x0b, 0x0c, 0x0e] : [0x0e, 0x0f, 0x12];
    // Idle dims the scene but must not hide the fixture: at 0.55 the tap all but
    // vanished, which reads as "broken" rather than "resting".
    const fade = dim ? 0.78 : 1;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = this.idx(x, y);
        const o = i * 4;
        const t = this.type[i];
        let r, g, b;

        if (t === SOLID) {
          const c = BRASS[this.shade[i]];
          r = c[0]; g = c[1]; b = c[2];
        } else if (t === EMPTY) {
          // Subtle vertical vignette so the void isn't dead flat.
          const v = 1 - (y / H) * 0.25;
          r = bg[0] * v; g = bg[1] * v; b = bg[2] * v;
        } else {
          const cc = this.tint[i] / 255;
          const ramp = t === SED ? SED_RAMP : WATER_RAMP;
          const { lo, hi, f } = rampLookup(ramp, cc);
          // Ordered dithering between adjacent ramp stops.
          const pick = f > BAYER[y & 3][x & 3] ? hi : lo;
          r = pick[0]; g = pick[1]; b = pick[2];

          if (t === WATER) {
            // Specular edge: a water cell with empty space to its left catches
            // light. Fades out as the water turns opaque.
            const leftEmpty = x > 0 && this.type[i - 1] === EMPTY;
            const gloss = (1 - cc) * 0.55;
            if (leftEmpty && gloss > 0.04) {
              r += (255 - r) * gloss; g += (255 - g) * gloss; b += (255 - b) * gloss;
            }
          }
        }
        d[o] = r * fade; d[o + 1] = g * fade; d[o + 2] = b * fade; d[o + 3] = 255;
      }
    }

    this.offCtx.putImageData(this.img, 0, 0);
    const cw = this.canvas.width, ch = this.canvas.height;
    this.ctx.fillStyle = '#0b0c0e';
    this.ctx.fillRect(0, 0, cw, ch);
    this.ctx.imageSmoothingEnabled = false;
    // Integer-ish scale, letterboxed, to keep pixels square and crisp.
    const scale = Math.max(1, Math.floor(Math.min(cw / W, ch / H)));
    const dw = W * scale, dh = H * scale;
    this.ctx.drawImage(this.off, Math.floor((cw - dw) / 2), Math.floor((ch - dh) / 2), dw, dh);
  }
}

if (typeof module !== 'undefined') { module.exports = { Faucet }; }
