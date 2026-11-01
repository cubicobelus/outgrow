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
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    const scale = Math.min(this.canvas.width / this.game.w, this.canvas.height / this.game.h);
    this.view = {
      scale,
      x: (this.canvas.width - this.game.w * scale) / 2,
      y: (this.canvas.height - this.game.h * scale) / 2,
    };
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
  }
}

function fmt(n) {
  n = Math.max(0, n);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(0) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return Math.floor(n).toString();
}
