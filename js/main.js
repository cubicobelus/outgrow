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
const setup = { easy: 3, medium: 3, hard: 2, expert: 2, map: 'random' };
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
  const map = setup.map === 'random' ? generateMap(MAP_W, MAP_H, seed) : loadWorldMap(setup.map);
  game = new Game(map, seed, lineup);
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

// Send buttons: the share and the troops it would send right now.
el('shares').innerHTML = SHARES.map(s => `<button data-share="${s}">${s * 100}%<b></b></button>`).join('');

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
  document.querySelectorAll('#maps button').forEach(b => b.classList.toggle('on', b.dataset.map === setup.map));
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
    if (!game.launchAttack(me, target, troops)) showMsg(game.frontCount(me.id) >= ECON.maxFronts ? `All ${ECON.maxFronts} fronts are busy.` : 'Not enough troops to attack.', 2);
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
  // Wheel notches, trackpad swipes and pinch gestures (which arrive as ctrl + wheel) all ease in.
  const px = Math.max(-300, Math.min(300, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY));
  renderer.zoomAt(e.clientX, e.clientY, Math.exp(-px * (e.ctrlKey ? 0.012 : 0.0022)), true);
}, { passive: false });

el('zoomIn').addEventListener('click', () => renderer.zoomCentre(1.5));
el('zoomOut').addEventListener('click', () => renderer.zoomCentre(1 / 1.5));
el('zoomFit').addEventListener('click', () => renderer.fitAll());

let mouse = { x: 0, y: 0, tile: -1 };
canvas.addEventListener('mouseleave', () => { mouse.tile = -1; });
canvas.addEventListener('mousemove', e => {
  if (mode !== 'game') return;
  const i = renderer.tileAt(e.clientX, e.clientY);
  mouse = { x: e.clientX, y: e.clientY, tile: i };
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
  } else if (e.key === '+' || e.key === '=') renderer.zoomCentre(1.4);
  else if (e.key === '-' || e.key === '_') renderer.zoomCentre(1 / 1.4);
  else if (e.key === '0') renderer.fitAll();
  else if (e.key.startsWith('Arrow')) {
    renderer.panBy(e.key === 'ArrowLeft' ? 80 : e.key === 'ArrowRight' ? -80 : 0, e.key === 'ArrowUp' ? 80 : e.key === 'ArrowDown' ? -80 : 0);
    e.preventDefault();
  } else if (e.key >= '1' && e.key <= '5') setShare(SHARES[+e.key - 1]);
  else if (e.key === ' ' && !ended) { paused = !paused; e.preventDefault(); }
});

el('lineup').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  setup[b.dataset.key] += +b.dataset.d;
  renderSetup();
});
// Picking a map also swaps the match behind the menu, as a preview.
el('maps').addEventListener('click', e => { if (e.target.dataset.map) { setup.map = e.target.dataset.map; renderSetup(); toMenu(); } });
el('shares').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setShare(+b.dataset.share); });
el('speeds').addEventListener('click', e => { if (e.target.dataset.speed) setSpeed(+e.target.dataset.speed); });
el('play').addEventListener('click', startMatch);
el('howBtn').addEventListener('click', () => { howFrom = 'menu'; showScreen('how'); });
el('pauseHow').addEventListener('click', () => { howFrom = 'pause'; showScreen('how'); });
el('howBack').addEventListener('click', () => showScreen(howFrom));
el('pauseBtn').addEventListener('click', () => setPaused(true));
el('pauseToggle').addEventListener('click', () => { if (!ended) paused = !paused; });
el('resume').addEventListener('click', () => setPaused(false));
el('restart').addEventListener('click', startMatch);
el('quit').addEventListener('click', toMenu);
el('again').addEventListener('click', startMatch);
el('toMenu').addEventListener('click', toMenu);
// Keep playing (or watching): the match runs on with no clock and no 80% rule until one player is left.
el('watch').addEventListener('click', () => { showScreen(null); ended = false; game.freeplay = true; watching = !game.human.alive; });
window.addEventListener('resize', () => renderer.resize());

// ---- HUD and end screen ----

const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function updateHud() {
  const me = game.human, cap = maxTroops(me.tiles);
  el('troops').textContent = `${fmt(me.troops)} / ${fmt(cap)}`;
  el('fill').style.width = `${Math.min(100, me.troops / cap * 100)}%`;
  el('growth').textContent = `+${fmt(growthPerSec(me.troops, cap))}/s`;
  el('fronts').textContent = `${game.frontCount(me.id)} / ${ECON.maxFronts}`;
  el('land').textContent = `${me.tiles} tiles (${(me.tiles / game.landTiles * 100).toFixed(1)}%)`;
  // Past the end (keep playing) the clock counts up instead.
  const left = Math.max(0, Math.ceil(ECON.matchTime - game.time));
  el('clockLabel').textContent = game.freeplay ? 'Time' : 'Time left';
  el('clock').textContent = game.freeplay ? mmss(game.time) : mmss(left);
  el('clock').classList.toggle('low', !game.freeplay && left <= 60 && game.phase === 'play');
  el('density').textContent = (me.troops / Math.max(1, me.tiles)).toFixed(1);
  document.querySelectorAll('#shares b').forEach((b, k) => { const t = fmt(me.troops * SHARES[k]); if (b.textContent !== t) b.textContent = t; });
  const name = id => (id === NEUTRAL ? 'Open land' : game.players[id].name);
  el('attacks').innerHTML =
    game.attacks.filter(a => a.target === me.id).map(a => `<div class="in">Defending vs ${name(a.attacker)}: ${fmt(a.troops)}</div>`).join('') +
    game.boats.filter(b => b.target === me.id).map(b => `<div class="in">${name(b.owner)} boat incoming: ${fmt(b.troops)}</div>`).join('') +
    game.attacks.filter(a => a.attacker === me.id).map(a => `<div class="out">Attacking ${name(a.target)}: ${fmt(a.troops)}</div>`).join('') +
    game.boats.filter(b => b.owner === me.id).map(b => `<div class="out">Boat to ${name(b.target)}: ${fmt(b.troops)}</div>`).join('');
  el('feed').innerHTML = game.feed.filter(f => game.time - f.time < 8).map(f =>
    `<div style="opacity:${Math.min(1, (8 - (game.time - f.time)) / 2).toFixed(2)}"><b>${f.victim}</b> was taken out${f.killer ? ` by ${f.killer}` : ''}</div>`).join('');
  // Top 8 by land with their rank; the human's own row is added below when outside the top 8.
  const alive = game.players.filter(p => p.alive && p.spawned).sort((a, b) => b.tiles - a.tiles);
  const row = (p, r) => `<tr${p === me ? ' class="me"' : ''}><td class="rank">${r}</td><td><span class="dot" style="background:rgb(${p.color})"></span>${p.name}</td>` +
    `<td>${(p.tiles / game.landTiles * 100).toFixed(1)}%</td><td>${fmt(p.troops)}</td></tr>`;
  const mine = alive.indexOf(me);
  el('board').innerHTML = alive.slice(0, 8).map((p, k) => row(p, k + 1)).join('') +
    (mine >= 8 ? (mine > 8 ? '<tr class="gap"><td></td><td>&middot;&middot;&middot;</td><td></td><td></td></tr>' : '') + row(me, mine + 1) : '');
}

// Stats for the player under the mouse (a temporary aid): troops, cap, growth, land, fronts.
function updateTip() {
  const tip = el('tip'), o = mouse.tile >= 0 ? game.owner[mouse.tile] : NEUTRAL;
  if (mode !== 'game' || o === NEUTRAL || !game.players[o].alive) { tip.hidden = true; return; }
  const q = game.players[o], cap = maxTroops(q.tiles);
  const row = (k, v) => `<div class="r"><span>${k}</span><span>${v}</span></div>`;
  tip.innerHTML = `<b>${q.name}</b>` + (q.isBot ? ` <span style="color:var(--dim)">${LEVELS.find(l => l[0] === q.botType)[1]}</span>` : '') +
    row('Troops', `${fmt(q.troops)} / ${fmt(cap)}`) +
    row('Growth', `+${fmt(growthPerSec(q.troops, cap))}/s`) +
    row('Land', `${q.tiles} (${(q.tiles / game.landTiles * 100).toFixed(1)}%)`) +
    row('Troops per tile', (q.troops / Math.max(1, q.tiles)).toFixed(1)) +
    row('Fronts', `${game.frontCount(q.id)} / ${ECON.maxFronts}`);
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(innerWidth - w - 8, mouse.x + 16) + 'px';
  tip.style.top = Math.min(innerHeight - h - 8, mouse.y + 16) + 'px';
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
  // Keep playing is offered while more than one player stands and the match has not already run on to the end.
  const standing = game.players.filter(p => p.alive && p.spawned).length;
  el('watch').hidden = standing < 2 || (game.freeplay && me.alive);
  el('watch').textContent = me.alive ? 'Keep playing' : 'Keep watching';
  const rows = [
    ['Land', `${(me.tiles / game.landTiles * 100).toFixed(1)}%`],
    ['Peak land', `${(me.peak / game.landTiles * 100).toFixed(1)}%`],
    ['Rank', `${humanRank()} of ${game.players.filter(p => p.spawned).length}`],
    ['Time', mmss(game.freeplay ? game.time : Math.min(game.time, ECON.matchTime))],
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
    if (mode === 'game') {
      // While watching after being wiped out, only the final winner ends the match.
      const result = watching ? (game.winner() ? 'lose' : null) : game.outcome();
      if (result) showEnd(result);
    }
  }
  if (msgTimer > 0) { msgTimer -= dt; if (msgTimer <= 0) showMsg('', 0); }
  const inGame = mode === 'game';
  el('paused').hidden = !(inGame && paused && el('pause').hidden && el('how').hidden);
  el('pauseToggle').textContent = paused ? 'Resume' : 'Pause';
  el('pauseToggle').classList.toggle('on', paused);
  el('start').hidden = !(inGame && game.phase === 'start');
  if (inGame && game.phase === 'start') {
    el('start').textContent = `${game.human.spawned ? 'Click to move your start' : 'Click open land to place your start'}: ${Math.ceil(game.startLeft)}s`;
  }
  renderer.draw(dt);
  if (inGame) { updateHud(); updateTip(); } else el('tip').hidden = true;
  requestAnimationFrame(frame);
}

setShare(0.4);
setSpeed(1);
renderSetup();
toMenu();
requestAnimationFrame(frame);
