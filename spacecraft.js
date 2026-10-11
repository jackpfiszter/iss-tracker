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
        map: GLOW, color: srgb(craft.color).multiplyScalar(1.1), size: 20, sizeAttenuation: false,
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

async function loadSpacecraft(craft) {
    try {
        const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${craft.id}&FORMAT=tle`);
        if (!r.ok) throw new Error(r.status);
        const lines = (await r.text()).split('\n').map(l => l.trim());
        const rec = satellite.twoline2satrec(lines.find(l => l.startsWith('1 ')), lines.find(l => l.startsWith('2 ')));
        if (rec.error) throw new Error('unusable TLE');
        craft.satrec = rec;
        craft.pathAt = 0;
        setTimeout(() => loadSpacecraft(craft), 6 * 3600 * 1000);
    } catch (e) {
        console.warn(`${craft.name} orbit unavailable:`, e.message || e);
        setTimeout(() => loadSpacecraft(craft), 10 * 60 * 1000);
    }
}
SPACECRAFT.forEach(loadSpacecraft);

// One orbit, centred on now
function fillCraftOrbit(craft, now) {
    const period = 2 * Math.PI / craft.satrec.no * 60000;
    const pos = craft.orbit.geometry.attributes.position;
    for (let i = 0; i < CRAFT_ORBIT_POINTS; i++) {
        const s = issState(craft.satrec, new Date(now - period / 2 + period * i / CRAFT_ORBIT_POINTS));
        if (!s) continue;
        const v = latLonToVector3(s.lat, s.lon, altToRadius(s.alt));
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
        if (Math.abs(now - craft.pathAt) > 60000) { fillCraftOrbit(craft, now.getTime()); craft.pathAt = now.getTime(); }

        const vis = showMode ? far : 0;
        craft.glow.material.opacity  += (vis * (s.sunlit ? 0.9 : 0.35) - craft.glow.material.opacity) * 0.1;
        craft.orbit.material.opacity += (vis * 0.06 - craft.orbit.material.opacity) * 0.1;

        const [x, y, z] = toScreen(craft.p);
        const sheetTop = PHONE.matches ? innerHeight - sheet.offsetHeight : innerHeight;
        const onScreen = z < 1 && x > 0 && x < innerWidth && y > 70 && y < sheetTop - 10 && !occluded(craft.p);
        const op = showMode && far > 0.5 && onScreen ? 1 : 0;
        if (String(op) !== craft.tag.style.opacity) craft.tag.style.opacity = op;
        if (op) craft.tag.style.transform = `translate3d(${x.toFixed(1)}px, ${(y - 4).toFixed(1)}px, 0) translateY(-50%)`;
    }
}
