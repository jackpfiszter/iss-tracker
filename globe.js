// ─── GLOBE SCENE ─────────────────────────────────────────────────────────────
// Everything that gets drawn: Earth, clouds, aurora, atmosphere, the ISS
// model, orbit paths and the home marker (the sky lives in sky.js). The Earth
// stays fixed in world space (earth-fixed frame) and app.js moves the camera.
//
// Lighting is done in linear light with real-ish units, then bloom, exposure
// and ACES tone mapping run as a final pass, so bright things (sun, glint,
// city lights, aurora) can glow without washing out everything else.

const R          = 5;      // globe radius in scene units (1 unit ≈ 1274 km)
const SKY_RADIUS = 40;     // star shell, kept centred on the camera
const EXPOSURE   = 1.35;

function latLonToVector3(lat, lon, radius) {
    const phi   = (90 - lat) * DEG;
    const theta = (lon + 180) * DEG;
    return new THREE.Vector3(
        -radius * Math.sin(phi) * Math.cos(theta),
         radius * Math.cos(phi),
         radius * Math.sin(phi) * Math.sin(theta)
    );
}
const altToRadius = alt => R * (1 + alt / EARTH_RADIUS_KM);
const srgb = hex => new THREE.Color(hex).convertSRGBToLinear();

// ─── QUALITY ─────────────────────────────────────────────────────────────────
// Phones start one tier down; app.js steps down further if frames run slow.
// ?q=low|medium|high pins a tier.
const QUALITY_TIERS = [
    { name: 'low',    pixelRatio: 1,    bloom: false, bloomScale: 0.5, steps: 5  },
    { name: 'medium', pixelRatio: 1.5,  bloom: true,  bloomScale: 0.5, steps: 8  },
    { name: 'high',   pixelRatio: 2,    bloom: true,  bloomScale: 1,   steps: 12 },
];
const COMPACT       = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
const PINNED_TIER   = QUALITY_TIERS.findIndex(q => q.name === new URLSearchParams(location.search).get('q'));
let qualityTier     = PINNED_TIER >= 0 ? PINNED_TIER : COMPACT ? 1 : 2;
let quality         = QUALITY_TIERS[qualityTier];

// ─── RENDERER ────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
document.getElementById('globe').appendChild(renderer.domElement);

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(10, 1, 0.5, 300);
const sunDir = new THREE.Vector3(1, 0, 0);
const moonDir = new THREE.Vector3(-1, 0, 0);

// Scene → HDR multisampled target → bloom → exposure + ACES + sRGB. Needs
// WebGL2 with float render targets and the post-processing scripts; without
// them the renderer tone-maps each material directly and skips the bloom.
const post = (() => {
    const caps = renderer.capabilities;
    const floatTargets = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    if (!caps.isWebGL2 || !floatTargets || !THREE.UnrealBloomPass || !THREE.FullScreenQuad) return null;
    const target = new THREE.WebGLMultisampleRenderTarget(1, 1, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
    });
    target.samples = 4;
    // Some GPUs advertise float targets but can't multisample them: check
    // the buffer actually works before relying on it
    const gl = renderer.getContext();
    renderer.setRenderTarget(target);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    renderer.setRenderTarget(null);
    if (!complete) { target.dispose(); return null; }
    const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.4, 1.0);
    // Its blur buffers default to 8 bits, which steps visibly in faint glow
    for (const rt of [bloom.renderTargetBright, ...bloom.renderTargetsHorizontal, ...bloom.renderTargetsVertical]) rt.texture.type = THREE.HalfFloatType;
    const output = new THREE.FullScreenQuad(new THREE.ShaderMaterial({
        uniforms: { tScene: { value: target.texture }, exposure: { value: EXPOSURE }, time: { value: 0 }, motion: { value: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1 },
            sunUv: { value: new THREE.Vector2() }, sunAmt: { value: 0 }, burst: { value: 1 }, aspect: { value: 1 } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: `
            uniform sampler2D tScene; uniform float exposure, time, motion; varying vec2 vUv;
            uniform vec2 sunUv; uniform float sunAmt, burst, aspect;

            // Lens flare, added in HDR before tone mapping so it sits in the image
            // like a real camera's: a starburst from the aperture blades, a soft
            // glow and streak, and faint ghosts mirrored through the frame centre
            vec3 ghost(vec2 uv, vec2 c, float r, vec3 tint) {
                float d = length((uv - c) * vec2(aspect, 1.0));
                return tint * smoothstep(r, r * 0.7, d) * (0.45 + 0.55 * smoothstep(r * 0.3, r * 0.95, d));
            }
            vec3 lensFlare(vec2 uv) {
                vec2 d  = (uv - sunUv) * vec2(aspect, 1.0);
                float r = length(d), a = atan(d.y, d.x);
                float rays = pow(abs(cos(a * 3.0)), 320.0) + 0.4 * pow(abs(cos(a * 3.0 + 1.5708)), 500.0);
                vec3 col = vec3(1.0, 0.96, 0.9) * rays * exp(-r * 14.0) * 0.35 * burst;
                col += vec3(1.0, 0.9, 0.75) * exp(-r * 22.0) * 0.3;
                col += vec3(0.65, 0.78, 1.0) * exp(-abs(d.y) * 300.0) * exp(-abs(d.x) * 2.8) * 0.12 * burst;
                vec2 axis = vec2(0.5) - sunUv;
                col += ghost(uv, sunUv + axis * 0.6,  0.03,  vec3(0.4, 0.65, 1.0)) * 0.08;
                col += ghost(uv, sunUv + axis * 1.3,  0.07,  vec3(0.5, 1.0, 0.7))  * 0.035;
                col += ghost(uv, sunUv + axis * 1.65, 0.018, vec3(1.0, 0.65, 0.4)) * 0.1;
                col += ghost(uv, sunUv + axis * 2.15, 0.11,  vec3(0.75, 0.55, 1.0)) * 0.022;
                // A faint rainbow ring
                col += vec3(exp(-pow((r - 0.27) / 0.012, 2.0)), exp(-pow((r - 0.28) / 0.012, 2.0)), exp(-pow((r - 0.29) / 0.012, 2.0))) * 0.02;
                return col * sunAmt;
            }
            vec3 rrtOdt(vec3 v) {
                vec3 a = v * (v + 0.0245786) - 0.000090537;
                vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
                return a / b;
            }
            vec3 aces(vec3 c) {
                const mat3 IN  = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
                const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
                return clamp(OUT * rrtOdt(IN * (c * exposure / 0.6)), 0.0, 1.0);
            }
            float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
            void main() {
                // A lens: colours fringe slightly towards the edges, and the corners fall off
                vec2 off = (vUv - 0.5) * dot(vUv - 0.5, vUv - 0.5) * 0.006;
                vec3 hdr = vec3(texture2D(tScene, vUv + off).r, texture2D(tScene, vUv).g, texture2D(tScene, vUv - off).b);
                if (sunAmt > 0.001) hdr += lensFlare(vUv);
                hdr *= mix(1.0, 0.8, smoothstep(0.4, 1.0, length(vUv - 0.5) * 1.3));
                vec3 c = aces(hdr);
                // Grade: ACES mutes colour, so give it back, then a gentle S-curve
                c = max(mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 1.08), 0.0);
                c = mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
                c = mix(c, c * c * (3.0 - 2.0 * c), 0.12);
                // Faint film grain, strongest in the mid-tones, which also stops dark gradients banding
                float luma = dot(c, vec3(0.299, 0.587, 0.114));
                c += (hash(gl_FragCoord.xy + fract(time) * 517.0 * motion) - 0.5) * (0.012 + 0.03 * luma * (1.0 - luma));
                gl_FragColor = vec4(c, 1.0);
            }`,
        depthTest: false, depthWrite: false,
    }));
    return { target, bloom, output };
})();

if (!post) {
    renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    renderer.outputEncoding      = THREE.sRGBEncoding;
}

let viewW = 1, viewH = 1;
function resizeRenderer(w, h) {
    viewW = w; viewH = h;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
    renderer.setSize(w, h);
    if (post) {
        const pr = renderer.getPixelRatio();
        post.target.setSize(Math.round(w * pr), Math.round(h * pr));
        post.bloom.setSize(Math.round(w * pr * quality.bloomScale), Math.round(h * pr * quality.bloomScale));
    }
    skyPixelRatio.value = renderer.getPixelRatio();
}

function setQuality(tier) {
    qualityTier = Math.max(0, Math.min(QUALITY_TIERS.length - 1, tier));
    quality     = QUALITY_TIERS[qualityTier];
    atmosphereMat.defines.STEPS = quality.steps;
    auroraMat.defines.STEPS     = quality.steps + 4;
    atmosphereMat.needsUpdate = auroraMat.needsUpdate = true;
    resizeRenderer(viewW, viewH);
}

// Where the sun is on screen (0–1 uv), how strongly to flare, and how
// spiky (brighter just as it clears the horizon). Only with post-processing.
function setLensFlare(u, v, amount, spikes) {
    if (!post) return;
    const un = post.output.material.uniforms;
    un.sunUv.value.set(u, v);
    un.sunAmt.value = amount;
    un.burst.value  = spikes;
}

function renderFrame() {
    if (!post) { renderer.render(scene, camera); return; }
    renderer.setRenderTarget(post.target);
    renderer.render(scene, camera);
    if (quality.bloom) post.bloom.render(renderer, null, post.target, 0, false);
    renderer.setRenderTarget(null);
    post.output.material.uniforms.time.value = elapsedU.value;
    post.output.material.uniforms.aspect.value = viewW / viewH;
    post.output.render(renderer);
}

// ─── TEXTURES ────────────────────────────────────────────────────────────────
// NASA Blue/Black Marble live in the repo. Relief, ocean mask and stock clouds
// come from the three.js repo on a CDN; each texture starts as a neutral 1×1
// pixel so a failed download degrades the look instead of breaking it.
const TEXTURE_CDN    = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/planets/';
const textureManager = new THREE.LoadingManager();
const textureLoader  = new THREE.TextureLoader(textureManager);
textureLoader.setCrossOrigin('anonymous');
const anisotropy = renderer.capabilities.getMaxAnisotropy();

function pixel(r, g, b, a = 255) {
    const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true;
    return t;
}
function texture(url, fallback, wrap, loader = textureLoader) {
    const uniform = { value: fallback };
    loader.load(url, t => {
        t.anisotropy = anisotropy;
        if (wrap) t.wrapS = THREE.RepeatWrapping;
        uniform.value = t;
    }, undefined, () => console.warn('Texture unavailable:', url));
    return uniform;
}

const dayMap    = texture('textures/earth-day.jpg',   pixel(24, 48, 90));
const nightMap  = texture('textures/earth-night.jpg', pixel(4, 8, 16));
const normalMap = texture(TEXTURE_CDN + 'earth_normal_2048.jpg',   pixel(128, 128, 255));
const specMap   = texture(TEXTURE_CDN + 'earth_specular_2048.jpg', pixel(0, 0, 0));
const cloudMap  = texture(TEXTURE_CDN + 'earth_clouds_1024.png',   pixel(0, 0, 0, 0), true);  // coverage is in alpha
const cloudShift = { value: 0 };
const cloudLevels = { value: new THREE.Vector2(0, 1) };   // remaps coverage; the live map needs its thin veil trimmed
const cloudsOn    = { value: 1 };                          // 0–1, eased when the clouds button is toggled
const moonLight  = { value: 0.5 };    // fraction of the moon's disc that's lit
const elapsedU   = { value: 0 };

// Sharp close-up tiles (streamed in by detail.js). Each layer is a window of
// N×N NASA tiles; layer 0 is the sharp one, layer 1 a wider, coarser ring.
const DETAIL_TILE_PX     = 512;
const DETAIL_TILES       = COMPACT ? 2 : 4;
const DETAIL_LAYER_COUNT = COMPACT ? 1 : 2;
const detailBlank = new Uint8Array((DETAIL_TILE_PX * DETAIL_TILES) ** 2 * 4);   // shared, never written
function detailTexture() {
    const size = DETAIL_TILE_PX * DETAIL_TILES;
    const t = new THREE.DataTexture(detailBlank, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
    return t;
}
const detailUniforms = {};
for (let i = 0; i < DETAIL_LAYER_COUNT; i++) {
    detailUniforms['detailDay' + i]   = { value: detailTexture() };
    detailUniforms['detailNight' + i] = { value: detailTexture() };
    detailUniforms['detailWin' + i]   = { value: new THREE.Vector4(0, 0, 1, 1) };
    detailUniforms['detailOn' + i]    = { value: 0 };
}

function glowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.18, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
}
const GLOW = glowTexture();

// Map markers: a crisp bright point with only a faint halo, so they read as
// precise positions rather than soft blobs
function markerTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.1, 'rgba(255,255,255,1)');
    grad.addColorStop(0.16, 'rgba(255,255,255,0.3)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.06)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
}
const MARKER = markerTexture();

// ─── SHARED SHADER CODE ──────────────────────────────────────────────────────
// Atmosphere constants in scene units. Scale heights are stretched 2.5× (and
// scattering divided by the same) so the limb reads at globe scale while the
// optical depth looking straight down stays close to Earth's.
const ATMOSPHERE_GLSL = `
    #define PI 3.14159265
    const float RG = ${R.toFixed(1)};
    const float RA = ${(R * 1.025).toFixed(4)};
    const float HR = 0.0157;
    const float HM = 0.0024;
    const vec3  BR = vec3(2.96, 6.88, 16.9);
    const float BM = 8.0;
    vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }

    // Chapman approximation: air along a ray from height h (in scale heights)
    // with zenith cosine mu, out to space (Schüler 2012)
    float chapman(float X, float h, float mu) {
        float c = sqrt(X + h);
        if (mu >= 0.0) return c / (c * mu + 1.0) * exp(-h);
        float x0 = sqrt(1.0 - mu * mu) * (X + h);
        return 2.0 * sqrt(x0) * exp(min(X - x0, 40.0)) - c / (1.0 - c * mu) * exp(-h);
    }
    vec3 opticalToSun(float r, float mu) {
        float h  = r - RG;
        float dR = HR * chapman(RG / HR, h / HR, mu);
        float dM = HM * chapman(RG / HM, h / HM, mu);
        return BR * dR + BM * 1.1 * dM;
    }
    // Colour of sunlight that reaches the ground (reddens at the terminator)
    vec3 sunAtGround(float mu) { return exp(-opticalToSun(RG + 0.002, mu)); }
`;

// Value noise on 3D points, for anything procedural
const NOISE_GLSL = `
    float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float noise3(vec3 x) {
        vec3 i = floor(x), f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }
    // The live map comes from infrared, which smooths thin cloud into a flat
    // grey veil. Break thin cover into patches (thick cloud is left alone),
    // at a scale coarse enough not to shimmer from far away.
    float breakup(vec3 n, float raw) {
        float w = noise3(n * 22.0);                           // warp, for swirling rather than blotchy shapes
        float t = noise3(n * 60.0 + w * 2.5) * 0.65 + noise3(n * 150.0 + w * 1.5) * 0.35;
        return raw * mix(1.0, 0.3 + 0.95 * smoothstep(0.2, 0.8, t), 1.0 - smoothstep(0.5, 0.85, raw));
    }
    // A direction t along the surface at unit normal n, as a step in the globe's uv
    vec2 tangentToUv(vec3 n, vec3 t) {
        vec3 east  = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(1e-6, 0.0, 0.0));
        vec3 north = cross(n, east);
        return vec2(dot(t, east) / (6.2831853 * max(length(n.xz), 0.05)), dot(t, north) / 3.1415927);
    }
`;

// How much close-up detail to add (1 riding along, 0 from far away); set by updateShells
const closeUp     = { value: 0 };
const lightningOn = { value: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1 };

// Each shader ends with these so the no-post fallback still tone-maps
const OUTPUT_GLSL = `
    #include <tonemapping_fragment>
    #include <encodings_fragment>
`;

const WORLD_VERT = `
    varying vec2 vUv;
    varying vec3 vN;
    varying vec3 vPos;
    void main() {
        vUv = uv;
        vN  = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

// ─── EARTH ───────────────────────────────────────────────────────────────────
// Sharp NASA tiles (detail.js) are blended over the base maps near the camera
const earthMat = new THREE.ShaderMaterial({
    uniforms: Object.assign({
        sunDir: { value: sunDir }, moonDir: { value: moonDir }, moonLight, cloudShift, cloudLevels, cloudsOn, closeUp, time: elapsedU,
        dayMap, nightMap, normalMap, specMap, cloudMap,
    }, detailUniforms),
    defines: { DETAIL: DETAIL_LAYER_COUNT, DETAIL_N: DETAIL_TILES.toFixed(1) },
    vertexShader: WORLD_VERT,
    fragmentShader: ATMOSPHERE_GLSL + NOISE_GLSL + `
        uniform sampler2D dayMap, nightMap, normalMap, specMap, cloudMap;
        float cloudRaw(vec2 uv, vec3 n) { return breakup(n, texture2D(cloudMap, uv).a); }
        uniform vec3 sunDir, moonDir;
        uniform float cloudShift, moonLight, closeUp, time, cloudsOn;
        uniform vec2 cloudLevels;
        varying vec2 vUv;
        varying vec3 vN, vPos;

        #if DETAIL > 0
        uniform sampler2D detailDay0, detailNight0; uniform vec4 detailWin0; uniform float detailOn0;
        #endif
        #if DETAIL > 1
        uniform sampler2D detailDay1, detailNight1; uniform vec4 detailWin1; uniform float detailOn1;
        #endif

        // win = (first column, first row, tile span in degrees, tiles around the globe).
        // Tiles sit in the texture at (column mod N, row mod N) with repeat
        // wrapping, so moving the window never shuffles loaded tiles.
        vec4 detailSample(sampler2D map, vec4 win, float on, vec2 lonLat) {
            float lx = mod((lonLat.x + 180.0) / win.z - win.x, win.w);
            float ly = (90.0 - lonLat.y) / win.z - win.y;
            vec2 uv = (vec2(mod(win.x, DETAIL_N), mod(win.y, DETAIL_N)) + vec2(lx, ly)) / DETAIL_N;
            vec4 c  = texture2D(map, uv);
            // Alpha from a blurrier mip ramps the blend down near tiles that
            // haven't arrived yet, instead of a hard edge
            float a = min(c.a, texture2D(map, uv, 4.0).a);
            vec2 l = vec2(lx, ly) / DETAIL_N;
            float edge = smoothstep(0.0, 0.1, l.x) * smoothstep(0.0, 0.1, 1.0 - l.x) * smoothstep(0.0, 0.1, l.y) * smoothstep(0.0, 0.1, 1.0 - l.y);
            return vec4(c.rgb / max(c.a, 0.004), a * edge * on);
        }

        // Black Marble: warm city lights over a blue moonlit base. Returns
        // (city light amount, base brightness).
        vec2 nightSplit(vec3 t) {
            float lum = dot(t, vec3(0.299, 0.587, 0.114));
            return vec2(smoothstep(0.02, 0.28, t.r - t.b * 0.75) * (0.6 + lum * 1.6), lum);
        }

        void main() {
            vec3 N  = normalize(vN);
            vec3 T  = normalize(cross(vec3(0.0, 1.0, 0.0), N));
            vec3 B  = cross(N, T);
            vec3 nm = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
            vec3 Np = normalize(T * nm.x * 0.7 + B * nm.y * 0.7 + N * nm.z);
            vec3 V  = normalize(cameraPosition - vPos);
            vec2 ll = vec2(vUv.x * 360.0 - 180.0, vUv.y * 180.0 - 90.0);

            vec3 dayTex = texture2D(dayMap, vUv).rgb;
            vec2 night  = nightSplit(texture2D(nightMap, vUv).rgb);
            float lights = night.x;
            #if DETAIL > 1
                vec4 fd = detailSample(detailDay1, detailWin1, detailOn1, ll);
                dayTex = mix(dayTex, fd.rgb, fd.a);
                vec4 fn = detailSample(detailNight1, detailWin1, detailOn1, ll);
                lights = mix(lights, nightSplit(fn.rgb).x, fn.a);
            #endif
            #if DETAIL > 0
                vec4 nd = detailSample(detailDay0, detailWin0, detailOn0, ll);
                dayTex = mix(dayTex, nd.rgb, nd.a);
                vec4 nn = detailSample(detailNight0, detailWin0, detailOn0, ll);
                lights = mix(lights, nightSplit(nn.rgb).x, nn.a);
            #endif

            float d     = dot(N, sunDir);
            // Cloud shadows fall away from the sun, further when it's low
            float cloud  = cloudsOn * clamp((cloudRaw(vUv + vec2(cloudShift, 0.0), N) - cloudLevels.x) / (cloudLevels.y - cloudLevels.x), 0.0, 1.0);
            float reach  = min(0.007 * sqrt(max(1.0 - d * d, 0.0)) / max(d, 0.08), 0.03);
            vec2  toSun  = tangentToUv(N, sunDir - N * d);
            float shadow = cloudsOn * clamp((cloudRaw(vUv + vec2(cloudShift, 0.0) + toSun * reach, N) - cloudLevels.x) / (cloudLevels.y - cloudLevels.x), 0.0, 1.0);
            vec3  sunT   = sunAtGround(d);
            // Art direction: a little richer than the satellite imagery, with deeper oceans
            vec3  albedo = toLinear(dayTex);
            albedo = max(mix(vec3(dot(albedo, vec3(0.2126, 0.7152, 0.0722))), albedo, 1.04), 0.0);
            albedo = mix(albedo, albedo * vec3(0.7, 0.88, 1.15), texture2D(specMap, vUv).r * 0.5);
            vec3  col    = albedo * max(dot(Np, sunDir), 0.0) * sunT * (1.0 - shadow * 0.6);
            // A warm golden band where day meets night
            col += vec3(1.0, 0.5, 0.2) * 0.01 * exp(-pow((d - 0.02) / 0.04, 2.0));

            // Water: a sun glint that sparkles up close, and the sky reflected at low angles
            float water   = texture2D(specMap, vUv).r * (1.0 - cloud);
            float nh      = max(dot(N, normalize(sunDir + V)), 0.0);
            // Fine detail only near the camera; further off it would just shimmer
            float near    = closeUp * (1.0 - smoothstep(0.5, 1.5, length(cameraPosition - vPos)));
            float sparkle = 1.0;
            if (near > 0.0) sparkle = mix(1.0, 0.25 + 1.6 * noise3(N * 2600.0 + vec3(time * 0.6, 0.0, time * 0.4)), near);
            // Sunglint as rough water really reflects it (GGX microfacets with
            // Fresnel): only ~2% straight on, so it's a broad silvery sheen
            // rather than a hot spot, brightening towards grazing angles. The
            // roughness wanders like calm and choppy patches of sea.
            float nl    = max(dot(N, sunDir), 0.0), nv = max(dot(N, V), 0.001);
            float vh    = max(dot(V, normalize(sunDir + V)), 0.0);
            float wind  = noise3(N * 18.0) * 0.6 + noise3(N * 55.0) * 0.4;
            float alpha = mix(0.13, 0.33, wind), a2 = alpha * alpha;
            float ggx   = a2 / (PI * pow(nh * nh * (a2 - 1.0) + 1.0, 2.0));
            float kk    = alpha * 0.5;
            float vis   = (nl / (nl * (1.0 - kk) + kk)) * (nv / (nv * (1.0 - kk) + kk));
            float fres  = 0.02 + 0.98 * pow(1.0 - vh, 5.0);
            col += sunT * vec3(0.92, 0.95, 1.0) * water * PI * ggx * vis * fres / (4.0 * nv) * sparkle * 0.55;
            float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
            col += water * fresnel * vec3(0.05, 0.11, 0.24) * smoothstep(-0.1, 0.3, d);

            // Night: a moonlit base (brighter towards full moon) and city lights
            float dark   = 1.0 - smoothstep(-0.1, 0.06, d);
            float moon   = 0.6 + 2.2 * moonLight * max(dot(N, moonDir), 0.0);
            // Night: continents in deep moonlit blue, and city lights bright enough to glow
            vec3 moonlit = vec3(0.45, 0.55, 0.85) * (toLinear(vec3(night.y)) * 1.7 + 0.0015) * moon;
            vec3 city    = vec3(1.0, 0.62, 0.32) * lights * (1.0 - cloud * 0.7) * 1.25;
            col += (moonlit + city) * dark;

            gl_FragColor = vec4(col, 1.0);
            ${OUTPUT_GLSL}
        }`,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(R, 192, 144), earthMat));

const cloudMat = new THREE.ShaderMaterial({
    uniforms: { sunDir: { value: sunDir }, moonDir: { value: moonDir }, moonLight, cloudMap, cloudShift, cloudLevels, cloudsOn, closeUp, lightningOn, time: elapsedU },
    vertexShader: WORLD_VERT,
    fragmentShader: ATMOSPHERE_GLSL + NOISE_GLSL + `
        uniform sampler2D cloudMap; uniform vec3 sunDir, moonDir; uniform float cloudShift, moonLight, closeUp, lightningOn, time, cloudsOn; uniform vec2 cloudLevels;
        varying vec2 vUv; varying vec3 vN, vPos;
        float coverage(vec2 uv, vec3 n) { return breakup(n, texture2D(cloudMap, uv + vec2(cloudShift, 0.0)).a); }
        void main() {
            vec3 N  = normalize(vN);
            vec3 V  = normalize(cameraPosition - vPos);
            float d = dot(N, sunDir);
            float raw = coverage(vUv, N);
            // Up close the map is blurry: break the edges up into cumulus-sized
            // puffs, near the camera only (further off they'd just shimmer)
            float near = closeUp * (1.0 - smoothstep(0.5, 1.5, length(cameraPosition - vPos)));
            if (near > 0.0) {
                float puffs = noise3(N * 900.0) * 0.5 + noise3(N * 2300.0) * 0.3 + noise3(N * 5600.0) * 0.2;
                raw += (puffs - 0.5) * 0.45 * near * smoothstep(0.02, 0.35, raw);
            }
            float c = clamp((raw - cloudLevels.x) / (cloudLevels.y - cloudLevels.x), 0.0, 1.0);

            // Relief: thicker cloud towards the sun shades this side, thinner lets it light up
            vec2 toSun  = tangentToUv(N, sunDir - N * d);
            float lit   = clamp(1.0 + (raw - coverage(vUv + toSun * 0.004, N)) * 2.2, 0.55, 1.25);
            // Thin edges glow when the sun is behind them
            float lining = pow(max(dot(-V, sunDir), 0.0), 6.0) * c * (1.0 - c) * 5.0;

            // Cloud tops catch the sun a little past the ground terminator
            vec3 sunT  = sunAtGround(d + 0.03);
            vec3 day   = sunT * (vec3(0.93) * clamp((d + 0.06) / 1.06, 0.0, 1.0) * lit + lining);
            vec3 night = vec3(0.01, 0.016, 0.035) * (0.5 + 3.0 * moonLight * max(dot(N, moonDir), 0.0));

            // Lightning in deep storm clouds on the night side, mostly in the tropics
            float bolt = 0.0;
            // Only up close, where a flash reads as a storm lighting its cloud
            // from inside (from far away it was just glitter). Rare, soft,
            // with the double flicker of a real strike.
            if (lightningOn > 0.5 && closeUp > 0.0 && d < 0.0) {
                vec3 cell    = floor(N * 90.0);                 // ~70 km storm cells
                float phase  = time * 0.7 + hash3(cell) * 23.0;
                float strike = step(0.985, hash3(cell + floor(phase) * 1.37));
                float t      = fract(phase) * 1.43;             // seconds into this cell's slot
                float flash  = strike * (exp(-18.0 * t) + 0.6 * exp(-18.0 * abs(t - 0.12)));
                float storm  = smoothstep(0.8, 0.97, raw) * smoothstep(0.75, 0.25, abs(N.y)) * smoothstep(0.0, -0.15, d);
                bolt = flash * storm * closeUp * smoothstep(0.55, 0.0, length(fract(N * 90.0) - 0.5));
                night += vec3(0.6, 0.68, 1.0) * bolt * 2.0;
            }

            if (cloudsOn <= 0.0) discard;
            gl_FragColor = vec4(day + night, max(c * 0.96, bolt) * cloudsOn);
            ${OUTPUT_GLSL}
        }`,
    transparent: true, depthWrite: false,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(R * 1.007, 160, 120), cloudMat));

// ─── VOLUMES: AURORA AND ATMOSPHERE ──────────────────────────────────────────
// Both are drawn on a shell around the Earth and work out, per pixel, the
// camera ray through the air analytically, so the same pass hazes the ground,
// lights the limb and shows the aurora from any angle. The ray is measured
// from its closest approach to the Earth's centre to keep float precision.
const RAY_GLSL = `
    varying vec3 vPos;
    // Returns false if the ray misses the sphere of radius rOut. o is the
    // closest-approach point; s0..s1 is the span in front of the camera,
    // stopping at the ground.
    bool rayShell(float rOut, out vec3 o, out vec3 rd, out float s0, out float s1, out bool ground) {
        rd = normalize(vPos - cameraPosition);
        float tc = -dot(cameraPosition, rd);
        o = cameraPosition + rd * tc;
        float rc2 = dot(o, o);
        if (rc2 >= rOut * rOut) return false;
        float h = sqrt(rOut * rOut - rc2);
        s0 = max(-h, -tc);
        s1 = h;
        ground = false;
        if (rc2 < RG * RG) {
            float hg = sqrt(RG * RG - rc2);
            if (-hg > -tc) { s1 = -hg; ground = true; }
        }
        return s1 > s0;
    }
`;
const SHELL_VERT = `
    varying vec3 vPos;
    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

// Aurora from NOAA's 30-minute forecast (weather.js fills auroraMap).
// Green oxygen glow with a sharp lower edge around 100 km, fading upwards
// into red, in curtains that drift slowly.
const AURORA_TOP = R + 0.2;
const auroraMap  = { value: pixel(0, 0, 0) };
const auroraOn   = { value: 0 };
const auroraMat = new THREE.ShaderMaterial({
    uniforms: { sunDir: { value: sunDir }, auroraMap, auroraOn, time: elapsedU },
    defines: { STEPS: quality.steps + 4 },
    vertexShader: SHELL_VERT,
    fragmentShader: ATMOSPHERE_GLSL + NOISE_GLSL + RAY_GLSL + `
        uniform sampler2D auroraMap; uniform float auroraOn, time; uniform vec3 sunDir;
        void main() {
            if (auroraOn < 0.5) discard;
            vec3 o, rd; float s0, s1; bool ground;
            if (!rayShell(${AURORA_TOP.toFixed(3)}, o, rd, s0, s1, ground)) discard;
            float ds = (s1 - s0) / float(STEPS);
            float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
            vec3 sum = vec3(0.0);
            for (int i = 0; i < STEPS; i++) {
                vec3 p  = o + rd * (s0 + ds * (float(i) + jitter));
                float r = length(p);
                vec3 n  = p / r;
                float h = r - RG;
                float lon = atan(n.z, -n.x), lat = asin(n.y);
                vec2 uv = vec2(fract(lon / (2.0 * PI)), lat / PI + 0.5);
                float a = texture2D(auroraMap, uv).r;
                float dark = smoothstep(0.1, -0.15, dot(n, sunDir));
                // Curtains: noise squashed along the axis, so folds run east-west
                // and are thin north-south, with fine vertical rays
                float folds = noise3(vec3(n.x * 9.0 + time * 0.02, n.y * 55.0, n.z * 9.0)) * 0.65
                            + noise3(vec3(n.x * 24.0, n.y * 140.0 - time * 0.05, n.z * 24.0)) * 0.35;
                float curtain = smoothstep(0.45, 0.85, folds) * (0.75 + 0.25 * noise3(vec3(n.x * 120.0, n.y * 6.0 + time * 0.3, n.z * 120.0)));
                float green = smoothstep(0.072, 0.085, h) * exp(-(h - 0.085) / 0.03);
                float red   = smoothstep(0.11, 0.16, h) * exp(-(h - 0.16) / 0.05);
                sum += a * dark * max(curtain, 0.0) * (vec3(0.1, 1.0, 0.35) * green + vec3(0.9, 0.12, 0.3) * red * 0.2);
            }
            gl_FragColor = vec4(sum * ds * 5.0, 1.0);
            ${OUTPUT_GLSL}
        }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const auroraShell = new THREE.Mesh(new THREE.SphereGeometry(AURORA_TOP, 96, 64), auroraMat);
auroraShell.renderOrder = 1;
scene.add(auroraShell);

// Single scattering (Rayleigh + Mie) along the view ray, plus the thin green
// airglow line on the night-side limb. Output is added to what's behind and
// the alpha dims it by the air's transmittance.
const atmosphereMat = new THREE.ShaderMaterial({
    uniforms: { sunDir: { value: sunDir }, sunE: { value: 3.5 } },
    defines: { STEPS: quality.steps },
    vertexShader: SHELL_VERT,
    fragmentShader: ATMOSPHERE_GLSL + RAY_GLSL + `
        uniform vec3 sunDir; uniform float sunE;
        float chord(float r, float rc2) { return sqrt(max(r * r - rc2, 0.0)); }
        void main() {
            vec3 o, rd; float s0, s1; bool ground;
            if (!rayShell(RA, o, rd, s0, s1, ground)) discard;
            float ds = (s1 - s0) / float(STEPS);
            vec2 depth = vec2(0.0);
            vec3 sumR = vec3(0.0), sumM = vec3(0.0);
            for (int i = 0; i < STEPS; i++) {
                vec3 p  = o + rd * (s0 + ds * (float(i) + 0.5));
                float r = length(p);
                vec2 dens = exp(-(r - RG) / vec2(HR, HM)) * ds;
                depth += dens * 0.5;
                vec3 att = exp(-(BR * depth.x + BM * 1.1 * depth.y + opticalToSun(r, dot(p, sunDir) / r)));
                depth += dens * 0.5;
                sumR += dens.x * att;
                sumM += dens.y * att;
            }
            float mu  = dot(rd, sunDir);
            float g   = 0.76;
            float phR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
            float phM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
            // Art direction: real haze over the ground reads as fog on a small
            // globe, so it's thinned there; rays that only skim the air (the
            // limb) are boosted into a bright rim instead
            vec3 light = sunE * (sumR * BR * phR * (ground ? 0.65 : 1.2) + sumM * BM * phM * (ground ? 0.2 : 1.0));
            vec3 trans = exp(-(BR * depth.x + BM * 1.1 * depth.y));
            if (ground) trans = mix(vec3(1.0), trans, 0.65);

            // Airglow: a shell ~90–100 km up, only on the night side
            float rc2  = dot(o, o);
            float glow = chord(RG + 0.078, rc2) - chord(RG + 0.068, rc2);
            if (!ground) glow *= 2.0;
            light += vec3(0.006, 0.05, 0.02) * glow * smoothstep(-0.05, -0.25, dot(normalize(o), sunDir));

            gl_FragColor = vec4(light, dot(trans, vec3(0.3333)));
            ${OUTPUT_GLSL}
        }`,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
});
const atmosphereShell = new THREE.Mesh(new THREE.SphereGeometry(R * 1.025, 128, 96), atmosphereMat);
atmosphereShell.renderOrder = 2;
scene.add(atmosphereShell);

// A soft halo around the whole planet: not physical, just beautiful from far
// away. Blue on the day side, warming to orange round the terminator, gone
// on the night side and when the camera is close.
const HALO_R = R * 1.12;
const haloMat = new THREE.ShaderMaterial({
    uniforms: { sunDir: { value: sunDir }, strength: { value: 1 }, limb: { value: Math.sqrt(1 - (R / HALO_R) ** 2) } },
    vertexShader: WORLD_VERT,
    fragmentShader: `
        uniform vec3 sunDir; uniform float strength, limb;
        varying vec3 vN, vPos;
        void main() {
            vec3 n  = normalize(vN);
            vec3 V  = normalize(cameraPosition - vPos);
            float t = clamp(-dot(V, n) / limb, 0.0, 1.0);        // 1 at the planet's edge, 0 at the halo's
            // Sunlight where the view ray passes closest to the planet
            vec3 rd = -V;
            vec3 o  = cameraPosition - rd * dot(cameraPosition, rd);
            float d = dot(normalize(o), sunDir);
            float blue = smoothstep(-0.2, 0.0, d);
            vec3 col = mix(vec3(1.0, 0.38, 0.12) * 0.45, vec3(0.18, 0.45, 1.0), blue);
            float a  = pow(t, 3.0) * smoothstep(-0.38, -0.05, d) * strength;
            gl_FragColor = vec4(col * a * 0.22, 1.0);
            ${OUTPUT_GLSL}
        }`,
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const halo = new THREE.Mesh(new THREE.SphereGeometry(HALO_R, 96, 64), haloMat);
halo.renderOrder = 2;
scene.add(halo);

// Shells are drawn from their outside face, so the ISS (above the air) and
// the Earth's depth occlude them properly. If the camera ever dips inside,
// flip to the inside face.
function updateShells() {
    const r = camera.position.length();
    closeUp.value = 1 - THREE.MathUtils.smoothstep(r - R, 0.8, 3);
    haloMat.uniforms.strength.value = THREE.MathUtils.smoothstep(r - R, 1.5, 8);
    atmosphereMat.side = r < R * 1.025 * 1.002 ? THREE.BackSide : THREE.FrontSide;
    auroraMat.side     = r < AURORA_TOP * 1.002 ? THREE.BackSide : THREE.FrontSide;
}

// ─── ORBIT PATHS ─────────────────────────────────────────────────────────────
// One orbit behind and one ahead (dashed), refilled from the TLE. Both are
// brightest at the ISS and fade away the further they are from now, in
// either direction. Drawn after the atmosphere so the haze doesn't soften them.
const PATH_POINTS = 187;
const PATH_STEP_S = 30;
function pathLine(material) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PATH_POINTS * 3), 3));
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, material);
    line.frustumCulled = false;
    line.renderOrder = 3;
    scene.add(line);
    return line;
}
function pathMaterial(opacity, dashed) {
    return new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color(1.3, 1.3, 1.3) }, opacity: { value: opacity } },
        defines: dashed ? { DASHED: 1 } : {},
        vertexShader: `
            attribute float fade;
            varying float vFade;
            #ifdef DASHED
            attribute float lineDistance;
            varying float vDist;
            #endif
            void main() {
                vFade = fade;
                #ifdef DASHED
                vDist = lineDistance;
                #endif
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: `
            uniform vec3 color; uniform float opacity;
            varying float vFade;
            #ifdef DASHED
            varying float vDist;
            #endif
            void main() {
                #ifdef DASHED
                if (mod(vDist, 0.12) > 0.05) discard;
                #endif
                gl_FragColor = vec4(color, opacity * vFade);
                ${OUTPUT_GLSL}
            }`,
        transparent: true, depthWrite: false,
    });
}
// Fade from 1 at the ISS to nothing about 55 minutes away, so the fade plays
// out on the side of the planet you can see
const pathFade = i => Math.pow(Math.max(0, 1 - i / ((PATH_POINTS - 1) * 0.6)), 1.6);

const pastMat  = pathMaterial(0.75, false);
const pastLine = pathLine(pastMat);
pastLine.geometry.setAttribute('fade', new THREE.BufferAttribute(
    new Float32Array(PATH_POINTS).map((_, i) => pathFade(PATH_POINTS - 1 - i)), 1));   // oldest first

const futureMat  = pathMaterial(0.6, true);
const futureLine = pathLine(futureMat);
futureLine.geometry.setAttribute('fade', new THREE.BufferAttribute(
    new Float32Array(PATH_POINTS).map((_, i) => pathFade(i)), 1));                      // now first
// Dash spacing, refilled in place rather than via computeLineDistances(),
// which would allocate a fresh GPU buffer each time
const futureDist = new THREE.BufferAttribute(new Float32Array(PATH_POINTS), 1);
futureLine.geometry.setAttribute('lineDistance', futureDist);

function rebuildPaths(satrec, now) {
    const fill = (line, fromS) => {
        const pos = line.geometry.attributes.position;
        for (let i = 0; i < PATH_POINTS; i++) {
            const s = issState(satrec, new Date(now + (fromS + i * PATH_STEP_S) * 1000));
            const v = latLonToVector3(s.lat, s.lon, altToRadius(s.alt));
            pos.setXYZ(i, v.x, v.y, v.z);
        }
        line.geometry.setDrawRange(0, PATH_POINTS);
        pos.needsUpdate = true;
    };
    fill(pastLine, -(PATH_POINTS - 1) * PATH_STEP_S);
    fill(futureLine, 0);
    const pos = futureLine.geometry.attributes.position;
    for (let i = 1; i < PATH_POINTS; i++) {
        futureDist.array[i] = futureDist.array[i - 1] + Math.hypot(
            pos.getX(i) - pos.getX(i - 1), pos.getY(i) - pos.getY(i - 1), pos.getZ(i) - pos.getZ(i - 1));
    }
    futureDist.needsUpdate = true;
}

// Keep the "now" ends of both orbits on the live ISS position
function pinPath(p) {
    const past = pastLine.geometry.attributes.position, future = futureLine.geometry.attributes.position;
    past.setXYZ(PATH_POINTS - 1, p.x, p.y, p.z);
    future.setXYZ(0, p.x, p.y, p.z);
    past.needsUpdate = future.needsUpdate = true;
}

// Ground track of the selected pass, shown in "My sky"
const passTrackMat = new THREE.LineBasicMaterial({ color: srgb(0x7dd3fc).multiplyScalar(1.4), transparent: true, opacity: 0, depthWrite: false });
const passTrack = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), passTrackMat);
passTrack.frustumCulled = false;
passTrack.renderOrder = 3;
scene.add(passTrack);

function setPassTrack(points) {
    passTrack.geometry.dispose();
    passTrack.geometry = new THREE.BufferGeometry().setFromPoints(points.length > 1 ? points : [new THREE.Vector3(), new THREE.Vector3()]);
}

// ─── HOME MARKER ─────────────────────────────────────────────────────────────
const homeGroup = new THREE.Group();
homeGroup.visible = false;
const homeColor = srgb(0x7dd3fc).multiplyScalar(1.4);
const homeRing = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.075, 48),
    new THREE.MeshBasicMaterial({ color: homeColor, side: THREE.DoubleSide, transparent: true }));
const homeDot = new THREE.Mesh(new THREE.CircleGeometry(0.022, 20),
    new THREE.MeshBasicMaterial({ color: homeColor, side: THREE.DoubleSide }));
homeRing.renderOrder = homeDot.renderOrder = 3;
homeGroup.add(homeRing, homeDot);
scene.add(homeGroup);

function placeHomeMarker(home) {
    const n = latLonToVector3(home.lat, home.lon, 1);
    homeGroup.position.copy(n).multiplyScalar(R + 0.012);
    homeGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    homeGroup.visible = true;
    return n;
}
