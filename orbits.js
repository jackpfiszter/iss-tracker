// ─── ORBIT DATA SOURCES ──────────────────────────────────────────────────────
// Two-line elements (TLEs) for the ISS and the other spacecraft. They're
// remembered in the browser and fetched at most every two hours: the
// published elements change only a few times a day, and CelesTrak blocks
// addresses that ask more often than that. A remembered set also means the
// station appears instantly on the next visit.

const TLE_MIN_INTERVAL = 2 * 60 * 60 * 1000;
const TLE_KEY = id => `iss-tracker.tle.${id}`;

const tleLines = text => {
    const lines = text.split('\n').map(l => l.trim());
    return [lines.find(l => l.startsWith('1 ')), lines.find(l => l.startsWith('2 '))];
};
const tleJson = async r => { const { line1, line2 } = await r.json(); return [line1, line2]; };

// Each source is (NORAD id) → fetch options; tried in order
const TLE_FROM = {
    // Amateur Radio on the ISS republishes NASA's own elements, often the newest
    ariss:     id => id === 25544 && ['https://live.ariss.org/iss.txt', r => r.text().then(tleLines)],
    celestrak: id => [`https://celestrak.org/NORAD/elements/gp.php?CATNR=${id}&FORMAT=tle`, r => r.text().then(tleLines)],
    wheretheiss: id => id === 25544 && ['https://api.wheretheiss.at/v1/satellites/25544/tles', tleJson],
    tleapi:    id => [`https://tle.ivanstanojevic.me/api/tle/${id}`, tleJson],
};

// Hours since the elements were measured
const tleEpochAgeH = line1 => {
    const yy = +line1.slice(18, 20), day = +line1.slice(20, 32);
    return (Date.now() - Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) - (day - 1) * 86400000) / 3600000;
};

function rememberedTle(id) {
    try { return JSON.parse(localStorage.getItem(TLE_KEY(id))); } catch { return null; }
}

// The freshest usable elements: the remembered ones if checked recently,
// otherwise from the sources in order, stopping once one is under a day old.
// Resolves to { lines, fetchedAt }, or rejects if nothing at all is available.
async function getTle(id, sources) {
    const kept = rememberedTle(id);
    if (kept && Date.now() - kept.fetchedAt < TLE_MIN_INTERVAL) return kept;
    let best = null;
    for (const name of sources) {
        const how = TLE_FROM[name](id);
        if (!how) continue;
        try {
            const r = await fetch(how[0]);
            if (!r.ok) throw new Error(`${name} ${r.status}`);
            const lines = await how[1](r);
            if (!lines[0] || !lines[1] || satellite.twoline2satrec(...lines).error) throw new Error(`${name}: unusable`);
            if (!best || tleEpochAgeH(lines[0]) < tleEpochAgeH(best[0])) best = lines;
            if (tleEpochAgeH(best[0]) < 24) break;
        } catch (e) {
            console.warn(`Orbit data for ${id}:`, e.message || e);
        }
    }
    if (best && kept && tleEpochAgeH(kept.lines[0]) < tleEpochAgeH(best[0])) best = kept.lines;   // never go backwards
    if (!best) {
        if (kept) return { ...kept, failed: true };
        throw new Error('no orbit data');
    }
    const entry = { lines: best, fetchedAt: Date.now() };
    try { localStorage.setItem(TLE_KEY(id), JSON.stringify(entry)); } catch { /* storage unavailable */ }
    return entry;
}

// When to look again: two hours after the last check, or in ten minutes if
// every source just failed
const tleNextCheck = entry => entry.failed ? 10 * 60 * 1000 : Math.max(60 * 1000, entry.fetchedAt + TLE_MIN_INTERVAL - Date.now());
