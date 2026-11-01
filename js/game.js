// Game state and rules: ownership, troops, attacks. Bot decisions are in bots.js. No drawing here.

const TICK = 0.1; // seconds per simulation step
const NEUTRAL = -1;

const PLAYER_COLORS = [
  [235, 64, 52], [52, 120, 235], [240, 200, 40], [150, 70, 210], [30, 190, 170], [240, 130, 30],
  [220, 80, 170], [110, 200, 60], [90, 90, 200], [190, 120, 80], [60, 160, 230], [200, 200, 200],
  [130, 40, 60], [250, 170, 150], [40, 110, 80], [170, 170, 60],
];
class Game {
  // lineup: bot type keys from BOT_TYPES, one per bot.
  constructor(map, seed, lineup) {
    this.map = map;
    this.w = map.w; this.h = map.h;
    this.rand = mulberry32(seed ^ 0x9e3779b9);
    this.owner = new Int16Array(this.w * this.h).fill(NEUTRAL);
    this.players = [];
    this.attacks = [];
    this.boats = [];
    this.wakes = []; // routes of boats that just landed, kept briefly so their trail can fade
    this.eliminated = []; // players in the order they fell
    this.dirty = new Set();
    this.time = 0;
    this.phase = 'start';
    this.startLeft = ECON.spawnTime;
    this.landTiles = 0;
    for (const t of map.terrain) if (t !== WATER) this.landTiles++;
    this.human = this.addPlayer('You', PLAYER_COLORS[0], null);
    const counts = {};
    lineup.forEach((type, b) => {
      counts[type] = (counts[type] || 0) + 1;
      this.addPlayer(`${BOT_TYPES[type].label} ${counts[type]}`, PLAYER_COLORS[(b + 1) % PLAYER_COLORS.length], type);
    });
  }

  addPlayer(name, color, botType) {
    const p = {
      id: this.players.length, name, color, isBot: !!botType, botType, alive: true, spawned: false,
      troops: 0, tiles: 0, sumX: 0, sumY: 0, border: new Set(), nextThink: 0,
      spawnAt: 0.5 + this.rand() * (ECON.spawnTime - 1.5), // when a bot places its start
    };
    this.players.push(p);
    return p;
  }

  neighbors(i) {
    const w = this.w, x = i % w, y = (i - x) / w, out = [];
    if (x > 0) out.push(i - 1);
    if (x < w - 1) out.push(i + 1);
    if (y > 0) out.push(i - w);
    if (y < this.h - 1) out.push(i + w);
    return out;
  }

  isLand(i) { return this.map.terrain[i] !== WATER; }

  isBorder(i) {
    const o = this.owner[i];
    if (o === NEUTRAL) return false;
    const n = this.neighbors(i);
    if (n.length < 4) return true;
    for (const j of n) if (this.owner[j] !== o) return true;
    return false;
  }

  refreshBorder(i) {
    const o = this.owner[i];
    if (o === NEUTRAL) return;
    const set = this.players[o].border;
    if (this.isBorder(i)) set.add(i); else set.delete(i);
  }

  setOwner(i, pid) {
    const old = this.owner[i];
    const x = i % this.w, y = (i - x) / this.w;
    if (old !== NEUTRAL) {
      const p = this.players[old];
      p.tiles--; p.sumX -= x; p.sumY -= y; p.border.delete(i);
      if (p.tiles <= 0) this.eliminate(p);
    }
    this.owner[i] = pid;
    if (pid !== NEUTRAL) {
      const p = this.players[pid];
      p.tiles++; p.sumX += x; p.sumY += y;
    }
    this.refreshBorder(i);
    this.dirty.add(i);
    for (const j of this.neighbors(i)) { this.refreshBorder(j); this.dirty.add(j); }
  }

  eliminate(p) {
    p.alive = false;
    this.eliminated.push(p);
    this.boats = this.boats.filter(b => b.owner !== p.id);
    p.troops = 0;
    this.attacks = this.attacks.filter(a => a.attacker !== p.id);
  }

  // A start must be open land and at least ECON.spawnGap tiles from every other start.
  canSpawn(p, cx, cy, gap = ECON.spawnGap) {
    const c = cy * this.w + cx;
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h || !this.isLand(c)) return false;
    if (this.owner[c] !== NEUTRAL && this.owner[c] !== p.id) return false;
    return !this.players.some(q => q !== p && q.spawned && (q.spawnX - cx) ** 2 + (q.spawnY - cy) ** 2 < gap * gap);
  }

  // Claims a small disc around (cx, cy), moving p's start if it already has one.
  spawn(p, cx, cy, gap) {
    if (!this.canSpawn(p, cx, cy, gap)) return false;
    if (p.spawned) this.clearStart(p);
    const r = ECON.spawnRadius;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = y * this.w + x;
        if (this.isLand(i) && this.owner[i] === NEUTRAL) this.setOwner(i, p.id);
      }
    }
    p.spawned = true;
    p.spawnX = cx; p.spawnY = cy;
    p.troops = maxTroops(p.tiles) * ECON.startTroopsFrac;
    return true;
  }

  // Gives the start back without eliminating the player (only during the starting window).
  clearStart(p) {
    const tiles = [...p.border];
    for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === p.id) tiles.push(i);
    for (const i of tiles) this.owner[i] = NEUTRAL;
    p.tiles = 0; p.sumX = 0; p.sumY = 0; p.border.clear();
    for (const i of tiles) {
      this.dirty.add(i);
      for (const j of this.neighbors(i)) { this.refreshBorder(j); this.dirty.add(j); }
    }
  }

  // A random valid spot. With `looks` above 1, compares that many and keeps the one with the most
  // room: far from other starts and with plenty of cheap plains nearby.
  findStart(p, looks = 1) {
    const smart = looks > 1;
    let best = null, bestScore = -1, found = 0;
    for (let tries = 0; tries < 3000 && found < looks; tries++) {
      const x = Math.floor(this.rand() * this.w), y = Math.floor(this.rand() * this.h);
      if (!this.canSpawn(p, x, y, tries < 2500 ? ECON.spawnGap : 4)) continue;
      found++;
      let score = 0;
      if (smart) {
        let near = 40;
        for (const q of this.players) if (q !== p && q.spawned) near = Math.min(near, Math.hypot(q.spawnX - x, q.spawnY - y));
        let plains = 0;
        for (let dy = -8; dy <= 8; dy += 2) for (let dx = -8; dx <= 8; dx += 2) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < this.w && yy < this.h && this.map.terrain[yy * this.w + xx] === PLAINS) plains++;
        }
        score = near + plains * 0.3;
      }
      if (score > bestScore) { best = [x, y]; bestScore = score; }
    }
    return best;
  }

  placeBot(p) {
    const spot = this.findStart(p, { hard: 10, expert: 60 }[p.botType] || 1);
    if (spot) this.spawn(p, spot[0], spot[1], 4);
    else p.alive = false;
  }

  // Starting window: bots drop in at random moments, the human may place and move freely.
  stepStart() {
    this.startLeft -= TICK;
    const elapsed = ECON.spawnTime - this.startLeft;
    for (const p of this.players) if (p.isBot && p.alive && !p.spawned && elapsed >= p.spawnAt) this.placeBot(p);
    if (this.startLeft > 0) return;
    for (const p of this.players) {
      if (!p.alive || p.spawned) continue;
      if (p.isBot) this.placeBot(p);
      else { const spot = this.findStart(p); if (spot) this.spawn(p, spot[0], spot[1], 4); }
    }
    this.phase = 'play';
    this.time = 0;
  }

  // Tiles of `target` (or neutral land) touching `attacker`, with how many attacker tiles each touches.
  front(attacker, target) {
    const counts = new Map();
    for (const b of this.players[attacker].border) {
      for (const j of this.neighbors(b)) {
        if (this.owner[j] === target && this.isLand(j)) counts.set(j, (counts.get(j) || 0) + 1);
      }
    }
    return counts;
  }

  // An attack's front. A beachhead attack (from a boat, with `edge`) only spreads from the tiles
  // it took itself; any other attack uses the attacker's whole border with the target.
  frontOf(a) {
    if (!a.edge) return this.front(a.attacker, a.target);
    const counts = new Map();
    for (const t of a.edge) {
      let open = false;
      if (this.owner[t] === a.attacker) {
        for (const j of this.neighbors(t)) {
          if (this.owner[j] === a.target && this.isLand(j)) { counts.set(j, (counts.get(j) || 0) + 1); open = true; }
        }
      }
      if (!open) a.edge.delete(t);
    }
    return counts;
  }

  touches(attacker, target) {
    for (const b of this.players[attacker].border) {
      for (const j of this.neighbors(b)) if (this.owner[j] === target && this.isLand(j)) return true;
    }
    return false;
  }

  launchAttack(p, target, troops) {
    troops = Math.min(troops, p.troops);
    if (!p.alive || target === p.id || troops < 1) return false;
    if (!this.touches(p.id, target)) return false;
    p.troops -= troops;
    // Opposing attacks between the same two players cancel out first.
    const counter = this.attacks.find(a => a.attacker === target && a.target === p.id);
    if (counter) {
      const clash = Math.min(counter.troops, troops);
      counter.troops -= clash; troops -= clash;
      if (counter.troops <= 0) this.attacks.splice(this.attacks.indexOf(counter), 1);
      if (troops <= 0) return true;
    }
    const same = this.attacks.find(a => a.attacker === p.id && a.target === target && !a.edge);
    if (same) same.troops += troops;
    else this.attacks.push({ attacker: p.id, target, troops });
    return true;
  }

  // Terrain multiplies everything. Open land touching a rival's border is contested and costs
  // more; owned land costs more the more troops the defender holds per tile, and big empires
  // can be made to pay extra to attack players (sizePenalty, off by default).
  tileCost(i, target, attacker) {
    const mult = TERRAIN[this.map.terrain[i]].mult;
    if (target === NEUTRAL) {
      let cost = ECON.tileCost * mult;
      for (const j of this.neighbors(i)) {
        const o = this.owner[j];
        if (o !== NEUTRAL && o !== attacker) { cost *= ECON.contested; break; }
      }
      return cost;
    }
    const d = this.players[target];
    return (ECON.tileCost + ECON.defenseMult * d.troops / Math.max(1, d.tiles)) * mult *
      (1 + ECON.sizePenalty * this.players[attacker].tiles / this.landTiles);
  }

  stepAttack(a) {
    const attacker = this.players[a.attacker];
    const def = a.target === NEUTRAL ? null : this.players[a.target];
    const counts = this.frontOf(a);
    if (counts.size === 0) return false;
    // Prefer tiles already wrapped by the attacker so fronts stay smooth, and easy ground:
    // rough terrain is taken later and the front moves slower through it.
    const cand = [];
    let reach = 0;
    for (const [i, c] of counts) {
      const mult = TERRAIN[this.map.terrain[i]].mult;
      cand.push([i, (c + this.rand() * 1.5) / mult]);
      reach += 1 / mult;
    }
    cand.sort((p, q) => q[1] - p[1]);
    const n = Math.min(cand.length, Math.max(1, Math.ceil(reach * ECON.spreadFrac)));
    let sx = 0, sy = 0, taken = 0;
    for (let k = 0; k < n; k++) {
      const i = cand[k][0];
      const cost = this.tileCost(i, a.target, a.attacker);
      if (a.troops < cost) break;
      a.troops -= cost;
      if (def) def.troops -= Math.min(def.troops, def.troops / Math.max(1, def.tiles));
      this.setOwner(i, attacker.id);
      if (a.edge) a.edge.add(i);
      sx += i % this.w; sy += Math.floor(i / this.w); taken++;
      if (def && !def.alive) break;
    }
    // Where the fighting is, smoothed, for the number drawn on the map.
    if (taken) {
      const x = sx / taken, y = sy / taken;
      if (a.fx === undefined || Math.hypot(a.fx - x, a.fy - y) > 25) { a.fx = x; a.fy = y; }
      else { a.fx += (x - a.fx) * 0.15; a.fy += (y - a.fy) * 0.15; }
    }
    if (taken < n || (def && !def.alive)) return false;
    return a.troops >= ECON.tileCost;
  }

  // ---- boats ----

  isWater(i) { return this.map.terrain[i] === WATER; }

  // Whether the patch of land around tile i (same owner, connected) touches p's territory.
  reachableByLand(p, i) {
    const o = this.owner[i];
    const seen = new Set([i]), stack = [i];
    while (stack.length) {
      const t = stack.pop();
      for (const j of this.neighbors(t)) {
        if (this.owner[j] === p.id) return true;
        if (!seen.has(j) && this.owner[j] === o && this.isLand(j)) { seen.add(j); stack.push(j); }
      }
    }
    return false;
  }

  hasCoast(p) {
    for (const b of p.border) for (const j of this.neighbors(b)) if (this.isWater(j)) return true;
    return false;
  }

  neutralLeft() {
    let owned = 0;
    for (const p of this.players) if (p.alive) owned += p.tiles;
    return this.landTiles - owned;
  }

  // Water tiles a boat can move to from water tile i: the four sides plus diagonals that do not
  // cut across a land corner, so routes run straight and diagonal instead of in steps.
  seaSteps(i) {
    const w = this.w, x = i % w, y = (i - x) / w, out = [];
    for (const j of this.neighbors(i)) if (this.isWater(j)) out.push(j);
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= this.h) continue;
      const j = ny * w + nx;
      if (this.isWater(j) && this.isWater(y * w + nx) && this.isWater(ny * w + x)) out.push(j);
    }
    return out;
  }

  // Sends a boat from p's coast to a shore of `target` (a player id or NEUTRAL) on landmass
  // `landmass` (any landmass when null): the shore closest to tile `near` if given, else the
  // closest one by sea. Returns false if there is no way there.
  sendBoat(p, target, landmass, troops, near = -1) {
    troops = Math.min(troops, p.troops);
    if (!p.alive || troops < ECON.tileCost * 3 || target === p.id) return false;
    if (this.boats.filter(b => b.owner === p.id).length >= ECON.maxBoats) return false;
    const prev = new Int32Array(this.w * this.h).fill(-2);
    const queue = [];
    for (const b of p.border) for (const j of this.neighbors(b)) {
      if (this.isWater(j) && prev[j] === -2) { prev[j] = -1; queue.push(j); }
    }
    const nx = near % this.w, ny = Math.floor(near / this.w);
    let best = null, bestD = Infinity;
    for (let qi = 0; qi < queue.length; qi++) {
      const wtile = queue[qi];
      for (const j of this.seaSteps(wtile)) if (prev[j] === -2) { prev[j] = wtile; queue.push(j); }
      for (const j of this.neighbors(wtile)) {
        if (this.isWater(j)) continue;
        if (this.owner[j] === target && (landmass === null || this.map.landId[j] === landmass)) {
          if (near < 0) { best = [wtile, j]; break; }
          const d = (j % this.w - nx) ** 2 + (Math.floor(j / this.w) - ny) ** 2;
          if (d < bestD) { bestD = d; best = [wtile, j]; }
        }
      }
      if (best && near < 0) break;
    }
    if (!best) return false;
    const path = [];
    for (let t = best[0]; t !== -1; t = prev[t]) path.push(t);
    path.reverse();
    p.troops -= troops;
    this.boats.push({ owner: p.id, target, troops, path, pos: 0, land: best[1] });
    return true;
  }

  stepBoats() {
    const keep = [];
    for (const b of this.boats) {
      const p = this.players[b.owner];
      if (!p.alive) continue;
      b.pos += ECON.boatSpeed * TICK;
      if (b.pos < b.path.length - 1) { keep.push(b); continue; }
      this.wakes.push({ owner: b.owner, path: b.path, until: this.time + 3 });
      // Landed: whoever holds the beach now is the enemy.
      const target = this.owner[b.land];
      if (target === p.id) { p.troops += b.troops; continue; }
      const cost = this.tileCost(b.land, target, p.id);
      if (b.troops < cost) continue; // too few to take the beach: lost
      b.troops -= cost;
      if (target !== NEUTRAL) {
        const d = this.players[target];
        d.troops -= Math.min(d.troops, d.troops / Math.max(1, d.tiles));
      }
      this.setOwner(b.land, p.id);
      // The landing party fights on from the beach only, never merging into attacks elsewhere.
      this.attacks.push({ attacker: p.id, target, troops: b.troops, edge: new Set([b.land]),
        fx: b.land % this.w, fy: Math.floor(b.land / this.w) });
    }
    this.boats = keep;
    this.wakes = this.wakes.filter(t => t.until > this.time);
  }

  step() {
    if (this.phase === 'start') return this.stepStart();
    this.time += TICK;
    for (const p of this.players) {
      if (!p.alive || !p.spawned) continue;
      p.troops += growthPerSec(p.troops, maxTroops(p.tiles)) * TICK;
      if (p.isBot) botThink(this, p);
    }
    const keep = [];
    for (const a of this.attacks) {
      if (this.stepAttack(a)) keep.push(a);
      else if (this.players[a.attacker].alive) this.players[a.attacker].troops += a.troops;
    }
    this.attacks = keep;
    this.stepBoats();
  }

  // The winning player, or null while the match is on.
  winner() {
    if (this.phase === 'start') return null;
    const alive = this.players.filter(p => p.alive && p.spawned);
    if (!alive.length) return null;
    const top = alive.reduce((a, b) => (b.tiles > a.tiles ? b : a));
    if (alive.length === 1 || top.tiles >= this.landTiles * ECON.winShare || this.time >= ECON.matchTime) return top;
    return null;
  }

  // 'win', 'lose' or null.
  outcome() {
    const h = this.human;
    if (!h.spawned) return null;
    if (!h.alive) return 'lose';
    const w = this.winner();
    return w ? (w === h ? 'win' : 'lose') : null;
  }
}
