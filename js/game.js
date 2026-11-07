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
    this.takenAt = new Float32Array(this.w * this.h).fill(-1e9); // when each tile last changed owner
    this.players = [];
    this.attacks = [];
    this.boats = [];
    this.clashes = []; // player tiles just taken, flashed on the map
    this.feed = [];    // who was taken out by whom, for the kill feed: { victim, killer, time }
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
      if (p.tiles <= 0) this.eliminate(p, pid);
    }
    this.owner[i] = pid;
    this.takenAt[i] = this.time;
    if (pid !== NEUTRAL) {
      const p = this.players[pid];
      p.tiles++; p.sumX += x; p.sumY += y;
    }
    this.refreshBorder(i);
    this.dirty.add(i);
    for (const j of this.neighbors(i)) { this.refreshBorder(j); this.dirty.add(j); }
  }

  eliminate(p, by) {
    p.alive = false;
    this.eliminated.push(p);
    this.feed.push({ victim: p.name, killer: by !== undefined && by !== NEUTRAL ? this.players[by].name : null, time: this.time });
    if (this.feed.length > 20) this.feed.shift();
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

  // A random valid spot. With `looks` above 1, compares that many and keeps the best: far from
  // other starts, plenty of cheap plains nearby and land (not water) to grow into. Bots look more
  // the better they are: Easy takes the first spot, Medium 3, Hard 10, Expert 60.
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
        let plains = 0, room = 0;
        for (let dy = -12; dy <= 12; dy += 2) for (let dx = -12; dx <= 12; dx += 2) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
          const t = this.map.terrain[yy * this.w + xx];
          if (t !== WATER) room++;
          if (t === PLAINS && dx * dx + dy * dy <= 64) plains++;
        }
        score = near + plains * 0.3 + room * 0.1;
      }
      if (score > bestScore) { best = [x, y]; bestScore = score; }
    }
    return best;
  }

  placeBot(p) {
    const spot = this.findStart(p, { medium: 3, hard: 10, expert: 60 }[p.botType] || 1);
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

  // Players within `maxDepth` tiles of p across open land that p does not touch yet: for each, how many
  // open tiles lie in between (`depth`, 1 = a single tile of gap) and the player's tile nearest the way in.
  gapTo(p, maxDepth, cap = 6000) {
    const seen = new Set(), out = new Map();
    let frontier = [];
    for (const b of p.border) for (const j of this.neighbors(b)) {
      if (this.owner[j] === NEUTRAL && this.isLand(j) && !seen.has(j)) { seen.add(j); frontier.push(j); }
    }
    for (let d = 1; d <= maxDepth && frontier.length && seen.size < cap; d++) {
      const next = [];
      for (const i of frontier) for (const j of this.neighbors(i)) {
        const o = this.owner[j];
        if (o === NEUTRAL) { if (this.isLand(j) && !seen.has(j)) { seen.add(j); next.push(j); } }
        else if (o !== p.id && !out.has(o)) out.set(o, { id: o, depth: d, tile: j });
      }
      frontier = next;
    }
    return out;
  }

  // How many troops `id` has sent at p lately (halves every 2 minutes).
  grudge(p, id) {
    const g = p.grudge && p.grudge[id];
    return g ? g.v * Math.pow(0.5, (this.time - g.t) / 120) : 0;
  }

  frontCount(id) { return this.attacks.filter(a => a.attacker === id).length; }

  touches(attacker, target) {
    for (const b of this.players[attacker].border) {
      for (const j of this.neighbors(b)) if (this.owner[j] === target && this.isLand(j)) return true;
    }
    return false;
  }

  // `aim` ({ x, y, target }) makes an open-land attack a thrust: it only takes the open tiles nearest
  // that point and stops as soon as the attacker touches the player `target`.
  launchAttack(p, target, troops, aim) {
    troops = Math.min(troops, p.troops);
    if (!p.alive || target === p.id || troops < 1) return false;
    if (!this.touches(p.id, target)) return false;
    // At most ECON.maxFronts attacks at once; more troops at a target already being attacked just join it.
    if (this.attacks.filter(a => a.attacker === p.id).length >= ECON.maxFronts) {
      const joins = !aim && this.attacks.some(a => a.attacker === p.id && a.target === target && !a.edge && !a.aim);
      const counter = this.attacks.find(a => a.attacker === target && a.target === p.id);
      if (!joins && !(counter && troops <= counter.troops)) return false;
    }
    p.troops -= troops;
    // The target remembers who sent troops at it (a grudge that fades with a 2 minute half-life).
    if (target !== NEUTRAL) {
      const t = this.players[target], old = t.grudge && t.grudge[p.id];
      t.grudge = t.grudge || {};
      t.grudge[p.id] = { v: (old ? old.v * Math.pow(0.5, (this.time - old.t) / 120) : 0) + troops, t: this.time };
    }
    // Opposing attacks between the same two players cancel out first.
    const counter = this.attacks.find(a => a.attacker === target && a.target === p.id);
    if (counter) {
      const clash = Math.min(counter.troops, troops);
      counter.troops -= clash; troops -= clash;
      if (counter.troops <= 0) this.attacks.splice(this.attacks.indexOf(counter), 1);
      if (troops <= 0) return true;
    }
    const same = aim ? null : this.attacks.find(a => a.attacker === p.id && a.target === target && !a.edge && !a.aim);
    if (same) same.troops += troops;
    else this.attacks.push({ attacker: p.id, target, troops, aim });
    return true;
  }

  // Fresh ground (on unless switched off): how much of its owner's defense a tile has, from
  // freshWeak the moment it is taken up to 1 after freshTime seconds. Always 1 with the rule off.
  freshness(i) {
    if (!ECON.freshGround) return 1;
    const age = this.time - this.takenAt[i];
    return age >= ECON.freshTime ? 1 : ECON.freshWeak + (1 - ECON.freshWeak) * age / ECON.freshTime;
  }

  // Battle luck (on unless switched off): every luckRound seconds an attack on a player rolls a
  // factor for its cost per tile, averaging 1. Below 1 the attacker is lucky, above 1 the defender
  // is. The roll is the same for every fight, big or small, attacker or defender: luck favours no side.
  rollLuck(a, def) {
    if (!ECON.battleLuck || !def) { a.luck = 1; return; }
    if (a.luckUntil !== undefined && this.time < a.luckUntil) return;
    const s = ECON.luckSpread;
    const z = Math.sqrt(-2 * Math.log(1 - this.rand())) * Math.cos(2 * Math.PI * this.rand());
    a.luck = Math.max(0.5, Math.min(2, Math.exp(s * z - s * s / 2)));
    a.luckUntil = this.time + ECON.luckRound;
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
    return (ECON.tileCost + ECON.defenseMult * this.freshness(i) * d.troops / Math.max(1, d.tiles)) * mult *
      (1 + ECON.sizePenalty * this.players[attacker].tiles / this.landTiles);
  }

  stepAttack(a) {
    const attacker = this.players[a.attacker];
    const def = a.target === NEUTRAL ? null : this.players[a.target];
    if (a.aim && this.touches(a.attacker, a.aim.target)) return false;
    const counts = this.frontOf(a);
    if (counts.size === 0) return false;
    if (a.aim) {
      // A thrust: keep only the front tiles nearest the aim point.
      const dist = new Map();
      let best = Infinity;
      for (const i of counts.keys()) {
        const d = Math.hypot(i % this.w - a.aim.x, Math.floor(i / this.w) - a.aim.y);
        dist.set(i, d);
        if (d < best) best = d;
      }
      for (const [i, d] of dist) if (d > best + 3.5) counts.delete(i);
    }
    // A big force for the front it pushes against moves faster, a thin one slower: speed follows how
    // many front-widths of tiles the troops can pay for (1 = the base speed).
    let avg = 0, sample = 0;
    for (const i of counts.keys()) { avg += this.tileCost(i, a.target, a.attacker); if (++sample >= 24) break; }
    const speed = Math.max(0.5, Math.min(2.5, 0.6 + 0.4 * Math.sqrt(a.troops / (counts.size * (avg / sample)))));
    let pick = [];
    if (def) {
      // Against a player the front moves as a line: the most wrapped tiles fall first, so gaps
      // fill in before the line pushes deeper. Rough ground slows the whole line and costs more.
      let sumMult = 0;
      const cand = [];
      for (const [i, c] of counts) { sumMult += TERRAIN[this.map.terrain[i]].mult; cand.push([i, c + this.rand() * 0.6]); }
      const n = Math.max(1, Math.round(cand.length * ECON.spreadFrac * speed * 1.15 / Math.pow(sumMult / cand.length, 1.3) + this.rand() - 0.5));
      cand.sort((p, q) => q[1] - p[1]);
      pick = cand.slice(0, n).map(x => x[0]);
    } else {
      // Open land: every front tile may fall this tick, each terrain at its own pace (plains fast,
      // mountains about four times slower), so a front touching both advances on both, unequally.
      // Tiles already wrapped by the attacker fall sooner, which keeps fronts smooth.
      for (const [i, c] of counts) {
        const mult = TERRAIN[this.map.terrain[i]].mult;
        if (this.rand() < ECON.spreadFrac * speed * (0.6 + 0.4 * c) / Math.pow(mult, 1.3)) pick.push(i);
      }
      for (let k = pick.length - 1; k > 0; k--) { const j = Math.floor(this.rand() * (k + 1)); [pick[k], pick[j]] = [pick[j], pick[k]]; }
    }
    let sx = 0, sy = 0, taken = 0, spent = false;
    this.rollLuck(a, def);
    for (const i of pick) {
      const cost = this.tileCost(i, a.target, a.attacker) * a.luck;
      if (a.troops < cost) { spent = true; break; }
      a.troops -= cost;
      // The defender loses the troops that held the tile (fewer on fresh ground).
      if (def) def.troops -= Math.min(def.troops, this.freshness(i) * def.troops / Math.max(1, def.tiles));
      this.setOwner(i, attacker.id);
      if (a.edge) a.edge.add(i);
      if (def) this.clashes.push({ i, until: this.time + 0.6 });
      sx += i % this.w; sy += Math.floor(i / this.w); taken++;
      if (def && !def.alive) break;
    }
    // Where the fighting is, smoothed, for the number drawn on the map.
    if (taken) {
      const x = sx / taken, y = sy / taken;
      if (a.fx === undefined || Math.hypot(a.fx - x, a.fy - y) > 25) { a.fx = x; a.fy = y; }
      else { a.fx += (x - a.fx) * 0.15; a.fy += (y - a.fy) * 0.15; }
    }
    if (spent || (def && !def.alive)) return false;
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
    if (this.clashes.length) this.clashes = this.clashes.filter(c => c.until > this.time);
  }

  step() {
    if (this.phase === 'start') return this.stepStart();
    this.time += TICK;
    // Players and attacks are visited from a random starting point each tick, so nobody gains from
    // being first in the list (two equal bots otherwise split about 4 to 1).
    const n = this.players.length, off = Math.floor(this.rand() * n);
    for (let k = 0; k < n; k++) {
      const p = this.players[(k + off) % n];
      if (!p.alive || !p.spawned) continue;
      p.troops += growthPerSec(p.troops, maxTroops(p.tiles)) * TICK;
      if (p.isBot) botThink(this, p);
    }
    const keep = [], list = this.attacks, m = list.length, offA = m ? Math.floor(this.rand() * m) : 0;
    for (let k = 0; k < m; k++) {
      const a = list[(k + offA) % m];
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
    if (alive.length === 1) return top;
    // After "keep playing" (freeplay) the clock and the 80% rule no longer end the match.
    if (!this.freeplay && (top.tiles >= this.landTiles * ECON.winShare || this.time >= ECON.matchTime)) return top;
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
