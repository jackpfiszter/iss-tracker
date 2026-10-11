// ─── CREW ────────────────────────────────────────────────────────────────────
// Who's aboard right now, from a community-maintained list
// (corquaid/international-space-station-APIs), plus everyone else in space.

const CREW_URL = 'https://corquaid.github.io/international-space-station-APIs/JSON/people-in-space.json';
let crewData = null;

// Wikimedia serves resized copies (at standard widths only, like 120 px);
// the originals can be several MB
function thumbUrl(url, px = 120) {
    const m = /^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)$/.exec(url || '');
    return m ? `${m[1]}/thumb/${m[2]}/${m[3]}/${m[4]}/${px}px-${m[4]}` : url;
}

const daysUp = launched => Math.max(1, Math.floor((Date.now() / 1000 - launched) / 86400));

function personRow(p) {
    const a = document.createElement('a');
    a.className = 'person';
    a.href = p.url || '#';
    a.target = '_blank';
    a.rel = 'noopener';
    const initials = p.name.split(' ').map(w => w[0]).slice(0, 2).join('');
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = thumbUrl(p.image);
    img.onerror = () => { const ph = document.createElement('span'); ph.className = 'ph'; ph.textContent = initials; img.replaceWith(ph); };
    const text = document.createElement('div');
    const name = document.createElement('b'), role = document.createElement('span');
    name.textContent = p.name;
    role.textContent = `${p.position === 'Commander' ? 'Commander · ' : ''}${p.agency} · day ${daysUp(p.launched)}`;
    a.title = `${p.name}, ${p.position} (${p.agency}), ${daysUp(p.launched)} days in space on this mission`;
    text.append(name, role);
    a.append(img, text);
    return a;
}

function renderCrew() {
    if (!crewData) return;
    const people = crewData.people || [];
    const aboard = people.filter(p => p.iss);
    const elsewhere = people.filter(p => !p.iss);
    const head = document.createElement('p');
    head.className = 'crew-head';
    head.innerHTML = `<b>${aboard.length} people</b> aboard the ISS${crewData.iss_expedition ? ` · Expedition ${crewData.iss_expedition}` : ''}`;
    const list = document.createElement('div');
    list.className = 'crew-list';
    list.append(...aboard.map(personRow));
    const also = document.createElement('p');
    also.className = 'crew-also';
    also.id = 'crewAlso';
    byId('crew').replaceChildren(head, list, also);
    byId('crewCount').textContent = aboard.length;
    byId('crewCount').hidden = !aboard.length;
    updateCrewAlso(elsewhere);
}

// The line about everyone else, with how far away Tiangong is right now
function updateCrewAlso(elsewhere = (crewData?.people || []).filter(p => !p.iss)) {
    const el = byId('crewAlso');
    if (!el) return;
    const total = (crewData?.people || []).length;
    const onTiangong = elsewhere.filter(p => /shenzhou|tiangong/i.test(p.spacecraft));
    const others = elsewhere.filter(p => !onTiangong.includes(p));
    const where = [
        onTiangong.length && `${onTiangong.length} on China’s Tiangong station`,
        others.length && `${others.length} on ${[...new Set(others.map(p => p.spacecraft))].join(', ')}`,
    ].filter(Boolean).join(' and ');
    const tiangong = SPACECRAFT[0];
    const dist = tiangong.state && live.p ? ` Tiangong is <b>${fmt.int.format(craftDistance(live.p, tiangong.p))} km</b> from the ISS right now.` : '';
    el.innerHTML = (elsewhere.length ? `<b>${total} people</b> are in space today, including ${where}.` : '') + dist;
}

async function loadCrew() {
    try {
        const r = await fetch(CREW_URL);
        if (!r.ok) throw new Error(r.status);
        crewData = await r.json();
        renderCrew();
        setTimeout(loadCrew, 6 * 3600 * 1000);
    } catch (e) {
        console.warn('Crew list unavailable:', e.message || e);
        byId('crew').innerHTML = '<p class="note">Couldn’t load the crew list. Trying again shortly…</p>';
        setTimeout(loadCrew, 5 * 60 * 1000);
    }
}
loadCrew();
setInterval(() => updateCrewAlso(), 5000);
