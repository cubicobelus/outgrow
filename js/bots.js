// Bot decisions. Every level plays by the same rules as the human; higher levels
// only decide better and react faster.
//
// Easy and Medium use the simple rules below. They make the classic mistakes: Easy sits near
// its cap wasting growth, Medium attacks whenever it is nearly full, which leaves it emptied
// and cheap to take.
//   think:      seconds between decisions [min, max]
//   trigger:    take open land when troops reach this share of cap [min, max], picked once per bot
//   share:      share of troops sent at open land; earlyShare in the first earlyTime seconds
//               (overspending at the start is a classic mistake: low troops grow slowly)
//   war:        attack a player once troops reach this share of cap; warShare is the share sent
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
const EXPERT = { think: 0.2, openTrigger: 0.35, openShare: 0.5, openGuard: 0.5, safety: 0.6, minGain: 30, snipe: 1.5 };
const HARD =   { think: 0.4, openTrigger: 0.45, openShare: 0.35, openGuard: 0.3, safety: 0.9, minGain: 30, snipe: 1.2 };

const BOT_TYPES = {
  easy:   { label: 'Easy',   think: [1.5, 3],   trigger: [0.6, 0.8],   share: 0.25, earlyShare: 0.75, earlyTime: 60, war: 0.97, warShare: 0.25, aggression: 0,    idle: 0.5, pick: 'random' },
  medium: { label: 'Medium', think: [0.8, 1.5], trigger: [0.45, 0.55], share: 0.35, earlyShare: 0.6,  earlyTime: 45, war: 0.9,  warShare: 0.35, aggression: 0.03, idle: 0.1, pick: 'weakest' },
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

// Each bot gets its own slight lean, so two bots of one level never move in lockstep.
function lean(game, p) {
  if (!p.lean) {
    const j = () => 1 + (game.rand() - 0.5) * 0.2;
    p.lean = { trigger: j(), share: j(), safety: j() };
  }
  return p.lean;
}

// With no reachable land to take, cross the water: open land first, else (when `war` is set)
// the weakest player anywhere. Tried at most every 3 seconds since the search covers the sea.
function tryBoat(game, p, share, war) {
  if (game.time < (p.nextBoat || 0)) return false;
  p.nextBoat = game.time + 3;
  if (game.neutralLeft() > 0) return game.sendBoat(p, NEUTRAL, null, p.troops * share);
  if (!war) return false;
  let weak = null;
  for (const q of game.players) if (q.alive && q.spawned && q !== p && (!weak || q.troops < weak.troops)) weak = q;
  return !!weak && game.sendBoat(p, weak.id, null, p.troops * war);
}

// What happens if p sends `share` of its troops at q: tiles gained, whether q is wiped out,
// and how safe p is afterwards: its remaining troops over the biggest army any neighbour has
// left. A neighbour can only take land in proportion to its own troops over ours, so whole
// armies are what matter, not troops per tile.
function plan(game, p, q, share, near) {
  const send = p.troops * share, cost = estCost(game, p, q);
  const gain = Math.min(q.tiles, send / cost);
  let threat = Math.max(0, q.troops - gain * density(q));
  for (const r of near) if (r !== q) threat = Math.max(threat, r.troops);
  return { send, gain, wipes: gain >= q.tiles, safe: threat > 0 ? (p.troops - send) / threat : Infinity };
}

function botThink(game, p) {
  if (game.time < p.nextThink) return;
  const T = BOT_TYPES[p.botType];
  if (T.patient) return patientThink(game, p, T.patient);
  p.nextThink = game.time + T.think[0] + game.rand() * (T.think[1] - T.think[0]);
  if (p.trigger === undefined) p.trigger = T.trigger[0] + game.rand() * (T.trigger[1] - T.trigger[0]);
  const cap = maxTroops(p.tiles);
  if (game.attacks.some(a => a.attacker === p.id)) return;
  if (game.rand() < T.idle) return;

  const near = neighbourIds(game, p);
  let target = null;
  if (near.length) {
    target = T.pick === 'random' ? near[Math.floor(game.rand() * near.length)]
      : near.reduce((a, b) => (density(b) < density(a) ? b : a));
  }
  const open = game.touches(p.id, NEUTRAL);
  if (open && p.troops >= p.trigger * cap && !(target && game.rand() < T.aggression)) {
    game.launchAttack(p, NEUTRAL, p.troops * (game.time < T.earlyTime ? T.earlyShare : T.share));
  } else if (!open && p.troops >= p.trigger * cap && tryBoat(game, p, T.share, target ? 0 : T.warShare)) {
    return;
  } else if (target && p.troops >= (open ? p.trigger : T.war) * cap) {
    game.launchAttack(p, target.id, p.troops * T.warShare);
  }
}

function patientThink(game, p, E) {
  const L = lean(game, p);
  p.nextThink = game.time + E.think * (0.7 + game.rand() * 0.6);
  const cap = maxTroops(p.tiles);
  const busy = target => game.attacks.some(a => a.attacker === p.id && a.target === target);
  const near = neighbourIds(game, p);
  const openCost = ECON.tileCost * AVG_TERRAIN;
  // Troops we keep so that neighbours do not find us cheap.
  const guard = near.length ? E.openGuard * Math.max(...near.map(density)) * p.tiles : 0;

  // Snipe: a neighbour that just emptied itself is nearly as cheap as open land.
  for (const q of near) {
    const cost = estCost(game, p, q);
    if (busy(q.id) || cost > E.snipe * openCost) continue;
    const send = Math.min(p.troops - guard, q.tiles * cost * 1.2);
    if (send > cost * 10) game.launchAttack(p, q.id, send);
  }

  if (game.touches(p.id, NEUTRAL)) {
    const send = Math.min(p.troops * E.openShare * L.share, p.troops - guard);
    if (!busy(NEUTRAL) && p.troops >= E.openTrigger * L.trigger * cap && send > openCost * 5) game.launchAttack(p, NEUTRAL, send);
    return;
  }
  if (game.attacks.some(a => a.attacker === p.id)) return;
  if (p.troops >= E.openTrigger * L.trigger * cap && tryBoat(game, p, E.openShare * L.share, near.length ? 0 : 0.5)) return;
  if (!near.length) return;

  // Only attack when it stays safe; among safe options take the most land, wiping someone out counts double.
  let best = null, bestScore = 0;
  for (const q of near) {
    for (const share of [0.3, 0.5, 0.7]) {
      const pl = plan(game, p, q, share, near);
      if (pl.safe < E.safety * L.safety || pl.gain < E.minGain) continue;
      const score = pl.gain * (pl.wipes ? 2 : 1);
      if (score > bestScore) { best = [q, Math.min(pl.send, q.tiles * estCost(game, p, q) * 1.2)]; bestScore = score; }
    }
  }
  if (best) game.launchAttack(p, best[0].id, best[1]);
}
