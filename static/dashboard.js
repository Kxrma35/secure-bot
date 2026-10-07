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
  const CHART_POINTS = 50;
  const TOKEN_KEY = 'securebot-token';

  // ── storage (may throw in private windows) ─────────────
  const store = {
    get() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } },
    set(v) { try { sessionStorage.setItem(TOKEN_KEY, v); } catch (_) { /* in-memory only */ } },
    clear() { try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ } },
  };

  const S = {
    token: store.get(),
    frames: 0,
    lastTs: null,            // ts value of the newest reading
    lastChangeAt: 0,         // performance.now() when lastTs last changed (clock-skew proof)
    latest: null,
    alerts: [],
    state: 'connecting',
    alertKeys: new Set(),
    firstAlertLoad: true,
    serverOffset: null,      // server clock minus browser clock (ms), from the HTTP Date header
  };

  const fmt = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '—');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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

  // ── auth ───────────────────────────────────────────────
  function showLogin() {
    S.token = '';
    store.clear();
    root.classList.remove('authed');
    $('login-pass').value = '';
    $('app').setAttribute('inert', '');
    setTimeout(() => $('login-user').focus(), 0);
  }

  function hideLogin() {
    root.classList.add('authed');
    $('app').removeAttribute('inert');
  }

  async function authFetch(url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${S.token}` } });
    const serverDate = Date.parse(r.headers.get('Date') || '');
    if (!isNaN(serverDate)) S.serverOffset = serverDate - Date.now();
    if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-error');
    const btn = $('login-submit');
    err.textContent = '';
    btn.disabled = true;
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('login-user').value, password: $('login-pass').value }),
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

  $('signout').addEventListener('click', () => {
    showLogin();
    setState('connecting');
    S.frames = 0; S.lastTs = null; S.latest = null;
    window.scrollTo(0, 0);
  });

  // ── state (hero, nav pill, screen-reader announcements) ─
  const COPY = {
    connecting: ['Connecting.', 'Reaching your SecureBot dashboard…', 'Connecting'],
    waiting: ['Waiting for the sensor.', 'You are signed in, but no readings have arrived. Check that the Arduino, the MQTT broker and the serial reader are running.', 'Waiting'],
    clear: ['All clear.', 'No tampering detected. Live data is flowing from the sensor.', 'All clear'],
    tamper: ['Tamper detected.', 'The sensor flagged movement. Go and check the device.', 'Tamper'],
    stale: ['Signal lost.', 'No new readings have arrived. The sensor, the serial reader or the broker may have stopped.', 'Signal lost'],
  };

  function setState(next) {
    if (next === S.state) return;
    S.state = next;
    document.body.dataset.state = next;
    const [title, sub, pill] = COPY[next];
    const t = $('hero-title-text');
    t.textContent = title;
    t.classList.remove('swap');
    void t.offsetWidth;             // restart the animation
    t.classList.add('swap');
    $('hero-sub').textContent = sub;
    $('nav-pill-text').textContent = pill;
    $('sr-status').textContent = `${title} ${sub}`;
    const sig = $('signal');
    sig.textContent = next === 'stale' ? 'Lost' : next === 'waiting' || next === 'connecting' ? 'Waiting' : 'Live';
  }

  function updateMeta() {
    const el = $('hero-meta');
    if (!S.latest) { el.textContent = ' '; return; }
    el.textContent = `Last reading ${clock(S.latest.ts)} · ${S.frames.toLocaleString()} received this session`;
  }

  // ── smooth numbers ─────────────────────────────────────
  const tweens = new Map();   // element -> { cur, target, decimals, text }
  function tweenTo(id, target, decimals = 2, opts = {}) {
    const el = $(id);
    if (!el) return;
    let t = tweens.get(el);
    if (!t) { t = { cur: target, target, decimals, int: !!opts.int }; tweens.set(el, t); el.textContent = opts.int ? Math.round(target).toLocaleString() : fmt(target, decimals); return; }
    t.target = target;
  }

  function stepTweens() {
    tweens.forEach((t, el) => {
      if (t.cur === t.target) return;
      t.cur = reduced ? t.target : t.cur + (t.target - t.cur) * 0.22;
      if (Math.abs(t.target - t.cur) < Math.pow(10, -t.decimals) / 2) t.cur = t.target;
      el.textContent = t.int ? Math.round(t.cur).toLocaleString() : fmt(t.cur, t.decimals);
    });
  }

  // ── charts ─────────────────────────────────────────────
  function themeColors() {
    const cs = getComputedStyle(root);
    return {
      x: cs.getPropertyValue('--axis-x').trim(), y: cs.getPropertyValue('--axis-y').trim(), z: cs.getPropertyValue('--axis-z').trim(),
      grid: cs.getPropertyValue('--hairline').trim(), muted: cs.getPropertyValue('--muted').trim(),
    };
  }
  let colors = themeColors();
  window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { colors = themeColors(); });

  function makeChart(canvas) {
    const ctx = canvas.getContext('2d');
    const bufs = [[], [], []];
    const dash = [[], [8, 5], [2, 4]];
    let w = 0, h = 0, dpr = 1, lo = -1, hi = 1, dirty = true;

    function resize() {
      dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty = true;
    }
    new ResizeObserver(resize).observe(canvas);
    resize();

    function path(pts, toX, toY) {
      ctx.beginPath();
      pts.forEach((v, i) => {
        const x = toX(i), y = toY(v);
        if (i === 0) ctx.moveTo(x, y);
        else { const px = toX(i - 1), py = toY(pts[i - 1]); const mx = (px + x) / 2; ctx.quadraticCurveTo(px, py, mx, (py + y) / 2); if (i === pts.length - 1) ctx.lineTo(x, y); }
      });
    }

    return {
      push(vals) {
        vals.forEach((v, i) => { bufs[i].push(v); if (bufs[i].length > CHART_POINTS) bufs[i].shift(); });
        dirty = true;
      },
      draw() {
        const all = bufs.flat();
        const wantLo = Math.min(...all, -1), wantHi = Math.max(...all, 1);
        const pad = (wantHi - wantLo) * 0.12;
        const tLo = wantLo - pad, tHi = wantHi + pad;
        const k = reduced ? 1 : 0.12;
        if (Math.abs(tLo - lo) > 0.001 || Math.abs(tHi - hi) > 0.001) { lo += (tLo - lo) * k; hi += (tHi - hi) * k; dirty = true; }
        if (!dirty) return;
        dirty = false;

        ctx.clearRect(0, 0, w, h);
        const toY = (v) => h - 6 - ((v - lo) / (hi - lo)) * (h - 12);
        const toX = (i) => (i / (CHART_POINTS - 1)) * w;

        ctx.lineWidth = 1; ctx.strokeStyle = colors.grid; ctx.setLineDash([]);
        for (let g = 0; g <= 4; g++) { const y = Math.round(6 + (g / 4) * (h - 12)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
        if (lo < 0 && hi > 0) { ctx.strokeStyle = colors.muted; ctx.globalAlpha = 0.5; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(0, toY(0)); ctx.lineTo(w, toY(0)); ctx.stroke(); ctx.globalAlpha = 1; ctx.setLineDash([]); }

        const keys = [colors.x, colors.y, colors.z];
        bufs.forEach((pts, i) => {
          if (pts.length < 2) return;
          // right-align so the newest point sits at the right edge
          const off = CHART_POINTS - pts.length;
          const X = (j) => toX(j + off);
          const grad = ctx.createLinearGradient(0, 0, 0, h);
          grad.addColorStop(0, keys[i] + '33'); grad.addColorStop(1, keys[i] + '00');
          if (/^#[0-9a-f]{6}$/i.test(keys[i])) {
            path(pts, X, toY); ctx.lineTo(X(pts.length - 1), h); ctx.lineTo(X(0), h); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
          }
          ctx.strokeStyle = keys[i]; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash(dash[i]);
          path(pts, X, toY); ctx.stroke(); ctx.setLineDash([]);
          const lx = X(pts.length - 1), ly = toY(pts[pts.length - 1]);
          ctx.fillStyle = keys[i]; ctx.beginPath(); ctx.arc(lx - 1, ly, 3.5, 0, Math.PI * 2); ctx.fill();
        });
      },
      clear() { bufs.forEach((b) => { b.length = 0; }); dirty = true; },
    };
  }

  const accelChart = makeChart($('accel-chart'));
  const gyroChart = makeChart($('gyro-chart'));

  // ── 3D device tilt ─────────────────────────────────────
  const device = $('device');
  const tilt = { roll: 0, pitch: 0, tr: 0, tp: 0 };
  function stepTilt() {
    const k = reduced ? 1 : 0.14;
    tilt.roll += (tilt.tr - tilt.roll) * k;
    tilt.pitch += (tilt.tp - tilt.pitch) * k;
    device.style.setProperty('--roll', tilt.roll.toFixed(2));
    device.style.setProperty('--pitch', tilt.pitch.toFixed(2));
  }

  // ── data intake ────────────────────────────────────────
  function applyReading(d, { live = true } = {}) {
    S.latest = d;
    const mag = Math.hypot(d.ax || 0, d.ay || 0, d.az || 0);
    const roll = Math.atan2(d.ay || 0, d.az || 0) * 180 / Math.PI;
    const pitch = Math.atan2(-(d.ax || 0), Math.hypot(d.ay || 0, d.az || 0)) * 180 / Math.PI;
    tilt.tr = clamp(roll, -60, 60); tilt.tp = clamp(pitch, -60, 60);
    ['ax', 'ay', 'az', 'gx', 'gy', 'gz'].forEach((k) => { if (typeof d[k] === 'number') tweenTo(k, d[k], 2); });
    tweenTo('roll', roll, 1); tweenTo('pitch', pitch, 1); tweenTo('force', mag, 2);
    accelChart.push([d.ax ?? 0, d.ay ?? 0, d.az ?? 0]);
    gyroChart.push([d.gx ?? 0, d.gy ?? 0, d.gz ?? 0]);
    if (live) {
      S.frames++;
      tweenTo('frames', S.frames, 0, { int: true });
    }
  }

  let telemetryBusy = false;
  async function pollTelemetry() {
    if (!S.token || telemetryBusy || document.hidden) return;
    telemetryBusy = true;
    try {
      const d = await authFetch('/api/telemetry');
      if (!d || !d.ts) { if (S.state === 'connecting') setState('waiting'); return; }
      if (d.ts !== S.lastTs) {
        S.lastTs = d.ts; S.lastChangeAt = performance.now();
        applyReading(d);
      }
      evaluateState();
    } catch (_) {
      if (S.token) setState(S.frames ? 'stale' : 'connecting');
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
    if (!S.token || alertsBusy || document.hidden) return;
    alertsBusy = true;
    try {
      renderAlerts(await authFetch('/api/alerts'));
    } catch (_) { /* keep the last list */ } finally { alertsBusy = false; }
  }

  const ALERT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 19.5h18.4L12 3Z"/><path d="M12 10v4.5M12 17.6v.01"/></svg>';
  function alertEl(x) {
    const li = document.createElement('li');
    li.className = 'alert';
    li.dataset.key = String(x.ts);
    const mag = Math.hypot(x.ax || 0, x.ay || 0, x.az || 0);
    li.innerHTML = `<span class="alert-badge">${ALERT_SVG}</span>
      <div><div class="alert-title">Tamper detected<small></small></div><div class="alert-axes"></div></div>
      <div class="alert-force">${fmt(mag, 1)}<small>m/s² force</small></div>`;
    li.querySelector('.alert-axes').textContent = `x ${fmt(x.ax)}   y ${fmt(x.ay)}   z ${fmt(x.az)}`;
    li.dataset.ts = x.ts;
    return li;
  }

  function renderAlerts(list) {
    S.alerts = list;
    const ul = $('alert-list');
    const keys = new Set(list.map((x) => String(x.ts)));
    // add new ones, oldest first so the newest ends up on top
    [...list].reverse().forEach((x) => {
      const k = String(x.ts);
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
    S.alertKeys.clear(); S.firstAlertLoad = true; $('alert-list').textContent = '';
    accelChart.clear(); gyroChart.clear();
    setState('connecting');
    try {  // warm the charts with the server's recent history
      const hist = await authFetch('/api/history');
      hist.forEach((d) => applyReading(d, { live: false }));
      if (hist.length) S.lastTs = hist[hist.length - 1].ts;
    } catch (_) { /* fine: charts fill live */ }
    pollTelemetry(); pollAlerts();
  }

  setInterval(pollTelemetry, TELEMETRY_MS);
  setInterval(pollAlerts, ALERTS_MS);
  // Polling pauses in a hidden tab, so don't judge staleness there; refresh straight away on return.
  setInterval(() => { if (!document.hidden) { evaluateState(); refreshRelative(); } }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollTelemetry(); pollAlerts(); } });

  // ── animation loop ─────────────────────────────────────
  function frame() {
    stepTweens(); stepTilt();
    accelChart.draw(); gyroChart.draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── scroll effects ─────────────────────────────────────
  const nav = $('nav');
  const hero = $('overview');
  const scene = $('motion');
  let scrollQueued = false;

  function onScroll() {
    scrollQueued = false;
    const y = window.scrollY;
    nav.classList.toggle('scrolled', y > 8);
    if (reduced) return;
    const vh = window.innerHeight;
    const hp = clamp(y / (hero.offsetHeight * 0.75), 0, 1);
    const inner = hero.querySelector('.hero-inner');
    inner.style.opacity = String(1 - hp);
    inner.style.transform = `translateY(${(-hp * 70).toFixed(1)}px) scale(${(1 - hp * 0.07).toFixed(3)})`;
    const top = scene.offsetTop;
    const sp = clamp((y - top) / (scene.offsetHeight - vh), 0, 1);
    device.style.setProperty('--sp', (1 - Math.pow(1 - sp, 3)).toFixed(3));   // ease-out cubic
  }
  window.addEventListener('scroll', () => { if (!scrollQueued) { scrollQueued = true; requestAnimationFrame(onScroll); } }, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();

  // reveal on scroll
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduced) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.15, rootMargin: '0px 0px -6% 0px' });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('in'));
  }

  // active nav link
  const links = [...document.querySelectorAll('.nav-links a')];
  if ('IntersectionObserver' in window) {
    const so = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        links.forEach((a) => { const on = a.dataset.section === e.target.id; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['overview', 'motion', 'signals', 'alerts'].forEach((id) => so.observe($(id)));
  }

  // ── boot ───────────────────────────────────────────────
  if (S.token) { hideLogin(); startSession(); }
  else { showLogin(); }
})();
