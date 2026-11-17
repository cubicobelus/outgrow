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
  climate(w, h, terrain, moist, rand);
  const landId = labelLandmasses(w, h, terrain);
  return { w, h, terrain, landId };
}

// Some generated maps get a desert or a cold edge, many get neither: a dry patch turns the driest
// lowland to desert, and a cold top and/or bottom turns lowland there to tundra (hills and mountains
// stay). Drawn after the land is made, so the same seed keeps the same coastline.
function climate(w, h, terrain, moist, rand) {
  const low = i => terrain[i] === PLAINS || terrain[i] === FOREST;
  if (rand() < 0.4) {
    const dry = fractal(w, h, rand, [36, 18, 9]);
    for (let i = 0; i < dry.length; i++) dry[i] -= moist[i] * 0.5;
    const share = 0.06 + rand() * 0.12, lowDry = [];
    for (let i = 0; i < dry.length; i++) if (low(i)) lowDry.push(dry[i]);
    const line = quantile(lowDry, 1 - share);
    for (let i = 0; i < dry.length; i++) if (low(i) && dry[i] >= line) terrain[i] = DESERT;
  }
  if (rand() < 0.35) {
    const side = rand(), depth = 0.12 + rand() * 0.1, edge = fractal(w, h, rand, [12, 6]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, j = (edge[i] - 0.5) * 0.08, top = y / h + j, bottom = 1 - y / h + j;
      if (low(i) && ((side < 0.7 && top < depth) || (side > 0.3 && bottom < depth))) terrain[i] = TUNDRA;
    }
  }
}

// Gives every landmass an id (water is -1). Islands smaller than `minIsland` tiles are sunk.
function labelLandmasses(w, h, terrain, minIsland = ECON.minIsland) {
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
    if (comp[i] >= 0 && sizes[comp[i]] < minIsland) { terrain[i] = WATER; comp[i] = -1; }
  }
  return comp;
}

// A real-world map from worldmaps.js. Small real islands are kept (only specks are sunk).
function loadWorldMap(key) {
  const def = WORLD_MAPS[key], terrain = new Uint8Array(def.w * def.h);
  let i = 0;
  for (const [, n, c] of def.rle.matchAll(/(\d+)([wpfhmdt])/g)) terrain.fill('wpfhmdt'.indexOf(c), i, i += +n);
  return { w: def.w, h: def.h, terrain, landId: labelLandmasses(def.w, def.h, terrain, 6) };
}

// The map catalogue, in display order. `generated` makes new terrain every match; the rest are real
// maps in worldmaps.js. Regions drive the picker's filter chips.
const MAP_INFO = [
  { id: 'generated', name: 'Generated', regions: ['Continents'], note: 'new terrain every match' },
  { id: 'random', name: 'Random', regions: ['Continents'], note: 'a real map, picked when you press Play' },
  { id: 'world', name: 'World', regions: ['Continents'] },
  { id: 'europe', name: 'Europe', regions: ['Europe'] },
  { id: 'northamerica', name: 'North America', regions: ['Continents', 'Americas'] },
  { id: 'mediterranean', name: 'Mediterranean', regions: ['Europe', 'Africa', 'Seas & islands'] },
  { id: 'eastasia', name: 'East Asia', regions: ['Asia'] },
  { id: 'africa', name: 'Africa', regions: ['Continents', 'Africa'] },
  { id: 'southamerica', name: 'South America', regions: ['Continents', 'Americas'] },
  { id: 'asia', name: 'Asia', regions: ['Continents', 'Asia'] },
  { id: 'oceania', name: 'Australia and the Pacific', regions: ['Continents', 'Oceania'] },
  { id: 'seasia', name: 'Southeast Asia', regions: ['Asia', 'Oceania', 'Seas & islands'] },
  { id: 'caribbean', name: 'Caribbean', regions: ['Americas', 'Seas & islands'] },
  { id: 'middleeast', name: 'Middle East', regions: ['Asia', 'Africa'] },
  { id: 'britishisles', name: 'British Isles', regions: ['Europe', 'Seas & islands'] },
  { id: 'japan', name: 'Japan', regions: ['Asia', 'Seas & islands'] },
  { id: 'usa', name: 'United States', regions: ['Americas'] },
  { id: 'scandinavia', name: 'Scandinavia and the Baltic', regions: ['Europe'] },
  { id: 'iberia', name: 'Iberia', regions: ['Europe', 'Seas & islands'] },
  { id: 'centraleurope', name: 'Central Europe', regions: ['Europe'] },
  { id: 'balkans', name: 'Balkans', regions: ['Europe'] },
  { id: 'blacksea', name: 'Black Sea', regions: ['Europe', 'Asia', 'Seas & islands'] },
  { id: 'caucasus', name: 'Caucasus', regions: ['Europe', 'Asia'] },
  { id: 'centralasia', name: 'Central Asia', regions: ['Asia'] },
  { id: 'siberia', name: 'Siberia', regions: ['Asia'] },
  { id: 'arctic', name: 'Arctic and Greenland', regions: ['Americas', 'Europe', 'Seas & islands'] },
  { id: 'southasia', name: 'South Asia', regions: ['Asia'] },
  { id: 'canada', name: 'Canada', regions: ['Americas'] },
  { id: 'mexico', name: 'Mexico', regions: ['Americas'] },
  { id: 'centralamerica', name: 'Central America', regions: ['Americas'] },
  { id: 'gulfofmexico', name: 'Gulf of Mexico', regions: ['Americas', 'Seas & islands'] },
  { id: 'greatlakes', name: 'Great Lakes', regions: ['Americas'] },
  { id: 'pacificnw', name: 'Pacific Northwest', regions: ['Americas'] },
  { id: 'brazil', name: 'Brazil', regions: ['Americas'] },
  { id: 'amazon', name: 'Amazon basin', regions: ['Americas'] },
  { id: 'andes', name: 'Andes', regions: ['Americas'] },
  { id: 'patagonia', name: 'Patagonia', regions: ['Americas'] },
  { id: 'sahara', name: 'Sahara', regions: ['Africa'] },
  { id: 'westafrica', name: 'West Africa', regions: ['Africa'] },
  { id: 'eastafrica', name: 'East Africa', regions: ['Africa'] },
  { id: 'southernafrica', name: 'Southern Africa', regions: ['Africa'] },
  { id: 'nile', name: 'Egypt and the Nile', regions: ['Africa', 'Asia'] },
  { id: 'madagascar', name: 'Madagascar', regions: ['Africa', 'Seas & islands'] },
  { id: 'turkey', name: 'Turkey', regions: ['Europe', 'Asia'] },
  { id: 'china', name: 'China', regions: ['Asia'] },
  { id: 'indonesia', name: 'Indonesia', regions: ['Asia', 'Oceania', 'Seas & islands'] },
  { id: 'philippines', name: 'Philippines', regions: ['Asia', 'Oceania', 'Seas & islands'] },
  { id: 'hawaii', name: 'Hawaii', regions: ['Oceania', 'Seas & islands'] },
  { id: 'aegean', name: 'Aegean', regions: ['Europe', 'Seas & islands'] },
  { id: 'newzealand', name: 'New Zealand', regions: ['Oceania', 'Seas & islands'] },
  { id: 'gulfs', name: 'Persian Gulf and Red Sea', regions: ['Asia', 'Africa', 'Seas & islands'] },
  { id: 'norwegiansea', name: 'Iceland and the Norwegian Sea', regions: ['Europe', 'Seas & islands'] },
];
const MAP_REGIONS = ['Continents', 'Americas', 'Europe', 'Asia', 'Africa', 'Oceania', 'Seas & islands'];

// Map size sets the default player count (the human included).
const TILES_PER_PLAYER = 1650, MIN_PLAYERS = 2, MAX_PLAYERS = 20;
const GENERATED_LAND = 17850; // typical land tiles of a generated 220x140 map (measured over 60 seeds: 17786 to 17864)
const playersForLand = land => Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.round(land / TILES_PER_PLAYER)));
const sizeClass = land => land < 16000 ? 'Small' : land < 24000 ? 'Medium' : land < 32000 ? 'Large' : 'Huge';
const landCache = {};
// The real maps only: not the generated map, nor the Random card (which stands for one of them).
const realMapIds = () => MAP_INFO.map(m => m.id).filter(id => id !== 'generated' && id !== 'random');
function mapLand(key) {
  if (key === 'generated') return GENERATED_LAND;
  if (key === 'random') { // a middling size, so the card suggests a middling player count
    if (landCache.random === undefined) {
      const lands = realMapIds().map(mapLand).sort((a, b) => a - b), h = lands.length >> 1;
      landCache.random = lands.length % 2 ? lands[h] : (lands[h - 1] + lands[h]) / 2;
    }
    return landCache.random;
  }
  if (landCache[key] === undefined) landCache[key] = loadWorldMap(key).terrain.reduce((n, t) => n + (t !== WATER), 0);
  return landCache[key];
}
