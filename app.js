// ─── ISS TRACKER ─────────────────────────────────────────────────────────────
// Data, camera modes and UI. The scene itself lives in globe.js, orbit and
// sun maths in astro.js, place names in places.js.

const $              = id => document.getElementById(id);
const PHONE          = window.matchMedia('(max-width: 760px)');   // keep in sync with index.html
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const damp           = (rate, dt) => 1 - Math.exp(-rate * dt);

// clockNow() and the time machine are in timemachine.js

const fmt = {
    int:  new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }),
    time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }),
    day:  new Intl.DateTimeFormat(undefined, { weekday: 'short' }),
    lat:  v => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? 'N' : 'S'}`,
    lon:  v => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? 'E' : 'W'}`,
    mmss: ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; },
};

// ─── STATUS ──────────────────────────────────────────────────────────────────
function setStatus(state, text) {
    $('brand').dataset.state = state;
    $('statusDot').dataset.state = state;
    $('statusText').textContent = text;
}

function formatAge(hours) {
    if (hours < 1)  return 'under an hour';
    if (hours < 48) return `${Math.round(hours)} h`;
    return `${Math.round(hours / 24)} days`;
}

// ─── ORBIT DATA (TLE) ────────────────────────────────────────────────────────
// Two-line elements let satellite.js compute the ISS position for any moment,
// so everything moves smoothly and needs no further requests.
const TLE_SOURCES = [
    async () => {
        const r = await fetch('https://api.wheretheiss.at/v1/satellites/25544/tles');
        if (!r.ok) throw new Error(`wheretheiss.at ${r.status}`);
        const { line1, line2 } = await r.json();
        return [line1, line2];
    },
    async () => {
        const r = await fetch('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle');
        if (!r.ok) throw new Error(`CelesTrak ${r.status}`);
        const lines = (await r.text()).split('\n').map(l => l.trim());
        return [lines.find(l => l.startsWith('1 ')), lines.find(l => l.startsWith('2 '))];
    },
];
const TLE_REFRESH = 2 * 60 * 60 * 1000;
const TLE_RETRY   = 60 * 1000;
const TLE_STALE_H = 72;

let satrec     = null;
let tleFailing = false;

async function loadTLE() {
    for (const source of TLE_SOURCES) {
        try {
            const [line1, line2] = await source();
            const rec = satellite.twoline2satrec(line1, line2);
            if (rec.error || !issState(rec, clockNow())) throw new Error('unusable TLE');
            const first = !satrec;
            satrec     = rec;
            tleFailing = false;
            onOrbitData(first);
            updateStatus();
            setTimeout(loadTLE, TLE_REFRESH);
            return;
        } catch (e) {
            console.error('TLE fetch error:', e);
        }
    }
    tleFailing = true;
    updateStatus();
    setTimeout(loadTLE, TLE_RETRY);
}

function updateStatus() {
    if (!satrec) {
        setStatus(tleFailing ? 'lost' : 'warn', tleFailing ? 'No signal · retrying' : 'Acquiring orbit');
        $('tleAge').textContent = 'Waiting for orbit data';
        return;
    }
    const ageH = (Date.now() / 86400000 + 2440587.5 - satrec.jdsatepoch) * 24;
    $('tleAge').textContent = `Position computed in your browser from orbit data ${formatAge(ageH)} old.`;
    if (ageH > TLE_STALE_H) setStatus('warn', 'Orbit data stale');
    else if (tleFailing)    setStatus('warn', 'Offline · predicting');
    else                    setStatus('live', 'Tracking');
}
setInterval(updateStatus, 30 * 1000);

// ─── LIVE STATE ──────────────────────────────────────────────────────────────
const live = {};

function issFrame(now) {
    const s  = issState(satrec, now);
    const s2 = issState(satrec, new Date(now.getTime() + 2000));
    if (!s || !s2) return false;
    const p   = latLonToVector3(s.lat, s.lon, altToRadius(s.alt));
    const up  = p.clone().normalize();
    const fwd = latLonToVector3(s2.lat, s2.lon, altToRadius(s2.alt)).sub(p);
    fwd.sub(up.clone().multiplyScalar(fwd.dot(up))).normalize();
    const side = new THREE.Vector3().crossVectors(up, fwd);
    Object.assign(live, s, { now, p, up, fwd, side });
    return true;
}

// ─── CAMERA MODES ────────────────────────────────────────────────────────────
// earth: overview  ·  follow: chase camera behind the ISS  ·  cupola: looking
// down from the station's window  ·  sky: above home
let mode = 'earth';
const earthView = { lat: 20, lon: -100, dist: 62, targetDist: 62, userZoomed: false, drift: 0 };
const chase     = { yaw: 0.45, pitch: 0.18, dist: 0.26, targetDist: 0.26 };
const cupola    = { yaw: 0, tilt: 0.55, fov: 72, targetFov: 72 };   // tilt: radians from straight down, towards yaw
let flight = null;
let lastInteraction = -Infinity;   // performance.now() of the last drag, pinch or scroll
let homeNormal = null;

// ─── FRAMING ─────────────────────────────────────────────────────────────────
// The globe centres in whatever part of the screen the UI leaves free, and
// that offset eases as the sheet opens and closes.
const sheet = $('sheet');
const frame = { tx: 0, ty: 0, ox: 0, oy: 0, w: innerWidth, h: innerHeight };

function measureFree() {
    const top = $('brand').getBoundingClientRect().bottom + 10;
    let left = 0, bottom = innerHeight;
    if (PHONE.matches)          bottom = innerHeight - sheet.offsetHeight;
    else if (innerWidth > 1100) left = sheet.getBoundingClientRect().right;
    else                        bottom = sheet.getBoundingClientRect().top;
    frame.tx = left / 2;
    frame.ty = (top + bottom) / 2 - innerHeight / 2;
    frame.w  = innerWidth - left;
    frame.h  = bottom - top;
    if (!earthView.userZoomed) earthView.targetDist = fitDistance();
}

function fitDistance() {
    const px = Math.max(160, Math.min(frame.h - 30, frame.w * 0.9));
    return THREE.MathUtils.clamp(5.9 * innerHeight / (Math.tan(5 * DEG) * px), 40, 160);
}

function desiredView() {
    if (mode === 'follow' && live.p) {
        const { p, up, fwd, side } = live;
        // A slow handheld drift, as if filmed from a nearby spacecraft
        const t     = performance.now() / 1000;
        const yaw   = chase.yaw   + (REDUCED_MOTION ? 0 : 0.025 * Math.sin(t * 0.11) + 0.01 * Math.sin(t * 0.37));
        const pitch = chase.pitch + (REDUCED_MOTION ? 0 : 0.015 * Math.sin(t * 0.13 + 1.7) + 0.006 * Math.sin(t * 0.41));
        const o = side.clone().multiplyScalar(Math.sin(yaw) * Math.cos(pitch))
            .add(up.clone().multiplyScalar(Math.sin(pitch)))
            .add(fwd.clone().multiplyScalar(-Math.cos(yaw) * Math.cos(pitch)))
            .multiplyScalar(chase.dist);
        const pos    = p.clone().add(o);
        const target = p.clone().add(p.clone().sub(pos).multiplyScalar(1.4)).sub(up.clone().multiplyScalar(0.16));
        return { pos, target, up: up.clone(), fov: 52 };
    }
    if (mode === 'cupola' && live.p) {
        // From the window on the Earth-facing side, tilted towards the direction of travel
        const { p, up, fwd, side } = live;
        const ahead = fwd.clone().multiplyScalar(Math.cos(cupola.yaw)).addScaledVector(side, Math.sin(cupola.yaw));
        const dir   = up.clone().multiplyScalar(-Math.cos(cupola.tilt)).addScaledVector(ahead, Math.sin(cupola.tilt));
        const camUp = ahead.clone().multiplyScalar(Math.cos(cupola.tilt)).addScaledVector(up, Math.sin(cupola.tilt));
        const pos   = p.clone().addScaledVector(up, -0.002);
        return { pos, target: pos.clone().add(dir), up: camUp, fov: cupola.fov };
    }
    if (mode === 'sky' && homeNormal) {
        const north  = new THREE.Vector3(0, 1, 0).sub(homeNormal.clone().multiplyScalar(homeNormal.y)).normalize();
        const pos    = homeNormal.clone().multiplyScalar(R + 7.5).sub(north.clone().multiplyScalar(5.5));
        const target = homeNormal.clone().multiplyScalar(R).add(north.clone().multiplyScalar(0.6));
        return { pos, target, up: homeNormal.clone(), fov: 28 };
    }
    return { pos: latLonToVector3(earthView.lat, earthView.lon, earthView.dist), target: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), fov: 10 };
}

const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const current = { pos: new THREE.Vector3(0, 0, 160), target: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), fov: 10 };

let autoTab = false;
function flyTo(newMode, duration = 2600) {
    if (newMode === 'sky' && !homeNormal) { requestSky(); return; }
    if (newMode === 'earth') {
        if (live.p) { earthView.lat = live.lat * 0.6; earthView.lon = live.lon; }
        earthView.userZoomed = false;
        earthView.dist = earthView.targetDist = fitDistance();
    }
    look.vx = look.vy = 0;
    mode = newMode;
    flight = {
        from: { pos: current.pos.clone(), target: current.target.clone(), up: current.up.clone(), fov: current.fov },
        start: performance.now(),
        duration: REDUCED_MOTION ? 600 : duration,
    };
    if (mode === 'sky') { selectTab('passes'); autoTab = true; }
    else if (autoTab)   { selectTab('now'); autoTab = false; }
    updateModeUI();
}

// Along a great circle, with a lift so short hops still feel like a flight
function arcPosition(a, b, e) {
    const ra = a.length(), rb = b.length();
    const da = a.clone().normalize(), db = b.clone().normalize();
    const qe = new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(da, db), e);
    const r  = Math.pow(ra, 1 - e) * Math.pow(rb, e) * (1 + Math.sin(Math.PI * e) * (0.25 + da.angleTo(db) * 0.6));
    return da.applyQuaternion(qe).multiplyScalar(r);
}

function updateCamera(dt) {
    earthView.dist += (earthView.targetDist - earthView.dist) * damp(6, dt);
    cupola.fov     += (cupola.targetFov - cupola.fov) * damp(6, dt);
    chase.dist     += (chase.targetDist - chase.dist) * damp(6, dt);

    const want = desiredView();
    if (flight) {
        const t = Math.min(1, (performance.now() - flight.start) / flight.duration);
        const e = easeInOut(t);
        current.pos.copy(arcPosition(flight.from.pos, want.pos, e));
        current.target.lerpVectors(flight.from.target, want.target, e);
        current.up.lerpVectors(flight.from.up, want.up, e).normalize();
        current.fov = flight.from.fov + (want.fov - flight.from.fov) * e;
        if (t >= 1) { flight = null; rewatchFrameRate(); }
    } else {
        current.pos.copy(want.pos);
        current.target.copy(want.target);
        current.up.copy(want.up);
        current.fov = want.fov;
    }

    frame.ox += (frame.tx - frame.ox) * damp(5, dt);
    frame.oy += (frame.ty - frame.oy) * damp(5, dt);
    camera.setViewOffset(innerWidth, innerHeight, -frame.ox, -frame.oy, innerWidth, innerHeight);

    camera.position.copy(current.pos);
    camera.up.copy(current.up);
    camera.lookAt(current.target);
    camera.fov  = current.fov;
    camera.near = THREE.MathUtils.clamp((current.pos.length() - R) * 0.05, 0.004, 1);
    camera.far  = current.pos.length() + R * 2 + SKY_RADIUS;
    camera.updateProjectionMatrix();
    sky.position.copy(camera.position);
}

// ─── INPUT: drag with momentum, eased zoom, pinch ────────────────────────────
const canvas   = renderer.domElement;
const pointers = new Map();
const look     = { vx: 0, vy: 0 };
let lastMoveAt = 0, pinchSpread = null;

function applyLook(dx, dy) {
    if (mode === 'earth') {
        const k = 0.12 * earthView.dist / 62;
        earthView.lon -= dx * k;
        earthView.lat  = THREE.MathUtils.clamp(earthView.lat + dy * k, -80, 80);
    } else if (mode === 'follow') {
        chase.yaw  -= dx * 0.006;
        chase.pitch = THREE.MathUtils.clamp(chase.pitch + dy * 0.004, -0.2, 1.3);
    } else if (mode === 'cupola') {
        const k = cupola.fov / 72;
        cupola.yaw  += dx * 0.004 * k;
        cupola.tilt  = THREE.MathUtils.clamp(cupola.tilt - dy * 0.003 * k, 0, 1.15);
    }
}
function zoomBy(k) {
    if (mode === 'earth') {
        earthView.targetDist = THREE.MathUtils.clamp(earthView.targetDist * k, 14, 160);
        earthView.userZoomed = true;
    }
    if (mode === 'follow') chase.targetDist = THREE.MathUtils.clamp(chase.targetDist * k, 0.18, 3);
    if (mode === 'cupola') cupola.targetFov = THREE.MathUtils.clamp(cupola.targetFov * k, 20, 90);   // a zoom lens
}
const spread = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };

canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    look.vx = look.vy = 0;
    lastInteraction = lastMoveAt = performance.now();
    if (pointers.size === 2) pinchSpread = spread();
});
canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    const t = performance.now();
    lastInteraction = t;
    if (pointers.size === 1) {
        applyLook(dx, dy);
        const dt = Math.max(1, t - lastMoveAt) / 1000;
        look.vx = look.vx * 0.7 + (dx / dt) * 0.3;
        look.vy = look.vy * 0.7 + (dy / dt) * 0.3;
    } else if (pinchSpread) {
        const s = spread();
        zoomBy(pinchSpread / s);
        pinchSpread = s;
    }
    lastMoveAt = t;
});
function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchSpread = null;
    // A drag that stopped before release shouldn't fling
    if (performance.now() - lastMoveAt > 80) look.vx = look.vy = 0;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', e => {
    e.preventDefault();
    lastInteraction = performance.now();
    zoomBy(Math.pow(1.0015, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY));
}, { passive: false });

document.querySelectorAll('#modes button').forEach(b =>
    b.addEventListener('click', () => { if (b.dataset.mode !== mode) flyTo(b.dataset.mode); }));

window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea')) return;
    const key = e.key.toLowerCase();
    const target = { 1: 'earth', 2: 'follow', 3: 'cupola', 4: 'sky', f: 'follow', c: 'cupola' }[key];
    if (key === 'k') setClouds(!showClouds);
    if (target && target !== mode) flyTo(target);
    if (key === 'r' || (key === 'escape' && mode !== 'earth' && byId('timePanel').hidden)) flyTo('earth');
});

// ─── UI: MODES, TABS, SHEET ──────────────────────────────────────────────────
function updateModeUI() {
    const buttons = [...document.querySelectorAll('#modes button')];
    buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    const active = buttons.find(b => b.dataset.mode === mode);
    const slider = document.querySelector('#modes .slider');
    slider.style.width = active.offsetWidth + 'px';
    slider.style.transform = `translateX(${active.offsetLeft}px)`;
}

function selectTab(name) {
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('.pane').forEach(p => { p.hidden = p.dataset.pane !== name; });
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { selectTab(b.dataset.tab); autoTab = false; }));

// Phones: tap or swipe the handle/summary to open and close the sheet
function setSheet(open) {
    sheet.dataset.state = open ? 'open' : 'peek';
    $('handle').setAttribute('aria-expanded', String(open));
}
{
    let startY = null;
    for (const el of [$('handle'), $('summary')]) {
        el.addEventListener('pointerdown', e => { startY = e.clientY; });
        el.addEventListener('pointerup', e => {
            if (startY === null) return;
            const dy = e.clientY - startY;
            startY = null;
            if (dy < -24) setSheet(true);
            else if (dy > 24) setSheet(false);
            else setSheet(sheet.dataset.state !== 'open');
        });
    }
}
new ResizeObserver(measureFree).observe(sheet);

// ─── UI: ODOMETER ────────────────────────────────────────────────────────────
// Each digit is a strip of 0–9 three times over. Rolls take the short way
// round (9 → 0 rolls forward one), then quietly re-centre on the middle copy.
let odoDigits = [];
function setOdometer(text) {
    $('odo').setAttribute('aria-label', `${text} km/h`);
    if (odoDigits.length !== text.length) {
        odoDigits = [...text].map(ch => {
            const el = document.createElement('span');
            el.className = 'd';
            el.setAttribute('aria-hidden', 'true');
            if (!/\d/.test(ch)) { el.textContent = ch; return { el }; }
            const strip = document.createElement('span');
            strip.className = 'strip';
            for (let i = 0; i < 30; i++) { const n = document.createElement('span'); n.textContent = i % 10; strip.append(n); }
            el.append(strip);
            const pos = 10 + Number(ch);
            strip.style.transition = 'none';
            strip.style.transform = `translateY(${-pos}em)`;
            return { el, strip, pos };
        });
        $('odo').replaceChildren(...odoDigits.map(d => d.el));
    }
    [...text].forEach((ch, i) => {
        const d = odoDigits[i];
        if (!d.strip) return;
        const want = Number(ch);
        const next = [want, want + 10, want + 20].reduce((a, b) => Math.abs(b - d.pos) < Math.abs(a - d.pos) ? b : a);
        if (next === d.pos) return;
        d.strip.style.transition = '';
        d.strip.style.transform = `translateY(${-next}em)`;
        d.pos = next;
        clearTimeout(d.timer);
        d.timer = setTimeout(() => {
            const centred = 10 + (d.pos % 10);
            if (centred === d.pos) return;
            d.strip.style.transition = 'none';
            d.strip.style.transform = `translateY(${-centred}em)`;
            d.pos = centred;
        }, 900);
    });
}

// ─── UI: ROTATING COMPARISONS ────────────────────────────────────────────────
let compareIndex = 0;
function comparisons() {
    const v = live.velocity, min = km => Math.round(km / v * 60);
    return [
        `New York → London in ${min(5570)} minutes`,
        `${Math.round(v / 1235)}× the speed of sound`,
        `Once around the planet every ${Math.round(live.period / 60000)} minutes`,
        `${Math.round(live.orbitsToday)} sunrises and sunsets a day`,
        `Los Angeles → New York in ${min(3940)} minutes`,
    ];
}
// One element: fade out, swap the text, fade back in
function rotateComparison() {
    if (!live.period) return;
    const span = $('compare').firstElementChild;
    span.className = 'leaving';
    setTimeout(() => {
        span.textContent = comparisons()[compareIndex++ % 5];
        span.className = 'entering';
        void span.offsetWidth;
        span.className = '';
    }, REDUCED_MOTION ? 0 : 450);
}
setInterval(rotateComparison, 6000);

// Swap a label's text with a soft blur, only when it actually changes
function swapText(el, text) {
    if (el.textContent === text || el.dataset.next === text) return;
    el.dataset.next = text;
    el.classList.add('swap');
    setTimeout(() => { el.textContent = text; el.classList.remove('swap'); delete el.dataset.next; }, 450);
}

// ─── UI: TOASTS ──────────────────────────────────────────────────────────────
function dismiss(t) {
    if (t.classList.contains('out')) return;
    t.classList.add('out');
    setTimeout(() => t.remove(), 600);
}
function toast(icon, title, text) {
    const box = $('toasts');
    const t = document.createElement('div');
    t.className = 'toast glass';
    t.innerHTML = '<i aria-hidden="true"></i><div><b></b><span></span></div>';
    t.querySelector('i').textContent = icon;
    t.querySelector('b').textContent = title;
    t.querySelector('span').textContent = text;
    box.prepend(t);
    [...box.children].filter(c => !c.classList.contains('out')).slice(3).forEach(dismiss);
    setTimeout(() => dismiss(t), 7000);
}

// ─── UI: ORBIT DIAL ──────────────────────────────────────────────────────────
// One ring per orbit, from the last northbound equator crossing: sunlit arcs
// warm, shadow arcs blue, a dot for where the ISS is now.
const DIAL_R = 50, DIAL_C = 2 * Math.PI * DIAL_R;
let dialSegments = [];

function buildDial(now) {
    let t = now.getTime(), prev = live.lat;
    for (let i = 0; i < 800; i++) {
        t -= 10000;
        const lat = issState(satrec, new Date(t)).lat;
        if (lat < 0 && prev >= 0) break;
        prev = lat;
    }
    live.ascNode     = t;
    live.period      = 2 * Math.PI / satrec.no * 60000;
    live.orbitsToday = 86400000 / live.period;

    dialSegments = [];
    const N = 120;
    let start = 0, lit = issState(satrec, new Date(t)).sunlit;
    for (let i = 1; i <= N; i++) {
        const l = i === N ? !lit : issState(satrec, new Date(t + live.period * i / N)).sunlit;
        if (l !== lit) { dialSegments.push({ from: start / N, to: i / N, lit }); start = i; lit = l; }
    }
    const ring = (w, gap) => `<circle cx="60" cy="60" r="${DIAL_R}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="${w}"/>` +
        dialSegments.map(s => `<circle cx="60" cy="60" r="${DIAL_R}" fill="none" stroke="${s.lit ? 'var(--day)' : 'var(--night)'}" stroke-opacity="0.9" stroke-width="${w}" stroke-linecap="round"
            stroke-dasharray="${Math.max(0, (s.to - s.from) * DIAL_C - gap)} ${DIAL_C}" stroke-dashoffset="${-s.from * DIAL_C - gap / 2}"/>`).join('');
    $('dial').innerHTML     = ring(6, 6) + `<circle class="dot" r="7" fill="#fff" stroke="rgba(0,0,0,0.4)" stroke-width="2"/>`;
    $('miniDial').innerHTML = ring(10, 10) + `<circle class="dot" r="11" fill="#fff"/>`;
}

function updateDial(now) {
    const frac = ((now - live.ascNode) / live.period) % 1;
    const a = frac * Math.PI * 2;
    document.querySelectorAll('#dial .dot, #miniDial .dot').forEach(dot => {
        dot.setAttribute('cx', 60 + DIAL_R * Math.cos(a));
        dot.setAttribute('cy', 60 + DIAL_R * Math.sin(a));
    });
    return frac;
}

function nextLightChange(frac) {
    const seg = dialSegments.find(s => frac >= s.from && frac < s.to) || dialSegments[0];
    return seg ? { ms: (seg.to - frac) * live.period, sunrise: !seg.lit } : null;
}

// ─── HOME & PASSES ───────────────────────────────────────────────────────────
// Location is remembered in this browser only, rounded to ~1 km
const HOME_KEY = 'iss-tracker.home';
let home = null, passes = [], selectedPass = 0, passSamples = [], passesFor = null, passesFrom = 0;

try {
    const saved = JSON.parse(localStorage.getItem(HOME_KEY));
    if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) home = saved;
} catch { /* storage unavailable */ }

function setHome(h) {
    home = h;
    homeNormal = placeHomeMarker(home);
    $('passesEmpty').hidden = true;
    $('passesFull').hidden = false;
    refreshPasses();
}

let skyAfterLocate = false;
function locate() {
    const buttons = [$('locateBtn'), $('relocateBtn')];
    const done = () => buttons.forEach(b => { b.disabled = false; });
    const fail = msg => {
        done();
        skyAfterLocate = false;
        $('locateError').textContent = msg;
        $('locateError').hidden = false;
        toast('!', 'Location unavailable', msg);
    };
    if (!navigator.geolocation) { fail('This browser doesn’t share location.'); return; }
    buttons.forEach(b => { b.disabled = true; });
    $('locateBtn').textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(pos => {
        done();
        $('locateBtn').textContent = 'Use my location';
        $('locateError').hidden = true;
        const h = { lat: Math.round(pos.coords.latitude * 100) / 100, lon: Math.round(pos.coords.longitude * 100) / 100 };
        try { localStorage.setItem(HOME_KEY, JSON.stringify(h)); } catch { /* not persisted */ }
        setHome(h);
        if (skyAfterLocate || mode === 'sky') flyTo('sky', 2200);
        skyAfterLocate = false;
    }, err => {
        $('locateBtn').textContent = 'Try again';
        fail(err.code === err.PERMISSION_DENIED
            ? 'Location is blocked. Allow it for this page in your browser settings.'
            : 'Couldn’t get your location. Try again in a moment.');
    }, { timeout: 15000, maximumAge: 10 * 60 * 1000 });
}
$('locateBtn').addEventListener('click', locate);
$('relocateBtn').addEventListener('click', locate);

// "My sky" before we know where you are: show the Passes tab and ask
function requestSky() {
    selectTab('passes');
    autoTab = false;
    if (PHONE.matches) setSheet(true);
    skyAfterLocate = true;
    locate();
}

function polar(az, el) {
    const r = (90 - Math.max(el, 0)) / 90 * 70;
    return [r * Math.sin(az * DEG), -r * Math.cos(az * DEG)];
}

function refreshPasses() {
    if (!home || !satrec) return;
    passes = findVisiblePasses(satrec, home, clockNow(), { days: 7, max: 3 });
    passesFor = satrec;
    passesFrom = clockNow().getTime();
    selectedPass = 0;
    renderPasses();
}

function renderPasses() {
    $('passList').replaceChildren(...passes.map((p, i) => {
        const b = document.createElement('button');
        b.setAttribute('aria-pressed', String(i === selectedPass));
        b.innerHTML = `<b>${fmt.day.format(p.start)} ${fmt.time.format(p.start)}</b>${Math.round(p.maxElevation)}° · ${compass(p.startAz)} → ${compass(p.endAz)}`;
        b.addEventListener('click', () => { selectedPass = i; renderPasses(); });
        return b;
    }));
    if (!passes.length) {
        $('passList').innerHTML = '<p class="note">None in the next 7 days. It flies over often, but only shows up when it’s sunlit against a dark sky.</p>';
    }
    const p = passes[selectedPass];
    passSamples = [];
    if (!p) { $('chart').innerHTML = ''; setPassTrack([]); return; }

    const track = [];
    for (let t = p.start.getTime(); t <= p.end.getTime(); t += 5000) {
        const d  = new Date(t);
        const la = lookAngles(satrec, home, d);
        passSamples.push(polar(la.azimuth, la.elevation));
        const s = issState(satrec, d);
        track.push(latLonToVector3(s.lat, s.lon, R * 1.003));
    }
    setPassTrack(track);

    const pts = passSamples.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const [sx, sy] = passSamples[0], [ex, ey] = passSamples[passSamples.length - 1];
    $('chart').innerHTML = `
        <circle r="70" fill="rgba(125,211,252,0.05)" stroke="rgba(255,255,255,0.18)"/>
        <circle r="46.7" fill="none" stroke="rgba(255,255,255,0.08)"/>
        <circle r="23.3" fill="none" stroke="rgba(255,255,255,0.08)"/>
        <line x1="-70" x2="70" stroke="rgba(255,255,255,0.08)"/><line y1="-70" y2="70" stroke="rgba(255,255,255,0.08)"/>
        ${[['N', 0, -78], ['E', 78, 0], ['S', 0, 78], ['W', -78, 0]].map(([l, x, y]) => `<text x="${x}" y="${y}" fill="rgba(255,255,255,0.5)" font-size="9" text-anchor="middle" dominant-baseline="middle">${l}</text>`).join('')}
        <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" style="filter:drop-shadow(0 0 6px rgba(var(--accent-rgb),0.6))"/>
        <circle cx="${sx}" cy="${sy}" r="3" fill="var(--accent)"/>
        <path d="M${ex} ${ey} m-4 -4 l8 8 m0 -8 l-8 8" stroke="var(--accent)" stroke-width="1.5"/>
        <circle id="passDot" r="5" fill="#fff"/>`;
}

function animatePassDot(t) {
    const dot = $('passDot');
    if (!dot || !passSamples.length) return;
    const [x, y] = passSamples[Math.floor(((t / 4000) % 1) * (passSamples.length - 1))];
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
}

const countdownText = ms => {
    if (ms <= 0) return 'now';
    const h = Math.floor(ms / 3600000);
    if (h >= 24) return `in ${Math.floor(h / 24)} d ${h % 24} h`;
    if (h >= 1)  return `in ${h} h ${Math.floor(ms / 60000) % 60} min`;
    return `in ${Math.ceil(ms / 60000)} min`;
};
const badgeText = ms => ms <= 0 ? 'now' : ms >= 86400000 ? `${Math.floor(ms / 86400000)}d` : ms >= 3600000 ? `${Math.floor(ms / 3600000)}h` : `${Math.ceil(ms / 60000)}m`;

// Where the ISS is in your sky right now, with a nudge when it's visible
let lookUpToasted = false;
function updateSkyLive(now) {
    const la = lookAngles(satrec, home, now);
    if (!la) return;
    const el = $('skyLive');
    const up = la.elevation > 0;
    const visible = up && la.elevation >= PASS_MIN_ELEVATION && isSunlit(la.eci, sunDirectionEci(now)) && sunElevation(home, now) <= PASS_MAX_SUN_ELEV;
    el.classList.toggle('up', visible);
    const where = `${Math.round(la.elevation)}° up in the ${compass(la.azimuth)}`;
    el.textContent = !up ? `${fmt.int.format(la.range)} km away · below your horizon`
        : visible ? `Look up! ${where}`
        : `Above your horizon, ${where}, but not visible right now`;
    if (visible && !lookUpToasted && isLive()) toast('↑', 'Look up!', `The ISS is ${where}`);
    lookUpToasted = visible;
}

// ─── UI: PER-TICK TEXT ───────────────────────────────────────────────────────
// Places only count once the ISS has been over them for a moment, so small
// islands and coastlines don't flicker the label or spam notices.
const placeState = { shown: null, candidate: null, since: 0, lastToast: 0 };
let lastSunlit = null, travelled = 0;

function bearing(now) {
    const b = issState(satrec, new Date(now.getTime() + 10000));
    const p1 = live.lat * DEG, p2 = b.lat * DEG, dl = (b.lon - live.lon) * DEG;
    return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / DEG + 360) % 360;
}

function tickUI(now) {
    const speed = fmt.int.format(live.velocity);
    setOdometer(speed);
    $('sSpeed').textContent = speed;
    $('alt').textContent = live.alt.toFixed(1) + ' km';
    $('lat').textContent = fmt.lat(live.lat);
    $('lon').textContent = fmt.lon(live.lon);
    $('sunText').textContent = live.sunlit ? 'in sunlight' : 'in Earth’s shadow';
    $('tagAlt').textContent = Math.round(live.alt) + ' km up';
    $('tagSun').textContent = live.sunlit ? 'sunlit' : 'in shadow';
    $('travelled').textContent = fmt.int.format(travelled) + ' km';
    document.body.dataset.phase = live.sunlit ? 'day' : 'night';

    const heading = compass(bearing(now));
    $('heading').textContent = heading;

    if (live.period) {
        const frac = updateDial(now);
        $('orbitPct').textContent = Math.round(frac * 100) + '%';
        const next = nextLightChange(frac);
        if (next) {
            $('dialTime').textContent = $('miniDialTime').textContent = fmt.mmss(next.ms);
            $('dialLabel').textContent = next.sunrise ? 'to sunrise' : 'to sunset';
        }
    }

    const place = placeName(live.lat, live.lon);
    if (place.name !== placeState.candidate) { placeState.candidate = place.name; placeState.since = now; }
    if ((now - placeState.since > 1500 || placeState.shown === null) && place.name !== placeState.shown) {
        swapText($('place'), place.name);
        if (placeState.shown && isLive() && now - placeState.lastToast > 25000) {
            toast(place.land ? '◉' : '≈', place.land ? `Now over ${place.name}` : `Out over ${place.name}`,
                `${fmt.int.format(live.alt)} km up, heading ${heading}`);
            placeState.lastToast = now.getTime();
        }
        placeState.shown = place.name;
    }

    if (lastSunlit !== null && live.sunlit !== lastSunlit && isLive()) {
        const dark = dialSegments.find(s => !s.lit);
        toast(live.sunlit ? '☀' : '☾', live.sunlit ? 'Orbital sunrise' : 'Orbital sunset',
            live.sunlit ? `One of ${Math.round(live.orbitsToday)} sunrises the crew sees today`
                        : `Into Earth’s shadow for about ${dark ? Math.round((dark.to - dark.from) * live.period / 60000) : 35} minutes`);
    }
    lastSunlit = live.sunlit;

    const p = home && passes[0];
    $('passBadge').hidden = !p;
    if (home) {
        updateSkyLive(now);
        if (passesFor !== satrec || (p && p.end < now) || now < passesFrom) refreshPasses();
        $('skyCountdown').textContent = !p ? 'Nothing visible this week'
            : p.start <= now ? 'Visible now. Look up!' : `Next pass ${countdownText(p.start - now)}`;
        if (p) $('passBadge').textContent = badgeText(p.start - now);
    }

    // Phone summary line follows the camera mode
    $('sLine').innerHTML = mode === 'sky' && p
        ? `Next pass <b>${fmt.day.format(p.start)} ${fmt.time.format(p.start)}</b> · ${countdownText(p.start - now)}`
        : `Over <b>${placeState.shown ?? '—'}</b> · heading ${heading}`;
}

// ─── CALLOUT + FLARE (screen-space overlays) ─────────────────────────────────
const tmp = new THREE.Vector3();
const toScreen = v => { tmp.copy(v).project(camera); return [(tmp.x + 1) / 2 * innerWidth, (1 - tmp.y) / 2 * innerHeight, tmp.z]; };

// Is a world point hidden behind the Earth from the camera?
function occluded(point) {
    const c = camera.position, dir = point.clone().sub(c);
    const len = dir.length();
    dir.divideScalar(len);
    const t = -c.dot(dir);
    if (t < 0 || t > len) return false;
    return c.clone().add(dir.multiplyScalar(t)).length() < R;
}

const callout = $('callout');
callout.querySelector('polyline').setAttribute('points', '0,0 20,-34 34,-34');
function updateCallout() {
    if (!live.p) return;
    const [x, y] = toScreen(live.p);
    const sheetTop = PHONE.matches ? innerHeight - sheet.offsetHeight : innerHeight;
    const show = mode !== 'follow' && mode !== 'cupola' && !flight && !occluded(live.p) && y < sheetTop - 20 && y > 60;
    callout.style.opacity = show ? 1 : 0;
    const flip = x > innerWidth - 230;
    if (flip !== callout.classList.contains('flip')) {
        callout.classList.toggle('flip', flip);
        callout.querySelector('polyline').setAttribute('points', flip ? '0,0 -20,-34 -34,-34' : '0,0 20,-34 34,-34');
    }
    callout.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

const flare = $('flare');
let flareAlpha = 0;
function updateFlare(dt) {
    // Sun direction ray from the camera: how close does it pass to the Earth?
    const c = camera.position, t = -c.dot(sunDir);
    const miss = t < 0 ? Infinity : c.clone().add(sunDir.clone().multiplyScalar(t)).length();
    const vis  = THREE.MathUtils.smoothstep(miss, R, R * 1.035);
    const [x, y, z] = toScreen(c.clone().add(sunDir.clone().multiplyScalar(30)));
    const onScreen = z < 1 && x > -300 && x < innerWidth + 300 && y > -300 && y < innerHeight + 300;
    flareAlpha += ((onScreen && (mode === 'follow' || mode === 'cupola') && !flight ? vis : 0) - flareAlpha) * damp(6, dt);
    flare.style.opacity = flareAlpha.toFixed(3);
    if (flareAlpha < 0.01) return;
    // Brightest just as the sun clears the horizon
    const burst = 1 + 1.6 * (1 - THREE.MathUtils.smoothstep(miss, R, R * 1.08));
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const place = (sel, k, size) => {
        const d = flare.querySelector(sel);
        d.style.left = (x + (cx - x) * k) + 'px';
        d.style.top  = (y + (cy - y) * k) + 'px';
        if (size) d.style.width = d.style.height = size + 'px';
    };
    place('.core', 0, 260 * burst);
    place('.streak', 0);
    flare.querySelector('.streak').style.width = 900 * burst + 'px';
    place('.g1', 0.7, 70);
    place('.g2', 1.25, 140);
    place('.g3', 1.6, 40);
}

// ─── CLOUDS TOGGLE ───────────────────────────────────────────────────────────
const CLOUDS_KEY = 'iss-tracker.clouds';
let showClouds = true;
try { showClouds = localStorage.getItem(CLOUDS_KEY) !== 'off'; } catch { /* storage unavailable */ }
function setClouds(on) {
    showClouds = on;
    $('cloudsBtn').setAttribute('aria-pressed', String(on));
    try { localStorage.setItem(CLOUDS_KEY, on ? 'on' : 'off'); } catch { /* not persisted */ }
}
setClouds(showClouds);
cloudsOn.value = showClouds ? 1 : 0;
$('cloudsBtn').addEventListener('click', () => setClouds(!showClouds));

// ─── CUPOLA WINDOW ───────────────────────────────────────────────────────────
// The Cupola's seven windows from inside: a round one looking straight down,
// ringed by six trapezoids. Drawn once per resize around (0, 0), then moved to
// wherever the camera's centre sits on screen.
const cupolaEl = $('cupola');
function buildCupolaFrame() {
    const s  = Math.min(innerWidth, innerHeight);
    const r0 = s * 0.25, band = s * 0.04;
    const a1 = (r0 + band) / Math.cos(Math.PI / 6), a2 = s * 0.82 / Math.cos(Math.PI / 6);
    const hex = a => [0, 1, 2, 3, 4, 5].map(i => [a * Math.cos(i * Math.PI / 3), a * Math.sin(i * Math.PI / 3)]);
    const poly = pts => 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L') + 'Z';
    const circle = r => `M${r} 0A${r} ${r} 0 1 0 ${-r} 0A${r} ${r} 0 1 0 ${r} 0Z`;
    const big = 6000;
    const inner = hex(a1), outer = hex(a2);
    const mullions = inner.map(([x, y], i) => `M${x.toFixed(1)} ${y.toFixed(1)}L${outer[i][0].toFixed(1)} ${outer[i][1].toFixed(1)}`).join('');
    const bolts = [...Array(16)].map((_, i) => {
        const t = i / 16 * Math.PI * 2, r = r0 + band * 0.5;
        return `<circle cx="${(r * Math.cos(t)).toFixed(1)}" cy="${(r * Math.sin(t)).toFixed(1)}" r="${(band * 0.09).toFixed(1)}" fill="#1c2129"/>`;
    }).join('');
    $('cupolaFrame').innerHTML = `
        <defs>
            <radialGradient id="cupMetal" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${a2 * 1.1}">
                <stop offset="0" stop-color="#11141a"/><stop offset="0.45" stop-color="#0b0d12"/><stop offset="1" stop-color="#040506"/>
            </radialGradient>
            <linearGradient id="cupGlass" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#cfe0ff" stop-opacity="0.07"/><stop offset="0.5" stop-color="#cfe0ff" stop-opacity="0"/>
            </linearGradient>
        </defs>
        <g id="cupolaG">
            <path fill="url(#cupGlass)" d="${circle(r0)}${poly(outer)}${poly(inner)}" fill-rule="evenodd"/>
            <path fill="url(#cupMetal)" fill-rule="evenodd" d="M${-big} ${-big}H${big}V${big}H${-big}Z${circle(r0)}${poly(outer)}${poly(inner)}"/>
            <path d="${mullions}" stroke="#090b0f" stroke-width="${(band * 0.8).toFixed(1)}" stroke-linecap="butt"/>
            <path d="${circle(r0)}${poly(inner)}${poly(outer)}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="1.5"/>
            ${bolts}
        </g>`;
    cupolaAt = '';
}

let cupolaAt = '';
function updateCupola() {
    const on = mode === 'cupola' && !flight;
    if (on !== cupolaEl.classList.contains('on')) cupolaEl.classList.toggle('on', on);
    const t = `translate(${(innerWidth / 2 + frame.ox).toFixed(1)} ${(innerHeight / 2 + frame.oy).toFixed(1)})`;
    if (t !== cupolaAt) { cupolaAt = t; $('cupolaG')?.setAttribute('transform', t); }
}

// ─── NEWS ────────────────────────────────────────────────────────────────────
// Spaceflight News API — free, keyless, CORS-enabled
async function updateNews() {
    try {
        const res = await fetch('https://api.spaceflightnewsapi.net/v4/articles/?limit=6');
        if (!res.ok) throw new Error(res.status);
        const { results } = await res.json();
        $('news').replaceChildren(...results.map(a => {
            const link = document.createElement('a');
            const src  = document.createElement('span');
            link.href        = a.url;
            link.target      = '_blank';
            link.rel         = 'noopener';
            link.textContent = a.title;
            src.textContent  = a.news_site;
            link.append(src);
            return link;
        }));
        setTimeout(updateNews, 10 * 60 * 1000);
    } catch (e) {
        console.error('News fetch error:', e);
        $('news').innerHTML = '<p class="note">Signal lost. Retrying shortly…</p>';
        setTimeout(updateNews, 60 * 1000);
    }
}

// ─── STARTUP ─────────────────────────────────────────────────────────────────
let started = false, startedAt = 0, dialAt = 0, pathAt = 0, lastTickAt = 0;

function onOrbitData(first) {
    const now = clockNow();
    if (!issFrame(now)) return;
    buildDial(now);
    dialAt = now.getTime();
    pathAt = 0;
    refreshPasses();
    // If the intro has already played without the ISS, swing round to it
    if (first && started && mode === 'earth' && performance.now() - lastInteraction > 4000) flyTo('earth', 2400);
}

// Fade the veil and fly in from deep space once textures (or a timeout) are ready
function start() {
    if (started) return;
    started = true;
    startedAt = performance.now();
    $('veil').classList.add('gone');
    startWeather();
    const lat = live.p ? live.lat : 20, lon = live.p ? live.lon : -40;
    current.pos.copy(latLonToVector3(lat * 0.6 - 25, lon + 70, 170));
    flyTo('earth', 4200);
    rotateComparison();
    if (live.p) setTimeout(() => toast('◎', 'Tracking the ISS', `${fmt.int.format(live.alt)} km above ${placeName(live.lat, live.lon).name}`), 3200);
}
textureManager.onLoad = start;
setTimeout(start, 9000);

if (home) setHome(home);
loadTLE();
loadCountries().catch(e => console.error('Countries error:', e));
updateNews();

// ─── LAYOUT ──────────────────────────────────────────────────────────────────
function layout() {
    resizeRenderer(innerWidth, innerHeight);
    buildCupolaFrame();
    camera.aspect = innerWidth / innerHeight;
    measureFree();
    updateModeUI();
}
window.addEventListener('resize', layout);
layout();
earthView.dist = earthView.targetDist;
frame.ox = frame.tx;
frame.oy = frame.ty;
document.fonts.ready.then(layout);

// Status-bar clock
const tickClock = () => { $('clock').textContent = fmt.time.format(clockNow()); };
tickClock();
setInterval(tickClock, 250);

// ─── FRAME LOOP ──────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
let elapsed = 0;

// If the first seconds after the intro run slow, step the render quality
// down (unless ?q= pinned it). Stops watching once it's fast enough, and
// looks again after each flight, since Ride along and My sky cost more.
const fpsWatch = { frames: 0, since: 0, after: 0, done: false };
function rewatchFrameRate() {
    Object.assign(fpsWatch, { frames: 0, since: 0, after: performance.now() + 1500, done: false });
}
function watchFrameRate() {
    const t = performance.now();
    if (fpsWatch.done || !started || PINNED_TIER >= 0 || t - startedAt < 5000 || t < fpsWatch.after) return;
    if (!fpsWatch.since) fpsWatch.since = t;
    fpsWatch.frames++;
    if (t - fpsWatch.since < 3000) return;
    const fps = fpsWatch.frames / ((t - fpsWatch.since) / 1000);
    fpsWatch.frames = 0;
    fpsWatch.since = t;
    if (fps >= 45 || qualityTier === 0) fpsWatch.done = true;
    else setQuality(qualityTier - 1);
}

(function loop() {
    requestAnimationFrame(loop);
    const dt  = Math.min(clock.getDelta(), 0.1);
    updateTimeMachine(dt);
    const now = clockNow();
    elapsed += dt;
    elapsedU.value = elapsed;
    // Stock clouds drift slowly; the live map shows real positions, so it stays put
    if (!cloudsLive) cloudShift.value = (cloudShift.value + dt * 0.0006) % 1;
    cloudsOn.value += ((showClouds ? 1 : 0) - cloudsOn.value) * damp(4, dt);
    if (Math.abs(cloudsOn.value - (showClouds ? 1 : 0)) < 0.002) cloudsOn.value = showClouds ? 1 : 0;

    updateSky(now);

    if (satrec && issFrame(now)) {
        travelled += live.velocity / 3600 * dt;
        if (Math.abs(now - pathAt) > 20000) { rebuildPaths(satrec, now.getTime()); pathAt = now.getTime(); }
        pinPath(live.p);
        if (Math.abs(now - dialAt) > 30000) { buildDial(now); dialAt = now.getTime(); }
        if (live.period) updateDial(now);
        if (Math.abs(now - lastTickAt) > 250) { tickUI(now); lastTickAt = now.getTime(); }
    }

    // Momentum after a drag. Left alone for a while, the Earth view eases back
    // round to the ISS and then keeps it in frame as it travels.
    if (!pointers.size) {
        applyLook(look.vx * dt, look.vy * dt);
        const k = Math.exp(-dt * 4);
        look.vx *= k;
        look.vy *= k;
    }
    // (not when fast-forwarding: the ISS laps too quickly to chase)
    const idle = mode === 'earth' && !flight && !pointers.size && live.p && performance.now() - lastInteraction > 6000 && timeWarp.rate <= 60;
    earthView.drift += ((idle ? 1 : 0) - earthView.drift) * damp(0.5, dt);
    if (mode === 'earth' && live.p && earthView.drift > 0.001) {
        const dLon = ((live.lon - earthView.lon + 540) % 360) - 180;
        const k    = damp(0.25, dt) * earthView.drift;
        earthView.lon += dLon * k;
        earthView.lat += (live.lat * 0.6 - earthView.lat) * k;
    }

    updateCamera(dt);

    // Fade things by how close the camera is (0 = riding along, 1 = far out)
    const far   = THREE.MathUtils.smoothstep(camera.position.length() - R, 1.5, 8);
    const close = 1 - far;
    pastMat.uniforms.opacity.value = 0.75 * far;
    futureMat.uniforms.opacity.value = 0.6 * far;
    passTrackMat.opacity += ((mode === 'sky' ? 0.95 : 0) - passTrackMat.opacity) * damp(3, dt);
    homeRing.scale.setScalar(1 + 0.3 * (REDUCED_MOTION ? 0 : Math.sin(elapsed * 2)));
    if (live.p) updateStation(live, close, far, elapsed, dt, mode === 'follow' || !!flight, mode === 'cupola' && !flight);
    updateSpacecraft(now, far);
    updateCupola();
    if (live.p) updateSound(live, dt);
    animatePassDot(performance.now());

    updateShells();
    updateDetail(dt, !flight);
    updateCallout();
    updateFlare(dt);
    renderFrame();
    watchFrameRate();
})();
