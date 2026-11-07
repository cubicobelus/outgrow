// Bot decisions. Every level plays by the same rules as the human; higher levels
// only decide better and react faster.
//
// Every bot below Expert gets a personality when the match starts: each [min, max] range is
// picked once per bot, and the ranges of neighbouring levels overlap, so a sharp Medium can beat
// a sluggish Hard. On average each level still beats the one below.
//
// Easy plays almost at random (`chaos`): each decision it rolls whether to act, what to hit and
// how much to send. Medium uses the simple rules below and makes the classic mistakes: it
// attacks whenever it is nearly full, which leaves it emptied and cheap to take.
//   delay:      seconds before the first move [min, max]
//   think:      average seconds between decisions [min, max]
//   trigger:    take open land when troops reach this share of cap [min, max]
//   share:      share of troops sent at open land; earlyShare in the first earlyTime seconds
//               (overspending at the start is a classic mistake: low troops grow slowly)
//   war:        attack a player once troops reach this share of cap; warShare is the share sent
//   odds:       only attack a player whose whole army is at most 1/odds of ours (0 = attack blindly)
//   fronts:     most attacks it runs at once [min, max], picked per bot
//   aggression: chance to hit a neighbour even while open land is left
//   idle:       chance to skip a decision
//   pick:       'weakest' (fewest troops per tile) or 'random' neighbour
//
// Hard and Expert are patient: grab open land fast without looking cheap, only attack a player
// when it stays safe, and punish neighbours that empty themselves. Expert's numbers were tuned
// by simulating many games (see the context notes); Hard is the same logic, slower and less sharp.
//   think:       seconds between decisions
//   openTrigger: take open land when troops reach this share of cap, sending openShare
//   openGuard:   while bordering players, keep troops per tile at least this share of the strongest neighbour's
//   safety:      only attack if afterwards our troops are at least this many times the biggest army
//                any neighbour has left
//   minGain:     smallest attack on a player worth making, in tiles
//   snipe:       hit any neighbour whose land costs at most this many times open land
//   lean:        how far each bot's trigger, share and safety may stray from these (0.3 = up to 30% either way)
//   delay:       seconds before the first move [min, max]
//   chip:        also consider small 15% attacks when sitting near the cap
//   exact:       price targets from the real tiles on the front instead of an average, and weigh land, gaps and sea together
//   fronts:      most attacks it runs at once (the game allows 4)
//   patience:    below the growth sweet spot (40% of the cap) spending troops costs growth, so the safety margin grows by this times how far below it we are (2 = triple at an empty army)
//   horizon:     seconds of growth an attack is charged for: sending troops from below the growth peak costs the growth they would have produced, and an attack whose lost growth (in tiles at the front's price) is over `netMin` of its gain is not worth it unless it wipes the target out or the target is small
//   minX:        no ordinary attack below this share of the cap (wait a few seconds and strike with more); wipe-outs and small players are exempt
//   chipFrom:    small attacks (under 30% of troops) wait until troops reach this share of the cap, unless they wipe the target out or it is a small player
//   reserve:     a second or later front must leave at least this share of the cap in troops
//   grudge:      attacks on players that sent troops at us lately are worth this much more (up to x(1 + grudge))
//   capAt:       once troops reach this share of the cap growth has stalled, so take any attack that is not reckless (safety x0.6, chips, no minimum gain)
//   attackBias:  with open land still around, attack instead of expanding when the attack gains at least this share of what expanding would per troop (lower = readier to attack; 0 = never)
//   rival:       attacks on strong rivals are worth more, up to this much extra for the biggest one (win chance, not only land gained)
//   cleanup:     a player holding at most this share of all land is worth chipping at however few tiles it gives
//   crowd:       each boat already heading for a target scales its appeal by this (lower = avoids crowds)
//   noise:       how far estimates are off: each option's score is scaled by 1 plus or minus this (0 = perfect)
//   reach:       look for players this many open tiles away (not touching yet) and thrust at ones worth hitting; 0 = only neighbours
const EXPERT = { think: 0.15, openTrigger: 0.38, openShare: 0.45, openGuard: 0.5, safety: 0.65, minGain: 30, snipe: 1.5, lean: 0.05, delay: [0, 0.6], chip: true, reach: 10, exact: true, noise: 0, crowd: 0.5, rival: 0.8, cleanup: 0.04, attackBias: 0.5, fronts: 4, grudge: 0.1, capAt: 0.88, reserve: 0.3, patience: 2, chipFrom: 0.5, minX: 0.3, horizon: 25, netMin: 0.5 };
const HARD =   { think: 0.4, openTrigger: 0.52, openShare: 0.3, openGuard: 0.35, safety: 0.7, minGain: 10, snipe: 1.2, lean: 0.2, delay: [0, 3], chip: false, reach: 4, exact: false, noise: 0.35, crowd: 0.7, rival: 0, cleanup: 0.02, attackBias: 0, fronts: 3, grudge: 0.6, capAt: 0.88, reserve: 0.35, patience: 0, chipFrom: 0, minX: 0, horizon: 0, netMin: 0.5 };

const BOT_TYPES = {
  easy:   { label: 'Easy',   chaos: true, delay: [0, 5], think: [1.8, 4],   trigger: [0.35, 0.85], share: [0.15, 0.4], earlyShare: [0.45, 0.85], earlyTime: 60,
            war: [0.85, 1],    warShare: [0.15, 0.35], odds: 0, aggression: [0, 0.03], idle: 0.6, hit: 0.08, hitShare: [0.1, 0.5], pick: 'random' },
  medium: { label: 'Medium', delay: [0, 4], think: [0.6, 1.6], trigger: [0.4, 0.7],   share: [0.25, 0.45], earlyShare: [0.5, 0.8], earlyTime: 45,
            war: [0.77, 0.93], warShare: [0.25, 0.45], odds: [0.4, 0.7], aggression: [0, 0.08], idle: 0.1, fronts: [1, 2.99], pick: 'weakest' },
  hard:   { label: 'Hard',   patient: HARD },
  expert: { label: 'Expert', patient: EXPERT },
};

const BOT_LINEUP = ['easy', 'easy', 'easy', 'medium', 'medium', 'medium', 'hard', 'hard', 'expert', 'expert'];

const AVG_TERRAIN = 1.3; // rough average terrain multiplier, for estimates only

function density(q) { return q.troops / Math.max(1, q.tiles); }

function neighbourIds(game, p) {
  const ids = new Set();
  for (const b of p.border) for (const j of game.neighbors(b)) {
    const o = game.owner[j];
    if (o !== NEUTRAL && o !== p.id) ids.add(o);
  }
  return [...ids].map(id => game.players[id]);
}

// Expected troops per tile when p attacks q.
function estCost(game, p, q) {
  return (ECON.tileCost + ECON.defenseMult * density(q)) * AVG_TERRAIN *
    (1 + ECON.sizePenalty * p.tiles / game.landTiles);
}

const pick = (game, v) => (Array.isArray(v) ? v[0] + game.rand() * (v[1] - v[0]) : v);

// A bot's personality, picked on its first decision: one value from every [min, max] range.
function personality(game, p, T) {
  if (!p.pers) {
    p.pers = {};
    for (const k in T) p.pers[k] = pick(game, T[k]);
  }
  return p.pers;
}

// Hard and Expert keep their tuned logic but each bot leans a little (Hard a lot more than Expert).
function lean(game, p, E) {
  if (!p.lean) {
    const j = () => 1 + (game.rand() * 2 - 1) * E.lean;
    p.lean = { trigger: j(), share: j(), safety: j() };
  }
  return p.lean;
}

// The first decision only sets when the bot will really start.
function firstMove(game, p, delay) {
  if (p.started) return false;
  p.started = true;
  p.nextThink = game.time + pick(game, delay);
  return true;
}

// With no reachable land to take, cross the water: open land first, else (when `war` is set)
// the weakest player that can actually be reached by sea. Tried at most every 3 seconds since
// the search covers the sea.
function tryBoat(game, p, share, war) {
  if (game.time < (p.nextBoat || 0)) return false;
  p.nextBoat = game.time + 2 + game.rand() * 5;
  if (game.neutralLeft() > 0 && !(game.boats.some(b => b.target === NEUTRAL) && game.rand() < 0.7) && game.sendBoat(p, NEUTRAL, null, p.troops * share)) return true;
  if (!war) return false;
  const others = game.players.filter(q => q.alive && q.spawned && q !== p).sort((a, b) => a.troops - b.troops);
  return others.some(q => !(game.boats.some(b => b.target === q.id) && game.rand() < 0.6) && game.sendBoat(p, q.id, null, p.troops * war));
}

// Troops it takes to wipe q out. A small player is priced tile by tile (a single mountain tile
// held by a big army costs far more than the average estimate); a big one by the estimate.
function wipeCost(game, p, q) {
  const est = estCost(game, p, q) * q.tiles;
  if (q.tiles > 150 || !q.border.size) return est;
  let sum = 0;
  for (const i of q.border) sum += game.tileCost(i, q.id, p.id);
  return sum * q.tiles / q.border.size;
}

// The real average cost of a tile on the front between p and q (null when they do not touch).
function frontCost(game, p, q) {
  const front = game.front(p.id, q.id);
  if (!front.size) return null;
  let sum = 0;
  for (const i of front.keys()) sum += game.tileCost(i, q.id, p.id);
  return sum / front.size;
}

// What happens if p sends `share` of its troops at q: tiles gained, whether q is wiped out,
// and how safe p is afterwards: its remaining troops over the biggest army any neighbour has
// left. A neighbour can only take land in proportion to its own troops over ours, so whole
// armies are what matter, not troops per tile.
function plan(game, p, q, share, near, tile) {
  // Never more than it takes to wipe q out (with a margin), so finishing off a small player is cheap.
  const cost = tile || estCost(game, p, q), need = (tile ? tile * q.tiles : wipeCost(game, p, q)) * 1.2, send = Math.min(p.troops * share, need);
  const gain = send >= need ? q.tiles : Math.min(q.tiles, send / cost);
  let threat = Math.max(0, q.troops - gain * density(q));
  for (const r of near) if (r !== q) threat = Math.max(threat, r.troops);
  return { send, gain, cost, wipes: gain >= q.tiles, safe: threat > 0 ? (p.troops - send) / threat : Infinity };
}

function botThink(game, p) {
  if (game.time < p.nextThink) return;
  const T = BOT_TYPES[p.botType];
  if (T.patient) return patientThink(game, p, T.patient);
  const P = personality(game, p, T);
  if (firstMove(game, p, T.delay)) return;
  p.nextThink = game.time + P.think * (0.6 + game.rand() * 0.8);
  if (T.chaos) return chaosThink(game, p, T);
  const cap = maxTroops(p.tiles);
  if (game.frontCount(p.id) >= Math.floor(P.fronts)) return;
  if (game.rand() < T.idle) return;

  const near = neighbourIds(game, p);
  let target = null;
  if (near.length) {
    target = T.pick === 'random' ? near[Math.floor(game.rand() * near.length)]
      : near.reduce((a, b) => (density(b) < density(a) ? b : a));
    // A neighbour that sent troops at us lately is the likelier target.
    const sore = near.filter(q => game.grudge(p, q.id) > 0.1 * cap);
    if (sore.length && game.rand() < 0.5) target = sore[Math.floor(game.rand() * sore.length)];
  }
  const open = game.touches(p.id, NEUTRAL);
  if (open && p.troops >= P.trigger * cap && !(target && game.rand() < P.aggression)) {
    game.launchAttack(p, NEUTRAL, p.troops * (game.time < P.earlyTime ? P.earlyShare : P.share));
  } else if (!open && p.troops >= P.trigger * cap && tryBoat(game, p, P.share, target ? 0 : P.warShare)) {
    return;
  } else if (target && p.troops >= (open ? P.trigger : P.war) * cap && p.troops >= (p.troops >= 0.9 * cap ? Math.min(P.odds, 0.5) : P.odds) * target.troops) {
    game.launchAttack(p, target.id, p.troops * P.warShare);
  }
}

// Easy: a coin toss each time. Acts only above a random fill level, sends a random share, and
// picks open land or a random neighbour (or a boat) without weighing anything. `hit` is the chance
// a decision attacks a player, sending a random share within `hitShare`.
function chaosThink(game, p, T) {
  const r = () => game.rand();
  if (r() < T.idle || p.troops < (0.1 + r() * 0.8) * maxTroops(p.tiles)) return;
  const share = 0.1 + r() * 0.7;
  const near = neighbourIds(game, p);
  if (near.length && r() < T.hit) {
    const sore = near.filter(q => game.grudge(p, q.id) > 0.1 * maxTroops(p.tiles));
    const who = sore.length && r() < 0.5 ? sore : near;
    const hitShare = T.hitShare[0] + (share - 0.1) / 0.7 * (T.hitShare[1] - T.hitShare[0]);
    game.launchAttack(p, who[Math.floor(r() * who.length)].id, p.troops * hitShare);
    return;
  }
  if (game.touches(p.id, NEUTRAL)) { game.launchAttack(p, NEUTRAL, p.troops * share); return; }
  if (r() < 0.3) tryBoat(game, p, share, share);
}

function patientThink(game, p, E) {
  if (firstMove(game, p, E.delay)) return;
  const L = lean(game, p, E);
  p.nextThink = game.time + E.think * (0.7 + game.rand() * 0.6);
  const cap = maxTroops(p.tiles);
  const busy = target => game.attacks.some(a => a.attacker === p.id && a.target === target);
  const near = neighbourIds(game, p);
  const openCost = ECON.tileCost * AVG_TERRAIN;
  // Troops we keep so that neighbours do not find us cheap.
  // A tiny enemy with a big army has a huge density but cannot take much, so the guard never
  // exceeds one and a half times the strongest neighbouring army.
  const guard = near.length ? Math.min(E.openGuard * Math.max(...near.map(density)) * p.tiles, 1.5 * Math.max(...near.map(q => q.troops))) : 0;

  // Snipe: a neighbour that just emptied itself is nearly as cheap as open land.
  for (const q of near) {
    const cost = estCost(game, p, q);
    if (busy(q.id) || cost > E.snipe * openCost) continue;
    const need = wipeCost(game, p, q) * 1.2, send = Math.min(p.troops - guard, need);
    // A snipe that does not finish the target must be worth the growth the troops would have produced.
    const lost = E.horizon ? Math.max(0, growthPerSec(p.troops, cap) - growthPerSec(p.troops - send, cap)) * E.horizon : 0;
    if (send < need && lost > send * E.netMin) continue;
    if (send > cost * 10) game.launchAttack(p, q.id, send);
  }

  // Only attack when it stays safe; among safe options take the most land, wiping someone out
  // counts double, and a player that can be wiped out is always worth it however small.
  const top = Math.max(1, ...game.players.filter(q => q.alive && q.spawned && q !== p).map(q => q.tiles));
  // Troop growth peaks at 40% of the cap. Below it, troops spent now are growth lost, so a patient bot
  // asks for a bigger safety margin and holds back small attacks until it has recovered.
  const x = p.troops / cap, deficit = Math.max(0, 0.4 - x) / 0.4;
  // Troops of growth given up over the next `horizon` seconds by sending `send` now (0 above the peak, where sending speeds growth up).
  const lostGrowth = send => (E.horizon ? Math.max(0, growthPerSec(p.troops, cap) - growthPerSec(p.troops - send, cap)) * E.horizon : 0);
  const choose = (targets, relaxed) => {
    const out = [];
    for (const q of targets) {
      if ((p.cool && p.cool[q.id]) > game.time || busy(q.id)) continue;
      let best = null;
      const tile = E.exact ? frontCost(game, p, q) : null;
      let fuzz = 1 + E.noise * (game.rand() * 2 - 1);
      // A target other boats are already heading for is less appealing (sharper bots mind more).
      if (!near.includes(q)) fuzz *= Math.pow(E.crowd, game.boats.filter(b => b.target === q.id).length);
      // A chip (15%, Expert only): an army at its cap regrows a slice at full speed, so a small
      // safe attack is nearly free even when a big one would leave the bot exposed.
      for (const share of E.chip || relaxed ? [0.08, 0.15, 0.3, 0.5, 0.7] : [0.3, 0.5, 0.7]) {
        const pl = plan(game, p, q, share, near.includes(q) ? near : [...near, q], tile);
        const small = q.tiles <= E.cleanup * game.landTiles;
        if (!relaxed && !pl.wipes && !small && (x < E.minX || (share < 0.3 && x < E.chipFrom))) continue;
        if (!relaxed && !pl.wipes && !small && lostGrowth(pl.send) / (tile || estCost(game, p, q)) > pl.gain * E.netMin) continue;
        if (pl.safe < E.safety * L.safety * (relaxed ? 0.6 : 1 + E.patience * deficit) || (pl.gain < E.minGain && !pl.wipes && !relaxed && q.tiles > E.cleanup * game.landTiles)) continue;
        // Land gained, doubled for a wipe-out, and more for hitting a rival that is a real contender.
        const score = pl.gain * (pl.wipes ? 2 : 1) * (1 + E.rival * q.tiles / top) * (1 + E.grudge * Math.min(1, game.grudge(p, q.id) / (0.25 * cap))) * fuzz;
        if (!best || score > best.score) best = { q, score, send: pl.send, wipes: pl.wipes };
      }
      if (best) out.push(best);
    }
    return out.sort((a, b) => b.score - a.score);
  };
  // An attack that ends at once (too few troops for the tile in front) must not be repeated
  // forever: leave that player alone for a while so the other options get their turn.
  // Extra fronts must leave a reserve: a thin army sits on the weak side of the growth hump.
  const spare = send => (game.frontCount(p.id) ? Math.min(send, p.troops - E.reserve * cap) : send);
  const strike = o => {
    const send = spare(o.send);
    if (send < ECON.tileCost * 5) return false;
    p.cool = p.cool || {}; p.tried = p.tried || {};
    if (game.time - (p.tried[o.q.id] || -9) < 1.5) p.cool[o.q.id] = game.time + 10;
    p.tried[o.q.id] = game.time;
    return game.launchAttack(p, o.q.id, send);
  };

  // Prey across a gap: a weak player a few open tiles away is as good as a neighbour, so push a narrow
  // thrust across the gap and let the normal attack logic take over once the borders touch.
  if (E.reach && game.time >= (p.nextPrey || 0) && !game.attacks.some(a => a.attacker === p.id && a.aim)) {
    p.nextPrey = game.time + 1.5;
    let best = null;
    for (const g of game.gapTo(p, E.reach).values()) {
      const q = game.players[g.id];
      if (!q.alive || near.includes(q)) continue;
      const pl = plan(game, p, q, 0.5, [...near, q]);
      if (pl.safe < E.safety * L.safety || (pl.gain < E.minGain && !pl.wipes && q.tiles > E.cleanup * game.landTiles)) continue;
      const send = g.depth * 8 * ECON.tileCost * ECON.contested * AVG_TERRAIN * 1.5 + 300;
      if (send > p.troops * 0.5 || p.troops - send < guard) continue;
      const score = (pl.gain * (pl.wipes ? 2 : 1)) / g.depth;
      if (!best || score > best.score) best = { score, send, q, tile: g.tile };
    }
    if (best) game.launchAttack(p, NEUTRAL, best.send, { x: best.tile % game.w, y: Math.floor(best.tile / game.w), target: best.q.id });
  }

  const ready = p.troops >= E.openTrigger * L.trigger * cap;
  const openTouch = game.touches(p.id, NEUTRAL);
  if (openTouch) {
    // Expanding is not always the best use of troops: an attack that gains nearly as much per troop
    // (more for a wipe-out or a strong rival) is taken instead, more readily by the sharper bots.
    if (E.attackBias && ready && game.frontCount(p.id) < E.fronts) {
      const openValue = 1 / (openCost * ECON.contested);
      // Only for a wipe-out or a contender: hitting a minor player is not worth slowing down expansion.
      const o = choose(near).find(o => (o.wipes || o.q.tiles >= 0.8 * top) && o.score / o.send >= E.attackBias * openValue);
      if (o && strike(o)) return;
    }
    const send = spare(Math.min(p.troops * E.openShare * L.share, p.troops - guard));
    if (!busy(NEUTRAL) && ready && send > openCost * 5 && game.launchAttack(p, NEUTRAL, send)) return;
  }
  if (game.frontCount(p.id) >= E.fronts) return;
  // With land around, only expansion and the strategic strikes above are worth the troops.
  if (openTouch) return;
  if (ready && game.neutralLeft() > 0 && tryBoat(game, p, E.openShare * L.share, 0)) return;

  const full = p.troops >= E.capAt * cap;
  let land = choose(near, full);
  // The sharpest bots weigh sea targets against land ones instead of only when land runs out.
  if (E.exact && game.time >= (p.nextSea || 0)) {
    p.nextSea = game.time + 2 + game.rand() * 4;
    const sea = choose(game.players.filter(q => q.alive && q.spawned && q !== p && !near.includes(q)), full);
    if (sea.length && (!land.length || sea[0].score * 0.7 > land[0].score) && sea.some(o => game.sendBoat(p, o.q.id, null, o.send))) return;
  }
  if (land.length) { strike(land[0]); return; }
  // Nothing worth taking by land: weigh every other player across the sea the same way.
  if (game.time < (p.nextSea || 0)) return;
  p.nextSea = game.time + 2 + game.rand() * 4;
  const sea = choose(game.players.filter(q => q.alive && q.spawned && q !== p && !near.includes(q)), full);
  sea.some(o => game.sendBoat(p, o.q.id, null, o.send));
}
