// ─── SHARP CLOSE-UPS ─────────────────────────────────────────────────────────
// The base Earth textures are about 10 km a pixel, which is plenty from far
// away but blurry from the ISS. When the camera is close enough for that to
// show, this streams NASA GIBS tiles around the spot it's looking at: Blue
// Marble (the same imagery as the base texture) at up to ~500 m a pixel, and
// VIIRS city lights on the night side. Only tiles on the right side of the
// terminator are fetched.
//
// Tiles land in globe.js's detail textures at (column mod N, row mod N), so
// sliding the window along only loads the new edge.

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/';
const DETAIL_URLS = {
    day:   GIBS + 'BlueMarble_ShadedRelief_Bathymetry/default/default/500m/',
    night: GIBS + 'VIIRS_CityLights_2012/default/default/500m/',
};
const DETAIL_MAX_LEVEL   = 7;                  // 2.25° tiles, ~490 m a pixel
const DETAIL_MIN_LEVEL   = 4;                  // any coarser and the base texture is as good
const BASE_TEXEL_DEG     = 360 / 4096;
const DETAIL_CACHE_SIZE  = COMPACT ? 24 : 96;  // decoded tiles kept in memory
const DETAIL_CONCURRENCY = 6;
const UPLOADS_PER_FRAME  = 2;

// GIBS's EPSG:4326 grid: level z tiles are 288/2^z degrees, from (-180°, 90°)
const tileSpan    = z => 288 / 2 ** z;
const tilesAround = z => Math.round(360 / tileSpan(z));
const tilesDown   = z => Math.round(180 / tileSpan(z));

const tileCache = new Map();   // url → { bitmap } or { failedAt }, in least-recently-used order
const tileQueue = [];          // { url, priority } waiting to be fetched
const tileLoading = new Set();

const detailLayers = Array.from({ length: DETAIL_LAYER_COUNT }, (_, i) => ({
    z: -1, col0: -1, row0: -1, want: 0, wanted: [],
    placed: { day: new Map(), night: new Map() },   // slot → url
    tex:    { day: detailUniforms['detailDay' + i], night: detailUniforms['detailNight' + i] },
    win:    detailUniforms['detailWin' + i].value,
    on:     detailUniforms['detailOn' + i],
}));
const detailView = { lat: 0, lon: 0, zNeed: 0 };   // where the view meets the ground, and the level that suits it
let detailDirty = false, detailCheckedAt = 0;

// ─── FETCHING ────────────────────────────────────────────────────────────────
function pumpTiles() {
    tileQueue.sort((a, b) => a.priority - b.priority);
    while (tileLoading.size < DETAIL_CONCURRENCY && tileQueue.length) {
        const { url } = tileQueue.shift();
        tileLoading.add(url);
        fetch(url)
            .then(r => r.ok ? r.blob() : Promise.reject(new Error(r.status)))
            .then(blob => createImageBitmap(blob))
            .then(bitmap => { tileCache.set(url, { bitmap }); trimTileCache(); })
            .catch(() => tileCache.set(url, { failedAt: performance.now() }))
            .finally(() => { tileLoading.delete(url); detailDirty = true; pumpTiles(); });
    }
}

function trimTileCache() {
    for (const [url, entry] of tileCache) {
        if (tileCache.size <= DETAIL_CACHE_SIZE) break;
        entry.bitmap?.close();
        tileCache.delete(url);
    }
}

function cachedTile(url) {
    const entry = tileCache.get(url);
    if (!entry) return null;
    if (entry.failedAt !== undefined && performance.now() - entry.failedAt > 60000) { tileCache.delete(url); return null; }
    tileCache.delete(url);        // move to the most-recently-used end
    tileCache.set(url, entry);
    return entry;
}

// ─── GPU UPLOADS ─────────────────────────────────────────────────────────────
const SLOT_BLANK = { isDataTexture: true, image: { width: DETAIL_TILE_PX, height: DETAIL_TILE_PX, data: new Uint8Array(DETAIL_TILE_PX ** 2 * 4) } };
const slotPos = new THREE.Vector2();
function writeSlot(texture, slot, image) {
    const [sx, sy] = slot.split(',');
    slotPos.set(sx * DETAIL_TILE_PX, sy * DETAIL_TILE_PX);
    renderer.copyTextureToTexture(slotPos, image.isDataTexture ? image : { image }, texture);
}

// ─── WINDOWS ─────────────────────────────────────────────────────────────────
function setLevel(L, z) {
    L.z = z;
    L.col0 = L.row0 = -1;
    for (const kind of ['day', 'night']) {
        L.placed[kind].clear();
        L.tex[kind].value.needsUpdate = true;    // re-upload the blank texture
    }
}

// Which tiles (and day/night kinds) the window needs, nearest the centre first
function planWindow(L, tx, ty) {
    const N = DETAIL_TILES, around = tilesAround(L.z), span = tileSpan(L.z);
    L.wanted = [];
    for (let j = 0; j < N; j++) {
        for (let k = 0; k < N; k++) {
            const col = (L.col0 + k) % around, row = L.row0 + j;
            const n = latLonToVector3(90 - (row + 0.5) * span, -180 + (col + 0.5) * span, 1);
            const d = n.dot(sunDir), m = Math.sin(span * 0.75 * DEG) + 0.12;
            const slot = `${col % N},${row % N}`;
            const priority = Math.hypot(L.col0 + k + 0.5 - tx, row + 0.5 - ty);
            for (const kind of ['day', 'night']) {
                if (kind === 'day' ? d < -m : d > m) continue;
                L.wanted.push({ kind, slot, priority, url: `${DETAIL_URLS[kind]}${L.z}/${row}/${col}.jpeg` });
            }
        }
    }
    L.wanted.sort((a, b) => a.priority - b.priority);
    // Clear slots now holding a tile from outside the window, so it can't
    // show up in the wrong place. This has to happen now, with the new
    // window; mipmaps are rebuilt once per texture rather than per slot.
    for (const kind of ['day', 'night']) {
        const keep  = new Set(L.wanted.filter(w => w.kind === kind).map(w => w.slot + w.url));
        const stale = [...L.placed[kind]].filter(([slot, url]) => !keep.has(slot + url)).map(([slot]) => slot);
        const tex   = L.tex[kind].value;
        stale.forEach((slot, i) => {
            tex.generateMipmaps = i === stale.length - 1;
            writeSlot(tex, slot, SLOT_BLANK);
            L.placed[kind].delete(slot);
        });
        tex.generateMipmaps = true;
    }
    detailDirty = true;
}

// Upload what's arrived and queue what hasn't
function reconcile() {
    let budget = UPLOADS_PER_FRAME;
    detailDirty = false;
    tileQueue.length = 0;
    for (const L of detailLayers) {
        if (L.z < 0 || !L.want) continue;
        for (const w of L.wanted) {
            if (L.placed[w.kind].get(w.slot) === w.url) continue;
            const entry = cachedTile(w.url);
            if (entry?.bitmap) {
                if (budget-- <= 0) { detailDirty = true; continue; }
                writeSlot(L.tex[w.kind].value, w.slot, entry.bitmap);
                L.placed[w.kind].set(w.slot, w.url);
            } else if (!entry && !tileLoading.has(w.url)) {
                tileQueue.push({ url: w.url, priority: w.priority + (L === detailLayers[0] ? 0 : 1.5) });
            }
        }
    }
    pumpTiles();
}

// ─── EACH FRAME ──────────────────────────────────────────────────────────────
const _dir = new THREE.Vector3(), _hit = new THREE.Vector3(), _centre = new THREE.Vector3();

// settled: false while the camera is mid-flight, so levels don't churn
function updateDetail(dt, settled) {
    for (const L of detailLayers) L.on.value += (L.want - L.on.value) * (1 - Math.exp(-dt * 3));
    if (settled) planDetail();
    if (detailDirty) reconcile();
}

function planDetail() {
    // Where the view meets the ground, and how much ground one pixel covers there
    const cam = camera.position, r = cam.length();
    camera.getWorldDirection(_dir);
    const b = cam.dot(_dir), disc = b * b - (r * r - R * R);
    let dist;
    if (disc > 0 && -b - Math.sqrt(disc) > 0) {
        dist = -b - Math.sqrt(disc);
        _hit.copy(cam).addScaledVector(_dir, dist);
    } else {
        dist = Math.sqrt(Math.max(r * r - R * R, 0));
        _hit.copy(cam).setLength(R);
    }
    // Lean the window towards the ground under the camera, which is closest and sharpest
    _centre.copy(cam).setLength(R).multiplyScalar(0.4).addScaledVector(_hit, 0.6).normalize();
    const lat = Math.asin(_centre.y) / DEG;
    const lon = wrapLon(Math.atan2(_centre.z, -_centre.x) / DEG - 180);
    const pixelDeg = dist * (camera.fov * DEG / viewH) / R / DEG;
    const useful   = pixelDeg < BASE_TEXEL_DEG * 0.8;
    // Level whose texels match a screen pixel at the view centre
    const zNeed = Math.log2(288 / (DETAIL_TILE_PX * pixelDeg));
    Object.assign(detailView, { lat, lon, zNeed });

    const recheck = performance.now() - detailCheckedAt > 30000;   // the terminator moves
    if (recheck) detailCheckedAt = performance.now();

    detailLayers.forEach((L, i) => {
        L.want = 0;
        if (!useful) return;
        // The wide layer stays two levels coarser than the sharp one can go
        const offset = DETAIL_LAYER_COUNT === 1 ? 1 : i === 0 ? 2 : 0;
        const zMax   = DETAIL_MAX_LEVEL - (i > 0 ? 2 : 0);
        const zf = Math.min(zNeed + offset, zMax + 0.5);
        if (L.z < 0 || Math.abs(zf - (L.z + 0.5)) > 0.8) {
            const z = Math.min(zMax, Math.floor(zf));
            if (z !== L.z) setLevel(L, z);
        }
        if (L.z < DETAIL_MIN_LEVEL) return;
        L.want = 1;

        const N = DETAIL_TILES, span = tileSpan(L.z), around = tilesAround(L.z);
        const tx = (lon + 180) / span, ty = (90 - lat) / span;
        const dx = (((tx - L.col0) % around) + around) % around, dy = ty - L.row0;
        const m = N / 4;
        if (L.col0 < 0 || dx < m || dx > N - m || dy < m || dy > N - m || recheck) {
            const col0 = ((Math.floor(tx - N / 2 + 0.5) % around) + around) % around;
            const row0 = Math.max(0, Math.min(tilesDown(L.z) - N, Math.floor(ty - N / 2 + 0.5)));
            if (col0 !== L.col0 || row0 !== L.row0 || recheck) {
                L.col0 = col0;
                L.row0 = row0;
                L.win.set(col0, row0, span, around);
                // Priorities are measured in unwrapped columns from col0
                planWindow(L, col0 + (((tx - col0) % around) + around) % around, ty);
            }
        }
    });
}
