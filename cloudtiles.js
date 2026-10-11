// ─── SHARP LIVE CLOUDS ───────────────────────────────────────────────────────
// The global cloud map is about 10 km a pixel and up to 3 hours old. Three
// geostationary weather satellites see most of the planet far better:
// GOES-East (the Americas), GOES-West (the Pacific) and Himawari (Asia and
// Australia). NASA GIBS serves their infrared images at 2 km every 10
// minutes, so on desktop the tiles around the view are streamed in and
// turned from temperature into cloud cover. Europe, Africa and the western
// Indian Ocean (Meteosat's patch, not on GIBS) keep the global map.
//
// Tiles land in globe.js's cloudDetail texture the same way detail.js lays
// out terrain: at (column mod N, row mod N), so the window can slide.

const IR_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/';
const IR_SATELLITES = [
    { layer: 'GOES-East_ABI_Band13_Clean_Infrared', lon: -75.2 },
    { layer: 'GOES-West_ABI_Band13_Clean_Infrared', lon: -137.2 },
    { layer: 'Himawari_AHI_Band13_Clean_Infrared',  lon: 140.7 },
];
const IR_ENABLED   = !COMPACT;          // tiles are 200–400 KB each, too heavy for phones
const IR_MAX_LEVEL = 5;                 // 2 km a pixel
const IR_MIN_LEVEL = 3;
const IR_VIEW_DEG  = 66;                // how far from a satellite's longitude (or the equator) it sees well
const IR_REFRESH   = 30 * 60 * 1000;
const IR_CACHE     = 40;

let irColours = null;                   // packed RGB → brightness temperature, °C
const irTiles  = new Map();             // url → Uint8Array of cover, or { failedAt }
const irLoading = new Set();
const irWin = { z: -1, col0: -1, row0: -1, placed: new Map(), wanted: [], round: 0, refreshedAt: 0, dirty: false };

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

// The best-placed satellite for a spot, if any sees it well
function irSatellite(lat, lon) {
    if (Math.abs(lat) > IR_VIEW_DEG) return null;
    let best = null, bestD = IR_VIEW_DEG;
    for (const s of IR_SATELLITES) {
        const d = Math.abs(((lon - s.lon + 540) % 360) - 180);
        if (d < bestD) { best = s; bestD = d; }
    }
    return best;
}

// Temperature → cloud cover. Clear ground or sea is warm (warmer towards the
// tropics); cloud tops get colder the higher and thicker they are.
function irCover(rgba, row0Lat, span) {
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
    const R = 2, rows = new Float32Array(P * P), out = new Uint8Array(P * P * 4);
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
        out[i * 4] = Math.round(s / n * 255);
        out[i * 4 + 3] = 255;
    }
    return out;
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
            irTiles.set(w.url, irCover(irCtx.getImageData(0, 0, DETAIL_TILE_PX, DETAIL_TILE_PX).data, w.lat0, w.span));
            for (const [url, entry] of irTiles) { if (irTiles.size <= IR_CACHE) break; irTiles.delete(url); }
        })
        .catch(() => irTiles.set(w.url, { failedAt: performance.now() }))
        .finally(() => { irLoading.delete(w.url); irWin.dirty = true; });
}

function planIrWindow(tx, ty) {
    const N = DETAIL_TILES, span = tileSpan(irWin.z), around = tilesAround(irWin.z);
    irWin.wanted = [];
    for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
        const col = (irWin.col0 + k) % around, row = irWin.row0 + j;
        const lat0 = 90 - row * span;
        const sat = irSatellite(lat0 - span / 2, -180 + (col + 0.5) * span);
        if (!sat) continue;
        irWin.wanted.push({
            slot: `${col % N},${row % N}`, lat0, span,
            url: `${IR_BASE}${sat.layer}/default/default/2km/${irWin.z}/${row}/${col}.png#${irWin.round}`,
            priority: Math.hypot(irWin.col0 + k + 0.5 - tx, row + 0.5 - ty),
        });
    }
    irWin.wanted.sort((a, b) => a.priority - b.priority);
    // Clear slots that now belong to tiles outside the window
    const keep = new Set(irWin.wanted.map(w => w.slot));
    const tex = cloudDetail.value;
    for (const slot of [...irWin.placed.keys()]) {
        if (keep.has(slot) && irWin.wanted.some(w => w.slot === slot && w.url.split('#')[0] === irWin.placed.get(slot).split('#')[0])) continue;
        writeSlot(tex, slot, SLOT_BLANK);
        irWin.placed.delete(slot);
    }
    irWin.dirty = true;
}

function reconcileIr() {
    irWin.dirty = false;
    let budget = 1;
    for (const w of irWin.wanted) {
        if (irWin.placed.get(w.slot) === w.url) continue;
        const entry = irTiles.get(w.url);
        if (entry instanceof Uint8Array) {
            if (budget-- <= 0) { irWin.dirty = true; continue; }
            writeSlot(cloudDetail.value, w.slot, { isDataTexture: true, image: { width: DETAIL_TILE_PX, height: DETAIL_TILE_PX, data: entry } });
            irWin.placed.set(w.slot, w.url);
        } else if (entry?.failedAt !== undefined) {
            if (performance.now() - entry.failedAt > 120000) irTiles.delete(w.url);
        } else if (!irLoading.has(w.url) && irLoading.size < 4) {
            fetchIrTile(w);
        } else {
            irWin.dirty = true;     // still waiting for a free request
        }
    }
}

// Each frame, after detail.js has worked out where the view is
function updateCloudTiles(dt, settled) {
    const want = IR_ENABLED && cloudsLive && irColours && showClouds;
    cloudDetailOn.value += ((want && irWin.z >= IR_MIN_LEVEL ? 1 : 0) - cloudDetailOn.value) * (1 - Math.exp(-dt * 2));
    if (!want) return;

    if (settled) {
        const zf = Math.min(detailView.zNeed + 1, IR_MAX_LEVEL + 0.5);
        if (irWin.z < 0 || Math.abs(zf - (irWin.z + 0.5)) > 0.8) {
            const z = Math.max(IR_MIN_LEVEL, Math.min(IR_MAX_LEVEL, Math.floor(zf)));
            if (z !== irWin.z) { irWin.z = z; irWin.col0 = irWin.row0 = -1; irWin.placed.clear(); cloudDetail.value.needsUpdate = true; }
        }
        // A fresh round of tiles every half hour (the satellites update every 10 minutes)
        const refresh = performance.now() - irWin.refreshedAt > IR_REFRESH;
        if (refresh) { irWin.refreshedAt = performance.now(); irWin.round++; }

        const N = DETAIL_TILES, span = tileSpan(irWin.z), around = tilesAround(irWin.z);
        const tx = (detailView.lon + 180) / span, ty = (90 - detailView.lat) / span;
        const dx = (((tx - irWin.col0) % around) + around) % around, dy = ty - irWin.row0, m = N / 4;
        if (irWin.col0 < 0 || dx < m || dx > N - m || dy < m || dy > N - m || refresh) {
            const col0 = ((Math.floor(tx - N / 2 + 0.5) % around) + around) % around;
            const row0 = Math.max(0, Math.min(tilesDown(irWin.z) - N, Math.floor(ty - N / 2 + 0.5)));
            if (col0 !== irWin.col0 || row0 !== irWin.row0 || refresh) {
                irWin.col0 = col0;
                irWin.row0 = row0;
                cloudWin.value.set(col0, row0, span, around);
                planIrWindow(col0 + (((tx - col0) % around) + around) % around, ty);
            }
        }
    }
    if (irWin.dirty) reconcileIr();
}
