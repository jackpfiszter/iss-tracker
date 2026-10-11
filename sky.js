// ─── SKY ─────────────────────────────────────────────────────────────────────
// The real night sky: the 8,400 stars of the Yale Bright Star Catalogue (to
// magnitude 6.5, about what the eye can see), the Milky Way along the actual
// galactic plane, the sun, and the moon in its true place and phase.
// The sky group follows the camera so it never clips. Inside it, `celestial`
// holds everything fixed to the stars and turns with sidereal time, because
// the rest of the scene is fixed to the Earth.

const sky = new THREE.Group();
scene.add(sky);
const celestial = new THREE.Group();
sky.add(celestial);
const skyPixelRatio = { value: renderer.getPixelRatio() };
// Like a camera's exposure: up close over the sunlit Earth, the faint sky fades
const skyGain = { value: 1 };

// Positions in `celestial` use latLonToVector3(declination, right ascension)
const GAL_POLE   = latLonToVector3(27.13, 192.86, 1);
const GAL_CENTRE = latLonToVector3(-28.94, 266.40, 1);

// ─── MILKY WAY ───────────────────────────────────────────────────────────────
// Procedural: a band along the galactic plane, brighter and warmer towards
// the centre in Sagittarius, broken up by dust lanes. It never changes, so
// the noise is baked once into an equirectangular texture at load rather
// than run for every background pixel each frame.
const MILKY_WAY_GAIN = 25;    // stored brighter so 8-bit texels don't band
function bakeMilkyWay() {
    const target = new THREE.WebGLRenderTarget(2048, 1024, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms: { pole: { value: GAL_POLE }, centre: { value: GAL_CENTRE } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: `
            #define PI 3.14159265
            uniform vec3 pole, centre;
            varying vec2 vUv;
            float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
            float noise(vec3 x) {
                vec3 i = floor(x), f = fract(x);
                f = f * f * (3.0 - 2.0 * f);
                return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
                           mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
            }
            float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
            void main() {
                // Same layout as SphereGeometry's UVs (and latLonToVector3)
                float phi = (1.0 - vUv.y) * PI, theta = vUv.x * 2.0 * PI;
                vec3 d  = vec3(-sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
                float b = asin(clamp(dot(d, pole), -1.0, 1.0));            // galactic latitude
                float l = atan(dot(d, cross(pole, centre)), dot(d, centre)); // galactic longitude, 0 at the centre
                float n = fbm(d * 6.0);
                float band  = exp(-pow(b / (0.1 + 0.07 * n), 2.0)) * (0.3 + 0.7 * exp(-pow(l / 1.3, 2.0)));
                float bulge = exp(-(l * l / 0.16 + b * b / 0.025));
                float dust  = 1.0 - 0.8 * smoothstep(0.4, 0.75, fbm(d * 14.0 + 3.0)) * exp(-pow(b / 0.06, 2.0)) * exp(-pow(l / 1.8, 2.0));
                float clump = 0.6 + 0.8 * fbm(d * 30.0);
                vec3 col = (vec3(0.55, 0.62, 0.85) * band + vec3(1.0, 0.8, 0.58) * bulge) * dust * clump;
                gl_FragColor = vec4(col * 0.02 * ${MILKY_WAY_GAIN.toFixed(1)}, 1.0);
            }`,
        depthTest: false, depthWrite: false,
    }));
    quad.frustumCulled = false;
    const bakeScene = new THREE.Scene();
    bakeScene.add(quad);
    renderer.setRenderTarget(target);
    renderer.render(bakeScene, new THREE.Camera());
    renderer.setRenderTarget(null);
    quad.geometry.dispose();
    quad.material.dispose();
    return target.texture;
}

const milkyWay = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS * 0.97, 64, 32), new THREE.ShaderMaterial({
    uniforms: { map: { value: bakeMilkyWay() }, gain: skyGain },
    vertexShader: `varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
        uniform sampler2D map; uniform float gain;
        varying vec2 vUv;
        void main() {
            gl_FragColor = vec4(texture2D(map, vUv).rgb * gain / ${MILKY_WAY_GAIN.toFixed(1)}, 1.0);
            #include <tonemapping_fragment>
            #include <encodings_fragment>
        }`,
    side: THREE.BackSide, depthTest: false, depthWrite: false,
}));
milkyWay.renderOrder = -3;
celestial.add(milkyWay);

// ─── STARS ───────────────────────────────────────────────────────────────────
// data/stars.json is flat [ra°, dec°, magnitude, B−V colour index, …]
function starTint(bv) {
    const stops = [[-0.4, 0.62, 0.72, 1.0], [0.0, 0.85, 0.9, 1.0], [0.4, 1.0, 0.97, 0.92],
                   [0.8, 1.0, 0.88, 0.72], [1.2, 1.0, 0.78, 0.55], [2.0, 1.0, 0.62, 0.38]];
    bv = Math.min(2, Math.max(-0.4, bv));
    let i = 0;
    while (bv > stops[i + 1][0]) i++;
    const [a, b] = [stops[i], stops[i + 1]], k = (bv - a[0]) / (b[0] - a[0]);
    return [1, 2, 3].map(j => a[j] + (b[j] - a[j]) * k);
}

async function loadStars() {
    const data = await (await fetch('data/stars.json')).json();
    const n = data.length / 4;
    const pos = new Float32Array(n * 3), tint = new Float32Array(n * 3), size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const [ra, dec, mag, bv] = data.slice(i * 4, i * 4 + 4);
        const v = latLonToVector3(dec, ra, SKY_RADIUS * 0.95);
        pos.set([v.x, v.y, v.z], i * 3);
        // Compress the brightness range a little so faint stars still show
        const I = Math.min(0.05 * Math.pow(10, -0.3 * (mag - 6)), 4);
        tint.set(starTint(bv).map(c => c * I), i * 3);
        size[i] = Math.min(4.5, Math.max(1.6, 1.6 + (5 - mag) * 0.45));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    const stars = new THREE.Points(geo, new THREE.ShaderMaterial({
        uniforms: { pixelRatio: skyPixelRatio, gain: skyGain },
        vertexShader: `
            uniform float pixelRatio;
            attribute vec3 tint; attribute float size;
            varying vec3 vTint;
            void main() {
                vTint = tint;
                gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = size * pixelRatio;
            }`,
        fragmentShader: `
            uniform float gain;
            varying vec3 vTint;
            void main() {
                vec2 q = gl_PointCoord - 0.5;
                gl_FragColor = vec4(vTint * gain * exp(-dot(q, q) * 18.0), 1.0);
                #include <tonemapping_fragment>
                #include <encodings_fragment>
            }`,
        blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    }));
    stars.renderOrder = -2;
    stars.frustumCulled = false;
    celestial.add(stars);
}
loadStars().catch(e => console.warn('Stars unavailable:', e));

// ─── SUN ─────────────────────────────────────────────────────────────────────
// A small, very bright core; the bloom pass turns it into glare. Drawn before
// the Earth without depth, so the Earth simply paints over it.
const sunGeo = new THREE.BufferGeometry();
sunGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
const sunGlow = new THREE.Points(sunGeo, new THREE.PointsMaterial({
    map: GLOW, color: srgb(0xfff1d6).multiplyScalar(post ? 10 : 1), size: post ? 46 : 150, sizeAttenuation: false,
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
}));
sunGlow.renderOrder = -1;
sunGlow.frustumCulled = false;
sky.add(sunGlow);

// ─── MOON ────────────────────────────────────────────────────────────────────
// True angular size (0.52°). Lit by the sun, so the phase comes out right.
const MOON_DIST = SKY_RADIUS * 0.9;
const moonMap = texture(TEXTURE_CDN + 'moon_1024.jpg', pixel(150, 150, 150), false, new THREE.TextureLoader());
const moon = new THREE.Mesh(new THREE.SphereGeometry(MOON_DIST * Math.tan(0.26 * DEG), 48, 24), new THREE.ShaderMaterial({
    uniforms: { map: moonMap, sunDir: { value: sunDir } },
    vertexShader: WORLD_VERT,
    fragmentShader: `
        uniform sampler2D map; uniform vec3 sunDir;
        varying vec2 vUv; varying vec3 vN;
        void main() {
            vec3 albedo = pow(texture2D(map, vUv).rgb, vec3(2.2));
            float lit = max(dot(normalize(vN), sunDir), 0.0);
            gl_FragColor = vec4(albedo * (lit * 2.4 + 0.006), 1.0);   // the dark limb faintly earthlit
            #include <tonemapping_fragment>
            #include <encodings_fragment>
        }`,
    depthTest: false, depthWrite: false,
}));
moon.renderOrder = -1;
sky.add(moon);

// ─── EACH FRAME ──────────────────────────────────────────────────────────────
const X_AXIS = new THREE.Vector3(1, 0, 0);
function updateSky(now) {
    const dayView = closeUp.value * THREE.MathUtils.smoothstep(camera.position.clone().normalize().dot(sunDir), -0.1, 0.4);
    skyGain.value += (1 - 0.75 * dayView - skyGain.value) * 0.05;

    const ss = subsolarPoint(now);
    sunDir.copy(latLonToVector3(ss.lat, ss.lon, 1));
    sunGeo.attributes.position.setXYZ(0, sunDir.x * SKY_RADIUS * 0.9, sunDir.y * SKY_RADIUS * 0.9, sunDir.z * SKY_RADIUS * 0.9);
    sunGeo.attributes.position.needsUpdate = true;

    // Stars sit at their inertial positions; turning by -GMST puts them over
    // the right longitudes
    celestial.rotation.y = -satellite.gstime(now);

    const m = subPoint(moonDirectionEci(now), now);
    moonDir.copy(latLonToVector3(m.lat, m.lon, 1));
    moon.position.copy(moonDir).multiplyScalar(MOON_DIST);
    moon.quaternion.setFromUnitVectors(X_AXIS, moonDir.clone().negate());   // near side towards Earth
    moonLight.value = (1 - sunDir.dot(moonDir)) / 2;
}
