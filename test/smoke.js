// Outgrow smoke test: catches a broken change before a push. Node built-ins only, no deps.
//   node test/smoke.js [repo folder]      (default: the folder above this script)
// Checks: 1 scripts in index.html exist and every js file compiles; 2 bots-only game runs 120 s
// sane (all spawned, land grows, no NaN/negative); 3 one full game reaches a winner; 4 same seed
// twice gives identical tile counts; 5 every real-world map loads and runs 30 s; 6 human can spawn,
// attack neutral land and gain tiles. Prints PASS/FAIL per check; exit code 1 if any failed.
const fs = require('fs'), path = require('path'), vm = require('vm');
const repo = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const js = f => path.join(repo, 'js', f + '.js');
const results = [];
function check(name, fn) {
  let detail = '';
  try { detail = fn() || ''; results.push(true); console.log('PASS', name, detail); }
  catch (e) { results.push(false); console.log('FAIL', name, (e && e.message) || e); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }

// Fresh sandbox with the game scripts in index.html order (render.js and main.js need a browser).
function load() {
  const ctx = vm.createContext({ console, Math });
  for (const f of ['economy', 'worldmaps', 'map', 'game', 'bots']) vm.runInContext(fs.readFileSync(js(f), 'utf8'), ctx, { filename: f + '.js' });
  return ctx;
}
// Runs code in the sandbox; its top-level const/class names are visible to later calls.
const run = (ctx, code) => vm.runInContext(code, ctx);
// Helpers defined inside the sandbox: a bots-only game, stepping, and a sanity scan.
const HELPERS = `
  function botGame(map, seed) { const g = new Game(map, seed, BOT_LINEUP); g.human.alive = false; return g; }
  function steps(g, secs) { for (let n = Math.round(secs / TICK); n-- > 0;) g.step(); }
  function owned(g) { return g.players.reduce((s, p) => s + p.tiles, 0); }
  function sane(g) { for (const p of g.players) if (!Number.isFinite(p.troops) || p.troops < 0 || !Number.isFinite(p.tiles) || p.tiles < 0) return p.name + ' troops=' + p.troops + ' tiles=' + p.tiles; return ''; }
  function tiles(g) { return g.players.map(p => p.tiles).join(','); }
  function playStart(g) { while (g.phase === 'start') g.step(); }  // 8 s starting window, bots spawn
`;

check('scripts exist and compile', () => {
  const html = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)].map(m => m[1]);
  assert(srcs.length >= 5, 'only ' + srcs.length + ' script tags found');
  for (const s of srcs) assert(fs.existsSync(path.join(repo, s)), 'missing ' + s);
  const files = fs.readdirSync(path.join(repo, 'js')).filter(f => f.endsWith('.js'));
  for (const f of files) new vm.Script(fs.readFileSync(path.join(repo, 'js', f), 'utf8'), { filename: f });
  return srcs.length + ' scripts, ' + files.length + ' files';
});

const ctx = (() => { try { const c = load(); run(c, HELPERS); return c; } catch (e) { console.log('FAIL load game scripts', e.message); return null; } })();
if (!ctx) { console.log('0/' + (results.length + 5) + ' passed'); process.exit(1); }

check('bots-only game runs 120 s sanely', () => {
  ctx.g = run(ctx, 'botGame(generateMap(220, 140, 7919), 7919)');
  run(ctx, 'playStart(g)');
  const bots = ctx.g.players.filter(p => p.isBot);
  assert(bots.every(p => p.spawned && p.tiles > 0), 'a bot did not spawn or own land');
  const before = run(ctx, 'owned(g)');
  run(ctx, 'steps(g, 120)');
  const after = run(ctx, 'owned(g)'), bad = run(ctx, 'sane(g)');
  assert(!bad, 'bad value: ' + bad);
  assert(after > before, 'land did not grow: ' + before + ' -> ' + after);
  // Bots can be wiped out early in a normal game (about 0.8 per game by 120 s), so only most must be left.
  assert(bots.filter(p => p.tiles > 0).length >= bots.length / 2, 'over half the bots own no land');
  return 'land ' + before + ' -> ' + after;
});

check('full game reaches a winner', () => {
  ctx.g = run(ctx, 'botGame(generateMap(220, 140, 7919), 7919)');
  const cap = 12000;  // match clock is 900 s = 9000 steps after the 8 s start window
  let n = 0, w = null;
  while (!(w = ctx.g.winner()) && n++ < cap) ctx.g.step();
  assert(w, 'no winner after ' + cap + ' steps');
  return w.name + ' at ' + ctx.g.time.toFixed(0) + ' s, ' + w.tiles + ' tiles';
});

check('same seed twice is identical (60 s)', () => {
  const t = () => { ctx.g = run(ctx, 'botGame(generateMap(220, 140, 4242), 4242)'); run(ctx, 'playStart(g); steps(g, 60)'); return run(ctx, 'tiles(g)'); };
  const a = t(), b = t();
  assert(a === b, a + ' vs ' + b);
  return a;
});

check('real-world maps load and run 30 s', () => {
  const keys = Object.keys(run(ctx, 'WORLD_MAPS'));
  assert(keys.length > 0, 'no world maps');
  for (const k of keys) {
    ctx.k = k; ctx.g = run(ctx, 'botGame(loadWorldMap(k), 99)');
    run(ctx, 'playStart(g); steps(g, 30)');
    assert(run(ctx, 'owned(g)') > 0, k + ': no land claimed');
    const bad = run(ctx, 'sane(g)'); assert(!bad, k + ': ' + bad);
  }
  return keys.join(',');
});

check('map sizes give sane player counts', () => {
  const keys = ['generated', ...Object.keys(run(ctx, 'WORLD_MAPS'))], out = [];
  for (const k of keys) {
    ctx.k = k;
    const n = run(ctx, 'playersForLand(mapLand(k))'), c = run(ctx, 'sizeClass(mapLand(k))');
    assert(n >= 2 && n <= 20, k + ': ' + n + ' players');
    assert(['Small', 'Medium', 'Large', 'Huge'].includes(c), k + ': size class ' + c);
    out.push(k + ' ' + n + ' ' + c);
  }
  const pl = k => { ctx.k = k; return run(ctx, 'playersForLand(mapLand(k))'); };
  assert(pl('europe') > pl('world'), 'europe should have more players than world');
  const cols = run(ctx, 'PLAYER_COLORS.map(c => c.join())');
  assert(cols.length >= run(ctx, 'MAX_PLAYERS'), 'only ' + cols.length + ' colours');
  assert(new Set(cols).size === cols.length, 'duplicate player colour');
  return out.join('; ');
});

check('europe full lineup of 19 bots spawns and runs 30 s', () => {
  ctx.g = run(ctx, `(function () {
    const lineup = [...Array(8).fill('easy'), ...Array(6).fill('medium'), ...Array(3).fill('hard'), ...Array(2).fill('expert')];
    const g = new Game(loadWorldMap('europe'), 5, lineup); g.human.alive = false; return g;
  })()`);
  run(ctx, 'playStart(g); steps(g, 30)');
  const bots = ctx.g.players.filter(p => p.isBot);
  assert(bots.length === 19, bots.length + ' bots');
  // A bot may already be wiped out by 30 s (an Expert can take a weak neighbour that fast); every bot must have spawned.
  assert(bots.every(p => p.spawned && (p.tiles > 0 || !p.alive)), 'a bot did not spawn or own land');
  assert(bots.filter(p => p.alive).length >= 15, 'too many bots gone by 30 s');
  const bad = run(ctx, 'sane(g)'); assert(!bad, bad);
  return '19 bots, land ' + run(ctx, 'owned(g)');
});

check('human spawns, attacks neutral land, gains tiles', () => {
  ctx.g = run(ctx, 'new Game(generateMap(220, 140, 31676), 31676, [])');
  const r = run(ctx, `(function () {
    const h = g.human; let spot = g.findStart(h);
    if (!spot || !g.spawn(h, spot[0], spot[1], 0)) return 'human could not spawn';
    g.phase = 'play'; h.troops = 5000;
    const t0 = h.tiles;
    if (!g.launchAttack(h, NEUTRAL, 3000)) return 'launchAttack refused';
    steps(g, 20);
    return h.tiles > t0 ? 'ok ' + t0 + ' -> ' + h.tiles : 'tiles did not grow: ' + t0 + ' -> ' + h.tiles;
  })()`);
  assert(r.startsWith('ok'), r);
  return r;
});

const ok = results.filter(Boolean).length;
console.log(ok + '/' + results.length + ' passed');
process.exit(ok === results.length ? 0 : 1);
