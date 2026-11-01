// Page wiring: input, HUD, the main loop.

const MAP_W = 220, MAP_H = 140;
const SHARES = [0.2, 0.4, 0.6, 0.8];

const canvas = document.getElementById('map');
const el = id => document.getElementById(id);
let game, renderer, share = 0.4, speed = 1, paused = false, acc = 0, last = 0, msgTimer = 0, ended = false, watching = false;

function newGame(seed) {
  seed = seed ?? Math.floor(Math.random() * 1e9);
  game = new Game(generateMap(MAP_W, MAP_H, seed), seed, BOT_LINEUP);
  game.spawnBots();
  renderer = new Renderer(canvas, game);
  renderer.resize();
  ended = false; watching = false;
  el('overlay').hidden = true;
  showMsg('Click open land to place your start.', 0);
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

canvas.addEventListener('click', e => {
  const i = renderer.tileAt(e.clientX, e.clientY);
  if (i < 0 || ended) return;
  const me = game.human;
  if (me.spawned && !me.alive) return;
  if (!me.spawned) {
    const x = i % game.w, y = (i - x) / game.w;
    if (game.spawn(me, x, y)) showMsg('', 0);
    else showMsg('Pick open land that nobody owns.', 2);
    return;
  }
  if (!game.isLand(i)) return;
  const target = game.owner[i];
  if (target === me.id) return;
  if (!game.launchAttack(me, target, me.troops * share)) {
    showMsg(target === NEUTRAL ? 'No open land touches your border.' : 'You do not border them yet.', 2);
  }
});

canvas.addEventListener('mousemove', e => {
  const i = renderer.tileAt(e.clientX, e.clientY);
  if (i < 0) { el('hover').textContent = ''; return; }
  const o = game.owner[i];
  const terr = TERRAIN[game.map.terrain[i]].name;
  el('hover').textContent = o === NEUTRAL ? terr : `${terr}, ${game.players[o].name}`;
});

window.addEventListener('keydown', e => {
  if (e.key >= '1' && e.key <= '4') setShare(SHARES[+e.key - 1]);
  else if (e.key === ' ') { paused = !paused; e.preventDefault(); }
});

el('shares').addEventListener('click', e => { if (e.target.dataset.share) setShare(+e.target.dataset.share); });
el('speeds').addEventListener('click', e => { if (e.target.dataset.speed) setSpeed(+e.target.dataset.speed); });
el('newmap').addEventListener('click', () => newGame());
el('again').addEventListener('click', () => newGame());
el('watch').addEventListener('click', () => { el('overlay').hidden = true; ended = false; watching = true; });
window.addEventListener('resize', () => renderer.resize());

function updateHud() {
  const me = game.human, cap = maxTroops(me.tiles);
  el('troops').textContent = `${fmt(me.troops)} / ${fmt(cap)}`;
  el('fill').style.width = `${Math.min(100, me.troops / cap * 100)}%`;
  el('growth').textContent = `+${fmt(growthPerSec(me.troops, cap))}/s`;
  el('land').textContent = `${me.tiles} tiles (${(me.tiles / game.landTiles * 100).toFixed(1)}%)`;
  const left = Math.max(0, Math.ceil(ECON.matchTime - game.time));
  el('clock').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  el('sending').textContent = fmt(me.troops * share);
  el('attacks').innerHTML = game.attacks
    .filter(a => a.attacker === me.id)
    .map(a => `<div>&rarr; ${a.target === NEUTRAL ? 'Open land' : game.players[a.target].name}: ${fmt(a.troops)}</div>`)
    .join('');
  const ranked = game.players.filter(p => p.alive && p.spawned).sort((a, b) => b.tiles - a.tiles).slice(0, 8);
  el('board').innerHTML = ranked.map(p =>
    `<tr${p === me ? ' class="me"' : ''}><td><span class="dot" style="background:rgb(${p.color})"></span>${p.name}</td>` +
    `<td>${(p.tiles / game.landTiles * 100).toFixed(1)}%</td><td>${fmt(p.troops)}</td></tr>`).join('');
}

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000 || 0);
  last = now;
  if (!paused && game.human.spawned && !ended) {
    acc += dt * speed;
    while (acc >= TICK) { game.step(); acc -= TICK; }
    const result = watching ? null : game.outcome();
    if (result) {
      ended = true;
      const w = game.winner();
      el('result').textContent = result === 'win' ? 'You win'
        : !game.human.alive ? 'You were wiped out' : `${w.name} wins`;
      el('overlay').hidden = false;
    }
  }
  if (msgTimer > 0) { msgTimer -= dt; if (msgTimer <= 0) showMsg('', 0); }
  el('paused').hidden = !paused;
  renderer.draw();
  updateHud();
  requestAnimationFrame(frame);
}

setShare(0.4);
setSpeed(1);
newGame();
requestAnimationFrame(frame);
