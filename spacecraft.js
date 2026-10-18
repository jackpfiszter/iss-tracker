// ─── OTHER SPACECRAFT ────────────────────────────────────────────────────────
// China's Tiangong station and the Hubble Space Telescope, from CelesTrak
// orbit data: a glowing marker, a label and one faint orbit each. They show
// in the Earth and My sky views. If the data can't load they simply don't.

const SPACECRAFT = [
    { id: 48274, name: 'Tiangong', color: 0xff8f6b },
    { id: 20580, name: 'Hubble',   color: 0xc7a8ff },
    { id: 33053, name: 'Fermi',    color: 0x7fd8ff },
    { id: 28485, name: 'Swift',    color: 0xffd86b },
    { id: 25994, name: 'Terra',    color: 0x8fe39a },
];
const CRAFT_ORBIT_POINTS = 120;

for (const craft of SPACECRAFT) {
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

    const orbitGeo = new THREE.BufferGeometry();
    orbitGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CRAFT_ORBIT_POINTS * 3), 3));
    craft.orbit = new THREE.LineLoop(orbitGeo, new THREE.LineBasicMaterial({
        color: srgb(craft.color), transparent: true, opacity: 0, depthWrite: false,
    }));
    craft.orbit.renderOrder = 3;
    craft.orbit.frustumCulled = false;
    scene.add(craft.glow, craft.orbit);

    craft.tag = document.createElement('div');
    craft.tag.className = 'craft-tag';
    craft.tag.style.setProperty('--c', '#' + craft.color.toString(16).padStart(6, '0'));
    craft.tag.innerHTML = `<i></i><span>${craft.name}</span>`;
    craft.tag.style.opacity = 0;
    document.getElementById('craftTags').append(craft.tag);
}

// Orbit data via orbits.js: CelesTrak first, TLE API as the backup
async function loadSpacecraft(craft) {
    try {
        const entry = await getTle(craft.id, ['celestrak', 'tleapi']);
        const rec = satellite.twoline2satrec(...entry.lines);
        if (rec.error) throw new Error('unusable TLE');
        craft.satrec = rec;
        craft.pathAt = 0;
        setTimeout(() => loadSpacecraft(craft), tleNextCheck(entry));
    } catch (e) {
        console.warn(`${craft.name} orbit:`, e.message || e);
        setTimeout(() => loadSpacecraft(craft), 10 * 60 * 1000);
    }
}
SPACECRAFT.forEach(loadSpacecraft);

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

// ─── STARLINK ────────────────────────────────────────────────────────────────
// The whole constellation (thousands of satellites) as one cloud of dots, from
// a single CelesTrak group download. Off until switched on (L or the button);
// positions are recomputed every couple of seconds rather than every frame.
const STARLINK_KEY = 'iss-tracker.starlink';
const STARLINK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle';
const STARLINK_REFRESH = 2000;
const starlink = { on: false, sats: null, loading: false, at: 0, count: 0 };
try { starlink.on = localStorage.getItem(STARLINK_KEY) === 'on'; } catch { /* storage unavailable */ }

starlink.points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
    color: srgb(0xcfe4ff), size: 2.2, sizeAttenuation: false,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
}));
starlink.points.renderOrder = 3;
starlink.points.frustumCulled = false;
scene.add(starlink.points);

async function loadStarlink() {
    if (starlink.sats || starlink.loading) return;
    starlink.loading = true;
    try {
        const r = await fetch(STARLINK_URL);
        if (!r.ok) throw new Error(r.status);
        const lines = (await r.text()).split('\n').map(l => l.trim()).filter(Boolean);
        const sats = [];
        for (let i = 0; i + 2 < lines.length; i += 3) {
            const rec = satellite.twoline2satrec(lines[i + 1], lines[i + 2]);
            if (!rec.error) sats.push(rec);
        }
        if (!sats.length) throw new Error('no usable elements');
        starlink.sats = sats;
        starlink.points.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sats.length * 3), 3));
        starlink.at = 0;
        // Elements go stale over days, so refresh them every 6 hours
        setTimeout(() => { starlink.sats = null; if (starlink.on) loadStarlink(); }, 6 * 60 * 60 * 1000);
    } catch (e) {
        console.warn('Starlink orbits:', e.message || e);
        setTimeout(() => { if (starlink.on) loadStarlink(); }, 10 * 60 * 1000);
    }
    starlink.loading = false;
}

function setStarlink(on) {
    starlink.on = on;
    byId('starlinkBtn').setAttribute('aria-pressed', String(on));
    try { localStorage.setItem(STARLINK_KEY, on ? 'on' : 'off'); } catch { /* not persisted */ }
    if (on) loadStarlink();
}

function updateStarlink(now, vis) {
    const p = starlink.points.material;
    p.opacity += ((starlink.on && starlink.sats ? vis * 0.85 : 0) - p.opacity) * 0.1;
    starlink.points.visible = p.opacity > 0.01;
    if (!starlink.points.visible || Math.abs(now - starlink.at) < STARLINK_REFRESH) return;
    starlink.at = now.getTime();
    const gmst = satellite.gstime(now);
    const pos = starlink.points.geometry.attributes.position;
    let n = 0;
    for (const rec of starlink.sats) {
        const pv = satellite.propagate(rec, now);
        if (!pv.position) continue;   // decayed or out of range
        const geo = satellite.eciToGeodetic(pv.position, gmst);
        const v = latLonToVector3(geo.latitude / DEG, wrapLon(geo.longitude / DEG), altToRadius(geo.height));
        pos.setXYZ(n++, v.x, v.y, v.z);
    }
    starlink.points.geometry.setDrawRange(0, n);
    pos.needsUpdate = true;
}

// Distance between two spacecraft, in km
const craftDistance = (a, b) => a.distanceTo(b) / R * EARTH_RADIUS_KM;

function updateSpacecraft(now, far) {
    const showMode = (mode === 'earth' || mode === 'sky') && !flight;
    updateStarlink(now, showMode ? far : 0);
    for (const craft of SPACECRAFT) {
        if (!craft.satrec) continue;
        const s = issState(craft.satrec, now);
        if (!s) continue;
        craft.state = s;
        craft.p.copy(latLonToVector3(s.lat, s.lon, altToRadius(s.alt)));
        craft.glow.geometry.attributes.position.setXYZ(0, craft.p.x, craft.p.y, craft.p.z);
        craft.glow.geometry.attributes.position.needsUpdate = true;
        if (Math.abs(now - craft.pathAt) > 10000) { fillCraftOrbit(craft, now.getTime()); craft.pathAt = now.getTime(); }

        const vis = showMode ? far : 0;
        craft.glow.material.opacity  += (vis * (s.sunlit ? 0.9 : 0.35) - craft.glow.material.opacity) * 0.1;
        craft.orbit.material.opacity += (vis * 0.06 - craft.orbit.material.opacity) * 0.1;

        const [x, y, z] = toScreen(craft.p);
        const sheetTop = PHONE.matches ? innerHeight - sheet.offsetHeight : innerHeight;
        const onScreen = z < 1 && x > 0 && x < innerWidth && y > 70 && y < sheetTop - 10 && !occluded(craft.p);
        const op = showMode && far > 0.5 && onScreen ? 1 : 0;
        if (String(op) !== craft.tag.style.opacity) craft.tag.style.opacity = op;
        // Always follow, even while hidden or fading, so a label never fades
        // back in at a stale spot and then jumps
        // (behind the camera the projection mirrors, so leave it where it was)
        if (z < 1) craft.tag.style.transform = `translate3d(${x.toFixed(1)}px, ${(y - 4).toFixed(1)}px, 0) translateY(-50%)`;
    }
}
