// ─── LIVE WEATHER ────────────────────────────────────────────────────────────
// Real cloud cover from the last half hour (our own global map from the five
// geostationary weather satellites, built by tools/clouds; failing that,
// matteason/live-cloud-maps' 3-hourly one) and NOAA's 30-minute aurora
// forecast. Both fail quietly: the globe keeps the stock clouds and simply
// shows no aurora.

const CLOUDS_URL = `https://clouds.matteason.co.uk/images/${COMPACT ? '2048x1024' : '4096x2048'}/clouds-alpha.png`;
const AURORA_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const CLOUD_PERIOD_MS = 3 * 3600 * 1000;
// Served by GitHub Pages with the site (and to anywhere else, for local testing)
const OWN_CLOUDS       = 'https://jackpfiszter.github.io/iss-tracker/clouds/';
const OWN_CLOUDS_STALE = 3 * 3600 * 1000;
const OWN_CLOUD_LEVELS = [0.04, 0.9];
const OWN_CLOUD_BREAKUP = 0.35;

let cloudsLive = false;   // true once the real cloud map is showing (so app.js stops the drift)
let auroraPeak = 0;       // strongest forecast value anywhere, 0–100

// The map is built from infrared, which sees cool clear ground (deserts at
// night, high plateaus, cold land in autumn) as a faint, even veil of cloud.
// Real cloud is brighter and broken up, so the clear-ground level is
// estimated as the darkest broad, even level around each spot (a coarse
// grid of local minima, opened and smoothed) and taken away. Towards the
// poles, where the map is patched together from the edges of its sources,
// it's left as it is. Runs in a worker: a 4096×2048 map takes ~0.5 s.
const VEIL_WORKER = `
onmessage = async ({ data: { url, prebuilt } }) => {
    try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(r.status);
        const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        const W = bmp.width, H = bmp.height, cv = new OffscreenCanvas(W, H), cx = cv.getContext('2d');
        cx.drawImage(bmp, 0, 0);
        const rgba = cx.getImageData(0, 0, W, H).data;
        let out;
        if (prebuilt) {
            // Our map is already cover, as grey: just take a channel (rows south to north)
            out = new Uint8Array(W * H);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[(H - 1 - y) * W + x] = rgba[(y * W + x) * 4];
        } else {
            const a = new Uint8Array(W * H);
            for (let i = 0; i < W * H; i++) a[i] = rgba[i * 4 + 3];
            out = removeVeil(a, W, H);
        }
        postMessage({ W, H, out }, [out.buffer]);
    } catch (e) { postMessage({ error: String(e) }); }
};

const RADIUS = 5, CLAMP = 0.85;   // grid cells (1°) for the opening; ground never counts brighter than this
function removeVeil(a, W, H) {
    const GW = 360, GH = 180, cw = W / GW, ch = H / GH, g = new Float32Array(GW * GH);
    // Each 1° cell's darkest quarter-cell average: finds the gaps between clouds
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
        let lo = 255;
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
            const y0 = Math.floor((gy + sy / 4) * ch), y1 = Math.max(y0 + 1, Math.floor((gy + (sy + 1) / 4) * ch));
            const x0 = Math.floor((gx + sx / 4) * cw), x1 = Math.max(x0 + 1, Math.floor((gx + (sx + 1) / 4) * cw));
            let s = 0, n = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += a[y * W + x]; n++; }
            lo = Math.min(lo, s / n);
        }
        g[gy * GW + gx] = lo / 255;
    }
    // Separable filter over the grid, wrapping in longitude: fn folds the
    // neighbours within r cells into a running value that starts at v0
    const filt = (src, fn, v0, r) => {
        const tmp = new Float32Array(GW * GH), dst = new Float32Array(GW * GH);
        for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
            let v = v0, n = 0;
            for (let d = -r; d <= r; d++) { v = fn(v, src[y * GW + (x + d + GW) % GW]); n++; }
            tmp[y * GW + x] = fn === sum ? v / n : v;
        }
        for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
            let v = v0, n = 0;
            for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < GH) { v = fn(v, tmp[yy * GW + x]); n++; } }
            dst[y * GW + x] = fn === sum ? v / n : v;
        }
        return dst;
    };
    const sum = (p, q) => p + q;
    let bg = filt(filt(g, Math.min, 1, RADIUS), Math.max, 0, RADIUS);   // an opening: broad, even areas only
    bg = filt(filt(bg, sum, 0, 2), sum, 0, 2);                             // softened
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        const lat = 90 - (y + 0.5) / ch;
        const keep = Math.min(1, Math.max(0, (Math.abs(lat) - 50) / 15));     // 0 below 50°, 1 by 65°
        const fy = Math.min(GH - 1.001, Math.max(0, (y + 0.5) / ch - 0.5)), y0 = Math.floor(fy), ty = fy - y0;
        for (let x = 0; x < W; x++) {
            const fx = (x + 0.5) / cw - 0.5, x0 = Math.floor(fx), tx = fx - x0;
            const i0 = y0 * GW + (x0 + GW) % GW, i1 = y0 * GW + (x0 + 1) % GW;
            const b = (bg[i0] * (1 - tx) + bg[i1] * tx) * (1 - ty) + (bg[i0 + GW] * (1 - tx) + bg[i1 + GW] * tx) * ty;
            const ground = Math.min(b, CLAMP) * (1 - keep);
            out[(H - 1 - y) * W + x] = Math.round(Math.max(0, a[y * W + x] / 255 - ground) / (1 - ground) * 255);
        }
    }
    return out;
}`;
let veilWorker = null;

// Our own map first (tools/clouds, rebuilt every 30 minutes with the site);
// if it's missing or more than a few hours old, matteason's, cleaned up
function loadLiveClouds() {
    fetch(`${OWN_CLOUDS}clouds.json?v=${Math.floor(Date.now() / 300000)}`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(r.status)))
        .then(meta => {
            if (Date.now() - Date.parse(meta.time) > OWN_CLOUDS_STALE) throw new Error(`map from ${meta.time}`);
            loadCloudMap(`${OWN_CLOUDS}clouds-${COMPACT ? 4096 : 8192}.webp?v=${encodeURIComponent(meta.time)}`, true);
        })
        .catch(e => {
            console.warn('Prebuilt clouds unavailable; using matteason/live-cloud-maps', e);
            loadCloudMap(new URL(`${CLOUDS_URL}?v=${Math.floor(Date.now() / CLOUD_PERIOD_MS)}`, location.href).href, false);
        });
}

function loadCloudMap(url, prebuilt) {
    const show = (t, levels) => {
        t.anisotropy = anisotropy;
        t.wrapS = THREE.RepeatWrapping;
        t.needsUpdate = true;
        const old = cloudMap.value;
        cloudMap.value = t;
        old.dispose();
        cloudsLive = true;
        cloudLevels.value.set(...levels);
        // Ours already has real broken cloud; matteason's flattens thin cloud into a veil
        cloudBreakup.value = prebuilt ? OWN_CLOUD_BREAKUP : 1;
        cloudShift.value = 0;
        // Ours updates every 30 minutes; matteason's every 3 hours (check 20 minutes after it's due)
        const stamp = Math.floor(Date.now() / CLOUD_PERIOD_MS);
        setTimeout(loadLiveClouds, prebuilt ? 30 * 60 * 1000 : (stamp + 1) * CLOUD_PERIOD_MS - Date.now() + 20 * 60 * 1000);
    };
    const fail = e => {
        if (prebuilt) {
            console.warn('Prebuilt clouds failed to load', e);
            return loadCloudMap(new URL(`${CLOUDS_URL}?v=${Math.floor(Date.now() / CLOUD_PERIOD_MS)}`, location.href).href, false);
        }
        plain(e);
    };
    // Without the worker (older browsers): matteason's map as it comes, veil and all
    const plain = e => {
        if (e) console.warn('Cloud clean-up unavailable; using the map as it is', e);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => show(new THREE.Texture(img), [0.36, 0.86]);   // levels that hide most of the veil
        img.onerror = () => {
            console.warn('Live clouds unavailable; using stock clouds');
            setTimeout(loadLiveClouds, 15 * 60 * 1000);
        };
        img.src = url;
    };
    try {
        veilWorker ??= new Worker(URL.createObjectURL(new Blob([VEIL_WORKER], { type: 'text/javascript' })));
    } catch (e) { return fail(e); }
    veilWorker.onmessage = ({ data }) => {
        if (data.error) return fail(data.error);
        const t = new THREE.DataTexture(data.out, data.W, data.H, THREE.AlphaFormat);
        t.magFilter = THREE.LinearFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        show(t, prebuilt ? OWN_CLOUD_LEVELS : [0.2, 0.8]);
    };
    veilWorker.postMessage({ url, prebuilt });
}

// The forecast is a 360×181 grid of [longitude 0–359, latitude −90–90,
// chance of aurora 0–100]. It becomes a texture in the globe's u/v layout.
async function loadAurora() {
    try {
        const res = await fetch(AURORA_URL);
        if (!res.ok) throw new Error(res.status);
        const { coordinates } = await res.json();
        const W = 360, H = 181, data = new Uint8Array(W * H * 4);
        let peak = 0;
        for (const [lon, lat, v] of coordinates) {
            if (Math.abs(lat) < 35) continue;   // the model only covers the auroral zones; ignore stray values
            const i = ((Math.round(lat) + 90) * W + (Math.round(lon) + 180) % 360) * 4;
            // The forecast is a broad probability; easing it in keeps the glow to the core of the oval
            data[i] = data[i + 1] = data[i + 2] = Math.round(255 * Math.min(1, Math.max(0, (v - 4) / 36)) ** 1.5);
            data[i + 3] = 255;
            peak = Math.max(peak, v);
        }
        const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
        t.magFilter = t.minFilter = THREE.LinearFilter;
        t.wrapS = THREE.RepeatWrapping;
        t.needsUpdate = true;
        const old = auroraMap.value;
        auroraMap.value = t;
        old.dispose();
        auroraPeak = peak;
        auroraOn.value = peak >= 5 ? 1 : 0;
        setTimeout(loadAurora, 30 * 60 * 1000);
    } catch (e) {
        console.warn('Aurora forecast unavailable:', e.message || e);
        setTimeout(loadAurora, 10 * 60 * 1000);
    }
}

function startWeather() {
    loadLiveClouds();
    loadAurora();
}
