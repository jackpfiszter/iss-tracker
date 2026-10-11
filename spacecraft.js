// ─── OTHER SPACECRAFT ────────────────────────────────────────────────────────
// China's Tiangong station and the Hubble Space Telescope, from CelesTrak
// orbit data: a glowing marker, a label and one faint orbit each. They show
// in the Earth and My sky views. If the data can't load they simply don't.

const SPACECRAFT = [
    { id: 48274, name: 'Tiangong', color: 0xff8f6b },
    { id: 20580, name: 'Hubble',   color: 0xc7a8ff },
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

// Distance between two spacecraft, in km
const craftDistance = (a, b) => a.distanceTo(b) / R * EARTH_RADIUS_KM;

function updateSpacecraft(now, far) {
    const showMode = (mode === 'earth' || mode === 'sky') && !flight;
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
