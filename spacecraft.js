// ─── OTHER SPACECRAFT ────────────────────────────────────────────────────────
// Notable satellites from CelesTrak orbit data, each with a glowing marker, a
// label and one faint orbit, plus whole constellations drawn as clouds of dots.
// The satellites button opens a picker; what you tick is remembered, and a
// satellite's orbit data is only fetched once it's ticked. They show in the
// Earth and My sky views. If the data can't load they simply don't.
//
// Only low Earth orbit and a few medium ones are listed: objects that loop
// out tens of thousands of km (Chandra, TESS) would overflow the globe view.

const CRAFT_GROUPS = [
    { key: 'station',    title: 'Space stations',    color: 0xff8f6b },
    { key: 'telescope',  title: 'Space telescopes',  color: 0xc7a8ff },
    { key: 'earth',      title: 'Watching the Earth', color: 0x8fe39a },
    { key: 'veteran',    title: 'Veterans',          color: 0xffd86b },
];

// core: always loaded (the Crew tab measures the distance to Tiangong)
const SPACECRAFT = [
    { id: 48274, name: 'Tiangong',   group: 'station',   core: true, note: "China's space station" },
    { id: 20580, name: 'Hubble',     group: 'telescope', note: 'The optical and ultraviolet telescope, since 1990' },
    { id: 33053, name: 'Fermi',      group: 'telescope', note: 'Gamma-ray telescope' },
    { id: 28485, name: 'Swift',      group: 'telescope', note: 'Swings round to catch gamma-ray bursts' },
    { id: 38358, name: 'NuSTAR',     group: 'telescope', note: 'Focusing X-ray telescope' },
    { id: 49954, name: 'IXPE',       group: 'telescope', note: 'Maps the polarisation of X-rays' },
    { id: 25994, name: 'Terra',      group: 'earth',     note: "NASA's flagship Earth observer, since 1999" },
    { id: 27424, name: 'Aqua',       group: 'earth',     note: 'Water cycle and climate' },
    { id: 49260, name: 'Landsat 9',  group: 'earth',     note: 'The long-running land-imaging series' },
    { id: 40697, name: 'Sentinel-2A', group: 'earth',    note: "Europe's land and vegetation imager" },
    { id: 43013, name: 'NOAA 20',    group: 'earth',     note: 'Polar-orbiting weather satellite' },
    { id: 46984, name: 'Sentinel-6', group: 'earth',     note: 'Measures sea level from 1,300 km up' },
    { id: 43613, name: 'ICESat-2',   group: 'earth',     note: 'Laser altimeter measuring ice height' },
    { id: 5,     name: 'Vanguard 1', group: 'veteran',   note: 'Launched 1958: the oldest satellite still in orbit' },
    { id: 7530,  name: 'AO-7',       group: 'veteran',   note: 'Amateur radio satellite from 1974, still working' },
    { id: 27386, name: 'Envisat',    group: 'veteran',   note: 'Bus-sized, dead since 2012 and drifting' },
];

// Whole constellations: one group download each, drawn as dots
const CONSTELLATIONS = [
    { key: 'starlink', name: 'Starlink', group: 'starlink',     color: 0xcfe4ff, size: 2.2, note: "SpaceX's broadband constellation: thousands" },
    { key: 'oneweb',   name: 'OneWeb',   group: 'oneweb',       color: 0xa8f0d0, size: 2.6, note: 'Polar-orbit broadband, 1,200 km up' },
    { key: 'iridium',  name: 'Iridium',  group: 'iridium-NEXT', color: 0xffb3d9, size: 3,   note: 'Satellite phones, 66 in six orbital planes' },
    { key: 'gps',      name: 'GPS',      group: 'gps-ops',      color: 0xffe08a, size: 3.6, note: 'Navigation, 20,000 km up' },
];

const CRAFT_ORBIT_POINTS = 120;
const SAT_KEY = 'iss-tracker.sats';
const SAT_DEFAULT = ['48274', '20580'];

// What's ticked, as craft ids and constellation keys
const picked = new Set(SAT_DEFAULT);
try {
    const saved = JSON.parse(localStorage.getItem(SAT_KEY));
    if (Array.isArray(saved)) { picked.clear(); saved.forEach(k => picked.add(String(k))); }
    // Starlink used to have a toggle of its own
    else if (localStorage.getItem('iss-tracker.starlink') === 'on') picked.add('starlink');
} catch { /* storage unavailable */ }

const hex = c => '#' + c.toString(16).padStart(6, '0');
const groupColor = key => CRAFT_GROUPS.find(g => g.key === key).color;

for (const craft of SPACECRAFT) {
    craft.color  = groupColor(craft.group);
    craft.key    = String(craft.id);
    craft.on     = picked.has(craft.key);
    craft.satrec = null;
    craft.state  = null;
    craft.pathAt = 0;
    craft.p      = new THREE.Vector3();

    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    craft.glow = new THREE.Points(glowGeo, new THREE.PointsMaterial({
        map: MARKER, color: srgb(craft.color).multiplyScalar(1.1), size: 22, sizeAttenuation: false,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
    }));
    craft.glow.renderOrder = 3;
    craft.glow.visible = false;

    const orbitGeo = new THREE.BufferGeometry();
    orbitGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CRAFT_ORBIT_POINTS * 3), 3));
    craft.orbit = new THREE.LineLoop(orbitGeo, new THREE.LineBasicMaterial({
        color: srgb(craft.color), transparent: true, opacity: 0, depthWrite: false,
    }));
    craft.orbit.renderOrder = 3;
    craft.orbit.frustumCulled = false;
    craft.orbit.visible = false;
    scene.add(craft.glow, craft.orbit);

    craft.tag = document.createElement('div');
    craft.tag.className = 'craft-tag';
    craft.tag.style.setProperty('--c', hex(craft.color));
    craft.tag.innerHTML = `<i></i><span>${craft.name}</span>`;
    craft.tag.style.opacity = 0;
    document.getElementById('craftTags').append(craft.tag);
}

// Orbit data via orbits.js: CelesTrak first, TLE API as the backup
async function loadSpacecraft(craft) {
    if (craft.loading) return;
    craft.loading = true;
    try {
        const entry = await getTle(craft.id, ['celestrak', 'tleapi']);
        const rec = satellite.twoline2satrec(...entry.lines);
        if (rec.error) throw new Error('unusable TLE');
        craft.satrec = rec;
        craft.pathAt = 0;
        setTimeout(() => { craft.loading = false; loadSpacecraft(craft); }, tleNextCheck(entry));
    } catch (e) {
        console.warn(`${craft.name} orbit:`, e.message || e);
        setTimeout(() => { craft.loading = false; loadSpacecraft(craft); }, 10 * 60 * 1000);
    }
    // loading stays true until the next scheduled check, so a repeat call can't double up
}
SPACECRAFT.filter(c => c.core || c.on).forEach(loadSpacecraft);

// One orbit, centred on now. The Earth's turn is frozen at now, so this is
// the orbit's ring in space (closed and flat), not the ground track lifted
// up, which twists ~24° over an orbit and can't close.
function fillCraftOrbit(craft, now) {
    const period = 2 * Math.PI / craft.satrec.no * 60000;
    const gmst = satellite.gstime(new Date(now));
    const pos = craft.orbit.geometry.attributes.position;
    for (let i = 0; i < CRAFT_ORBIT_POINTS; i++) {
        const pv = satellite.propagate(craft.satrec, new Date(now - period / 2 + period * i / CRAFT_ORBIT_POINTS));
        if (!pv.position) continue;
        const geo = satellite.eciToGeodetic(pv.position, gmst);
        const v = latLonToVector3(geo.latitude / DEG, wrapLon(geo.longitude / DEG), altToRadius(geo.height));
        pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
}

// ─── CONSTELLATIONS ──────────────────────────────────────────────────────────
// Thousands of satellites from one CelesTrak group download, as a single cloud
// of dots. Positions are recomputed every couple of seconds, not every frame.
const CONSTELLATION_REFRESH = COMPACT ? 5000 : 2000;

for (const layer of CONSTELLATIONS) {
    layer.on = picked.has(layer.key);
    layer.sats = null;
    layer.stale = false;
    layer.loading = false;
    layer.at = 0;
    layer.wall = 0;
    layer.points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
        color: srgb(layer.color), size: layer.size, sizeAttenuation: false,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
    }));
    layer.points.renderOrder = 3;
    layer.points.frustumCulled = false;
    layer.points.visible = false;
    scene.add(layer.points);
}

async function loadConstellation(layer) {
    if ((layer.sats && !layer.stale) || layer.loading) return;
    layer.loading = true;
    try {
        const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${layer.group}&FORMAT=tle`);
        if (!r.ok) throw new Error(r.status);
        const lines = (await r.text()).split('\n').map(l => l.trim()).filter(Boolean);
        const sats = [];
        for (let i = 0; i + 2 < lines.length; i += 3) {
            const rec = satellite.twoline2satrec(lines[i + 1], lines[i + 2]);
            if (!rec.error) sats.push(rec);
        }
        if (!sats.length) throw new Error('no usable elements');
        layer.sats = sats;
        layer.stale = false;
        layer.points.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sats.length * 3), 3));
        layer.at = 0;
        // Elements drift out of date over days, so look again every 6 hours
        setTimeout(() => { layer.stale = true; if (layer.on) loadConstellation(layer); }, 6 * 60 * 60 * 1000);
    } catch (e) {
        console.warn(`${layer.name} orbits:`, e.message || e);
        setTimeout(() => { if (layer.on) loadConstellation(layer); }, 10 * 60 * 1000);
    }
    layer.loading = false;
}

function updateConstellation(layer, now, vis) {
    const m = layer.points.material;
    m.opacity += ((layer.on && layer.sats ? vis * 0.85 : 0) - m.opacity) * 0.1;
    layer.points.visible = m.opacity > 0.01;
    if (!layer.points.visible) return;
    // Wall-clock throttle as well, so fast time-machine speeds don't recompute every frame
    const wall = performance.now();
    const interval = timeWarp.rate > 1 ? 400 : CONSTELLATION_REFRESH;
    if (Math.abs(now - layer.at) < 1000 || wall - layer.wall < interval) return;
    layer.at = now.getTime();
    layer.wall = wall;
    const gmst = satellite.gstime(now);
    const pos = layer.points.geometry.attributes.position;
    let n = 0;
    for (const rec of layer.sats) {
        const pv = satellite.propagate(rec, now);
        if (!pv.position) continue;   // decayed or out of range
        const geo = satellite.eciToGeodetic(pv.position, gmst);
        const v = latLonToVector3(geo.latitude / DEG, wrapLon(geo.longitude / DEG), altToRadius(geo.height));
        pos.setXYZ(n++, v.x, v.y, v.z);
    }
    layer.points.geometry.setDrawRange(0, n);
    pos.needsUpdate = true;
}

// Distance between two spacecraft, in km
const craftDistance = (a, b) => a.distanceTo(b) / R * EARTH_RADIUS_KM;

function updateSpacecraft(now, far) {
    const showMode = (mode === 'earth' || mode === 'sky') && !flight;
    CONSTELLATIONS.forEach(layer => updateConstellation(layer, now, showMode ? far : 0));
    for (const craft of SPACECRAFT) {
        if (!craft.satrec || !(craft.on || craft.core)) continue;
        const s = issState(craft.satrec, now);
        if (!s) continue;
        craft.state = s;
        craft.p.copy(latLonToVector3(s.lat, s.lon, altToRadius(s.alt)));
        craft.glow.geometry.attributes.position.setXYZ(0, craft.p.x, craft.p.y, craft.p.z);
        craft.glow.geometry.attributes.position.needsUpdate = true;
        if (craft.on && Math.abs(now - craft.pathAt) > 10000) { fillCraftOrbit(craft, now.getTime()); craft.pathAt = now.getTime(); }

        const vis = showMode && craft.on ? far : 0;
        craft.glow.material.opacity  += (vis * (s.sunlit ? 0.9 : 0.35) - craft.glow.material.opacity) * 0.1;
        craft.orbit.material.opacity += (vis * 0.06 - craft.orbit.material.opacity) * 0.1;
        craft.glow.visible  = craft.glow.material.opacity > 0.005;
        craft.orbit.visible = craft.orbit.material.opacity > 0.002;

        const [x, y, z] = toScreen(craft.p);
        const sheetTop = PHONE.matches ? innerHeight - sheet.offsetHeight : innerHeight;
        const onScreen = z < 1 && x > 0 && x < innerWidth && y > 70 && y < sheetTop - 10 && !occluded(craft.p);
        const op = vis > 0.5 && onScreen ? 1 : 0;
        if (String(op) !== craft.tag.style.opacity) craft.tag.style.opacity = op;
        // Always follow, even while hidden or fading, so a label never fades
        // back in at a stale spot and then jumps
        // (behind the camera the projection mirrors, so leave it where it was)
        if (z < 1) craft.tag.style.transform = `translate3d(${x.toFixed(1)}px, ${(y - 4).toFixed(1)}px, 0) translateY(-50%)`;
    }
}

// ─── PICKER ──────────────────────────────────────────────────────────────────
function setPicked(key, on) {
    on ? picked.add(key) : picked.delete(key);
    try { localStorage.setItem(SAT_KEY, JSON.stringify([...picked])); } catch { /* not persisted */ }
    const craft = SPACECRAFT.find(c => c.key === key);
    if (craft) {
        craft.on = on;
        if (on) { craft.pathAt = 0; loadSpacecraft(craft); }
        else craft.tag.style.opacity = 0;
    }
    const layer = CONSTELLATIONS.find(l => l.key === key);
    if (layer) {
        layer.on = on;
        if (on) loadConstellation(layer);
    }
}

function buildSatPicker() {
    const row = (key, name, note, color, size) => {
        const label = document.createElement('label');
        label.className = 'sat-row';
        label.style.setProperty('--c', hex(color));
        label.innerHTML = '<input type="checkbox"><i></i><span><b></b><small></small></span>';
        const box = label.querySelector('input');
        box.checked = picked.has(key);
        box.dataset.key = key;
        label.querySelector('b').textContent = name;
        label.querySelector('small').textContent = note;
        box.addEventListener('change', () => setPicked(key, box.checked));
        return label;
    };
    const heading = text => Object.assign(document.createElement('h4'), { className: 'sat-group', textContent: text });
    const list = byId('satList');
    for (const g of CRAFT_GROUPS) {
        list.append(heading(g.title), ...SPACECRAFT.filter(c => c.group === g.key).map(c => row(c.key, c.name, c.note, c.color)));
    }
    list.append(heading('Constellations'), ...CONSTELLATIONS.map(l => row(l.key, l.name, l.note, l.color)));
}
buildSatPicker();

function toggleSatPanel(open = byId('satPanel').hidden) {
    byId('satPanel').hidden = !open;
    byId('satsBtn').setAttribute('aria-expanded', String(open));
    byId('satsBtn').setAttribute('aria-pressed', String(open));
}

byId('satsBtn').addEventListener('click', () => toggleSatPanel());
byId('satReset').addEventListener('click', () => {
    byId('satList').querySelectorAll('input').forEach(box => {
        box.checked = SAT_DEFAULT.includes(box.dataset.key);
        setPicked(box.dataset.key, box.checked);
    });
});
window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea')) return;
    if (e.key.toLowerCase() === 'l') toggleSatPanel();
    if (e.key === 'Escape' && !byId('satPanel').hidden) toggleSatPanel(false);
});
// Constellations ticked on a previous visit start loading straight away
CONSTELLATIONS.filter(l => l.on).forEach(loadConstellation);
