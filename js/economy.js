// Every tunable number lives here. The shapes follow what was observed in the
// original game; the constants are guesses meant to be refit as data comes in.
const ECON = {
  capBase: 2000,       // max troops with no land
  capPerTile: 400,     // cap = capBase + capPerTile * tiles^capExp
  capExp: 0.75,        // below 1, so each extra tile adds less cap
  growthRate: 0.18,    // overall speed of troop growth
  growthShape: 1.5,    // growth peaks at troops = cap / (1 + growthShape), about 40% of cap
  tileCost: 20,        // troops spent to take one open plains tile
  defenseMult: 2,      // extra cost per owned tile = defenseMult * defender troops per tile
  spreadFrac: 0.12,    // share of an attack's front taken each tick
  startTroopsFrac: 0.3,
  spawnRadius: 3,
};

// Terrain ids index this table. Water cannot be taken.
const TERRAIN = [
  { name: 'Water',     mult: Infinity, color: [38, 70, 110] },
  { name: 'Plains',    mult: 1,        color: [150, 178, 104] },
  { name: 'Forest',    mult: 1.5,      color: [92, 132, 78] },
  { name: 'Hills',     mult: 2,        color: [168, 150, 110] },
  { name: 'Mountains', mult: 3,        color: [140, 136, 132] },
];
const WATER = 0, PLAINS = 1, FOREST = 2, HILLS = 3, MOUNTAINS = 4;

function maxTroops(tiles) {
  return ECON.capBase + ECON.capPerTile * Math.pow(tiles, ECON.capExp);
}

// Hump shaped: slow when nearly empty, fastest around 40% of cap, zero at cap.
function growthPerSec(troops, cap) {
  if (troops >= cap) return 0;
  const t = Math.max(troops, cap * 0.01);
  return ECON.growthRate * t * Math.pow(1 - troops / cap, ECON.growthShape);
}
