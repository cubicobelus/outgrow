// Drawing: the map is painted one pixel per tile into a small canvas, then scaled up.

class Renderer {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.tileCanvas = document.createElement('canvas');
    this.tileCanvas.width = game.w;
    this.tileCanvas.height = game.h;
    this.tctx = this.tileCanvas.getContext('2d');
    this.image = this.tctx.createImageData(game.w, game.h);
    for (let i = 0; i < game.w * game.h; i++) this.paintTile(i);
    this.view = { x: 0, y: 0, scale: 1 };
    this.cam = { zoom: 1, cx: game.w / 2, cy: game.h / 2 }; // zoom 1 = whole map fits
    this.goal = null;               // zoom the wheel is easing towards: { zoom, sx, sy }
    this.arrows = new WeakMap();    // attack -> its front arrows, refreshed a few times a second
  }

  paintTile(i) {
    const g = this.game, d = this.image.data, o = g.owner[i];
    let c = TERRAIN[g.map.terrain[i]].color;
    if (o !== NEUTRAL) {
      const pc = g.players[o].color;
      if (g.isBorder(i)) c = [pc[0] * 0.55, pc[1] * 0.55, pc[2] * 0.55];
      else c = [pc[0] * 0.6 + c[0] * 0.4, pc[1] * 0.6 + c[1] * 0.4, pc[2] * 0.6 + c[2] * 0.4];
    }
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.fit = Math.min(this.canvas.width / this.game.w, this.canvas.height / this.game.h);
    this.updateView();
  }

  // Zoom 1 fits the whole map. A little further out leaves room around it; the closest view puts
  // one tile at about 64 CSS pixels.
  clampZoom(z) { return Math.max(0.7, Math.min(64 * this.dpr / this.fit, z)); }

  updateView() {
    const c = this.cam, g = this.game;
    c.zoom = this.clampZoom(c.zoom);
    const scale = this.fit * c.zoom;
    // The view's centre may go anywhere on the map, so any tile can be dragged out from under the panels.
    c.cx = Math.max(0, Math.min(g.w, c.cx));
    c.cy = Math.max(0, Math.min(g.h, c.cy));
    this.view = { scale, x: this.canvas.width / 2 - c.cx * scale, y: this.canvas.height / 2 - c.cy * scale };
  }

  // Sets the zoom, keeping the map point under screen position (sx, sy) in canvas pixels in place.
  applyZoom(sx, sy, zoom) {
    const tx = (sx - this.view.x) / this.view.scale, ty = (sy - this.view.y) / this.view.scale;
    this.cam.zoom = zoom;
    this.updateView();
    this.cam.cx += tx - (sx - this.view.x) / this.view.scale;
    this.cam.cy += ty - (sy - this.view.y) / this.view.scale;
    this.updateView();
  }

  // Zooms by `factor` about the cursor. A wheel or button eases there (`smooth`); a pinch follows the fingers.
  zoomAt(clientX, clientY, factor, smooth) {
    const r = this.canvas.getBoundingClientRect();
    const sx = (clientX - r.left) * this.dpr, sy = (clientY - r.top) * this.dpr;
    if (!smooth) { this.goal = null; this.applyZoom(sx, sy, this.clampZoom(this.cam.zoom * factor)); return; }
    this.goal = { zoom: this.clampZoom((this.goal ? this.goal.zoom : this.cam.zoom) * factor), sx, sy };
  }

  zoomCentre(factor) {
    const r = this.canvas.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor, true);
  }

  // Whole map back in view.
  fitAll() {
    this.goal = null;
    this.cam.zoom = 1; this.cam.cx = this.game.w / 2; this.cam.cy = this.game.h / 2;
    this.updateView();
  }

  stepZoom(dt) {
    const gl = this.goal;
    if (!gl) return;
    const z = this.cam.zoom, k = 1 - Math.exp(-dt * 14);
    if (Math.abs(gl.zoom - z) < z * 0.004) { this.applyZoom(gl.sx, gl.sy, gl.zoom); this.goal = null; return; }
    this.applyZoom(gl.sx, gl.sy, z + (gl.zoom - z) * k);
  }

  panBy(dx, dy) {
    this.cam.cx -= dx * this.dpr / this.view.scale;
    this.cam.cy -= dy * this.dpr / this.view.scale;
    this.updateView();
  }

  // Screen (CSS pixels) to tile index, or -1 outside the map.
  tileAt(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect(), dpr = this.canvas.width / r.width;
    const x = Math.floor(((clientX - r.left) * dpr - this.view.x) / this.view.scale);
    const y = Math.floor(((clientY - r.top) * dpr - this.view.y) / this.view.scale);
    if (x < 0 || y < 0 || x >= this.game.w || y >= this.game.h) return -1;
    return y * this.game.w + x;
  }

  draw(dt = 0.016) {
    this.stepZoom(dt);
    const g = this.game, ctx = this.ctx, v = this.view;
    if (g.dirty.size) {
      for (const i of g.dirty) this.paintTile(i);
      g.dirty.clear();
      this.tctx.putImageData(this.image, 0, 0);
    } else if (!this.painted) {
      this.tctx.putImageData(this.image, 0, 0);
    }
    this.painted = true;
    ctx.fillStyle = '#1d3350';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.tileCanvas, v.x, v.y, g.w * v.scale, g.h * v.scale);
    this.drawLabels();
  }

  drawLabels() {
    const g = this.game, ctx = this.ctx, v = this.view;
    if (g.phase === 'start') {
      // Show the no-go zone around other starts while everyone is placing.
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      for (const p of g.players) {
        if (!p.spawned || p === g.human) continue;
        ctx.beginPath();
        ctx.arc(v.x + (p.spawnX + 0.5) * v.scale, v.y + (p.spawnY + 0.5) * v.scale, ECON.spawnGap * v.scale, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const l of this.labels()) {
      const p = g.players[l.owner];
      const size = Math.max(10, Math.min(36, Math.sqrt(l.size) * v.scale * 0.35)) * (l.main ? 1 : 0.8);
      const x = v.x + (l.x + 0.5) * v.scale, y = v.y + (l.y + 0.5) * v.scale;
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      ctx.lineWidth = size / 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.fillStyle = '#fff';
      if (!l.main) { ctx.strokeText(p.name, x, y); ctx.fillText(p.name, x, y); continue; }
      ctx.strokeText(p.name, x, y - size * 0.55);
      ctx.fillText(p.name, x, y - size * 0.55);
      ctx.font = `${size * 0.8}px system-ui, sans-serif`;
      ctx.strokeText(fmt(p.troops), x, y + size * 0.45);
      ctx.fillText(fmt(p.troops), x, y + size * 0.45);
    }
    this.drawClashes();
    this.drawAttacks();
    this.drawBoats();
  }

  // One label per separate piece of territory, at the tile deepest inside it, so a name always
  // sits on its own land even with colonies across the map. The biggest piece also shows troops;
  // pieces under 12 tiles get none. Recomputed at most every half second.
  labels() {
    const g = this.game, now = performance.now();
    if (this.labelCache && now - this.labelTime < 500) return this.labelCache;
    const n = g.w * g.h, comp = new Int32Array(n).fill(-1), dist = new Int32Array(n).fill(-1);
    const pieces = [], stack = [], queue = [];
    for (let s = 0; s < n; s++) {
      const o = g.owner[s];
      if (o === NEUTRAL || comp[s] >= 0) continue;
      const id = pieces.length, piece = { owner: o, size: 0, best: s, depth: 0 };
      pieces.push(piece);
      comp[s] = id; stack.push(s);
      while (stack.length) {
        const i = stack.pop();
        piece.size++;
        if (g.isBorder(i)) { dist[i] = 0; queue.push(i); }
        for (const j of g.neighbors(i)) if (comp[j] < 0 && g.owner[j] === o) { comp[j] = id; stack.push(j); }
      }
    }
    // Distance inward from each piece's edge; the deepest tile is where its label goes.
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q], piece = pieces[comp[i]];
      if (dist[i] > piece.depth) { piece.depth = dist[i]; piece.best = i; }
      for (const j of g.neighbors(i)) if (dist[j] < 0 && comp[j] === comp[i]) { dist[j] = dist[i] + 1; queue.push(j); }
    }
    const biggest = {};
    for (const pc of pieces) if (!biggest[pc.owner] || pc.size > biggest[pc.owner].size) biggest[pc.owner] = pc;
    this.labelCache = pieces.filter(pc => pc.size >= 12 && g.players[pc.owner].alive)
      .map(pc => ({ owner: pc.owner, size: pc.size, x: pc.best % g.w, y: Math.floor(pc.best / g.w), main: biggest[pc.owner] === pc }));
    this.labelTime = now;
    return this.labelCache;
  }

  // Sparks where an attack is taking a player's tiles: a bright flash that fades out.
  drawClashes() {
    const g = this.game, ctx = this.ctx, v = this.view;
    const r = Math.max(2 * this.dpr, v.scale * 0.5);
    for (const c of g.clashes) {
      const t = (c.until - g.time) / 0.6;
      const x = v.x + (c.i % g.w + 0.5) * v.scale, y = v.y + (Math.floor(c.i / g.w) + 0.5) * v.scale;
      ctx.fillStyle = `rgba(255, ${170 + 85 * t}, ${90 + 120 * t}, ${0.7 * t})`;
      ctx.beginPath();
      ctx.arc(x, y, r * (1.6 - 0.6 * t), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // A pill with the attack's troops where its front is moving. Attacks on the human pulse red.
  drawAttacks() {
    const g = this.game, ctx = this.ctx, v = this.view, k = this.dpr;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120);
    for (const a of g.attacks) this.drawArrows(a);
    for (const a of g.attacks) {
      if (a.fx === undefined) continue;
      const x = v.x + (a.fx + 0.5) * v.scale, y = v.y + (a.fy + 0.5) * v.scale;
      if (a.target === g.human.id) {
        ctx.strokeStyle = `rgba(255, 70, 50, ${0.4 + 0.6 * pulse})`;
        ctx.lineWidth = 3 * k;
        ctx.beginPath();
        ctx.arc(x, y, (14 + 6 * pulse) * k, 0, Math.PI * 2);
        ctx.stroke();
      }
      this.pill(x, y, fmt(a.troops), g.players[a.attacker].color, a.target === g.human.id, a.attacker === g.human.id);
    }
  }

  // Where an attack meets its target: for sampled front tiles, the tile and the direction the front
  // pushes (from the attacker's land into it). Refreshed four times a second.
  arrowSpots(a) {
    const g = this.game, now = performance.now(), c = this.arrows.get(a);
    if (c && now - c.t < 250) return c.list;
    const counts = a.edge ? g.frontOf(a) : g.front(a.attacker, a.target);
    const keys = [...counts.keys()], stride = Math.max(1, Math.ceil(keys.length / 80)), list = [];
    for (let n = 0; n < keys.length; n += stride) {
      const j = keys[n], jx = j % g.w, jy = (j - jx) / g.w;
      let dx = 0, dy = 0;
      for (const m of g.neighbors(j)) if (g.owner[m] === a.attacker) { dx += jx - (m % g.w); dy += jy - Math.floor(m / g.w); }
      const len = Math.hypot(dx, dy);
      if (len) list.push([jx, jy, dx / len, dy / len]);
    }
    this.arrows.set(a, { t: now, list });
    return list;
  }

  // Arrowheads flowing across every front against a player, from the attacker's land into the
  // defender's. Your attacks are gold, attacks on you red, the rest in the attacker's colour.
  drawArrows(a) {
    const g = this.game, ctx = this.ctx, v = this.view, k = this.dpr;
    if (a.target === NEUTRAL) return;
    const me = g.human.id;
    const col = a.attacker === me ? '255, 213, 74' : a.target === me ? '255, 70, 50'
      : g.players[a.attacker].color.map(x => Math.round(x * 0.6 + 255 * 0.4)).join(', ');
    const s = Math.max(3.5 * k, 0.75 * v.scale), now = performance.now();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const [jx, jy, dx, dy] of this.arrowSpots(a)) {
      const ph = (now / 1000 + ((jx * 7 + jy * 13) % 10) / 10) % 1;
      const along = (ph - 0.5) * 1.8;
      const x = v.x + (jx + 0.5 + dx * along) * v.scale, y = v.y + (jy + 0.5 + dy * along) * v.scale;
      const alpha = Math.sin(Math.PI * ph);
      ctx.beginPath();
      ctx.moveTo(x - dx * s * 0.5 - dy * s * 0.6, y - dy * s * 0.5 + dx * s * 0.6);
      ctx.lineTo(x + dx * s * 0.5, y + dy * s * 0.5);
      ctx.lineTo(x - dx * s * 0.5 + dy * s * 0.6, y - dy * s * 0.5 - dx * s * 0.6);
      ctx.strokeStyle = `rgba(0, 0, 0, ${0.7 * alpha})`;
      ctx.lineWidth = Math.max(3 * k, 0.32 * v.scale);
      ctx.stroke();
      ctx.strokeStyle = `rgba(${col}, ${alpha})`;
      ctx.lineWidth = Math.max(1.6 * k, 0.17 * v.scale);
      ctx.stroke();
    }
  }

  // A boat's route: solid where it has been, faint dashes where it is going.
  drawRoute(path, from, to, color, alpha, dashed) {
    const g = this.game, ctx = this.ctx, v = this.view;
    if (to - from < 1) return;
    ctx.strokeStyle = `rgba(${color}, ${alpha})`;
    ctx.lineWidth = 2 * this.dpr;
    ctx.setLineDash(dashed ? [4 * this.dpr, 5 * this.dpr] : []);
    ctx.beginPath();
    for (let i = Math.floor(from); i <= Math.min(path.length - 1, Math.ceil(to)); i++) {
      const x = v.x + (path[i] % g.w + 0.5) * v.scale, y = v.y + (Math.floor(path[i] / g.w) + 0.5) * v.scale;
      if (i === Math.floor(from)) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawBoats() {
    const g = this.game, ctx = this.ctx, v = this.view, k = this.dpr;
    for (const t of g.wakes) this.drawRoute(t.path, 0, t.path.length - 1, g.players[t.owner].color, 0.6 * (t.until - g.time) / 3, false);
    for (const b of g.boats) {
      const c0 = g.players[b.owner].color;
      this.drawRoute(b.path, 0, b.pos, c0, 0.75, false);
      this.drawRoute(b.path, b.pos, b.path.length - 1, c0, 0.35, true);
    }
    for (const b of g.boats) {
      const i = Math.min(b.path.length - 1, Math.floor(b.pos)), j = Math.min(b.path.length - 1, i + 1), f = b.pos - i;
      const x0 = b.path[i] % g.w, y0 = Math.floor(b.path[i] / g.w), x1 = b.path[j] % g.w, y1 = Math.floor(b.path[j] / g.w);
      const x = v.x + (x0 + (x1 - x0) * f + 0.5) * v.scale, y = v.y + (y0 + (y1 - y0) * f + 0.5) * v.scale;
      const c = g.players[b.owner].color;
      this.boatIcon(x, y, x1 >= x0 ? 1 : -1, c);
      this.pill(x, y - 20 * k, fmt(b.troops), c, b.target === g.human.id);
    }
  }

  // A small sailing boat: dark hull, mast, and a sail in the owner's colour, facing its heading.
  boatIcon(x, y, dir, color) {
    const ctx = this.ctx, k = this.dpr;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir * k, k);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.fillStyle = '#3b2a1e';
    ctx.beginPath();
    ctx.moveTo(-9, 2); ctx.lineTo(9, 2); ctx.lineTo(6, 6); ctx.lineTo(-6, 6); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 2); ctx.lineTo(0, -10); ctx.stroke();
    ctx.fillStyle = `rgb(${color})`;
    ctx.beginPath(); ctx.moveTo(1, -10); ctx.lineTo(8, 0); ctx.lineTo(1, 0); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  pill(x, y, text, color, danger, mine) {
    const ctx = this.ctx, k = this.dpr;
    ctx.font = `700 ${11 * k}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 10 * k, h = 16 * k;
    ctx.fillStyle = 'rgba(10, 14, 22, 0.85)';
    ctx.strokeStyle = danger ? '#ff4632' : mine ? '#ffd54a' : `rgb(${color})`;
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, y + k * 0.5);
  }
}

function fmt(n) {
  n = Math.max(0, n);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(0) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return Math.floor(n).toString();
}
