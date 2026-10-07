/* SecureBot dashboard. No dependencies. Talks to the existing Flask API:
   POST /api/login, GET /api/telemetry, /api/history, /api/alerts (Bearer token). */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reduceQuery.matches;
  reduceQuery.addEventListener?.('change', (e) => { reduced = e.matches; });

  const STALE_MS = 5000;        // no new reading for this long -> "Signal lost"
  const TELEMETRY_MS = 300;
  const ALERTS_MS = 2000;
  const FETCH_TIMEOUT_MS = 5000;
  const POINTS = 50;            // readings kept per chart (the server keeps the same 50)
  const TOKEN_KEY = 'securebot-token';
  const THEME_KEY = 'securebot-theme';

  // ── storage (may throw in private windows) ─────────────
  const safe = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
  const store = {
    get: () => safe(() => sessionStorage.getItem(TOKEN_KEY) || '', ''),
    set: (v) => safe(() => sessionStorage.setItem(TOKEN_KEY, v)),
    clear: () => safe(() => sessionStorage.removeItem(TOKEN_KEY)),
  };

  const S = {
    token: store.get(),
    sid: 0,                  // session id: bumps on every sign-in/out so late responses from an old session are ignored
    ready: false,            // false while the history warm-up is in flight (polling waits for it)
    frames: 0,               // readings this browser has seen (not every reading the sensor published)
    lastKey: '',             // identity of the newest reading seen
    lastChangeAt: 0,         // performance.now() when a new reading last arrived (fallback clock)
    latest: null,
    alerts: [],
    state: 'connecting',
    alertKeys: new Set(),
    firstAlertLoad: true,
    alertFails: 0,
    serverOffset: null,      // server clock minus browser clock (ms), from the HTTP Date header
    mode: 'raw',             // 'raw' | 'delta' (change from rest)
    paused: false,
  };

  class Superseded extends Error {}   // a response that belongs to a previous session

  const fmt = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '—');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // ts alone could in theory repeat, so identity also includes the values.
  const readingKey = (d) => `${d.ts}|${d.ax}|${d.ay}|${d.az}|${d.gx}|${d.gy}|${d.gz}|${d.tamper ? 1 : 0}`;
  const alertKey = (x) => `${x.ts}|${x.ax}|${x.ay}|${x.az}`;

  // Sensor timestamps come from the Pi, so compare them with the Pi's clock, not the browser's.
  const nowSec = () => (Date.now() + (S.serverOffset || 0)) / 1000;

  function ago(ts) {
    const s = Math.max(0, Math.round(nowSec() - ts));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }

  // ── theme (system / light / dark) ──────────────────────
  const THEMES = [['system', 'follow system'], ['light', 'light'], ['dark', 'dark']];
  let themeIdx = Math.max(0, THEMES.findIndex(([k]) => k === safe(() => localStorage.getItem(THEME_KEY), 'system')));
  function applyTheme() {
    const [key, label] = THEMES[themeIdx];
    if (key === 'system') { root.removeAttribute('data-theme'); safe(() => localStorage.removeItem(THEME_KEY)); }
    else { root.setAttribute('data-theme', key); safe(() => localStorage.setItem(THEME_KEY, key)); }
    $('theme-btn').setAttribute('aria-label', `Theme: ${label}. Activate to change.`);
    $('theme-btn').title = `Theme: ${label}`;
  }
  $('theme-btn').addEventListener('click', () => { themeIdx = (themeIdx + 1) % THEMES.length; applyTheme(); });
  applyTheme();

  // ── render scheduling: do work only when something changed ──
  let raf = 0;
  let chartsDirty = false;
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0;
    let more = stepTweens();
    more = stepTilt() || more;
    if (chartsDirty) { chartsDirty = false; charts.forEach((c) => c.render()); }
    if (more) kick();
  }

  // ── auth ───────────────────────────────────────────────
  function hideLogin() {
    root.classList.add('authed');
    $('app').removeAttribute('inert');
  }

  // Ends the current session: invalidates in-flight requests and wipes everything on screen.
  function showLogin() {
    S.sid++;
    S.token = '';
    S.ready = false;
    store.clear();
    resetSessionUI();
    setState('connecting');
    root.classList.remove('authed');
    $('login-pass').value = '';
    $('app').setAttribute('inert', '');
    setTimeout(() => $('login-user').focus(), 0);
  }

  async function authFetch(url) {
    const sid = S.sid;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);   // a hung request must not wedge polling
    let r;
    try {
      r = await fetch(url, { headers: { Authorization: `Bearer ${S.token}` }, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (sid !== S.sid) throw new Superseded();
    const serverDate = Date.parse(r.headers.get('Date') || '');
    if (!isNaN(serverDate)) S.serverOffset = serverDate - Date.now();
    if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (sid !== S.sid) throw new Superseded();
    return data;
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-error');
    const btn = $('login-submit');
    const username = $('login-user').value;
    const password = $('login-pass').value;
    err.textContent = '';
    if (!username || !password) { err.textContent = 'Enter your username and password.'; return; }
    btn.disabled = true;
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) {
        err.textContent = r.status === 401 ? 'Invalid username or password.' : `Sign-in failed (HTTP ${r.status}).`;
        return;
      }
      S.token = (await r.json()).token;
      store.set(S.token);
      hideLogin();
      startSession();
    } catch (_) {
      err.textContent = 'Could not reach the dashboard server.';
    } finally {
      btn.disabled = false;
    }
  });

  $('signout').addEventListener('click', () => { showLogin(); window.scrollTo(0, 0); });

  // ── state: status tile, pill, screen-reader announcement ──
  const ICONS = {
    check: 'm5 12.5 4.5 4.5L19 7.5',
    alert: 'M12 4 3 19.5h18L12 4ZM12 10.5v4M12 17.2v.01',
    info: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 8v5M12 16.2v.01',
    dots: 'M6.5 12h.01M12 12h.01M17.5 12h.01',
  };
  const COPY = {
    connecting: ['Connecting', 'Reaching your SecureBot dashboard…', 'Connecting', 'dots'],
    waiting: ['Waiting for the sensor', 'You are signed in, but no readings have arrived. Check that the Arduino, the MQTT broker and the serial reader are running.', 'Waiting', 'dots'],
    clear: ['All clear', 'No tampering detected. Live data is flowing from the sensor.', 'All clear', 'check'],
    tamper: ['Tamper detected', 'The sensor flagged movement. Go and check the device.', 'Tamper', 'alert'],
    stale: ['Signal lost', 'No new readings have arrived. The sensor, the serial reader or the broker may have stopped.', 'Signal lost', 'info'],
  };

  function setState(next) {
    if (next === S.state) return;
    S.state = next;
    document.body.dataset.state = next;
    const [title, sub, pill, icon] = COPY[next];
    const t = $('hero-title-text');
    t.textContent = title;
    t.classList.remove('swap');
    void t.offsetWidth;                         // restart the animation
    t.classList.add('swap');
    $('hero-sub').textContent = sub;
    $('nav-pill-text').textContent = pill;
    $('status-icon-path').setAttribute('d', ICONS[icon]);
    $('pill-icon-path').setAttribute('d', ICONS[icon]);
    const svg = $('status-icon-path').ownerSVGElement;
    svg.classList.remove('swap'); void svg.getBoundingClientRect(); svg.classList.add('swap');
    $('sr-status').textContent = `${title}. ${sub}`;
    $('signal').textContent = next === 'stale' ? 'Lost' : next === 'waiting' || next === 'connecting' ? 'Waiting' : 'Live';
  }

  function updateMeta() {
    const el = $('asof');
    if (!S.latest) { el.textContent = 'No readings yet'; return; }
    el.textContent = `${S.paused ? 'Charts paused · ' : ''}Last reading ${clock(S.latest.ts)}`;
  }

  // ── smooth numbers ─────────────────────────────────────
  const tweens = new Map();   // element -> { cur, target, decimals, int }
  function tweenTo(id, target, decimals = 2, opts = {}) {
    const el = $(id);
    if (!el) return;
    let t = tweens.get(el);
    if (!t) {
      t = { cur: target, target, decimals, int: !!opts.int };
      tweens.set(el, t);
      el.textContent = opts.int ? Math.round(target).toLocaleString() : fmt(target, decimals);
      return;
    }
    t.target = target;
    kick();
  }

  function stepTweens() {
    let more = false;
    tweens.forEach((t, el) => {
      if (t.cur === t.target) return;
      t.cur = reduced ? t.target : t.cur + (t.target - t.cur) * 0.22;
      if (Math.abs(t.target - t.cur) < Math.pow(10, -t.decimals) / 2) t.cur = t.target;
      else more = true;
      el.textContent = t.int ? Math.round(t.cur).toLocaleString() : fmt(t.cur, t.decimals);
    });
    return more;
  }

  // ── charts (SVG: hover crosshair, keyboard, legend, table view) ──
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (name, attrs = {}) => {
    const el = document.createElementNS(SVG_NS, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  };
  const tip = $('tip');

  function niceNum(x, round) {
    const exp = Math.floor(Math.log10(x)), f = x / Math.pow(10, exp);
    const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
    return nf * Math.pow(10, exp);
  }
  function niceScale(min, max, count) {
    let range = max - min;
    if (range < 1e-9) { min -= 0.5; max += 0.5; range = 1; }
    const pad = range * 0.08;
    const step = niceNum((range + 2 * pad) / count, true);
    const lo = Math.floor((min - pad) / step) * step;
    const hi = Math.ceil((max + pad) / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
    return { lo, hi, ticks, step };
  }
  const tickText = (v, step) => {
    const dec = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
    const s = v.toFixed(dec);
    return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
  };

  function makeChart({ bodyId, legendId, fields, names, label }) {
    const body = $(bodyId), legend = $(legendId);
    const rows = [];                 // { ts, v: [..] } newest last
    let snap = null;                 // frozen copy while paused
    let geom = null;                 // last render geometry, used by hover
    let hoverTs = null, hoverIdx = -1;
    let drawn = false, tableOn = false;
    const H = 190, M = { l: 46, r: 14, t: 10, b: 24 };

    const valEls = fields.map((_, i) => {
      const li = document.createElement('li');
      const key = document.createElement('span'); key.className = 'key'; key.style.setProperty('--c', `var(--series-${i + 1})`);
      const nm = document.createElement('span'); nm.className = 'legend-name'; nm.textContent = names[i];
      const val = document.createElement('span'); val.className = 'legend-val'; val.textContent = '—';
      li.append(key, nm, val);
      legend.appendChild(li);
      return val;
    });

    const svg = svgEl('svg', { class: 'chart-svg', tabindex: '0', role: 'img', 'aria-label': `${label} line chart of the last ${POINTS} readings on three axes. Use the left and right arrow keys to inspect values, or open the table view.` });
    const gGrid = svgEl('g'), gX = svgEl('g');
    const xh = svgEl('line', { class: 'xh', visibility: 'hidden' });
    const lines = fields.map((_, i) => { const p = svgEl('path', { class: 'ln' }); p.style.setProperty('--c', `var(--series-${i + 1})`); return p; });
    const dots = fields.map((_, i) => { const c = svgEl('circle', { class: 'dot', r: 5, visibility: 'hidden' }); c.style.setProperty('--c', `var(--series-${i + 1})`); return c; });
    const hov = fields.map((_, i) => { const c = svgEl('circle', { class: 'dot', r: 5, visibility: 'hidden' }); c.style.setProperty('--c', `var(--series-${i + 1})`); return c; });
    svg.append(gGrid, gX, ...lines, xh, ...dots, ...hov);

    const tableWrap = document.createElement('div');
    tableWrap.className = 'table-wrap'; tableWrap.hidden = true;
    const table = document.createElement('table'); table.className = 'data-table';
    const cap = document.createElement('caption'); cap.className = 'sr-only'; cap.textContent = `${label}: last ${POINTS} readings, newest first`;
    const thead = document.createElement('thead'), hr = document.createElement('tr');
    ['Time', ...names].forEach((h) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = h; hr.appendChild(th); });
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');
    table.append(cap, thead, tbody);
    tableWrap.appendChild(table);
    body.append(svg, tableWrap);

    new ResizeObserver(() => { chartsDirty = true; kick(); }).observe(body);

    const source = () => snap || rows;
    function series() {
      const src = source();
      const means = fields.map((_, k) => (S.mode === 'delta' && src.length ? src.reduce((a, r) => a + r.v[k], 0) / src.length : 0));
      return { src, vs: fields.map((_, k) => src.map((r) => r.v[k] - means[k])) };
    }

    function render() {
      const W = body.clientWidth;
      if (!W) return;
      const { src, vs } = series();
      const n = src.length;
      tableWrap.hidden = !tableOn;
      svg.style.display = tableOn ? 'none' : '';
      const last = n - 1;
      fields.forEach((_, k) => { valEls[k].textContent = n ? fmt(vs[k][last]) : '—'; });
      if (tableOn) { renderTable(src, vs); return; }

      svg.setAttribute('width', W); svg.setAttribute('height', H);
      const innerW = W - M.l - M.r, innerH = H - M.t - M.b;
      let mn = Infinity, mx = -Infinity;
      vs.forEach((a) => a.forEach((v) => { if (v < mn) mn = v; if (v > mx) mx = v; }));
      if (!isFinite(mn)) { mn = -1; mx = 1; }
      if (S.mode === 'delta') { mn = Math.min(mn, -0.05); mx = Math.max(mx, 0.05); }
      const sc = niceScale(mn, mx, 4);
      const toY = (v) => M.t + innerH - ((v - sc.lo) / (sc.hi - sc.lo)) * innerH;
      const toX = (i) => M.l + ((i + (POINTS - n)) / (POINTS - 1)) * innerW;

      // hairline grid + tick labels (recessive)
      const g = [];
      sc.ticks.forEach((t) => {
        const y = Math.round(toY(t)) + 0.5;
        g.push(svgEl('line', { class: t === 0 ? 'zero' : 'gl', x1: M.l, x2: W - M.r, y1: y, y2: y }));
        const tx = svgEl('text', { class: 'axis-t', x: M.l - 8, y: y + 4, 'text-anchor': 'end' });
        tx.textContent = tickText(t, sc.step);
        g.push(tx);
      });
      gGrid.replaceChildren(...g);
      const xs = [];
      if (n > 1) {
        [[0, 'start', M.l], [last, 'end', W - M.r]].forEach(([i, anchor, x]) => {
          const tx = svgEl('text', { class: 'axis-t', x, y: H - 6, 'text-anchor': anchor });
          tx.textContent = clock(src[i].ts);
          xs.push(tx);
        });
      }
      gX.replaceChildren(...xs);

      fields.forEach((_, k) => {
        if (n < 2) { lines[k].setAttribute('d', ''); dots[k].setAttribute('visibility', 'hidden'); return; }
        lines[k].setAttribute('d', vs[k].map((v, i) => `${i ? 'L' : 'M'}${toX(i).toFixed(1)} ${toY(v).toFixed(1)}`).join(''));
        dots[k].setAttribute('cx', toX(last).toFixed(1)); dots[k].setAttribute('cy', toY(vs[k][last]).toFixed(1));
        dots[k].setAttribute('visibility', 'visible');
      });
      if (n >= 2 && !drawn && !reduced) {
        drawn = true;
        lines.forEach((p) => {
          p.setAttribute('pathLength', '1'); p.classList.add('draw');
          p.addEventListener('animationend', () => { p.classList.remove('draw'); p.removeAttribute('pathLength'); }, { once: true });
        });
      } else if (n >= 2) drawn = true;

      geom = { src, vs, toX, toY, n, W };
      if (hoverTs !== null) {                       // keep the crosshair on the same reading as data scrolls
        const i = src.findIndex((r) => r.ts === hoverTs);
        if (i < 0) clearHover(); else showHover(i, null);
      }
    }

    function renderTable(src, vs) {
      const frag = [];
      for (let i = src.length - 1; i >= 0; i--) {
        const tr = document.createElement('tr');
        const td = document.createElement('td'); td.textContent = clock(src[i].ts); tr.appendChild(td);
        fields.forEach((_, k) => { const c = document.createElement('td'); c.textContent = fmt(vs[k][i]); tr.appendChild(c); });
        frag.push(tr);
      }
      tbody.replaceChildren(...frag);
    }

    // hover / keyboard
    function showHover(i, pointer) {
      if (!geom || i < 0 || i >= geom.n) return;
      const { src, vs, toX, toY } = geom;
      hoverIdx = i; hoverTs = src[i].ts;
      const x = toX(i);
      xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.setAttribute('y1', M.t); xh.setAttribute('y2', H - M.b); xh.setAttribute('visibility', 'visible');
      fields.forEach((_, k) => { hov[k].setAttribute('cx', x); hov[k].setAttribute('cy', toY(vs[k][i])); hov[k].setAttribute('visibility', 'visible'); });
      // tooltip: values lead, names follow; DOM + textContent only
      const time = document.createElement('div'); time.className = 'tip-time'; time.textContent = clock(src[i].ts);
      const rowsEl = fields.map((_, k) => {
        const r = document.createElement('div'); r.className = 'tip-row';
        const key = document.createElement('span'); key.className = 'key'; key.style.setProperty('--c', `var(--series-${k + 1})`);
        const nm = document.createElement('span'); nm.className = 'tip-name'; nm.textContent = names[k];
        const v = document.createElement('span'); v.className = 'tip-val'; v.textContent = fmt(vs[k][i]);
        r.append(key, nm, v);
        return r;
      });
      tip.replaceChildren(time, ...rowsEl);
      tip.hidden = false;
      const box = svg.getBoundingClientRect();
      const px = pointer ? pointer.x : box.left + x;
      const py = pointer ? pointer.y : box.top + toY(vs[0][i]);
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = `${clamp(px + 16, 8, window.innerWidth - tw - 8)}px`;
      tip.style.top = `${clamp(py - th / 2, 8, window.innerHeight - th - 8)}px`;
    }
    function clearHover() {
      hoverTs = null; hoverIdx = -1;
      xh.setAttribute('visibility', 'hidden'); hov.forEach((h) => h.setAttribute('visibility', 'hidden'));
      tip.hidden = true;
    }
    svg.addEventListener('pointermove', (e) => {
      if (!geom || !geom.n) return;
      const box = svg.getBoundingClientRect();
      const x = e.clientX - box.left;
      let best = 0, bd = Infinity;
      for (let i = 0; i < geom.n; i++) { const d = Math.abs(geom.toX(i) - x); if (d < bd) { bd = d; best = i; } }
      showHover(best, { x: e.clientX, y: e.clientY });
    });
    svg.addEventListener('pointerleave', clearHover);
    svg.addEventListener('blur', clearHover);
    svg.addEventListener('keydown', (e) => {
      if (!geom || !geom.n) return;
      const n = geom.n;
      let i = hoverIdx < 0 ? n - 1 : hoverIdx;
      if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
      else if (e.key === 'ArrowRight') i = Math.min(n - 1, i + 1);
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = n - 1;
      else if (e.key === 'Escape') { clearHover(); return; }
      else return;
      e.preventDefault();
      showHover(i, null);
    });

    return {
      push(ts, v) {
        rows.push({ ts, v });
        if (rows.length > POINTS) rows.shift();
        chartsDirty = true; kick();
      },
      render,
      setPaused(p) { snap = p ? rows.map((r) => ({ ts: r.ts, v: r.v.slice() })) : null; body.classList.toggle('is-paused', p); clearHover(); chartsDirty = true; kick(); },
      setTable(on) { tableOn = on; clearHover(); chartsDirty = true; kick(); },
      clear() { rows.length = 0; snap = null; geom = null; drawn = false; clearHover(); valEls.forEach((el) => { el.textContent = '—'; }); chartsDirty = true; kick(); },
      refresh() { clearHover(); chartsDirty = true; kick(); },
    };
  }

  const accelChart = makeChart({ bodyId: 'accel-body', legendId: 'accel-legend', fields: ['ax', 'ay', 'az'], names: ['X', 'Y', 'Z'], label: 'Accelerometer' });
  const gyroChart = makeChart({ bodyId: 'gyro-body', legendId: 'gyro-legend', fields: ['gx', 'gy', 'gz'], names: ['X', 'Y', 'Z'], label: 'Gyroscope' });
  const charts = [accelChart, gyroChart];
  const chartByName = { accel: accelChart, gyro: gyroChart };

  // controls
  document.querySelectorAll('.table-btn').forEach((btn) => btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'Chart' : 'Table';
    chartByName[btn.dataset.chart].setTable(on);
  }));

  function setMode(mode) {
    S.mode = mode;
    $('mode-raw').setAttribute('aria-pressed', String(mode === 'raw'));
    $('mode-delta').setAttribute('aria-pressed', String(mode === 'delta'));
    document.querySelectorAll('.chart-tile .unit').forEach((u, i) => {
      u.textContent = `${i === 0 ? 'm/s²' : 'rad/s'}${mode === 'delta' ? ' · change from rest' : ''}`;
    });
    charts.forEach((c) => c.refresh());
  }
  $('mode-raw').addEventListener('click', () => setMode('raw'));
  $('mode-delta').addEventListener('click', () => setMode('delta'));

  $('live-btn').addEventListener('click', () => {
    S.paused = !S.paused;
    $('live-btn').setAttribute('aria-pressed', String(!S.paused));
    $('live-label').textContent = S.paused ? 'Paused' : 'Live';
    charts.forEach((c) => c.setPaused(S.paused));
    updateMeta();
  });

  // ── 3D device tilt ─────────────────────────────────────
  const device = $('device');
  const tilt = { roll: 0, pitch: 0, tr: 0, tp: 0 };
  function stepTilt() {
    if (tilt.roll === tilt.tr && tilt.pitch === tilt.tp) return false;
    const k = reduced ? 1 : 0.14;
    tilt.roll += (tilt.tr - tilt.roll) * k;
    tilt.pitch += (tilt.tp - tilt.pitch) * k;
    if (Math.abs(tilt.tr - tilt.roll) < 0.005) tilt.roll = tilt.tr;
    if (Math.abs(tilt.tp - tilt.pitch) < 0.005) tilt.pitch = tilt.tp;
    device.style.setProperty('--roll', tilt.roll.toFixed(2));
    device.style.setProperty('--pitch', tilt.pitch.toFixed(2));
    return tilt.roll !== tilt.tr || tilt.pitch !== tilt.tp;
  }

  // ── session reset: nothing from a previous session may stay on screen ──
  function resetSessionUI() {
    S.frames = 0; S.lastKey = ''; S.lastChangeAt = 0; S.latest = null;
    S.alerts = []; S.alertKeys.clear(); S.firstAlertLoad = true; S.alertFails = 0;
    tweens.clear();
    ['roll', 'pitch', 'force'].forEach((id) => { $(id).textContent = '—'; });
    $('frames').textContent = '0';
    $('alert-count').textContent = '0';
    $('alert-count-label').textContent = 'Tamper alerts';
    $('last-alert').textContent = 'None';
    $('alert-list').textContent = '';
    $('alerts-empty').hidden = true;     // shown again once the first alert fetch succeeds
    $('alerts-warn').hidden = true;
    $('asof').textContent = 'No readings yet';
    charts.forEach((c) => c.clear());
    tilt.tr = tilt.tp = 0; kick();
  }

  // ── data intake ────────────────────────────────────────
  function applyReading(d, { live = true } = {}) {
    S.latest = d;
    const mag = Math.hypot(d.ax || 0, d.ay || 0, d.az || 0);
    const roll = Math.atan2(d.ay || 0, d.az || 0) * 180 / Math.PI;
    const pitch = Math.atan2(-(d.ax || 0), Math.hypot(d.ay || 0, d.az || 0)) * 180 / Math.PI;
    tilt.tr = clamp(roll, -60, 60); tilt.tp = clamp(pitch, -60, 60); kick();
    tweenTo('roll', roll, 1); tweenTo('pitch', pitch, 1); tweenTo('force', mag, 2);
    accelChart.push(d.ts, [d.ax ?? 0, d.ay ?? 0, d.az ?? 0]);
    gyroChart.push(d.ts, [d.gx ?? 0, d.gy ?? 0, d.gz ?? 0]);
    if (live) {
      S.frames++;
      tweenTo('frames', S.frames, 0, { int: true });
    }
  }

  let telemetryBusy = false;
  async function pollTelemetry() {
    if (!S.token || !S.ready || telemetryBusy || document.hidden) return;
    telemetryBusy = true;
    try {
      const d = await authFetch('/api/telemetry');
      if (!d || !d.ts) { if (!S.latest && S.state === 'connecting') setState('waiting'); return; }
      const key = readingKey(d);
      if (key !== S.lastKey) {
        S.lastKey = key; S.lastChangeAt = performance.now();
        applyReading(d);
      }
      evaluateState();
    } catch (e) {
      if (e instanceof Superseded) return;
      // A failed request says nothing about the sensor. Let the freshness timer decide.
      if (S.token && S.latest) evaluateState();
    } finally {
      telemetryBusy = false;
    }
  }

  function evaluateState() {
    if (!S.token) return;
    if (!S.latest) { if (S.state !== 'connecting') setState('waiting'); return; }
    // Prefer the server clock (instant and skew-proof); fall back to "no new reading seen for a while".
    const stale = S.serverOffset !== null
      ? nowSec() - S.latest.ts > STALE_MS / 1000 + 1.5
      : performance.now() - S.lastChangeAt > STALE_MS;
    setState(stale ? 'stale' : S.latest.tamper ? 'tamper' : 'clear');
    updateMeta();
  }

  let alertsBusy = false;
  async function pollAlerts() {
    if (!S.token || !S.ready || alertsBusy || document.hidden) return;
    alertsBusy = true;
    try {
      renderAlerts(await authFetch('/api/alerts'));
    } catch (e) {
      if (e instanceof Superseded) return;
      if (++S.alertFails >= 2) $('alerts-warn').hidden = false;   // don't let an old list pass as current
    } finally {
      alertsBusy = false;
    }
  }

  function alertIcon() {
    const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    svg.appendChild(svgEl('path', { d: ICONS.alert }));
    return svg;
  }

  // Built with DOM APIs and textContent only: server data is never parsed as HTML.
  function alertEl(x) {
    const li = document.createElement('li');
    li.className = 'alert';
    li.dataset.key = alertKey(x);
    li.dataset.ts = String(x.ts);

    const badge = document.createElement('span');
    badge.className = 'alert-badge';
    badge.appendChild(alertIcon());

    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'alert-title';
    title.append('Tamper detected');
    title.appendChild(document.createElement('small'));
    const axes = document.createElement('div');
    axes.className = 'alert-axes';
    axes.textContent = `x ${fmt(x.ax)}  y ${fmt(x.ay)}  z ${fmt(x.az)}`;
    body.append(title, axes);

    const force = document.createElement('div');
    force.className = 'alert-force';
    force.append(fmt(Math.hypot(x.ax || 0, x.ay || 0, x.az || 0), 1));
    const unit = document.createElement('small');
    unit.textContent = 'm/s² force';
    force.appendChild(unit);

    li.append(badge, body, force);
    return li;
  }

  function renderAlerts(list) {
    S.alerts = list;
    S.alertFails = 0;
    $('alerts-warn').hidden = true;
    const ul = $('alert-list');
    const keys = new Set(list.map(alertKey));
    // add new ones, oldest first so the newest ends up on top
    [...list].reverse().forEach((x) => {
      const k = alertKey(x);
      if (S.alertKeys.has(k)) return;
      const li = alertEl(x);
      if (!S.firstAlertLoad) li.classList.add('fresh');
      ul.prepend(li);
      S.alertKeys.add(k);
    });
    // drop ones the server no longer holds
    [...ul.children].forEach((li) => { if (!keys.has(li.dataset.key)) { S.alertKeys.delete(li.dataset.key); li.remove(); } });
    S.firstAlertLoad = false;

    $('alerts-empty').hidden = list.length > 0;
    tweenTo('alert-count', list.length, 0, { int: true });
    $('alert-count-label').textContent = list.length >= 20 ? 'Tamper alerts (latest 20)' : 'Tamper alerts';
    $('last-alert').textContent = list.length ? ago(list[0].ts) : 'None';
    refreshRelative();
  }

  function refreshRelative() {
    document.querySelectorAll('#alert-list .alert').forEach((li) => {
      const small = li.querySelector('.alert-title small');
      if (small) small.textContent = `${clock(+li.dataset.ts)} · ${ago(+li.dataset.ts)}`;
    });
    if (S.alerts.length) $('last-alert').textContent = ago(S.alerts[0].ts);
  }

  async function startSession() {
    S.sid++;                       // anything still in flight from an earlier session is now ignored
    resetSessionUI();
    S.ready = false;               // polling waits until history is in, so history can never overwrite newer data
    setState('connecting');
    try {  // warm the charts with the server's recent history
      const hist = await authFetch('/api/history');
      hist.forEach((d) => applyReading(d, { live: false }));
      if (hist.length) S.lastKey = readingKey(hist[hist.length - 1]);
    } catch (e) {
      if (e instanceof Superseded) return;   // a newer session owns the screen now
      /* otherwise fine: charts fill live */
    }
    S.ready = true;
    pollTelemetry(); pollAlerts();
  }

  setInterval(pollTelemetry, TELEMETRY_MS);
  setInterval(pollAlerts, ALERTS_MS);
  // Polling pauses in a hidden tab, so don't judge staleness there; refresh straight away on return.
  setInterval(() => { if (!document.hidden) { evaluateState(); refreshRelative(); } }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollTelemetry(); pollAlerts(); } });

  // ── boot ───────────────────────────────────────────────
  if (S.token) { hideLogin(); startSession(); }
  else { showLogin(); }
})();
