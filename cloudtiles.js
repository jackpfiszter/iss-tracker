// ─── SHARP LIVE CLOUDS ───────────────────────────────────────────────────────
// The global cloud map is about 10 km a pixel and up to 3 hours old. Three
// geostationary weather satellites see most of the planet far better:
// GOES-East (the Americas), GOES-West (the Pacific) and Himawari (Asia and
// Australia). NASA GIBS serves their infrared images at 2 km every 10
// minutes, so on desktop the tiles around the view are streamed in and
// turned from temperature into cloud cover. Europe, Africa and the western
// Indian Ocean (Meteosat's patch, not on GIBS) keep the global map.
//
// Tiles land in globe.js's cloudWide and cloudNear textures the same way
// detail.js lays out terrain: at (column mod N, row mod N), so a window can
// slide without moving the tiles already in it.

const IR_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/';
const IR_SATELLITES = [
    { layer: 'GOES-East_ABI_Band13_Clean_Infrared', lon: -75.2 },
    { layer: 'GOES-West_ABI_Band13_Clean_Infrared', lon: -137.2 },
    { layer: 'Himawari_AHI_Band13_Clean_Infrared',  lon: 140.7 },
];
const IR_ENABLED   = !COMPACT;          // tiles are 200–400 KB each, too heavy for phones
const IR_MAX_LEVEL = 5;                 // 2 km a pixel
const IR_MIN_LEVEL = 3;
// How far from the point under a satellite (as an angle at the Earth's
// centre) its view is good, and where it has faded out completely
const IR_VIEW_DEG  = 56;
const IR_EDGE_DEG  = 70;
const IR_REFRESH   = 30 * 60 * 1000;
const IR_CACHE     = 64;                // ~512 KB each
const IR_REQUESTS  = 6;

let irColours = null;                   // packed RGB → brightness temperature, °C
const irTiles  = new Map();             // url → Uint8Array of cover, or { failedAt }
const irLoading = new Set();

// The tiles are colour-coded by temperature; this file is NASA's colour scale.
// Its grey ramp (the warm end) only lists every other shade or so, so the
// greys in between are filled in by interpolation, and any other colour not
// in the scale takes its nearest neighbour's temperature.
let irEntries = [];
fetch('data/ir-colormap.json').then(r => r.json()).then(a => {
    irColours = new Map();
    for (let i = 0; i < a.length; i += 4) {
        irColours.set((a[i] << 16) | (a[i + 1] << 8) | a[i + 2], a[i + 3]);
        irEntries.push(a.slice(i, i + 4));
    }
    const greys = irEntries.filter(([r, g, b]) => r === g && g === b && r > 2 && r < 255).sort((p, q) => p[0] - q[0]);
    for (let v = greys[0][0]; v <= greys[greys.length - 1][0]; v++) {
        const key = (v << 16) | (v << 8) | v;
        if (irColours.has(key)) continue;
        const hi = greys.findIndex(e => e[0] > v), lo = greys[hi - 1], up = greys[hi];
        irColours.set(key, lo[3] + (up[3] - lo[3]) * (v - lo[0]) / (up[0] - lo[0]));
    }
}).catch(e => console.warn('Infrared colour scale unavailable:', e));

function irTemperature(r, g, b) {
    const key = (r << 16) | (g << 8) | b;
    let t = irColours.get(key);
    if (t === undefined) {
        let best = Infinity;
        for (const [er, eg, eb, et] of irEntries) {
            const d = (er - r) ** 2 + (eg - g) ** 2 + (eb - b) ** 2;
            if (d < best) { best = d; t = et; }
        }
        irColours.set(key, t);   // remember it
    }
    return t;
}

// Angle at the Earth's centre between a spot and the point under a satellite
const irAngle = (lat, lon, s) => Math.acos(Math.cos(lat * DEG) * Math.cos((lon - s.lon) * DEG)) / DEG;

// The best-placed satellite for a tile, if any sees part of it
function irSatellite(lat, lon, span) {
    let best = null, bestD = IR_EDGE_DEG + span * 0.7;
    for (const s of IR_SATELLITES) {
        const d = irAngle(lat, lon, s);
        if (d < bestD) { best = s; bestD = d; }
    }
    return best;
}

// Temperature → cloud cover. Clear ground or sea is warm (warmer towards the
// tropics); cloud tops get colder the higher and thicker they are. Towards
// the edge of the satellite's view it fades out, so it blends into the global
// map rather than ending at a tile edge. Packed as two bytes a pixel:
// cover × weight and weight (premultiplied, like the terrain tiles).
function irCover(rgba, row0Lat, lon0, span, sat) {
    const P = DETAIL_TILE_PX, cover = new Float32Array(P * P), valid = new Uint8Array(P * P);
    for (let y = 0; y < P; y++) {
        const lat = (row0Lat - (y + 0.5) / P * span) * DEG;
        const clear = 28 - 40 * Math.sin(lat) ** 2;          // a rough climatology of surface temperature, °C
        const warm = clear - 10, cold = clear - 50;
        for (let x = 0; x < P; x++) {
            const i = y * P + x;
            if (rgba[i * 4 + 3] < 128) continue;                // no data: leave transparent
            const k = Math.min(1, Math.max(0, (warm - irTemperature(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])) / (warm - cold)));
            cover[i] = k * k * (3 - 2 * k);
            valid[i] = 1;
        }
    }
    // A 5×5 blur: lone cold pixels (tiny cumulus, too small to show well)
    // fade to nothing instead of reading as specks; real cloud keeps its shape
    const R = 2, rows = new Float32Array(P * P), out = new Uint8Array(P * P * 2);
    for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
        let s = 0, n = 0;
        for (let d = -R; d <= R; d++) { const xx = x + d; if (xx >= 0 && xx < P && valid[y * P + xx]) { s += cover[y * P + xx]; n++; } }
        rows[y * P + x] = n ? s / n : 0;
    }
    for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
        const i = y * P + x;
        if (!valid[i]) continue;
        let s = 0, n = 0;
        for (let d = -R; d <= R; d++) { const yy = y + d; if (yy >= 0 && yy < P && valid[yy * P + x]) { s += rows[yy * P + x]; n++; } }
        const lat = row0Lat - (y + 0.5) / P * span, lon = lon0 + (x + 0.5) / P * span;
        const e = Math.min(1, Math.max(0, (IR_EDGE_DEG - irAngle(lat, lon, sat)) / (IR_EDGE_DEG - IR_VIEW_DEG)));
        const wgt = e * e * (3 - 2 * e);
        out[i * 2]     = Math.round(s / n * wgt * 255);
        out[i * 2 + 1] = Math.round(wgt * 255);
    }
    return out;
}

// Unpacked into RGBA just before each upload
const irUpload = { isDataTexture: true, image: { width: DETAIL_TILE_PX, height: DETAIL_TILE_PX, data: new Uint8Array(DETAIL_TILE_PX ** 2 * 4) } };
function irRgba(cover) {
    const out = irUpload.image.data;
    for (let i = 0, n = cover.length / 2; i < n; i++) {
        out[i * 4]     = cover[i * 2];
        out[i * 4 + 3] = cover[i * 2 + 1];
    }
    return irUpload;
}

const irCanvas = document.createElement('canvas');
irCanvas.width = irCanvas.height = DETAIL_TILE_PX;
const irCtx = irCanvas.getContext('2d', { willReadFrequently: true });

function fetchIrTile(w) {
    irLoading.add(w.url);
    fetch(w.url)
        .then(r => r.ok ? r.blob() : Promise.reject(new Error(r.status)))
        .then(blob => createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
        .then(bitmap => {
            irCtx.clearRect(0, 0, DETAIL_TILE_PX, DETAIL_TILE_PX);
            irCtx.drawImage(bitmap, 0, 0);
            bitmap.close();
            irTiles.set(w.url, irCover(irCtx.getImageData(0, 0, DETAIL_TILE_PX, DETAIL_TILE_PX).data, w.lat0, w.lon0, w.span, w.sat));
            for (const url of irTiles.keys()) { if (irTiles.size <= IR_CACHE) break; irTiles.delete(url); }
        })
        .catch(() => irTiles.set(w.url, { failedAt: performance.now() }))
        .finally(() => { irLoading.delete(w.url); irLayers.forEach(L => { L.dirty = true; }); });
}

// ─── WINDOWS ─────────────────────────────────────────────────────────────────
// Two windows over the same data, like the terrain: a wide one at a fixed
// coarse level that covers most of the visible globe and only slides when the
// view moves a long way, and a near one that sharpens what's under the camera.
// The near one fades out before it changes level, so the wide one (showing
// the same clouds, just softer) is what's seen while it refills.
const irLayers = [
    { name: 'wide', tex: cloudLayers.cloudWide, win: cloudLayers.cloudWideWin, on: cloudLayers.cloudWideOn },
    { name: 'near', tex: cloudLayers.cloudNear, win: cloudLayers.cloudNearWin, on: cloudLayers.cloudNearOn },
].map(L => Object.assign(L, { z: -1, nextZ: -1, col0: -1, row0: -1, placed: new Map(), wanted: [], dirty: false }));
let irRound = 0, irRefreshedAt = 0;

function planIrWindow(L, tx, ty) {
    const N = DETAIL_TILES, span = tileSpan(L.z), around = tilesAround(L.z);
    L.wanted = [];
    for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
        const col = (L.col0 + k) % around, row = L.row0 + j;
        const lat0 = 90 - row * span;
        const lon0 = -180 + col * span;
        const sat = irSatellite(lat0 - span / 2, lon0 + span / 2, span);
        if (!sat) continue;
        L.wanted.push({
            slot: `${col % N},${row % N}`, lat0, lon0, span, sat,
            url: `${IR_BASE}${sat.layer}/default/default/2km/${L.z}/${row}/${col}.png#${irRound}`,
            priority: Math.hypot(L.col0 + k + 0.5 - tx, row + 0.5 - ty),
        });
    }
    L.wanted.sort((a, b) => a.priority - b.priority);
    // Clear slots that now belong to tiles outside the window. A tile from the
    // previous round stays until its fresh copy arrives.
    const base = url => url.split('#')[0];
    for (const [slot, url] of [...L.placed]) {
        if (L.wanted.some(w => w.slot === slot && base(w.url) === base(url))) continue;
        writeSlot(L.tex.value, slot, SLOT_BLANK);
        L.placed.delete(slot);
    }
    L.dirty = true;
}

function setIrLevel(L, z) {
    L.z = z;
    L.col0 = L.row0 = -1;
    L.placed.clear();
    L.tex.value.needsUpdate = true;    // re-upload the blank texture
}

// Moves the window when the view nears its edge (or on a fresh round)
function slideIrWindow(L, refresh) {
    const N = DETAIL_TILES, span = tileSpan(L.z), around = tilesAround(L.z);
    const tx = (detailView.lon + 180) / span, ty = (90 - detailView.lat) / span;
    const dx = (((tx - L.col0) % around) + around) % around, dy = ty - L.row0, m = N / 4;
    if (L.col0 >= 0 && dx >= m && dx <= N - m && dy >= m && dy <= N - m && !refresh) return;
    const col0 = ((Math.floor(tx - N / 2 + 0.5) % around) + around) % around;
    const row0 = Math.max(0, Math.min(tilesDown(L.z) - N, Math.floor(ty - N / 2 + 0.5)));
    if (col0 === L.col0 && row0 === L.row0 && !refresh) return;
    L.col0 = col0;
    L.row0 = row0;
    L.win.value.set(col0, row0, span, around);
    planIrWindow(L, col0 + (((tx - col0) % around) + around) % around, ty);
}

// Nearest tiles first, sharing a few requests and a couple of uploads a frame
function reconcileIr(budget) {
    for (const L of irLayers) {
        if (!L.dirty || L.z < 0) continue;
        L.dirty = false;
        for (const w of L.wanted) {
            if (L.placed.get(w.slot) === w.url) continue;
            const entry = irTiles.get(w.url);
            if (entry instanceof Uint8Array) {
                if (budget.uploads <= 0) { L.dirty = true; continue; }
                budget.uploads--;
                writeSlot(L.tex.value, w.slot, irRgba(entry));
                L.placed.set(w.slot, w.url);
                irTiles.delete(w.url);          // most recently used
                irTiles.set(w.url, entry);
            } else if (entry?.failedAt !== undefined) {
                if (performance.now() - entry.failedAt > 120000) { irTiles.delete(w.url); L.dirty = true; }
            } else if (!irLoading.has(w.url) && irLoading.size < IR_REQUESTS) {
                fetchIrTile(w);
            } else {
                L.dirty = true;     // still waiting for a free request
            }
        }
    }
}

// Each frame, after detail.js has worked out where the view is
function updateCloudTiles(dt, settled) {
    const want = IR_ENABLED && cloudsLive && irColours && showClouds;
    const [wide, near] = irLayers;
    if (want && settled) {
        // The wide window: fixed level, the first to fill
        if (wide.z < 0) setIrLevel(wide, IR_MIN_LEVEL);
        // The near one: matched to the zoom, with plenty of hysteresis
        const zf = Math.min(detailView.zNeed + 1, IR_MAX_LEVEL + 0.5);
        if (near.nextZ < 0 ? zf >= IR_MIN_LEVEL + 1.2 : Math.abs(zf - (near.nextZ + 0.5)) > 0.8) {
            const z = Math.floor(zf);
            near.nextZ = z <= IR_MIN_LEVEL ? -1 : Math.min(IR_MAX_LEVEL, z);
        }
        // Change level only once faded out
        if (near.nextZ !== near.z && near.on.value < 0.02) setIrLevel(near, near.nextZ);

        const refresh = performance.now() - irRefreshedAt > IR_REFRESH;
        if (refresh) { irRefreshedAt = performance.now(); irRound++; }
        for (const L of irLayers) if (L.z >= 0) slideIrWindow(L, refresh);
    }
    wide.on.value += ((want && wide.z >= 0 ? 1 : 0) - wide.on.value) * (1 - Math.exp(-dt * 2));
    near.on.value += ((want && near.z >= 0 && near.z === near.nextZ ? 1 : 0) - near.on.value) * (1 - Math.exp(-dt * 3));
    if (want) reconcileIr({ uploads: 2 });
}
