// ─── PLACE NAMES ─────────────────────────────────────────────────────────────
// "Over Japan" / "Over the Pacific Ocean" from Natural Earth country outlines
// (data/countries.geojson, trimmed to names and 3-decimal coordinates).

let countries = null;

async function loadCountries() {
    const r = await fetch('data/countries.geojson');
    if (!r.ok) throw new Error(`countries ${r.status}`);
    countries = (await r.json()).features.map(f => ({
        name:  f.properties.name,
        polys: f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates,
    }));
}

function inRing(ring, lon, lat) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

const NEEDS_THE = /^(United|Dominican|Philippines|Netherlands|Bahamas|Czech|Central African|Dem\.|Solomon|Gambia)/;

// Oceans are rough boxes, which is plenty for a caption
function oceanName(lat, lon) {
    if (lat > 66)  return 'the Arctic Ocean';
    if (lat < -55) return 'the Southern Ocean';
    if (lon >= 20 && lon < 120 && lat < 28) return 'the Indian Ocean';
    if ((lon >= -70 && lon < 20) || (lat > 8 && lon >= -98 && lon < -70)) return 'the Atlantic Ocean';
    return 'the Pacific Ocean';
}

function placeName(lat, lon) {
    if (countries) {
        for (const c of countries) {
            const hit = c.polys.some(p => inRing(p[0], lon, lat) && !p.slice(1).some(h => inRing(h, lon, lat)));
            if (hit) return { name: (NEEDS_THE.test(c.name) ? 'the ' : '') + c.name, land: true };
        }
    }
    return { name: oceanName(lat, lon), land: false };
}
