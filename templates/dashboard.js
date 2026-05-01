const fmt = v => typeof v === 'number' ? v.toFixed(3) : '—';
let frames = 0;

//  Mini rolling chart 
function makeChart(id, colors) {
    const canvas = document.getElementById(id);
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.parentElement.clientWidth - 40;
    canvas.height = 130;
    const MAX = 50;
    const bufs = colors.map(() => []);

    return {
        push(vals) {
            vals.forEach((v, i) => {
                bufs[i].push(v);
                if (bufs[i].length > MAX) bufs[i].shift();
            });
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const W = canvas.width, H = canvas.height;
            const all = bufs.flat();
            const lo = Math.min(...all, -1), hi = Math.max(...all, 1);
            const toY = v => H - ((v - lo) / (hi - lo)) * H;

            // Zero line
            ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(0, toY(0)); ctx.lineTo(W, toY(0)); ctx.stroke();

            bufs.forEach((pts, i) => {
                if (pts.length < 2) return;
                ctx.strokeStyle = colors[i]; ctx.lineWidth = 1.5;
                ctx.beginPath();
                pts.forEach((v, x) => {
                    const px = (x / (MAX - 1)) * W;
                    x === 0 ? ctx.moveTo(px, toY(v)) : ctx.lineTo(px, toY(v));
                });
                ctx.stroke();
            });
        }
    };
}

const accelChart = makeChart('accel-chart', ['#f85149', '#3fb950', '#58a6ff']);
const gyroChart = makeChart('gyro-chart', ['#f85149', '#3fb950', '#58a6ff']);

//  Fetch telemetry 
async function fetchTelemetry() {
    try {
        const r = await fetch('/api/telemetry');
        const d = await r.json();
        if (!d.ts) return;

        document.getElementById('dot').classList.add('live');
        document.getElementById('ts').textContent =
            new Date(d.ts * 1000).toLocaleTimeString();

        document.getElementById('ax').textContent = fmt(d.ax);
        document.getElementById('ay').textContent = fmt(d.ay);
        document.getElementById('az').textContent = fmt(d.az);
        document.getElementById('gx').textContent = fmt(d.gx);
        document.getElementById('gy').textContent = fmt(d.gy);
        document.getElementById('gz').textContent = fmt(d.gz);

        const tf = document.getElementById('tamper');
        if (d.tamper) {
            tf.textContent = '⚠ TAMPER'; tf.className = 'value danger';
        } else {
            tf.textContent = 'CLEAR'; tf.className = 'value ok';
        }

        accelChart.push([d.ax ?? 0, d.ay ?? 0, d.az ?? 0]);
        gyroChart.push([d.gx ?? 0, d.gy ?? 0, d.gz ?? 0]);
        frames++;
        document.getElementById('frames').textContent = frames;

    } catch (_) {
        document.getElementById('dot').classList.remove('live');
    }
}

//  Fetch alerts 
async function fetchAlerts() {
    const r = await fetch('/api/alerts');
    const a = await r.json();
    document.getElementById('alert-count').textContent = a.length;

    const el = document.getElementById('alert-list');
    if (!a.length) {
        el.innerHTML = '<span class="none">No alerts yet.</span>';
        return;
    }
    el.innerHTML = a.map(x => {
        const t = new Date(x.ts * 1000).toLocaleTimeString();
        return `<div class="alert-item">
      <span class="tag">TAMPER</span>${t}
      &nbsp; ax:${fmt(x.ax)} &nbsp; ay:${fmt(x.ay)} &nbsp; az:${fmt(x.az)}
    </div>`;
    }).join('');
}

//  Poll 
setInterval(fetchTelemetry, 1000);
setInterval(fetchAlerts, 2000);
setInterval(() => {
    document.getElementById('health').textContent =
        `Broker: Mosquitto on localhost:1883  ·  Frames received: ${frames}`;
}, 3000);

fetchTelemetry();
fetchAlerts();