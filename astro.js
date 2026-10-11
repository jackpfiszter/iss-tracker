// ─── ORBITAL & SOLAR MATH ────────────────────────────────────────────────────
// Pure functions on top of satellite.js (global `satellite`).
// Angles are degrees and distances km unless a name says otherwise.

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

const wrapLon = lon => ((lon % 360) + 540) % 360 - 180;

// ─── SUN ─────────────────────────────────────────────────────────────────────
// Low-precision solar position (Astronomical Almanac), good to ~0.01°
function sunDirectionEci(date) {
    const n      = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const L      = (280.460 + 0.9856474 * n) * DEG;
    const g      = (357.528 + 0.9856003 * n) * DEG;
    const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    const eps    = (23.439 - 0.0000004 * n) * DEG;
    return {
        x: Math.cos(lambda),
        y: Math.cos(eps) * Math.sin(lambda),
        z: Math.sin(eps) * Math.sin(lambda),
    };
}

// Point on Earth with the sun directly overhead
function subsolarPoint(date) {
    return subPoint(sunDirectionEci(date), date);
}

// Sun's elevation above an observer's horizon (ignores refraction)
function sunElevation(observer, date) {
    const ss   = subsolarPoint(date);
    const cosZ = Math.sin(observer.lat * DEG) * Math.sin(ss.lat * DEG) +
                 Math.cos(observer.lat * DEG) * Math.cos(ss.lat * DEG) * Math.cos((observer.lon - ss.lon) * DEG);
    return 90 - Math.acos(Math.min(1, Math.max(-1, cosZ))) / DEG;
}

// ─── MOON ────────────────────────────────────────────────────────────────────
// Low-precision lunar position (Astronomical Almanac), good to ~0.3°.
// Returns a unit vector in the same inertial frame as sunDirectionEci.
function moonDirectionEci(date) {
    const T   = (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525;
    const s   = (a, b) => Math.sin((a + b * T) * DEG);
    const lam = (218.32 + 481267.881 * T + 6.29 * s(135.0, 477198.87) - 1.27 * s(259.3, -413335.36) +
                 0.66 * s(235.7, 890534.22) + 0.21 * s(269.9, 954397.74) - 0.19 * s(357.5, 35999.05) -
                 0.11 * s(186.5, 966404.03)) * DEG;
    const bet = (5.13 * s(93.3, 483202.02) + 0.28 * s(228.2, 960400.89) -
                 0.28 * s(318.3, 6003.15) - 0.17 * s(217.6, -407332.21)) * DEG;
    const eps = (23.439 - 0.0130 * T) * DEG;
    const x = Math.cos(bet) * Math.cos(lam);
    const y = Math.cos(bet) * Math.sin(lam);
    const z = Math.sin(bet);
    return { x, y: Math.cos(eps) * y - Math.sin(eps) * z, z: Math.sin(eps) * y + Math.cos(eps) * z };
}

// Point on Earth directly below an inertial direction (sun, moon, star)
function subPoint(dir, date) {
    return {
        lat: Math.asin(dir.z) / DEG,
        lon: wrapLon((Math.atan2(dir.y, dir.x) - satellite.gstime(date)) / DEG),
    };
}

// Cylindrical Earth shadow — accurate enough at the ISS's altitude
function isSunlit(posEci, sun) {
    const d = posEci.x * sun.x + posEci.y * sun.y + posEci.z * sun.z;
    if (d > 0) return true;
    return Math.hypot(posEci.x - d * sun.x, posEci.y - d * sun.y, posEci.z - d * sun.z) > EARTH_RADIUS_KM;
}

// ─── SATELLITE ───────────────────────────────────────────────────────────────
function issState(satrec, date) {
    const pv = satellite.propagate(satrec, date);
    if (!pv.position) return null;
    const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
    const v   = pv.velocity;
    return {
        lat:      geo.latitude / DEG,
        lon:      wrapLon(geo.longitude / DEG),
        alt:      geo.height,
        velocity: Math.hypot(v.x, v.y, v.z) * 3600,   // km/h
        sunlit:   isSunlit(pv.position, sunDirectionEci(date)),
    };
}

// Azimuth (0° = north, clockwise), elevation and slant range as seen by an observer
function lookAngles(satrec, observer, date) {
    const pv = satellite.propagate(satrec, date);
    if (!pv.position) return null;
    const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
    const la  = satellite.ecfToLookAngles(
        { latitude: observer.lat * DEG, longitude: observer.lon * DEG, height: 0 }, ecf);
    return { azimuth: la.azimuth / DEG, elevation: la.elevation / DEG, range: la.rangeSat, eci: pv.position };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = az => COMPASS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];

// ─── VISIBLE PASSES ──────────────────────────────────────────────────────────
// A pass is only worth looking up for when, at the same moment, the ISS is
// above 10°, still in sunlight, and the observer's sky is dark (sun below -6°).
const PASS_MIN_ELEVATION = 10;
const PASS_MAX_SUN_ELEV  = -6;
const PASS_STEP_MS       = 20 * 1000;

function findVisiblePasses(satrec, observer, from, { days = 7, max = 4 } = {}) {
    const passes = [];
    const end    = from.getTime() + days * 86400000;
    let pass     = null;

    for (let t = from.getTime(); t < end && passes.length < max; t += PASS_STEP_MS) {
        const date = new Date(t);
        const la   = lookAngles(satrec, observer, date);
        if (!la) break;

        const visible = la.elevation >= PASS_MIN_ELEVATION &&
                        sunElevation(observer, date) <= PASS_MAX_SUN_ELEV &&
                        isSunlit(la.eci, sunDirectionEci(date));

        if (visible) {
            if (!pass) pass = { start: date, startAz: la.azimuth, maxElevation: -90 };
            pass.end   = date;
            pass.endAz = la.azimuth;
            if (la.elevation > pass.maxElevation) {
                pass.maxElevation = la.elevation;
                pass.maxAz        = la.azimuth;
            }
        } else if (pass) {
            passes.push(pass);
            pass = null;
        }
    }
    if (pass) passes.push(pass);
    return passes;
}

if (typeof module !== 'undefined') {
    module.exports = { sunDirectionEci, moonDirectionEci, subPoint, subsolarPoint, sunElevation, isSunlit, issState, lookAngles, compass, findVisiblePasses };
}
