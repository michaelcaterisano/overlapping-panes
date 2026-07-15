// player.js — live in-browser score player for overlapping-panes.
// Loaded by index.html when ?score=<name> is present. Ports perform_score.js's
// TROUPE engine + driver into the page (no Playwright, no recording): fetches
// scores/<name>.json, plants voices, runs the timeline live behind a ▶ button.
// Any score authored for the 2D performer plays here exactly as it renders.
(function () {
  const Q = new URLSearchParams(location.search);
  const NAME = Q.get('score');
  if (!NAME) return;

  // stage is authored in 960x720; S fits that stage to the window, centered.
  const S = Math.min(innerWidth / 960, innerHeight / 720);
  const CX = innerWidth / 2, CY = innerHeight / 2, F = 900 * S;
  const MG = +(Q.get('gain') || 0.5);
  const P = () => (typeof appState !== 'undefined' ? appState.panes : panes);
  const stageToWin = (sx, sy) => [CX + (sx - 480) * S, CY + (sy - 360) * S];
  const ENTRY = { left: [120, 340], right: [820, 340], top: [460, 130], bottom: [460, 590],
    center: [480, 360], tl: [150, 160], tr: [800, 160], bl: [150, 560], br: [800, 560] };

  // ---------- TROUPE (ported from perform_score.js, running in-page) ----------
  function installTroupe() {
    const agents = (window.__troupe = { list: [], t0: performance.now() });
    // master bus: reroute everything bound for destination through gain->comp->limiter
    if (typeof audioCtx !== 'undefined' && !window.__masterBus) {
      const master = audioCtx.createGain(); master.gain.value = MG;
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.knee.value = 18; comp.ratio.value = 8;
      comp.attack.value = 0.004; comp.release.value = 0.15;
      const lim = audioCtx.createDynamicsCompressor();
      lim.threshold.value = -4; lim.knee.value = 2; lim.ratio.value = 20;
      lim.attack.value = 0.0008; lim.release.value = 0.06;
      const trim = audioCtx.createGain(); trim.gain.value = 0.85;
      master.connect(comp); comp.connect(lim); lim.connect(trim); trim.connect(audioCtx.destination);
      const oc = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (t, ...rest) {
        if (t === audioCtx.destination && this !== trim) return oc.call(this, master, ...rest);
        return oc.call(this, t, ...rest);
      };
      window.__masterBus = { master, comp, lim, trim };
    }
    const cam = (window.__cam = {
      z: 1, tz: 1, kz: 0.008, rot: 0, vel: 0, tvel: 0, kv: 0.02, cx: CX, cy: CY,
      px: CX, py: CY, pz: -F, tpx: CX, tpy: CY, tpz: -F, kp: 0.01,
      vx: 0, vy: 0, vz: 0, tvx: 0, tvy: 0, tvz: 0, kcv: 0.02,
      yaw: 0, tyaw: 0, pitch: 0, tpitch: 0, ka: 0.012, F, NEAR: 60,
    });
    window.__setCam = cfg => Object.assign(cam, cfg);
    agents.depth = 0; agents.tdepth = 0; agents.kd = 0.02;
    window.__setDepth = (d, k) => { agents.tdepth = d; if (k) agents.kd = k; };
    const retune = p => {
      const [r, g, b] = hslToRgb(p.hsl.h, p.hsl.s, p.hsl.l);
      p.rgb = { r, g, b };
      const [L] = rgbToLab(r, g, b);
      p.baseFrequency = getFrequencyFromLabL(L);
    };
    window.__addKeeper = (idx, cfg) => {
      const p = P()[idx];
      const gp = p.gain.gain;
      if (!gp.__wrapped) {
        const orig = gp.setTargetAtTime.bind(gp);
        gp.setTargetAtTime = (v, t, tc) => orig(p.__spatial != null ? p.__spatial : v, t, tc);
        gp.__wrapped = true;
      }
      agents.list.push(Object.assign({
        id: p.id, tx: p.x, ty: p.y, tw: p.width, th: p.height,
        wx: p.x, wy: p.y, ww: p.width, wh: p.height,
        wz: 0, tz3: 0, kZ: 0.015,
        hue: p.hsl.h, lit: p.hsl.l, kPos: 0.02, kSize: 0.02, kHue: 0.015,
        breathAmp: 0.04, breathHz: 0.08, phase: 0,
      }, cfg));
    };
    window.__setKeeper = (i, cfg) => { if (agents.list[i]) Object.assign(agents.list[i], cfg); };
    window.__allKeepers = cfg => agents.list.forEach(a => Object.assign(a, cfg));
    window.__litFor = (i, targetFreq, hue, sat) => {
      const a = agents.list[i]; if (!a) return null;
      const p = P().find(q => q.id === a.id); if (!p) return null;
      const h = (hue !== undefined ? hue : a.hue);
      const s = (sat !== undefined && sat !== null) ? sat : (a.sat != null ? a.sat : p.hsl.s);
      let lo = 2, hi = 98;
      const fAt = l => { const [r, g, b] = hslToRgb(h, s, l); const [L] = rgbToLab(r, g, b); return getFrequencyFromLabL(L); };
      for (let it = 0; it < 44; it++) { const mid = (lo + hi) / 2; if (fAt(mid) < targetFreq) lo = mid; else hi = mid; }
      const edge = (lo + hi) / 2;
      let bestL = edge, bestE = 1e9;
      for (let d = -0.6; d <= 0.6; d += 0.02) { const e = Math.abs(fAt(edge + d) - targetFreq); if (e < bestE - 1e-9) { bestL = edge + d; bestE = e; } }
      const fBest = fAt(bestL);
      let l2 = bestL, h2 = bestL;
      while (l2 > bestL - 1 && Math.abs(fAt(l2 - 0.02) - fBest) < 0.01) l2 -= 0.02;
      while (h2 < bestL + 1 && Math.abs(fAt(h2 + 0.02) - fBest) < 0.01) h2 += 0.02;
      return (l2 + h2) / 2;
    };
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const t = (now - agents.t0) / 1000;
      cam.z += (cam.tz - cam.z) * cam.kz;
      cam.vel += (cam.tvel - cam.vel) * cam.kv; cam.rot += cam.vel * dt;
      cam.vx += (cam.tvx - cam.vx) * cam.kcv; cam.vy += (cam.tvy - cam.vy) * cam.kcv; cam.vz += (cam.tvz - cam.vz) * cam.kcv;
      cam.px += (cam.tpx - cam.px) * cam.kp + cam.vx * dt;
      cam.py += (cam.tpy - cam.py) * cam.kp + cam.vy * dt;
      cam.pz += (cam.tpz - cam.pz) * cam.kp + cam.vz * dt;
      cam.tpx += cam.vx * dt; cam.tpy += cam.vy * dt; cam.tpz += cam.vz * dt;
      cam.yaw += (cam.tyaw - cam.yaw) * cam.ka; cam.pitch += (cam.tpitch - cam.pitch) * cam.ka;
      agents.depth += (agents.tdepth - agents.depth) * agents.kd;
      const cos = Math.cos(cam.rot), sin = Math.sin(cam.rot);
      const cy_ = Math.cos(cam.yaw), sy_ = Math.sin(cam.yaw);
      const cp_ = Math.cos(cam.pitch), sp_ = Math.sin(cam.pitch);
      for (const a of agents.list) {
        const p = P().find(q => q.id === a.id);
        if (!p) continue;
        a.wx += (a.tx - a.wx) * a.kPos; a.wy += (a.ty - a.wy) * a.kPos; a.wz += (a.tz3 - a.wz) * a.kZ;
        a.ww += (a.tw - a.ww) * a.kSize; a.wh += (a.th - a.wh) * a.kSize;
        const breath = 1 + a.breathAmp * Math.sin(2 * Math.PI * a.breathHz * t + a.phase);
        let rx = a.wx + a.ww / 2 - cam.px, ry = a.wy + a.wh / 2 - cam.py, rz = a.wz - cam.pz;
        const rx2 = rx * cy_ - rz * sy_; let rz2 = rx * sy_ + rz * cy_;
        const ry2 = ry * cp_ - rz2 * sp_; rz2 = ry * sp_ + rz2 * cp_;
        const PIERCE = cam.NEAR * 5;
        if (rz2 < cam.NEAR) {
          if (!a.__parked) { a.__parked = true; a.__boost = 1.8; }
          a.__boost += (1 - a.__boost) * 0.05;
          const dz = Math.max(cam.NEAR, -rz2); const s3 = (cam.F / dz) * cam.z;
          p.__spatial = Math.min(0.32, 0.075 * ((a.ww * s3) * (a.wh * s3) / REF_AREA) * a.__boost);
          p.x = -99999; p.y = -99999; p.width = 1; p.height = 1; continue;
        }
        a.__parked = false;
        if (rz2 < PIERCE) {
          const tcl = (PIERCE - rz2) / (PIERCE - cam.NEAR); const s3 = (cam.F / rz2) * cam.z;
          p.__spatial = Math.min(0.2 + 0.1 * tcl, 0.075 * ((a.ww * s3) * (a.wh * s3) / REF_AREA));
        } else p.__spatial = null;
        const scale = (cam.F / rz2) * cam.z;
        const w = a.ww * breath * scale, h = a.wh * breath * scale;
        p.width = w; p.height = h;
        p.x = cam.cx + (rx2 * cos - ry2 * sin) * scale - w / 2;
        p.y = cam.cy + (rx2 * sin + ry2 * cos) * scale - h / 2;
        const dh = ((a.hue - p.hsl.h + 540) % 360) - 180, dl = a.lit - p.hsl.l, ds = (a.sat != null ? a.sat : p.hsl.s) - p.hsl.s;
        if (Math.abs(dh) > 0.05 || Math.abs(dl) > 0.05 || Math.abs(ds) > 0.05) {
          p.hsl.h = (p.hsl.h + dh * a.kHue + 360) % 360;
          p.hsl.l = p.hsl.l + dl * a.kHue;
          p.hsl.s = Math.max(0, Math.min(100, p.hsl.s + ds * a.kHue));
          retune(p);
        }
        p.__alpha = a.alpha;
      }
    }, 33);
  }

  // ---------- VOLUMES draw override (flat panes -> extruded blocks) ----------
  function installVolumes(alpha0) {
    Pane.prototype.draw = function (ctx) {
      const { r, g, b } = this.rgb;
      const x = this.x, y = this.y, w = this.width, hh = this.height;
      const d = window.__troupe ? window.__troupe.depth : 0;
      ctx.globalAlpha = this.__alpha != null ? this.__alpha : alpha0;
      const c = (m, add) => 'rgb(' + Math.min(255, r * m + add) + ',' + Math.min(255, g * m + add) + ',' + Math.min(255, b * m + add) + ')';
      const rect = (px, py, pw, ph, fill) => { ctx.fillStyle = fill; ctx.fillRect(px, py, pw, ph); };
      const poly = (pts, fill) => { ctx.fillStyle = fill; ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.fill(); };
      if (d > 0.004) {
        const f = Math.max(0.25, 1.25 - (this.baseFrequency - 100) / 900);
        const dep = Math.min(w, hh) * 0.42 * f * d, dx = dep * 0.72, dy = dep * 0.72;
        poly([[x, y], [x + dx, y - dy], [x + w + dx, y - dy], [x + w, y]], c(1.45, 24));       // lit top
        poly([[x + w, y], [x + w + dx, y - dy], [x + w + dx, y + hh - dy], [x + w, y + hh]], c(0.5, 0)); // shadow side
      }
      rect(x, y, w, hh, 'rgb(' + r + ',' + g + ',' + b + ')');
      ctx.globalAlpha = 1;
    };
  }

  // ---------- driver (ported: plant, MOVES, timeline) ----------
  async function run(score) {
    const voices = score.voices.map(v => ({ ...v,
      hz: Math.min(985, Math.max(106, score.axisHz * (v.ratioNum / v.ratioDen) * Math.pow(2, v.octaveShift || 0))) }));
    const byName = {}; voices.forEach((v, i) => { byName[v.name] = i; });
    const voiceRef = ref => (typeof ref === 'number' && ref >= 0 && ref < voices.length) ? ref : byName[ref];
    const kIdx = {};
    const planted = new Set();
    const keeper = (i, cfg) => window.__setKeeper(i, cfg);
    const all = cfg => window.__allKeepers(cfg);
    const setCam = c => window.__setCam(c);
    const agent = i => window.__troupe.list[i];

    const tune = (vi, hz, hue, kHue, sat) => {
      const i = kIdx[vi] != null ? kIdx[vi] : vi;
      const lit = window.__litFor(i, hz, hue, sat == null ? null : sat);
      if (lit == null) return;
      const cfg = { lit };
      if (hue !== undefined) cfg.hue = hue;
      if (kHue !== undefined) cfg.kHue = kHue;
      if (sat != null) cfg.sat = sat;
      keeper(i, cfg);
    };
    const plant = v => {
      const [ex, ey] = stageToWin(...(ENTRY[v.entryFrom] || ENTRY.center));
      const pane = new Pane(ex, ey, (v.w || 210) * S, (v.h || 180) * S, 0);
      P().push(pane);
      if (pane.slider) { try { pane.slider.remove(); } catch (e) {} pane.slider = null; }
      const idx = P().length - 1;
      kIdx[byName[v.name]] = idx;
      window.__addKeeper(idx, { tw: (v.w || 210) * S, th: (v.h || 180) * S, hue: v.hue, kHue: 0.05,
        ...(v.sat != null ? { sat: v.sat } : {}), ...(v.alpha != null ? { alpha: v.alpha } : {}) });
      tune(byName[v.name], v.hz, v.hue, undefined, v.sat);
    };

    const pitchOrder = () => voices.map((v, i) => [i, v.hz]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
    const arrange = (positions, w, h, kPos) => {
      for (const [vi, x, y] of positions) {
        if (!planted.has(vi)) continue;
        const cfg = { tx: x, ty: y, kPos: kPos || 0.014 };
        if (w) { cfg.tw = w; cfg.th = h; }
        keeper(kIdx[vi], cfg);
      }
    };

    const MOVES = {
      mirror: a => {
        const gap = a.gap || 250 * S, ord = pitchOrder().filter(i => planted.has(i)), mid = Math.floor(ord.length / 2), pos = [];
        for (let k = 0; k < ord.length; k++) { const off = k - mid; pos.push([ord[k], CX - 105 * S + off * gap * 0.9, CY - 90 * S + Math.abs(off) * 20 * S]); }
        arrange(pos, a.w, a.h, a.kPos);
      },
      cascade: a => {
        const step = a.step || 60 * S, w = a.w || 330 * S, h = a.h || 270 * S, ord = pitchOrder().filter(i => planted.has(i)), n = ord.length;
        const x0 = CX - (n - 1) * step / 2 - w / 2, y0 = CY - (n - 1) * step * 0.36 - h / 2;
        arrange(ord.map((i, k) => [i, x0 + k * step, y0 + Math.round(k * step * 0.72)]), w, h, a.kPos || 0.03);
      },
      column: a => {
        const step = a.step || 78 * S, w = a.w || 280 * S, h = a.h || 140 * S, ord = pitchOrder().filter(i => planted.has(i)), n = ord.length, y0 = CY + (n - 1) * step / 2 - h / 2;
        arrange(ord.map((i, k) => [i, (a.x || CX) - w / 2, y0 - k * step]), w, h, a.kPos);
      },
      row: a => {
        const step = a.step || 110 * S, w = a.w || 160 * S, h = a.h || 300 * S, ord = pitchOrder().filter(i => planted.has(i)), n = ord.length, x0 = CX - (n - 1) * step / 2 - w / 2;
        arrange(ord.map((i, k) => [i, x0 + k * step, (a.y || CY) - h / 2]), w, h, a.kPos);
      },
      ring: a => {
        const r = a.radius || 210 * S, w = a.w || 230 * S, h = a.h || 190 * S, ord = pitchOrder().filter(i => planted.has(i));
        arrange(ord.map((i, k) => { const th = -Math.PI / 2 + (k / ord.length) * 2 * Math.PI; return [i, CX + r * Math.cos(th) - w / 2, CY + r * Math.sin(th) - h / 2]; }), w, h, a.kPos);
      },
      converge: a => {
        const depth = a.depth == null ? 0.7 : a.depth;
        for (const vi of planted) { const ag = agent(kIdx[vi]); if (!ag) continue; keeper(kIdx[vi], { tx: ag.tx + (CX - 130 * S - ag.tx) * depth, ty: ag.ty + (CY - 110 * S - ag.ty) * depth, kPos: a.kPos || 0.012 }); }
      },
      disperse: a => {
        const spots = [[100, 120], [640, 110], [110, 470], [660, 460], [370, 80], [380, 520], [90, 290], [680, 290], [380, 300]], ord = pitchOrder().filter(i => planted.has(i));
        arrange(ord.map((i, k) => [i, spots[k % spots.length][0] * S, spots[k % spots.length][1] * S]), a.w, a.h, a.kPos || 0.012);
      },
      retune: a => { const i = voiceRef(a.voice); if (i == null || !planted.has(i)) return; const hz = Math.min(985, Math.max(106, score.axisHz * (a.num / a.den) * Math.pow(2, a.oct || 0))); voices[i].hz = hz; tune(i, hz, undefined, a.kHue || 0.008); },
      swap: a => { const i = voiceRef(a.a), j = voiceRef(a.b); if (i == null || j == null) return; const fi = voices[i].hz, fj = voices[j].hz; voices[i].hz = fj; voices[j].hz = fi; tune(i, fj, undefined, 0.006); tune(j, fi, undefined, 0.006); },
      hueShift: a => { for (const vi of planted) { const hue = (voices[vi].hue + (a.deg || 40) + 360) % 360; voices[vi].hue = hue; tune(vi, voices[vi].hz, hue, a.kHue || 0.01); } },
      breathSync: a => all({ phase: 0, breathHz: a.hz || 0.08, breathAmp: a.amp || 0.07 }),
      breathWave: a => { const ord = pitchOrder().filter(i => planted.has(i)); for (let k = 0; k < ord.length; k++) keeper(kIdx[ord[k]], { phase: (k / ord.length) * 2 * Math.PI, breathHz: a.hz || 0.1, breathAmp: a.amp || 0.09 }); },
      grow: a => { for (const vi of planted) { const ag = agent(kIdx[vi]); if (ag) keeper(kIdx[vi], { tw: Math.min(560 * S, ag.tw * (a.factor || 1.25)), th: Math.min(460 * S, ag.th * (a.factor || 1.25)) }); } },
      shrink: a => MOVES.grow({ factor: a.factor || 0.8 }),
      swellOne: a => {
        const vi = voiceRef(a.voice); if (vi == null || !planted.has(vi)) return; const ki = kIdx[vi], ag = agent(ki); if (!ag) return;
        const tw = ag.tw, th = ag.th;
        keeper(ki, { tw: tw * (a.factor || 1.6), th: th * (a.factor || 1.6), kSize: 0.03 });
        setTimeout(() => keeper(ki, { tw, th, kSize: 0.02 }), (a.holdMs || 4000));
      },
      stillness: () => all({ breathAmp: 0.0, kPos: 0.003 }),
      orbit: a => {
        const vi = voiceRef(a.voice); if (vi == null || !planted.has(vi)) return; const ag = agent(kIdx[vi]); if (!ag) return;
        const th = (a.angleDeg || 0) * Math.PI / 180, tw = a.w || ag.tw, thh = a.h || ag.th;
        keeper(kIdx[vi], { tw, th: thh, tx: CX + (a.radius || 0) * Math.cos(th) - tw / 2, ty: CY + (a.radius || 0) * Math.sin(th) - thh / 2, kPos: a.kPos || 0.008 });
      },
      orbits: a => { const ord = pitchOrder().filter(i => planted.has(i)); for (let k = 0; k < ord.length; k++) { const r = (a.r0 || 0) + k * (a.rStep || 120 * S), deg = (a.angle0Deg == null ? -90 : a.angle0Deg) + k * (a.stepDeg == null ? 137.5 : a.stepDeg); MOVES.orbit({ voice: voices[ord[k]].name, radius: r, angleDeg: deg, w: a.w, h: a.h, kPos: a.kPos }); } },
      zoom: a => setCam({ tz: a.z == null ? 1 : a.z, kz: a.k || 0.008 }),
      spin: a => setCam({ tvel: a.vel || 0, kv: a.k || 0.02 }),
      paint: a => {
        const targets = (a.voice == null || a.voice === '*') ? [...planted] : [voiceRef(a.voice)].filter(v => v != null && planted.has(v));
        for (const vi of targets) { if (a.hue !== undefined) voices[vi].hue = (a.hue + 360) % 360; tune(vi, voices[vi].hz, a.hue, a.k || 0.01, a.sat); if (a.alpha !== undefined) keeper(kIdx[vi], { alpha: a.alpha }); }
      },
      depth: a => { const vi = voiceRef(a.voice); if (vi == null || !planted.has(vi)) return; keeper(kIdx[vi], { tz3: a.z || 0, kZ: a.k || 0.015 }); },
      layout3d: a => {
        let ord = pitchOrder().filter(i => planted.has(i)); if (a.reverse) ord = ord.slice().reverse();
        for (let k = 0; k < ord.length; k++) {
          const vi = ord[k]; let x = CX, y = CY, z = (a.z0 || 0) + k * (a.zStep || 300 * S);
          if (a.mode === 'tunnel') { const th = k * 2.4, r = (a.radius || 260 * S); x = CX + r * Math.cos(th); y = CY + r * 0.62 * Math.sin(th); }
          else if (a.mode === 'helix') { const th = (a.angle0 || 0) + k * (a.stepRad || 1.1), r = (a.radius || 300 * S); x = CX + r * Math.cos(th); y = CY + r * 0.7 * Math.sin(th); }
          else { x = CX + Math.sin(k * 12.9898) * (a.spread || 420 * S); y = CY + Math.sin(k * 78.233) * (a.spread || 420 * S) * 0.7; z = (a.z0 || 0) + ((k * 7) % ord.length) * (a.zStep || 300 * S); }
          const ag = agent(kIdx[vi]); if (!ag) continue;
          keeper(kIdx[vi], { tx: x - ag.tw / 2, ty: y - ag.th / 2, tz3: z, kPos: a.kPos || 0.02, kZ: a.kZ || 0.015, ...(a.w ? { tw: a.w * S, th: a.h * S } : {}) });
        }
      },
      flyTo: a => setCam({ tpx: a.x != null ? a.x : CX, tpy: a.y != null ? a.y : CY, tpz: a.z != null ? a.z : -900 * S, kp: a.k || 0.01 }),
      cruise: a => setCam({ tvx: a.vx || 0, tvy: a.vy || 0, tvz: a.vz || 0, kcv: a.k || 0.02 }),
      yaw: a => setCam({ tyaw: (a.deg || 0) * Math.PI / 180, ka: a.k || 0.012 }),
      pitch: a => setCam({ tpitch: (a.deg || 0) * Math.PI / 180, ka: a.k || 0.012 }),
      extrude: a => window.__setDepth(Math.max(0, Math.min(1, a.d == null ? 1 : a.d)), a.k || 0.02),
      tilt: () => {},   // CSS-canvas warp is a render-only recording move; no-op live
    };

    // scores author pixel keys in 960x720 stage space -> scale to window
    const scaleArgs = (a, move) => {
      const o = { ...a };
      for (const k of ['gap', 'step', 'w', 'h', 'x', 'y', 'radius', 'r0', 'rStep', 'z0', 'zStep', 'spread', 'vx', 'vy', 'vz']) if (o[k] != null) o[k] *= S;
      if (o.z != null && (move === 'depth' || move === 'flyTo')) o.z *= S;
      return o;
    };

    const events = [];
    voices.forEach(v => events.push({ atSec: v.entryAtSec, run: () => { plant(v); planted.add(byName[v.name]); } }));
    (score.events || []).forEach(e => events.push({ atSec: e.atSec, run: () => (MOVES[e.move] || (() => {}))(scaleArgs(e.args || {}, e.move)) }));
    events.sort((a, b) => a.atSec - b.atSec);
    for (const ev of events) setTimeout(() => { try { ev.run(); } catch (e) { console.warn('EV', e); } }, ev.atSec * 1000);
  }

  // ---------- boot: fetch score, show ▶, play ----------
  async function boot() {
    let score;
    try { score = await (await fetch('scores/' + NAME + '.json')).json(); }
    catch (e) { alert('score not found: ' + NAME); return; }
    const h = document.getElementById('howto'); if (h) h.remove();
    installTroupe();
    installVolumes(Number(Q.get('alpha') || 0.8));
    const ov = document.createElement('div');
    ov.textContent = '▶  play  ·  ' + (score.title || NAME);
    ov.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:1000;'
      + 'font:600 20px system-ui,Helvetica,Arial,sans-serif;color:#e8e4d8;background:rgba(0,0,0,.72);cursor:pointer;letter-spacing:.02em;text-align:center;padding:0 8vw';
    document.body.appendChild(ov);
    ov.addEventListener('pointerdown', () => {
      ov.remove();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      run(score);
    }, { once: true });
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 300);
  else addEventListener('load', () => setTimeout(boot, 300));
})();
