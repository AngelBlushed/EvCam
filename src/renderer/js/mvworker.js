'use strict';
/*
 * Motion estimation for the frame smoother (runs in a Worker, so a busy estimation never delays the compositor).
 *
 * In : { seq, rgba } - one 256x144 RGBA copy of every frame that arrives from the phone.
 * Out: { seq, mv }   - for the pair (previous frame, this frame): one displacement per 8x8 block (32x18 blocks), as
 *                      Float32 pairs (dx, dy) in pixels of the 256x144 copy, prev -> this, centred on the
 *                      in-between picture (symmetric block matching), or null for the first frame.
 *
 * Three steps, each starting from the previous one:
 *   1. coarse: 8x8 blocks on a 128x72 picture, every other displacement up to +-16 px (+-32 px of the 256x144 one:
 *      a drum stick moves a lot between two frames at 20 fps), then +-1 around the winner;
 *   2. fine: 8x8 blocks on 256x144, +-2 around the coarse vector of the parent block, and the neighbours' vectors;
 *   3. a 3x3 median filter, which removes the isolated wrong vectors.
 * A vector must beat the zero vector clearly (noise must not move anything), and a candidate borrowed from a
 * neighbour wins ties against a lone vector, which keeps the field coherent where the picture has little texture.
 */
const W = 256;
const H = 144;
const CW = 128;
const CH = 72;
const BS = 8;                  // block size, on both levels
const BX = W / BS;             // 32 fine blocks across
const BY = H / BS;             // 18
const CBX = CW / BS;           // 16 coarse blocks across
const CBY = CH / BS;           // 9
const COARSE_R = 16;
const REFINE_R = 2;

let prevFine = null;
let prevCoarse = null;

function luma(rgba) {
  const out = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return out;
}

function shrink2(fine) {
  const out = new Uint8Array(CW * CH);
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const i = y * 2 * W + x * 2;
      out[y * CW + x] = (fine[i] + fine[i + 1] + fine[i + W] + fine[i + W + 1]) >> 2;
    }
  }
  return out;
}

/**
 * Cost of moving by (dx, dy) in total between `a` (previous) and `b` (current) for the block at (x0, y0): the block
 * is read half the way back in `a` and half the way forward in `b`. Stops early once `limit` is exceeded.
 */
function cost(a, b, w, h, x0, y0, dx, dy, limit) {
  const ax = -(dx >> 1);
  const ay = -(dy >> 1);
  const bx = dx - (dx >> 1);
  const by = dy - (dy >> 1);
  let sum = 0;
  for (let y = 0; y < BS; y++) {
    let ya = y0 + y + ay;
    let yb = y0 + y + by;
    ya = ya < 0 ? 0 : ya >= h ? h - 1 : ya;
    yb = yb < 0 ? 0 : yb >= h ? h - 1 : yb;
    const ra = ya * w;
    const rb = yb * w;
    for (let x = 0; x < BS; x++) {
      let xa = x0 + x + ax;
      let xb = x0 + x + bx;
      xa = xa < 0 ? 0 : xa >= w ? w - 1 : xa;
      xb = xb < 0 ? 0 : xb >= w ? w - 1 : xb;
      const d = a[ra + xa] - b[rb + xb];
      sum += d < 0 ? -d : d;
    }
    if (sum > limit) return sum;
  }
  return sum;
}

/** Best vector for one block among the candidates [cx + i, cy + j] (i, j in -r..r, every `step`), plus extra candidates. */
function search(a, b, w, h, x0, y0, zero, cx, cy, r, step, extra, penalty) {
  let best = zero * 0.88;           // a vector must be clearly better than standing still
  let bx = 0;
  let by = 0;
  const tryVec = (vx, vy, pen) => {
    if (!vx && !vy) return;
    const c = cost(a, b, w, h, x0, y0, vx, vy, best - pen) + pen;
    if (c < best) { best = c; bx = vx; by = vy; }
  };
  for (let j = -r; j <= r; j += step) {
    for (let i = -r; i <= r; i += step) {
      const vx = cx + i;
      const vy = cy + j;
      tryVec(vx, vy, penalty * (Math.abs(vx) + Math.abs(vy)));
    }
  }
  // vectors of the neighbours: cheaper to adopt (no penalty for their size), so a textureless block follows its surroundings
  for (let k = 0; k < extra.length; k += 2) tryVec(extra[k], extra[k + 1], 0);
  return { x: bx, y: by, cost: best };
}

function estimate(pf, cf, pc, cc) {
  // ---- 1. coarse
  const cmx = new Int16Array(CBX * CBY);
  const cmy = new Int16Array(CBX * CBY);
  for (let by = 0; by < CBY; by++) {
    for (let bx = 0; bx < CBX; bx++) {
      const x0 = bx * BS;
      const y0 = by * BS;
      const zero = cost(pc, cc, CW, CH, x0, y0, 0, 0, 1e9);
      if (zero <= BS * BS * 1.5) continue;           // static or flat: stays at zero
      const extra = [];
      if (bx > 0) extra.push(cmx[by * CBX + bx - 1], cmy[by * CBX + bx - 1]);
      if (by > 0) extra.push(cmx[(by - 1) * CBX + bx], cmy[(by - 1) * CBX + bx]);
      let r1 = search(pc, cc, CW, CH, x0, y0, zero, 0, 0, COARSE_R, 2, extra, 2);
      if (r1.x || r1.y) {
        const r2 = search(pc, cc, CW, CH, x0, y0, zero, r1.x, r1.y, 1, 1, [], 2);
        if (r2.x || r2.y) r1 = r2;
      }
      cmx[by * CBX + bx] = r1.x;
      cmy[by * CBX + bx] = r1.y;
    }
  }
  // ---- 2. fine, starting from the coarse vector of the parent block (doubled: the fine picture is twice as big)
  const mx = new Float32Array(BX * BY);
  const my = new Float32Array(BX * BY);
  for (let by = 0; by < BY; by++) {
    for (let bx = 0; bx < BX; bx++) {
      const ci = (by >> 1) * CBX + (bx >> 1);
      const sx = cmx[ci] * 2;
      const sy = cmy[ci] * 2;
      const x0 = bx * BS;
      const y0 = by * BS;
      const zero = cost(pf, cf, W, H, x0, y0, 0, 0, 1e9);
      if (zero <= BS * BS * 1.5) continue;
      const extra = [sx, sy];
      if (bx > 0) extra.push(mx[by * BX + bx - 1], my[by * BX + bx - 1]);
      if (by > 0) extra.push(mx[(by - 1) * BX + bx], my[(by - 1) * BX + bx]);
      const r = search(pf, cf, W, H, x0, y0, zero, sx, sy, REFINE_R, 1, extra, 1);
      mx[by * BX + bx] = r.x;
      my[by * BX + bx] = r.y;
    }
  }
  // ---- 3. 3x3 median filter (each component on its own)
  const out = new Float32Array(BX * BY * 2);
  const win = new Float32Array(9);
  const med = (src, x, y) => {
    let n = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const xx = Math.min(BX - 1, Math.max(0, x + i));
        const yy = Math.min(BY - 1, Math.max(0, y + j));
        win[n++] = src[yy * BX + xx];
      }
    }
    for (let i = 1; i < 9; i++) {              // small insertion sort
      const v = win[i];
      let k = i - 1;
      while (k >= 0 && win[k] > v) { win[k + 1] = win[k]; k--; }
      win[k + 1] = v;
    }
    return win[4];
  };
  for (let y = 0; y < BY; y++) {
    for (let x = 0; x < BX; x++) {
      out[(y * BX + x) * 2] = med(mx, x, y);
      out[(y * BX + x) * 2 + 1] = med(my, x, y);
    }
  }
  return out;
}

self.onmessage = (event) => {
  const { seq, rgba } = event.data;
  const fine = luma(new Uint8ClampedArray(rgba));
  const coarse = shrink2(fine);
  let mv = null;
  if (prevFine) mv = estimate(prevFine, fine, prevCoarse, coarse);
  prevFine = fine;
  prevCoarse = coarse;
  if (mv) self.postMessage({ seq, mv }, [mv.buffer]);
  else self.postMessage({ seq, mv: null });
};
