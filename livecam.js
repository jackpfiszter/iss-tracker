// ─── LIVE CAMERA ─────────────────────────────────────────────────────────────
// NASA's live streams from the ISS, embedded from YouTube. The player is only
// created while the Live tab is showing, so nothing streams in the background.
// The note under it uses what the globe knows: if the ISS is in Earth's
// shadow, the camera is looking at a dark planet.

const LIVE_CAMS = {
    earth:   { id: 'awQzjn72bI0', about: 'An external camera looking down at Earth.' },
    station: { id: 'M3HKLzjvKPc', about: 'NASA’s main ISS feed: views outside and, when the crew is on duty, inside.' },
};
let liveCam = 'earth', camShown = null;

function camVisible() {
    const pane = document.querySelector('[data-pane="live"]');
    return !pane.hidden && !document.hidden && (!PHONE.matches || sheet.dataset.state === 'open');
}

function syncLiveCam() {
    const want = camVisible() ? liveCam : null;
    if (want === camShown) return;
    camShown = want;
    const box = byId('camVideo');
    if (!want) { box.replaceChildren(); return; }
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${LIVE_CAMS[want].id}?autoplay=1&mute=1&playsinline=1&rel=0`;
    iframe.title = 'Live video from the International Space Station';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    box.replaceChildren(iframe);
    byId('camLink').href = `https://www.youtube.com/watch?v=${LIVE_CAMS[want].id}`;
    updateCamNote();
}

function updateCamNote() {
    if (!camShown || !live.p) return;
    const cam = LIVE_CAMS[liveCam];
    let note;
    if (!isLive()) {
        note = 'The video is live, so it shows the station <b>right now</b>, not the time you’ve travelled to.';
    } else if (!live.sunlit) {
        const next = live.period && nextLightChange(updateDial(clockNow()));
        const mins = next ? Math.max(1, Math.round(next.ms / 60000)) : null;
        note = `The ISS is in Earth’s shadow${mins ? ` for another <b>${mins} min</b>` : ''}, so the view is mostly dark. Look for city lights and lightning.`;
    } else {
        note = `Over <b>${placeState.shown ?? 'Earth'}</b> in daylight right now. ${cam.about}`;
    }
    byId('camNote').innerHTML = note + ' The feed drops out now and then, between relay satellites.';
}

document.querySelectorAll('.cam-sources button').forEach(b => b.addEventListener('click', () => {
    liveCam = b.dataset.cam;
    document.querySelectorAll('.cam-sources button').forEach(o => o.setAttribute('aria-pressed', String(o === b)));
    camShown = null;
    syncLiveCam();
}));
new MutationObserver(syncLiveCam).observe(document.querySelector('[data-pane="live"]'), { attributes: true, attributeFilter: ['hidden'] });
new MutationObserver(syncLiveCam).observe(document.getElementById('sheet'), { attributes: true, attributeFilter: ['data-state'] });
document.addEventListener('visibilitychange', syncLiveCam);
setInterval(updateCamNote, 3000);
