// ─── THE STATION ─────────────────────────────────────────────────────────────
// NASA's 3D model of the ISS (models/iss.glb, from nasa/NASA-3D-Resources),
// given materials (the model ships untextured), solar arrays that turn to
// track the sun, blue earthshine from below, light that reddens through the
// atmosphere at orbital sunrise and sunset, and its own shadows up close.
// A simple stand-in made of boxes shows until it loads, or if it can't.
//
// Station space: x = port, y = up (zenith), z = forward (direction of travel).
// It's drawn enormously oversized (truss ≈ 0.085 units ≈ 100 km) so it reads.

const STATION_SPAN = 0.085;

const station = new THREE.Group();
station.visible = false;
scene.add(station);

// ─── LIGHTS ──────────────────────────────────────────────────────────────────
const sunLight = new THREE.DirectionalLight(0xffffff, 0);
sunLight.castShadow = true;
sunLight.shadow.mapSize.setScalar(COMPACT ? 1024 : 2048);
Object.assign(sunLight.shadow.camera, { left: -0.055, right: 0.055, top: 0.055, bottom: -0.055, near: 0.05, far: 0.5 });
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = 0.0002;
scene.add(sunLight, sunLight.target);
renderer.shadowMap.enabled    = true;
renderer.shadowMap.type       = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;   // only redrawn while riding along

// Earthshine: the "ground" half of a hemisphere light, pointed at the Earth
const earthshine = new THREE.HemisphereLight(0x000000, srgb(0x6f8fc8), 0);
scene.add(earthshine);
const ambient = new THREE.AmbientLight(srgb(0x3a5a8a), 0.12);   // keeps the shadowed side readable
// In Earth's shadow a soft cool light from above keeps the station's shape
// readable, as if lit by moonlight and the night glow
const nightFill = new THREE.DirectionalLight(srgb(0xc4cde6), 0);
scene.add(nightFill, nightFill.target);
scene.add(ambient);

// ─── STAND-IN ────────────────────────────────────────────────────────────────
// Truss along x, modules along z, arrays along ±y
function buildStandIn() {
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: srgb(0xdfe3e8), metalness: 0.35, roughness: 0.45 });
    const truss = new THREE.MeshStandardMaterial({ color: srgb(0x8f959e), metalness: 0.6, roughness: 0.4 });
    const panel = new THREE.MeshStandardMaterial({ color: srgb(0x9a6a24), metalness: 0.5, roughness: 0.35, side: THREE.DoubleSide });
    const add   = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
    add(new THREE.BoxGeometry(1.0, 0.035, 0.035), truss);
    for (const [r, len, z] of [[0.03, 0.36, 0.02], [0.024, 0.28, -0.3], [0.026, 0.12, 0.25]]) {
        add(new THREE.CylinderGeometry(r, r, len, 20), metal, 0, -0.04, z).rotation.x = Math.PI / 2;
    }
    const arrays = [];
    for (const x of [-0.47, -0.34, 0.34, 0.47]) {
        const pivot = new THREE.Group();
        pivot.position.x = x;
        for (const s of [1, -1]) {
            const b = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.32, 0.003), panel);
            b.position.y = s * 0.19;
            pivot.add(b);
        }
        g.add(pivot);
        arrays.push(pivot);
    }
    g.scale.setScalar(STATION_SPAN);
    // Arrays turn about the truss (x) to face the sun
    g.userData.track = s => { for (const a of arrays) a.rotation.x = Math.atan2(-s.y, s.z); };
    return g;
}
let stationModel = buildStandIn();
station.add(stationModel);

// ─── NASA MODEL ──────────────────────────────────────────────────────────────
// Model axes: x = nadir, y = forward, z = starboard, truss along z, 1 unit ≈
// 2.4 m. The arrays are one mesh and turn together about the truss.
const MODEL_TRUSS = 45.6;
const MODEL_AXIS  = new THREE.Vector3(-1.1, 10.8, 0);   // where the arrays meet the truss

// Solar cells: a grid on deep blue on the sun-facing side, gold Kapton behind
function arrayMaterial() {
    const m = new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.5, side: THREE.DoubleSide });
    m.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vModelPos, vModelNormal;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvModelPos = position; vModelNormal = normal;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vModelPos, vModelNormal;')
            .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
                vec2 g = abs(fract(vModelPos.yz * vec2(2.4, 1.5)) - 0.5);
                float grid = smoothstep(0.42, 0.47, max(g.x, g.y));
                vec3 cells = mix(vec3(0.02, 0.03, 0.075), vec3(0.18, 0.16, 0.14), grid);
                vec3 kapton = mix(vec3(0.5, 0.3, 0.09), vec3(0.28, 0.17, 0.05), grid);
                vec4 diffuseColor = vec4(vModelNormal.x > 0.0 ? cells : kapton, opacity);`);
    };
    return m;
}

function stationMaterial(name) {
    const std = (hex, metalness, roughness) => new THREE.MeshStandardMaterial({ color: srgb(hex), metalness, roughness, side: THREE.DoubleSide });
    if (/^lambert7/.test(name))      return arrayMaterial();            // main solar arrays
    if (/^soyuz_blinn4/.test(name))  return std(0xe2e1dc, 0.05, 0.55);  // radiators
    if (/^lambert3/.test(name))      return std(0xa9adb3, 0.7, 0.38);   // truss
    if (/^lambert4/.test(name))      return std(0x1b2a50, 0.45, 0.3);   // Russian solar arrays
    if (/^(blinn1|anisotropic1)/.test(name)) return std(0xd9d5cc, 0.12, 0.72);   // modules in white blankets
    return std(0xc4c6c9, 0.45, 0.5);
}

function loadStation() {
    if (!THREE.GLTFLoader || !THREE.DRACOLoader) return;
    const draco = new THREE.DRACOLoader();
    draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/libs/draco/');
    const loader = new THREE.GLTFLoader();
    loader.setDRACOLoader(draco);
    loader.load('models/iss.glb', gltf => {
        const materials = new Map();
        let arrays = null;
        const stray = [];
        gltf.scene.traverse(o => {
            if (!o.isMesh) return;
            o.geometry.computeBoundingBox();
            if (o.geometry.boundingBox.min.y > 30) { stray.push(o); return; }   // loose parts floating above the model
            const name = o.material.name;
            if (!materials.has(name)) materials.set(name, stationMaterial(name));
            o.material = materials.get(name);
            o.castShadow = o.receiveShadow = true;
            if (/^lambert7/.test(name)) arrays = o;
        });
        stray.forEach(o => o.parent.remove(o));

        // Model space → station space: forward (y) → z, starboard (z) → −x, nadir (x) → −y
        const frame = new THREE.Group();
        frame.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
            new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));
        frame.scale.setScalar(STATION_SPAN / MODEL_TRUSS);
        gltf.scene.position.copy(MODEL_AXIS).negate();
        frame.add(gltf.scene);

        // The arrays turn about the truss: the model's z axis through MODEL_AXIS
        const pivot = new THREE.Group();
        frame.add(pivot);
        if (arrays) {
            arrays.parent.remove(arrays);
            arrays.position.copy(MODEL_AXIS).negate();
            pivot.add(arrays);
        }
        const toModel = new THREE.Quaternion().copy(frame.quaternion).invert();
        const local = new THREE.Vector3();
        frame.userData.track = s => {
            local.copy(s).applyQuaternion(toModel);
            pivot.rotation.z = Math.atan2(local.y, local.x);
        };

        station.remove(stationModel);
        stationModel = frame;
        station.add(frame);
        draco.dispose();
    }, undefined, e => console.warn('ISS model unavailable; using the simple one', e));
}
loadStation();

// ─── THE CUPOLA ──────────────────────────────────────────────────────────────
// The seven-window observation dome, built in 3D around the camera for the
// Cupola view: a round window looking straight down, ringed by six angled
// trapezoids, in thick bevelled frames. It's lit by the real sun (with
// shadows, so sunlight falls through the windows onto the frames), by
// earthshine from below, and by a soft cabin light.
// Its own frame: x = port, y = forward, z = nadir (out through the dome).
const CUPOLA = { base: 0.15, top: 0.08, height: 0.08, window: 0.063, frame: 0.0085, depth: 0.007 };

// Shrink a convex polygon by m (each edge moves inward, corners re-meet)
function insetPolygon(pts, m) {
    const ccw = THREE.ShapeUtils.isClockWise(pts) ? -1 : 1;
    const edges = pts.map((a, i) => {
        const b = pts[(i + 1) % pts.length], d = b.clone().sub(a).normalize();
        return { p: a.clone().add(new THREE.Vector2(-d.y, d.x).multiplyScalar(m * ccw)), d };
    });
    return edges.map((e, i) => {
        const k = edges[(i + edges.length - 1) % edges.length];
        const t = ((e.p.x - k.p.x) * e.d.y - (e.p.y - k.p.y) * e.d.x) / (k.d.x * e.d.y - k.d.y * e.d.x);
        return k.p.clone().addScaledVector(k.d, t);
    });
}

function buildCupola() {
    const rig = new THREE.Group();
    const frameMat = new THREE.MeshStandardMaterial({ color: srgb(0x6a6f77), metalness: 0.25, roughness: 0.72, side: THREE.DoubleSide });
    const extrude = { depth: CUPOLA.depth, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2, curveSegments: 48 };
    const hex = (r, z) => [0, 1, 2, 3, 4, 5].map(i => new THREE.Vector3(r * Math.cos(i * Math.PI / 3), r * Math.sin(i * Math.PI / 3), z));
    const base = hex(CUPOLA.base, 0), top = hex(CUPOLA.top, CUPOLA.height);

    // Lay a flat panel (outline + holes, in its own 2D space) into 3D
    const panel = (shape, origin, u, v, n) => {
        const geo = new THREE.ExtrudeGeometry(shape, extrude);
        geo.applyMatrix4(new THREE.Matrix4().makeBasis(u, v, n).setPosition(origin));
        const mesh = new THREE.Mesh(geo, frameMat);
        mesh.castShadow = mesh.receiveShadow = true;
        rig.add(mesh);
    };

    // The end panel: a hexagon with the round window
    const end = new THREE.Shape(top.map(p => new THREE.Vector2(p.x, p.y)));
    end.holes.push(new THREE.Path().absarc(0, 0, CUPOLA.window, 0, Math.PI * 2, true));
    panel(end, new THREE.Vector3(0, 0, CUPOLA.height), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1));

    // Six sloping side panels, each a trapezoid with a trapezoid window
    for (let i = 0; i < 6; i++) {
        const A = base[i], B = base[(i + 1) % 6], C = top[(i + 1) % 6], D = top[i];
        const u = B.clone().sub(A).normalize();
        let n = new THREE.Vector3().crossVectors(B.clone().sub(A), D.clone().sub(A)).normalize();
        if (n.dot(A.clone().add(B).setZ(0)) < 0) n.negate();          // point away from the dome's axis
        const v = new THREE.Vector3().crossVectors(n, u);
        const flat = [A, B, C, D].map(P => new THREE.Vector2(P.clone().sub(A).dot(u), P.clone().sub(A).dot(v)));
        const shape = new THREE.Shape(flat);
        shape.holes.push(new THREE.Path(insetPolygon(flat, CUPOLA.frame)));
        panel(shape, A, u, v, n);
    }

    // A short wall above the base, so looking sideways shows the module, not space
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(CUPOLA.base, CUPOLA.base, 0.06, 6, 1, true), frameMat);
    wall.rotation.x = Math.PI / 2;
    wall.rotation.y = Math.PI / 6;
    wall.position.z = -0.03;
    wall.receiveShadow = true;
    rig.add(wall);

    rig.visible = false;
    scene.add(rig);
    return rig;
}
const cupolaRig   = buildCupola();
const cabinLight  = new THREE.PointLight(srgb(0xffeedd), 0, 0.45, 2);
scene.add(cabinLight);
const CUPOLA_BASIS = new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0));
const _cupolaQ = new THREE.Quaternion().setFromRotationMatrix(CUPOLA_BASIS);

// Does the Cupola's frame block the line of sight to the sun? (for the lens flare)
const _sunRay = new THREE.Raycaster();
function cupolaBlocksSun() {
    if (!cupolaRig.visible) return false;
    _sunRay.set(camera.position, sunDir);
    _sunRay.far = 1;
    return _sunRay.intersectObjects(cupolaRig.children, false).length > 0;
}

// ─── NAVIGATION LIGHTS ───────────────────────────────────────────────────────
// Red on the port end of the truss, green on starboard, a white strobe at the
// front. Only shown up close, bright enough to bloom.
const navLights = [[0.045, 0, 0, 0xff3b30], [-0.045, 0, 0, 0x34ff6a], [0, 0.002, 0.012, 0xffffff]].map(([x, y, z, color]) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x, y, z]), 3));
    const mat = new THREE.PointsMaterial({
        map: GLOW, color: srgb(color).multiplyScalar(3), size: 14, sizeAttenuation: false,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
    });
    const pts = new THREE.Points(geo, mat);
    pts.renderOrder = 3;
    station.add(pts);
    return mat;
});

// Glow so the ISS can be found from far away
const ISS_GLOW = { sunlit: srgb(0xfff1cf).multiplyScalar(0.9), shadow: srgb(0x9fb2ff).multiplyScalar(0.8) };
const issGlowGeo = new THREE.BufferGeometry();
issGlowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
const issGlowMat = new THREE.PointsMaterial({
    map: GLOW, color: ISS_GLOW.sunlit.clone(), size: 36, sizeAttenuation: false,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
});
const issGlow = new THREE.Points(issGlowGeo, issGlowMat);
issGlow.renderOrder = 3;
scene.add(issGlow);

// ─── EACH FRAME ──────────────────────────────────────────────────────────────
// Sunlight reaching the station: grazing the atmosphere it reddens and fades
// (orbital sunrise and sunset), behind the Earth it's gone.
const SUN_GRAZE_DEPTH = new THREE.Vector3(1.7, 4.1, 10);   // Rayleigh optical depth along a grazing ray
const SCALE_HEIGHT    = 8 / 1274;                          // 8 km in scene units
const _sunColour = new THREE.Color(), _basis = new THREE.Matrix4(), _toLocal = new THREE.Quaternion();

function sunAtStation(p) {
    const t = p.dot(sunDir);
    const h = t >= 0 ? Infinity : p.clone().addScaledVector(sunDir, -t).length() - R;   // ray's closest pass above the ground
    if (h === Infinity) return _sunColour.setRGB(1, 1, 1);
    const air = Math.exp(-Math.max(h, 0) / SCALE_HEIGHT);
    const fade = THREE.MathUtils.smoothstep(h, -0.002, 0.002);
    return _sunColour.setRGB(Math.exp(-SUN_GRAZE_DEPTH.x * air), Math.exp(-SUN_GRAZE_DEPTH.y * air), Math.exp(-SUN_GRAZE_DEPTH.z * air)).multiplyScalar(fade);
}

// live: the ISS frame from app.js. close: 1 riding along, 0 far out.
// inside: looking out of the Cupola, so the model itself is hidden.
function updateStation(live, close, far, elapsed, dt, riding, inside) {
    const { p, up, fwd, side } = live;
    station.visible = close > 0.002 && !inside;
    station.position.copy(p);
    station.quaternion.setFromRotationMatrix(_basis.makeBasis(side, up, fwd));
    _toLocal.copy(station.quaternion).invert();
    stationModel.userData.track?.(sunDir.clone().applyQuaternion(_toLocal));

    const sun = sunAtStation(p);
    sunLight.color.copy(sun);
    sunLight.intensity = 1.7;
    sunLight.position.copy(p).addScaledVector(sunDir, 0.25);
    sunLight.target.position.copy(p);
    const lit = (sun.r + sun.g + sun.b) / 3;

    // Earthshine is strongest over the day side
    earthshine.position.copy(up);
    earthshine.intensity = 0.05 + 0.9 * THREE.MathUtils.smoothstep(up.dot(sunDir), -0.15, 0.4);
    ambient.intensity += ((lit < 0.05 ? 0.55 : 0.12) - ambient.intensity) * (1 - Math.exp(-dt * 2));
    nightFill.intensity += ((lit < 0.05 ? 0.6 : 0) - nightFill.intensity) * (1 - Math.exp(-dt * 2));
    nightFill.position.copy(p).addScaledVector(up, 0.3).addScaledVector(side, 0.15);
    nightFill.target.position.copy(p);

    // Inside the Cupola: place the dome on the station, light the cabin, and
    // widen the sun's shadow box to take in the whole dome
    cupolaRig.visible = inside;
    cabinLight.intensity = inside ? 0.35 : 0;
    if (inside) {
        cupolaRig.position.copy(p);
        cupolaRig.quaternion.copy(station.quaternion).multiply(_cupolaQ);
        cabinLight.position.copy(p).addScaledVector(up, 0.01);
    }
    const box = inside ? 0.2 : 0.055, cam = sunLight.shadow.camera;
    if (cam.right !== box) {
        Object.assign(cam, { left: -box, right: box, top: box, bottom: -box });
        cam.updateProjectionMatrix();
    }

    // Self-shadows cost a second draw of the model, so not on the lowest tier
    if ((riding && station.visible || inside) && qualityTier > 0) renderer.shadowMap.needsUpdate = true;

    const pulse = REDUCED_MOTION ? 0 : Math.sin(elapsed * 2.4);
    issGlowGeo.attributes.position.setXYZ(0, p.x, p.y, p.z);
    issGlowGeo.attributes.position.needsUpdate = true;
    issGlowMat.size    = 30 * (1 + 0.15 * pulse);
    issGlowMat.opacity = far * (live.sunlit ? 1 : 0.35);
    issGlowMat.color.copy(live.sunlit === false ? ISS_GLOW.shadow : ISS_GLOW.sunlit);
    navLights[0].opacity = navLights[1].opacity = close * (0.75 + 0.25 * Math.sin(elapsed * 3));
    navLights[2].opacity = close * (elapsed % 1.6 < 0.08 ? 1 : 0);
}
