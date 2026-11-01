// Map generation: seeded value noise shaped into one continent.

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function noiseLayer(w, h, rand, cell) {
  const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const out = new Float32Array(w * h);
  const s = t => t * t * (3 - 2 * t);
  for (let y = 0; y < h; y++) {
    const gy = y / cell, y0 = Math.floor(gy), fy = s(gy - y0);
    for (let x = 0; x < w; x++) {
      const gx = x / cell, x0 = Math.floor(gx), fx = s(gx - x0);
      const a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1];
      const c = grid[(y0 + 1) * gw + x0], d = grid[(y0 + 1) * gw + x0 + 1];
      out[y * w + x] = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    }
  }
  return out;
}

function fractal(w, h, rand, cells) {
  const out = new Float32Array(w * h);
  let amp = 1;
  for (const cell of cells) {
    const layer = noiseLayer(w, h, rand, cell);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    amp *= 0.5;
  }
  return out;
}

// Value at quantile q of an array (q in 0..1).
function quantile(arr, q) {
  const sorted = Float32Array.from(arr).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function generateMap(w, h, seed) {
  const rand = mulberry32(seed);
  const elev = fractal(w, h, rand, [40, 20, 10, 5]);
  const moist = fractal(w, h, rand, [24, 12, 6]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x / w - 0.5) * 2, dy = (y / h - 0.5) * 2;
      elev[y * w + x] -= (dx * dx + dy * dy) * 0.9;
    }
  }
  const sea = quantile(elev, 0.42);
  const land = [];
  for (let i = 0; i < elev.length; i++) if (elev[i] >= sea) land.push(elev[i]);
  const hillLine = quantile(land, 0.78), mountainLine = quantile(land, 0.93);
  const forestLine = quantile(moist, 0.62);

  const terrain = new Uint8Array(w * h);
  for (let i = 0; i < terrain.length; i++) {
    const e = elev[i];
    if (e < sea) terrain[i] = WATER;
    else if (e >= mountainLine) terrain[i] = MOUNTAINS;
    else if (e >= hillLine) terrain[i] = HILLS;
    else terrain[i] = moist[i] >= forestLine ? FOREST : PLAINS;
  }
  const landId = labelLandmasses(w, h, terrain);
  return { w, h, terrain, landId };
}

// Gives every landmass an id (water is -1). Islands smaller than ECON.minIsland are sunk.
function labelLandmasses(w, h, terrain) {
  const comp = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const stack = [];
  for (let start = 0; start < terrain.length; start++) {
    if (terrain[start] === WATER || comp[start] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    comp[start] = id; stack.push(start);
    while (stack.length) {
      const i = stack.pop(); size++;
      const x = i % w, y = (i - x) / w;
      for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (n >= 0 && terrain[n] !== WATER && comp[n] < 0) { comp[n] = id; stack.push(n); }
      }
    }
    sizes.push(size);
  }
  for (let i = 0; i < terrain.length; i++) {
    if (comp[i] >= 0 && sizes[comp[i]] < ECON.minIsland) { terrain[i] = WATER; comp[i] = -1; }
  }
  return comp;
}
