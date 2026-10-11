// ─── LIVE WEATHER ────────────────────────────────────────────────────────────
// Real cloud cover from the last few hours (EUMETSAT satellite data, made
// into a global map every 3 hours by matteason/live-cloud-maps) and NOAA's
// 30-minute aurora forecast. Both fail quietly: the globe keeps the stock
// clouds and simply shows no aurora.

const CLOUDS_URL = `https://clouds.matteason.co.uk/images/${COMPACT ? '2048x1024' : '4096x2048'}/clouds-alpha.png`;
const AURORA_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const CLOUD_PERIOD_MS = 3 * 3600 * 1000;

let cloudsLive = false;   // true once the real cloud map is showing (so app.js stops the drift)
let auroraPeak = 0;       // strongest forecast value anywhere, 0–100

function loadLiveClouds() {
    // A new URL each 3-hour update, so no cache holds on to an old map
    const stamp = Math.floor(Date.now() / CLOUD_PERIOD_MS);
    new THREE.TextureLoader().load(`${CLOUDS_URL}?v=${stamp}`, t => {
        t.anisotropy = anisotropy;
        t.wrapS = THREE.RepeatWrapping;
        const old = cloudMap.value;
        cloudMap.value = t;
        old.dispose();
        cloudsLive = true;
        cloudLevels.value.set(0.36, 0.86);   // built from infrared, so cool clear ocean reads as a faint veil
        cloudShift.value = 0;
        // Check again 20 minutes after the next update is due
        setTimeout(loadLiveClouds, (stamp + 1) * CLOUD_PERIOD_MS - Date.now() + 20 * 60 * 1000);
    }, undefined, () => {
        console.warn('Live clouds unavailable; using stock clouds');
        setTimeout(loadLiveClouds, 15 * 60 * 1000);
    });
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
