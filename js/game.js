// Game state and rules: ownership, troops, attacks. Bot decisions are in bots.js. No drawing here.

const TICK = 0.1; // seconds per simulation step
const NEUTRAL = -1;

const PLAYER_COLORS = [
  [235, 64, 52], [52, 120, 235], [240, 200, 40], [150, 70, 210], [30, 190, 170], [240, 130, 30],
  [220, 80, 170], [110, 200, 60], [90, 90, 200], [190, 120, 80], [60, 160, 230], [200, 200, 200],
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
    this.dirty = new Set();
    this.time = 0;
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
    p.troops = 0;
    this.attacks = this.attacks.filter(a => a.attacker !== p.id);
  }

  // Claims a small disc around (cx, cy). Returns false if the spot is not open land.
  spawn(p, cx, cy) {
    const c = cy * this.w + cx;
    if (!this.isLand(c) || this.owner[c] !== NEUTRAL) return false;
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
    p.troops = maxTroops(p.tiles) * ECON.startTroopsFrac;
    return true;
  }

  spawnBots() {
    const minDist = 14;
    const taken = this.players.filter(p => p.spawned).map(p => [p.sumX / p.tiles, p.sumY / p.tiles]);
    for (const p of this.players) {
      if (!p.isBot || p.spawned) continue;
      for (let tries = 0; tries < 2000; tries++) {
        const x = Math.floor(this.rand() * this.w), y = Math.floor(this.rand() * this.h);
        const d = tries < 1500 ? minDist : 4;
        if (taken.some(([tx, ty]) => (tx - x) ** 2 + (ty - y) ** 2 < d * d)) continue;
        if (this.spawn(p, x, y)) { taken.push([x, y]); break; }
      }
      if (!p.spawned) p.alive = false;
    }
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
    const same = this.attacks.find(a => a.attacker === p.id && a.target === target);
    if (same) same.troops += troops;
    else this.attacks.push({ attacker: p.id, target, troops });
    return true;
  }

  // Owned land costs more the more troops the defender holds per tile, and big empires
  // pay extra to attack players, which slows down a runaway leader.
  tileCost(i, target, attacker) {
    let cost = ECON.tileCost * TERRAIN[this.map.terrain[i]].mult;
    if (target !== NEUTRAL) {
      const d = this.players[target];
      cost += ECON.defenseMult * d.troops / Math.max(1, d.tiles);
      cost *= 1 + ECON.sizePenalty * this.players[attacker].tiles / this.landTiles;
    }
    return cost;
  }

  stepAttack(a) {
    const attacker = this.players[a.attacker];
    const def = a.target === NEUTRAL ? null : this.players[a.target];
    const counts = this.front(a.attacker, a.target);
    if (counts.size === 0) return false;
    // Prefer tiles already wrapped by the attacker so fronts stay smooth.
    const cand = [];
    for (const [i, c] of counts) cand.push([i, c + this.rand() * 1.5]);
    cand.sort((p, q) => q[1] - p[1]);
    const n = Math.max(1, Math.ceil(cand.length * ECON.spreadFrac));
    for (let k = 0; k < n; k++) {
      const i = cand[k][0];
      const cost = this.tileCost(i, a.target, a.attacker);
      if (a.troops < cost) return false;
      a.troops -= cost;
      if (def) def.troops -= Math.min(def.troops, def.troops / Math.max(1, def.tiles));
      this.setOwner(i, attacker.id);
      if (def && !def.alive) return false;
    }
    return a.troops >= ECON.tileCost;
  }

  step() {
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
  }

  // The winning player, or null while the match is on.
  winner() {
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
