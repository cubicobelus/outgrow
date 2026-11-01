// Page wiring: menus, input, HUD, the main loop.

const MAP_W = 220, MAP_H = 140;
const SHARES = [0.1, 0.2, 0.4, 0.6, 0.8];
const LEVELS = [
  ['easy', 'Easy', 'makes mistakes'],
  ['medium', 'Medium', 'gets greedy'],
  ['hard', 'Hard', 'patient'],
  ['expert', 'Expert', 'plays its best'],
];
const MAX_BOTS = 15;

const canvas = document.getElementById('map');
const el = id => document.getElementById(id);
const setup = { easy: 3, medium: 3, hard: 2, expert: 2, length: 900 };
let game, renderer, mode = 'menu', share = 0.4, speed = 1, paused = false, acc = 0, last = 0;
let msgTimer = 0, ended = false, watching = false, howFrom = 'menu';
let warned = new Set(); // attacks and boats on the human already announced

function lineupFromSetup() {
  return LEVELS.flatMap(([key]) => Array(setup[key]).fill(key));
}

// A match map can be fixed with ?seed=123 in the address, which helps to replay or test a map.
function load(lineup, human) {
  const fixed = human && new URLSearchParams(location.search).get('seed');
  const seed = fixed ? +fixed : Math.floor(Math.random() * 1e9);
  game = new Game(generateMap(MAP_W, MAP_H, seed), seed, lineup);
  if (!human) game.human.alive = false;
  game.human.peak = 0;
  renderer = new Renderer(canvas, game);
  renderer.resize();
  ended = false; watching = false; paused = false; acc = 0; warned = new Set();
  showMsg('', 0);
}

// The menu sits over a bot-only match running in the background.
function toMenu() {
  mode = 'menu';
  document.body.classList.add('in-menu');
  showScreen('menu');
  load(['easy', 'medium', 'medium', 'hard', 'hard', 'expert', 'expert'], false);
}

function startMatch() {
  mode = 'game';
  ECON.matchTime = setup.length;
  document.body.classList.remove('in-menu');
  showScreen(null);
  load(lineupFromSetup(), true);
  setSpeed(1);
}

function showScreen(id) {
  for (const s of ['menu', 'how', 'pause', 'overlay']) el(s).hidden = s !== id;
}

function showMsg(text, seconds) {
  el('msg').textContent = text;
  el('msg').hidden = !text;
  msgTimer = seconds;
}

function setShare(s) {
  share = s;
  document.querySelectorAll('#shares button').forEach(b => b.classList.toggle('on', +b.dataset.share === s));
}

function setSpeed(s) {
  speed = s;
  document.querySelectorAll('#speeds button').forEach(b => b.classList.toggle('on', +b.dataset.speed === s));
}

function setPaused(on) {
  if (mode !== 'game' || ended) return;
  paused = on;
  showScreen(on ? 'pause' : null);
}

function renderSetup() {
  const total = LEVELS.reduce((s, [k]) => s + setup[k], 0);
  el('lineup').innerHTML = LEVELS.map(([key, name, note]) =>
    `<div class="lv"><span class="name">${name}<small>${note}</small></span>` +
    `<button data-key="${key}" data-d="-1" ${setup[key] === 0 || total <= 1 ? 'disabled' : ''}>&minus;</button>` +
    `<span class="count">${setup[key]}</span>` +
    `<button data-key="${key}" data-d="1" ${total >= MAX_BOTS ? 'disabled' : ''}>+</button></div>`).join('');
  document.querySelectorAll('#lengths button').forEach(b => b.classList.toggle('on', +b.dataset.len === setup.length));
}

// ---- input ----

function clickTile(clientX, clientY) {
  if (mode !== 'game' || ended || paused) return;
  const i = renderer.tileAt(clientX, clientY);
  if (i < 0) return;
  const me = game.human;
  if (game.phase === 'start') {
    const x = i % game.w, y = (i - x) / game.w;
    if (!game.spawn(me, x, y)) showMsg(game.isLand(i) ? 'Too close to another start.' : 'Pick land, not water.', 2);
    return;
  }
  if (!me.alive || !game.isLand(i)) return;
  const target = game.owner[i];
  if (target === me.id) return;
  const troops = me.troops * share;
  // Land that connects to ours is attacked over land; anything else needs a boat.
  if (game.reachableByLand(me, i)) {
    if (!game.launchAttack(me, target, troops)) showMsg('Not enough troops to attack.', 2);
    return;
  }
  if (game.boats.filter(b => b.owner === me.id).length >= ECON.maxBoats) {
    showMsg(`All ${ECON.maxBoats} of your boats are at sea.`, 2);
  } else if (!game.hasCoast(me)) {
    showMsg('You need a coast to send boats.', 2);
  } else if (!game.sendBoat(me, target, game.map.landId[i], troops, i)) {
    showMsg('No way to reach that by land or sea.', 2);
  }
}

// Pointer input: a tap or click acts on a tile, a drag pans, two fingers pinch to zoom.
const pointers = new Map();
let dragged = false, pinchDist = 0;
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  if (pointers.size === 1) dragged = false;
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchDist = Math.hypot(a.x - b.x, a.y - b.y); dragged = true; }
});
canvas.addEventListener('pointermove', e => {
  const pt = pointers.get(e.pointerId);
  if (!pt || mode !== 'game') return;
  const dx = e.clientX - pt.x, dy = e.clientY - pt.y;
  pt.x = e.clientX; pt.y = e.clientY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist) renderer.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
    pinchDist = d;
    return;
  }
  if (!dragged && Math.hypot(e.clientX - pt.x0, e.clientY - pt.y0) > 6) dragged = true;
  if (dragged) renderer.panBy(dx, dy);
});
const pointerEnd = e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 0 && !dragged && e.type === 'pointerup') clickTile(e.clientX, e.clientY);
  if (pointers.size < 2) pinchDist = 0;
};
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);
canvas.addEventListener('wheel', e => {
  if (mode !== 'game') return;
  e.preventDefault();
  renderer.zoomAt(e.clientX, e.clientY, Math.pow(1.0015, -e.deltaY));
}, { passive: false });

canvas.addEventListener('mousemove', e => {
  if (mode !== 'game') return;
  const i = renderer.tileAt(e.clientX, e.clientY);
  if (i < 0) { el('hover').textContent = ''; return; }
  const o = game.owner[i];
  const terr = TERRAIN[game.map.terrain[i]].name;
  el('hover').textContent = o === NEUTRAL ? terr : `${terr}, ${game.players[o].name}`;
});

window.addEventListener('keydown', e => {
  if (mode !== 'game') return;
  if (e.key === 'Escape') {
    if (!el('how').hidden) { showScreen(howFrom); return; }
    setPaused(!paused);
  } else if (paused && !el('pause').hidden) {
    return;
  } else if (e.key >= '1' && e.key <= '5') setShare(SHARES[+e.key - 1]);
  else if (e.key === ' ' && !ended) { paused = !paused; e.preventDefault(); }
});

el('lineup').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  setup[b.dataset.key] += +b.dataset.d;
  renderSetup();
});
el('lengths').addEventListener('click', e => { if (e.target.dataset.len) { setup.length = +e.target.dataset.len; renderSetup(); } });
el('shares').addEventListener('click', e => { if (e.target.dataset.share) setShare(+e.target.dataset.share); });
el('speeds').addEventListener('click', e => { if (e.target.dataset.speed) setSpeed(+e.target.dataset.speed); });
el('play').addEventListener('click', startMatch);
el('howBtn').addEventListener('click', () => { howFrom = 'menu'; showScreen('how'); });
el('pauseHow').addEventListener('click', () => { howFrom = 'pause'; showScreen('how'); });
el('howBack').addEventListener('click', () => showScreen(howFrom));
el('pauseBtn').addEventListener('click', () => setPaused(true));
el('resume').addEventListener('click', () => setPaused(false));
el('restart').addEventListener('click', startMatch);
el('quit').addEventListener('click', toMenu);
el('again').addEventListener('click', startMatch);
el('toMenu').addEventListener('click', toMenu);
el('watch').addEventListener('click', () => { showScreen(null); ended = false; watching = true; });
window.addEventListener('resize', () => renderer.resize());

// ---- HUD and end screen ----

const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function updateHud() {
  const me = game.human, cap = maxTroops(me.tiles);
  el('troops').textContent = `${fmt(me.troops)} / ${fmt(cap)}`;
  el('fill').style.width = `${Math.min(100, me.troops / cap * 100)}%`;
  el('growth').textContent = `+${fmt(growthPerSec(me.troops, cap))}/s`;
  el('land').textContent = `${me.tiles} tiles (${(me.tiles / game.landTiles * 100).toFixed(1)}%)`;
  const left = Math.max(0, Math.ceil(ECON.matchTime - game.time));
  el('clock').textContent = mmss(left);
  el('clock').classList.toggle('low', left <= 60 && game.phase === 'play');
  el('sending').textContent = fmt(me.troops * share);
  const name = id => (id === NEUTRAL ? 'Open land' : game.players[id].name);
  el('attacks').innerHTML =
    game.attacks.filter(a => a.target === me.id).map(a => `<div class="in">${name(a.attacker)} attacking: ${fmt(a.troops)}</div>`).join('') +
    game.boats.filter(b => b.target === me.id).map(b => `<div class="in">${name(b.owner)} boat incoming: ${fmt(b.troops)}</div>`).join('') +
    game.attacks.filter(a => a.attacker === me.id).map(a => `<div>&rarr; ${name(a.target)}: ${fmt(a.troops)}</div>`).join('') +
    game.boats.filter(b => b.owner === me.id).map(b => `<div>Boat &rarr; ${name(b.target)}: ${fmt(b.troops)}</div>`).join('');
  const ranked = game.players.filter(p => p.alive && p.spawned).sort((a, b) => b.tiles - a.tiles).slice(0, 8);
  el('board').innerHTML = ranked.map(p =>
    `<tr${p === me ? ' class="me"' : ''}><td><span class="dot" style="background:rgb(${p.color})"></span>${p.name}</td>` +
    `<td>${(p.tiles / game.landTiles * 100).toFixed(1)}%</td><td>${fmt(p.troops)}</td></tr>`).join('');
}

// Rank among everyone: the living by land, then the fallen in reverse order of elimination.
function humanRank() {
  const me = game.human;
  const alive = game.players.filter(p => p.alive && p.spawned).sort((a, b) => b.tiles - a.tiles);
  if (me.alive) return alive.indexOf(me) + 1;
  const fallen = game.eliminated;
  return alive.length + (fallen.length - fallen.indexOf(me));
}

function showEnd(result) {
  ended = true;
  const me = game.human, w = game.winner();
  el('result').textContent = result === 'win' ? 'Victory' : !me.alive ? 'Wiped out' : `${w.name} wins`;
  const rows = [
    ['Land', `${(me.tiles / game.landTiles * 100).toFixed(1)}%`],
    ['Peak land', `${(me.peak / game.landTiles * 100).toFixed(1)}%`],
    ['Rank', `${humanRank()} of ${game.players.filter(p => p.spawned).length}`],
    ['Time', mmss(Math.min(game.time, ECON.matchTime))],
  ];
  el('stats').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  showScreen('overlay');
}

// A short warning the first time each attack or boat heads for the human.
function warnIncoming() {
  const me = game.human;
  if (!me.alive) return;
  for (const x of [...game.attacks.filter(a => a.target === me.id), ...game.boats.filter(b => b.target === me.id)]) {
    if (warned.has(x)) continue;
    warned.add(x);
    showMsg(`${game.players[x.attacker ?? x.owner].name} is ${x.path ? 'sending a boat at' : 'attacking'} you!`, 2.5);
    el('hud').classList.remove('hit'); void el('hud').offsetWidth; el('hud').classList.add('hit');
  }
}

// ---- loop ----

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000 || 0);
  last = now;
  if (!paused && !ended) {
    acc += dt * (mode === 'menu' ? 2 : speed);
    while (acc >= TICK) { game.step(); acc -= TICK; }
    game.human.peak = Math.max(game.human.peak, game.human.tiles);
    if (mode === 'menu') {
      if (game.winner()) load(game.players.filter(p => p.isBot).map(p => p.botType), false);
    } else {
      warnIncoming();
    }
    if (mode === 'game' && !watching) {
      const result = game.outcome();
      if (result) showEnd(result);
    }
  }
  if (msgTimer > 0) { msgTimer -= dt; if (msgTimer <= 0) showMsg('', 0); }
  const inGame = mode === 'game';
  el('paused').hidden = !(inGame && paused && el('pause').hidden && el('how').hidden);
  el('start').hidden = !(inGame && game.phase === 'start');
  if (inGame && game.phase === 'start') {
    el('start').textContent = `${game.human.spawned ? 'Click to move your start' : 'Click open land to place your start'}: ${Math.ceil(game.startLeft)}s`;
  }
  renderer.draw();
  if (inGame) updateHud();
  requestAnimationFrame(frame);
}

setShare(0.4);
setSpeed(1);
renderSetup();
toMenu();
requestAnimationFrame(frame);
