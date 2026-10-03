// ─── SCENE SETUP ─────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(10, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.z = 100;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.getElementById('container').appendChild(renderer.domElement);

// ─── STAR FIELD ──────────────────────────────────────────────────────────────
const STAR_COUNT = 4000;
const starPos    = new Float32Array(STAR_COUNT * 3);

for (let i = 0; i < STAR_COUNT; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = 500 + Math.random() * 300;
    starPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    starPos[i * 3 + 2] = r * Math.cos(phi);
}

const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
    color: 0xffffff, size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.6,
})));

// ─── GLOBE ───────────────────────────────────────────────────────────────────
// Flat dark sphere — just enough to occlude the far side's coastlines
const sphere      = new THREE.Mesh(new THREE.SphereGeometry(5, 64, 64),
                                   new THREE.MeshBasicMaterial({ color: 0x1a1a1a }));
const sphereGroup = new THREE.Group();
sphereGroup.add(sphere);
scene.add(sphereGroup);

// ─── CONTROLS ────────────────────────────────────────────────────────────────
let isDragging = false;
let previousMousePosition = { x: 0, y: 0 };
let zoomLevel = 1;
const zoomSensitivity = 0.1;

renderer.domElement.addEventListener('mousedown', e => {
    isDragging = true;
    previousMousePosition = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('mousemove', e => {
    if (!isDragging) return;
    sphereGroup.rotation.y += (e.clientX - previousMousePosition.x) * 0.002;
    sphereGroup.rotation.x = THREE.MathUtils.clamp(
        sphereGroup.rotation.x + (e.clientY - previousMousePosition.y) * 0.002,
        -Math.PI / 2, Math.PI / 2
    );
    previousMousePosition = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('mouseup',    () => { isDragging = false; });
renderer.domElement.addEventListener('mouseleave', () => { isDragging = false; });
renderer.domElement.addEventListener('wheel', e => {
    const delta = -Math.sign(e.deltaY);
    zoomLevel = Math.min(Math.max(zoomLevel + delta * zoomSensitivity, 0.1), 10);
    camera.position.z = 100 / zoomLevel;
});

// ─── GEO HELPERS ─────────────────────────────────────────────────────────────
function latLonToVector3(lat, lon, radius) {
    const phi   = (90 - lat) * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    return new THREE.Vector3(
        -radius * Math.sin(phi) * Math.cos(theta),
         radius * Math.cos(phi),
         radius * Math.sin(phi) * Math.sin(theta)
    );
}

// Green wireframe coastlines (v1 look)
const landMat = new THREE.LineBasicMaterial({ color: 0x00ff00 });

function drawPolygon(polygon) {
    const points = polygon.map(([lon, lat]) => latLonToVector3(lat, lon, 5.01));
    sphereGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), landMat));
}

fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson')
    .then(r => r.json())
    .then(data => {
        data.features.forEach(f => {
            if (f.geometry.type === 'Polygon')
                f.geometry.coordinates.forEach(drawPolygon);
            if (f.geometry.type === 'MultiPolygon')
                f.geometry.coordinates.forEach(mp => mp.forEach(drawPolygon));
        });
    })
    .catch(e => console.error('GeoJSON error:', e));

// ─── ISS VISUALS ─────────────────────────────────────────────────────────────
const ISS_COLOR = 0xffee00;

// Yellow wireframe marker (v1 look)
const issMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 3, 3),
    new THREE.MeshBasicMaterial({ color: ISS_COLOR, wireframe: true })
);
sphereGroup.add(issMesh);

// ISS → earth-centre line
const issLineGeo = new THREE.BufferGeometry();
issLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
sphereGroup.add(new THREE.Line(issLineGeo, new THREE.LineBasicMaterial({ color: ISS_COLOR })));

// Sub-satellite surface point
const subSatMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 4, 4),
    new THREE.MeshBasicMaterial({ color: ISS_COLOR, wireframe: true })
);
sphereGroup.add(subSatMesh);

// ─── ORBITAL TRAIL ───────────────────────────────────────────────────────────
const TRAIL_LEN = 80;
const trailBuf  = new Float32Array(TRAIL_LEN * 3);
const trailGeo  = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailBuf, 3));
trailGeo.setDrawRange(0, 0);
sphereGroup.add(new THREE.Line(trailGeo,
    new THREE.LineBasicMaterial({ color: ISS_COLOR, transparent: true, opacity: 0.45 })));
let trailCount = 0;

// ─── NEWS ────────────────────────────────────────────────────────────────────
// Spaceflight News API — free, keyless, CORS-enabled
const newsEl = document.getElementById('newsContent');

async function updateNews() {
    try {
        const res = await fetch('https://api.spaceflightnewsapi.net/v4/articles/?limit=3');
        if (!res.ok) throw new Error(res.status);
        const { results } = await res.json();
        newsEl.replaceChildren(...results.map(a => {
            const p    = document.createElement('p');
            const link = document.createElement('a');
            const src  = document.createElement('em');
            link.href        = a.url;
            link.target      = '_blank';
            link.rel         = 'noopener';
            link.textContent = a.title;
            src.textContent  = a.news_site;
            p.append(link, src);
            return p;
        }));
    } catch (e) {
        console.error('News fetch error:', e);
        newsEl.innerHTML = '<p>Signal lost.</p>';
    }
}

updateNews();
setInterval(updateNews, 10 * 60 * 1000);

// ─── ISS POSITION FETCH ──────────────────────────────────────────────────────
const stat = id => document.getElementById(`stat-${id}`);

function fetchISSPosition() {
    const earthRadius = 6371, sphereRadius = 5;
    fetch('https://api.wheretheiss.at/v1/satellites/25544')
        .then(r => r.json())
        .then(data => {
            const { latitude, longitude, altitude, velocity, visibility, timestamp } = data;
            const height     = sphereRadius * (1 + altitude / earthRadius);
            const issPos     = latLonToVector3(latitude, longitude, height);
            const surfacePos = latLonToVector3(latitude, longitude, sphereRadius);

            issMesh.position.copy(issPos);
            subSatMesh.position.copy(surfacePos);

            const lp = issLineGeo.attributes.position;
            lp.setXYZ(1, issPos.x, issPos.y, issPos.z);
            lp.needsUpdate = true;
            // Line is re-positioned each tick, so refresh culling bounds
            issLineGeo.computeBoundingSphere();

            // Prepend to trail
            trailBuf.copyWithin(3, 0, (TRAIL_LEN - 1) * 3);
            issPos.toArray(trailBuf, 0);
            trailCount = Math.min(trailCount + 1, TRAIL_LEN);
            trailGeo.setDrawRange(0, trailCount);
            trailGeo.attributes.position.needsUpdate = true;
            trailGeo.computeBoundingSphere();

            stat('lat').textContent = latitude.toFixed(4)  + '°';
            stat('lon').textContent = longitude.toFixed(4) + '°';
            stat('alt').textContent = altitude.toFixed(1)  + ' km';
            stat('vel').textContent = velocity.toFixed(0)  + ' km/h';
            stat('vis').textContent = visibility;
            stat('utc').textContent = new Date(timestamp * 1000).toUTCString().slice(17, 25);
        })
        .catch(e => console.error('ISS fetch error:', e));
}

fetchISSPosition();
setInterval(fetchISSPosition, 2000);

// ─── RENDER LOOP ─────────────────────────────────────────────────────────────
function render() {
    // Slow drift when idle
    if (!isDragging) sphereGroup.rotation.y += 0.00022;

    renderer.render(scene, camera);
}

function animate() {
    requestAnimationFrame(animate);
    render();
}

// Status-bar clock — once a second is plenty
const clockEl = document.getElementById('currentTime');
const tickClock = () => { clockEl.textContent = new Date().toUTCString().slice(5, 25) + ' UTC'; };
tickClock();
setInterval(tickClock, 1000);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();
