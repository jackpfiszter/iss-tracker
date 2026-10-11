// ─── TIME MACHINE ────────────────────────────────────────────────────────────
// The whole app runs on clockNow(). Scrubbing or fast-forwarding it moves
// everything computed from orbit data: the ISS, sun, moon, stars, day and
// night, and the pass predictions. Live weather (clouds, aurora) and the live
// camera stay in the present.
//
// ?t=<minutes> starts with the clock shifted, e.g. ?t=30.
//
// This file loads before app.js, so it uses its own byId() rather than $().

const byId = id => document.getElementById(id);

const TIME_RANGE_MIN = { back: -24 * 60, ahead: 3 * 24 * 60 };   // matches the slider
const timeWarp = {
    offset: Number(new URLSearchParams(location.search).get('t') || 0) * 60000,
    rate: 1,            // simulated seconds per real second (0 = paused)
    scrubbing: false,
};
const clockNow = () => new Date(Date.now() + timeWarp.offset);
const isLive   = () => timeWarp.rate === 1 && Math.abs(timeWarp.offset) < 2000;

function describeOffset(ms) {
    const sign = ms < 0 ? '−' : '+', m = Math.round(Math.abs(ms) / 60000);
    if (m < 1)  return 'Live';
    if (m < 60) return `${sign}${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${sign}${h} h ${m % 60} min`;
    return `${sign}${Math.floor(h / 24)} d ${h % 24} h`;
}
const shortOffset = ms => {
    const m = Math.round(Math.abs(ms) / 60000), s = ms < 0 ? '−' : '+';
    return m < 60 ? `${s}${m}m` : m < 1440 ? `${s}${Math.round(m / 60)}h` : `${s}${Math.round(m / 1440)}d`;
};

function setTimeRate(rate) {
    timeWarp.rate = rate;
    renderTimeMachine(true);
}

function backToLive() {
    timeWarp.offset = 0;
    timeWarp.rate = 1;
    renderTimeMachine(true);
    onTimeJump();
}

// After a jump, anything cached against the clock needs recomputing
function onTimeJump() {
    pathAt = dialAt = lastTickAt = 0;
    lastSunlit = null;          // so the jump itself isn't announced as a sunrise or sunset
    placeState.shown = null;
    if (home) refreshPasses();
}

function toggleTimePanel(open = byId('timePanel').hidden) {
    byId('timePanel').hidden = !open;
    byId('clockBtn').setAttribute('aria-expanded', String(open));
    if (open) renderTimeMachine(true);
}

let tmShown = '';
function renderTimeMachine(force) {
    const off = timeWarp.offset, live = isLive();
    const key = `${Math.round(off / 60000)}|${timeWarp.rate}|${live}`;
    if (!force && key === tmShown) return;
    tmShown = key;

    document.body.toggleAttribute('data-warp', !live);
    byId('warpChip').hidden = live;
    byId('warpChip').textContent = timeWarp.rate === 0 ? '❚❚' : timeWarp.rate > 1 ? `${timeWarp.rate}×` : shortOffset(off);
    if (byId('timePanel').hidden) return;

    const now = clockNow();
    byId('timeWhen').textContent = `${fmt.day.format(now)} ${fmt.time.format(now)}`;
    byId('timeDelta').textContent = live ? 'Live' : describeOffset(off);
    byId('timeLive').disabled = live;
    document.querySelectorAll('.tp-speeds button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === timeWarp.rate)));
    if (!timeWarp.scrubbing) byId('timeSlider').value = Math.round(off / 60000);
}

// Each frame: advance the simulated clock and keep the readouts current.
// Uses wall-clock time, not the (capped) frame time, so the speed is right
// even on a slow device.
let tmLastFrame = performance.now();
function updateTimeMachine() {
    const t = performance.now(), real = Math.min(t - tmLastFrame, 1000);
    tmLastFrame = t;
    if (!timeWarp.scrubbing && timeWarp.rate !== 1) {
        timeWarp.offset += (timeWarp.rate - 1) * real;
        const min = TIME_RANGE_MIN.back * 60000, max = TIME_RANGE_MIN.ahead * 60000;
        if (timeWarp.offset > max || timeWarp.offset < min) {
            timeWarp.offset = Math.min(max, Math.max(min, timeWarp.offset));
            timeWarp.rate = 1;
        }
    }
    renderTimeMachine(false);
}

byId('clockBtn').addEventListener('click', () => toggleTimePanel());
byId('timeLive').addEventListener('click', backToLive);
document.querySelectorAll('.tp-speeds button').forEach(b =>
    b.addEventListener('click', () => setTimeRate(Number(b.dataset.rate))));
byId('timeSlider').addEventListener('input', e => {
    timeWarp.scrubbing = true;
    timeWarp.offset = Number(e.target.value) * 60000;
    if (Math.abs(timeWarp.offset) < 3 * 60000) timeWarp.offset = 0;   // snap to now
    renderTimeMachine(true);
});
byId('timeSlider').addEventListener('change', () => {
    timeWarp.scrubbing = false;
    onTimeJump();
});
window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea')) return;
    if (e.key.toLowerCase() === 't') toggleTimePanel();
    if (e.key === 'Escape' && !byId('timePanel').hidden) toggleTimePanel(false);
});
