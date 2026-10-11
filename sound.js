// ─── AMBIENT SOUND ───────────────────────────────────────────────────────────
// An optional, quiet soundscape made in the browser (no audio files): a slow
// drone that's warmer in sunlight and darker in Earth's shadow, a faint hiss
// of station air, and a soft chime at each orbital sunrise and sunset.
// Off by default; the speaker button or M turns it on.

const CHORDS = {
    day:   [110.00, 138.59, 164.81, 220.00],   // A major
    night: [98.00, 116.54, 146.83, 196.00],    // G minor
};
const sound = { ctx: null, on: false, master: null, filter: null, oscs: [], echo: null, sunlit: null };

function buildSound() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // A soft echo, so chimes ring out into space
    const echo = ctx.createDelay(1);
    echo.delayTime.value = 0.42;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2200;
    echo.connect(tone).connect(feedback).connect(echo);
    tone.connect(master);

    // Drone: each chord note on two slightly detuned oscillators, through a
    // slowly breathing low-pass filter
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    filter.Q.value = 0.8;
    filter.connect(master);
    const lfo = ctx.createOscillator(), lfoDepth = ctx.createGain();
    lfo.frequency.value = 0.045;
    lfoDepth.gain.value = 180;
    lfo.connect(lfoDepth).connect(filter.frequency);
    lfo.start();

    const oscs = [];
    CHORDS.day.forEach((f, i) => {
        for (const detune of [-5, 5]) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = i === 0 ? 'sine' : 'triangle';
            o.frequency.value = f;
            o.detune.value = detune;
            g.gain.value = i === 0 ? 0.09 : 0.035;
            o.connect(g).connect(filter);
            o.start();
            oscs.push({ o, i });
        }
    });

    // Air: looping noise through a wide band-pass
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const air = ctx.createBufferSource();
    air.buffer = noise;
    air.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 320;
    band.Q.value = 0.6;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.02;
    air.connect(band).connect(airGain).connect(master);
    air.start();

    Object.assign(sound, { ctx, master, filter, oscs, echo });
}

function setChord(sunlit) {
    const t = sound.ctx.currentTime, notes = sunlit ? CHORDS.day : CHORDS.night;
    for (const { o, i } of sound.oscs) o.frequency.setTargetAtTime(notes[i], t, 2.5);
    sound.filter.frequency.setTargetAtTime(sunlit ? 900 : 480, t, 3);
}

// Rising notes at sunrise, falling at sunset
function chime(sunrise) {
    const ctx = sound.ctx, t0 = ctx.currentTime + 0.05;
    const notes = sunrise ? [880, 1318.5, 1760] : [1318.5, 987.77, 659.25];
    notes.forEach((f, k) => {
        const o = ctx.createOscillator(), g = ctx.createGain(), t = t0 + k * 0.22;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.07, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 3);
        o.connect(g);
        g.connect(sound.master);
        g.connect(sound.echo);
        o.start(t);
        o.stop(t + 3.1);
    });
}

function setSound(on) {
    sound.on = on;
    byId('soundBtn').setAttribute('aria-pressed', String(on));
    if (on && !sound.ctx) buildSound();
    if (!sound.ctx) return;
    const t = sound.ctx.currentTime;
    if (on) {
        sound.ctx.resume();
        sound.sunlit = null;   // pick the chord on the next frame
        sound.master.gain.setTargetAtTime(0.55, t, 1.2);
    } else {
        sound.master.gain.setTargetAtTime(0, t, 0.4);
        setTimeout(() => { if (!sound.on) sound.ctx.suspend(); }, 2000);
    }
}

function updateSound(live) {
    if (!sound.on || !sound.ctx) return;
    if (live.sunlit !== sound.sunlit) {
        // Chime on a real change, not on switching on, and not while fast-forwarding
        if (sound.sunlit !== null && timeWarp.rate <= 60) chime(live.sunlit);
        sound.sunlit = live.sunlit;
        setChord(live.sunlit);
    }
}

byId('soundBtn').addEventListener('click', () => setSound(!sound.on));
window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea')) return;
    if (e.key.toLowerCase() === 'm') setSound(!sound.on);
});
