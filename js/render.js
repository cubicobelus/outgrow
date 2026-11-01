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

  updateView() {
    const c = this.cam, g = this.game;
    c.zoom = Math.max(1, Math.min(10, c.zoom));
    const scale = this.fit * c.zoom;
    // Keep the map on screen: at full zoom out it is centred, zoomed in it cannot be dragged away.
    const halfW = this.canvas.width / 2 / scale, halfH = this.canvas.height / 2 / scale;
    c.cx = g.w / 2 <= halfW ? g.w / 2 : Math.max(halfW, Math.min(g.w - halfW, c.cx));
    c.cy = g.h / 2 <= halfH ? g.h / 2 : Math.max(halfH, Math.min(g.h - halfH, c.cy));
    this.view = { scale, x: this.canvas.width / 2 - c.cx * scale, y: this.canvas.height / 2 - c.cy * scale };
  }

  // Zooms by `factor`, keeping the map point under the cursor in place.
  zoomAt(clientX, clientY, factor) {
    const r = this.canvas.getBoundingClientRect();
    const sx = (clientX - r.left) * this.dpr, sy = (clientY - r.top) * this.dpr;
    const tx = (sx - this.view.x) / this.view.scale, ty = (sy - this.view.y) / this.view.scale;
    this.cam.zoom *= factor;
    this.updateView();
    this.cam.cx += tx - (sx - this.view.x) / this.view.scale;
    this.cam.cy += ty - (sy - this.view.y) / this.view.scale;
    this.updateView();
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

  draw() {
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
    for (const p of g.players) {
      if (!p.alive || p.tiles < 12) continue;
      const size = Math.max(10, Math.min(36, Math.sqrt(p.tiles) * v.scale * 0.35));
      const x = v.x + (p.sumX / p.tiles + 0.5) * v.scale;
      const y = v.y + (p.sumY / p.tiles + 0.5) * v.scale;
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      ctx.lineWidth = size / 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.fillStyle = '#fff';
      ctx.strokeText(p.name, x, y - size * 0.55);
      ctx.fillText(p.name, x, y - size * 0.55);
      ctx.font = `${size * 0.8}px system-ui, sans-serif`;
      ctx.strokeText(fmt(p.troops), x, y + size * 0.45);
      ctx.fillText(fmt(p.troops), x, y + size * 0.45);
    }
    this.drawAttacks();
    this.drawBoats();
  }

  // A pill with the attack's troops where its front is moving. Attacks on the human pulse red.
  drawAttacks() {
    const g = this.game, ctx = this.ctx, v = this.view, k = this.dpr;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120);
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
      this.pill(x, y, fmt(a.troops), g.players[a.attacker].color, a.target === g.human.id);
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
      ctx.fillStyle = `rgb(${c})`;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 * k;
      ctx.beginPath();
      ctx.moveTo(x - 7 * k, y - 2 * k); ctx.lineTo(x + 7 * k, y - 2 * k); ctx.lineTo(x + 4 * k, y + 4 * k); ctx.lineTo(x - 4 * k, y + 4 * k);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      this.pill(x, y - 13 * k, fmt(b.troops), c, b.target === g.human.id);
    }
  }

  pill(x, y, text, color, danger) {
    const ctx = this.ctx, k = this.dpr;
    ctx.font = `700 ${11 * k}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 10 * k, h = 16 * k;
    ctx.fillStyle = 'rgba(10, 14, 22, 0.85)';
    ctx.strokeStyle = danger ? '#ff4632' : `rgb(${color})`;
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
