// Cinematic Three.js renderer for Molt City.
//
// Pipeline: physically-based scene → HDR render → SSAO → UnrealBloom →
// ACES filmic tone-mapping (OutputPass). On top of the simulation it adds:
//  - PBR car paint with clearcoat and environment reflections
//  - a real day/night cycle: moving sun + shadows, gradient sky dome, stars
//  - dynamic lighting at night: pooled streetlight + headlight + siren lights
//  - emissive neon shop signage and window glow
//  - wet, reflective asphalt and atmospheric rain after dark
//
// The simulation stays 2D (x, y on the ground); here it maps to (x, height, z).

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Reflector } from "three/addons/objects/Reflector.js";

import { TILE, ROAD, SIDEWALK, PARK } from "./world.js";
import { NPC_STATE } from "./npc.js";
import { mulberry32 } from "./util.js";

const STREETLIGHT_POOL = 10;
const HEADLIGHT_POOL = 4;

// Final grade: vignette, animated film grain, edge chromatic aberration,
// and a gentle contrast/saturation lift for a filmic look.
const CinematicShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    vignette: { value: 1.0 },
    grain: { value: 0.05 },
    aberration: { value: 0.0011 },
    saturation: { value: 1.12 },
    contrast: { value: 1.05 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time, vignette, grain, aberration, saturation, contrast;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      // chromatic aberration grows toward the edges
      vec2 off = c * aberration * r2 * 40.0;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      // contrast + saturation
      col = (col - 0.5) * contrast + 0.5;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, saturation);
      // vignette
      col *= 1.0 - smoothstep(0.4, 1.4, r2 * vignette * 2.0) * 0.55;
      // film grain
      col += (hash(vUv * vec2(1920.0, 1080.0) + time) - 0.5) * grain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Renderer3D {
  constructor(canvas, world, opts = {}) {
    this.world = world;
    this.quality = opts.quality || "high"; // "high" | "fast" (drops SSAO + reflections)
    this.reflections = opts.reflections ?? (this.quality === "high");

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(opts.pixelRatio || (typeof window !== "undefined" ? window.devicePixelRatio : 1), 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x9ec4ea, 0.00035);
    this.camera = new THREE.PerspectiveCamera(58, 16 / 9, 1, 6000);
    this.camPos = new THREE.Vector3(world.player.x, 150, world.player.y + 200);
    this.lookAt = new THREE.Vector3(world.player.x, 14, world.player.y);

    this.buildEnvironment();
    this.buildLights();
    this.buildSky();
    this.buildGround(world.city);
    this.buildBuildings(world.city);
    this.buildTrees(world.city);
    this.buildStreetlights(world.city);
    this.buildStreetProps(world.city);
    this.buildRain();

    this.vehicleMeshes = new Map();
    this.personMeshes = new Map();
    this.lightbars = [];
    this.peopleParts = makePeopleParts();

    this.buildLightPools();
  }

  // --- environment / image-based lighting ------------------------------------

  buildEnvironment() {
    // A small procedural sky used as an environment map so PBR surfaces
    // (car paint, glass) pick up believable reflections.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const geo = new THREE.SphereGeometry(500, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: new THREE.Color(0x6ba3e0) },
        bottom: { value: new THREE.Color(0xcdd6dd) },
      },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vP;
        void main(){ float h = clamp(vP.y/500.0*0.5+0.5,0.0,1.0); gl_FragColor = vec4(mix(bottom, top, h),1.0); }`,
    });
    envScene.add(new THREE.Mesh(geo, mat));
    this.envMap = pmrem.fromScene(envScene).texture;
    this.scene.environment = this.envMap;
    geo.dispose();
    mat.dispose();
    pmrem.dispose();
  }

  buildLights() {
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a3326, 0.55);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    const sc = this.sun.shadow.camera;
    sc.left = -700; sc.right = 700; sc.top = 700; sc.bottom = -700;
    sc.near = 1; sc.far = 3000;
    this.scene.add(this.sun, this.sun.target);

    this.moon = new THREE.DirectionalLight(0x9fb4ff, 0.0);
    this.scene.add(this.moon, this.moon.target);
  }

  buildSky() {
    // Gradient dome whose colors animate across the day; stars fade in at night.
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x2b6fc4) },
        mid: { value: new THREE.Color(0x9ec4ea) },
        bottom: { value: new THREE.Color(0xcdd6dd) },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        moonDir: { value: new THREE.Vector3(0, -1, 0) },
        sunColor: { value: new THREE.Color(0xfff0d0) },
        time: { value: 0 },
        cloud: { value: 0.55 },
        night: { value: 0 },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 top, mid, bottom, sunColor; uniform vec3 sunDir, moonDir;
        uniform float time, cloud, night; varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
        }
        float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.0; a*=0.5; } return v; }
        void main(){
          float h = vDir.y;
          vec3 col = h > 0.0 ? mix(mid, top, pow(h, 0.6)) : mix(mid, bottom, clamp(-h*4.0,0.0,1.0));
          float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
          col += sunColor * pow(s, 90.0) * 1.4;        // sun disc
          col += sunColor * pow(s, 6.0) * 0.18;        // atmospheric glow
          // drifting clouds projected onto the upper hemisphere
          if (h > 0.02) {
            vec2 uv = vDir.xz / (h + 0.25);
            float c = fbm(uv * 2.2 + vec2(time * 0.01, time * 0.004));
            c = smoothstep(0.55, 0.95, c) * cloud * clamp(h * 3.0, 0.0, 1.0);
            vec3 cloudCol = mix(vec3(1.0), vec3(0.18, 0.2, 0.28), night);
            col = mix(col, cloudCol, c * (1.0 - night * 0.4));
          }
          // moon disc + halo at night
          float m = max(dot(normalize(vDir), normalize(moonDir)), 0.0);
          col += vec3(0.85, 0.9, 1.0) * pow(m, 200.0) * night * 2.0;
          col += vec3(0.4, 0.5, 0.7) * pow(m, 8.0) * night * 0.2;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), this.skyMat);
    dome.frustumCulled = false;
    this.scene.add(dome);

    const rng = mulberry32(5);
    const N = 1400;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = rng() * 2 - 1;
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos[i * 3] = Math.cos(a) * r * 3600;
      pos[i * 3 + 1] = Math.abs(u) * 3600 + 200;
      pos[i * 3 + 2] = Math.sin(a) * r * 3600;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 14, transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  // --- static scenery --------------------------------------------------------

  buildGround(city) {
    const S = 16; // texture pixels per tile
    const cv = document.createElement("canvas");
    cv.width = city.w * S;
    cv.height = city.h * S;
    const g = cv.getContext("2d");
    // Roughness map: asphalt is glossier (wet sheen), sidewalks matte.
    const rcv = document.createElement("canvas");
    rcv.width = cv.width;
    rcv.height = cv.height;
    const rg = rcv.getContext("2d");
    // Alpha map: roads are semi-transparent so the reflector layer shows through.
    const acv = document.createElement("canvas");
    acv.width = cv.width;
    acv.height = cv.height;
    const ag = acv.getContext("2d");
    ag.fillStyle = "#fff";
    ag.fillRect(0, 0, acv.width, acv.height);
    const rng = mulberry32(9);
    const inter = (tx, ty) => tx % 10 < 2 && ty % 10 < 2;
    for (let ty = 0; ty < city.h; ty++) {
      for (let tx = 0; tx < city.w; tx++) {
        const t = city.tileAt(tx, ty);
        const x = tx * S;
        const y = ty * S;
        if (t === ROAD) {
          g.fillStyle = `rgb(${44 + rng() * 8 | 0},${46 + rng() * 8 | 0},${52 + rng() * 8 | 0})`;
          g.fillRect(x, y, S, S);
          g.fillStyle = "#d8c45a";
          if (tx % 10 === 1 && ty % 10 >= 2 && ty % 4 < 2) g.fillRect(x - 1, y + 2, 2, S - 4);
          if (ty % 10 === 1 && tx % 10 >= 2 && tx % 4 < 2) g.fillRect(x + 2, y - 1, S - 4, 2);
          // Crosswalk stripes where a road tile meets an intersection.
          const nearInter = inter(tx + 2, ty) || inter(tx - 2, ty) || inter(tx, ty + 2) || inter(tx, ty - 2);
          if (nearInter && !inter(tx, ty)) {
            g.fillStyle = "#cfd2d6";
            if (inter(tx, ty + 2) || inter(tx, ty - 2)) {
              for (let s = 0; s < S; s += 5) g.fillRect(x + s, y + 2, 3, S - 4);
            } else {
              for (let s = 0; s < S; s += 5) g.fillRect(x + 2, y + s, S - 4, 3);
            }
          }
          rg.fillStyle = "#333"; // low roughness → reflective when wet
          ag.fillStyle = "#969696"; // ~0.41 reflection, keeps asphalt readable
          ag.fillRect(x, y, S, S);
        } else if (t === SIDEWALK) {
          g.fillStyle = "#9a9aa2";
          g.fillRect(x, y, S, S);
          g.strokeStyle = "#86868e";
          g.strokeRect(x + 0.5, y + 0.5, S - 1, S - 1);
          rg.fillStyle = "#cc";
        } else if (t === PARK) {
          g.fillStyle = `rgb(${70 + rng() * 16 | 0},${120 + rng() * 22 | 0},${66 + rng() * 14 | 0})`;
          g.fillRect(x, y, S, S);
          rg.fillStyle = "#ee";
        } else {
          g.fillStyle = "#2b2d31";
          g.fillRect(x, y, S, S);
          rg.fillStyle = "#aa";
        }
        rg.fillRect(x, y, S, S);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const rough = new THREE.CanvasTexture(rcv);
    const W = city.w * TILE;
    const H = city.h * TILE;

    // True planar reflections for wet streets (high quality only).
    if (this.reflections) {
      this.roadReflector = new Reflector(new THREE.PlaneGeometry(W, H), {
        textureWidth: 512, textureHeight: 512, color: 0x33373d,
      });
      this.roadReflector.rotation.x = -Math.PI / 2;
      this.roadReflector.position.set(W / 2, 0.05, H / 2);
      this.roadReflector.visible = false; // only wet at night
      this.scene.add(this.roadReflector);
    }

    const alpha = new THREE.CanvasTexture(acv);
    // Starts dry/opaque; render() switches the roads to reflective at night.
    this.groundMat = new THREE.MeshStandardMaterial({
      map: tex, roughnessMap: rough, roughness: 1, metalness: 0.1, envMapIntensity: 0.4,
      alphaMap: this.reflections ? alpha : null,
      transparent: false,
      depthWrite: true,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, H), this.groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(W / 2, this.reflections ? 0.3 : 0, H / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  buildBuildings(city) {
    const rng = mulberry32(31);
    const facades = makeFacadeMaterials();
    const roof = new THREE.MeshStandardMaterial({ color: 0x34363c, roughness: 0.95 });
    this.windowMats = facades.map((f) => f.mat);
    const neonColors = [0xff3b6b, 0x36e0ff, 0xffd23b, 0x8b5bff, 0x3bff9e];
    this.neonMats = [];

    for (const b of city.buildings) {
      const floors = b.kind === "office" ? 8 + Math.floor(rng() * 9)
        : b.kind === "house" ? 4 + Math.floor(rng() * 3)
          : 2 + Math.floor(rng() * 2);
      const h = floors * 15;
      const w = b.tw * TILE - 8;
      const d = b.th * TILE - 8;
      const f = facades[Math.floor(rng() * facades.length)];
      const side = f.mat.clone();
      side.color = new THREE.Color(b.color).multiplyScalar(1.5);
      // Tile the window texture per floor so windows stay a sane size on tall towers.
      side.map = f.mat.map.clone();
      side.map.wrapS = side.map.wrapT = THREE.RepeatWrapping;
      side.map.repeat.set(Math.max(1, Math.round(w / 30)), floors);
      side.map.needsUpdate = true;
      side.emissiveMap = f.mat.emissiveMap.clone();
      side.emissiveMap.wrapS = side.emissiveMap.wrapT = THREE.RepeatWrapping;
      side.emissiveMap.repeat.copy(side.map.repeat);
      side.emissiveMap.needsUpdate = true;
      side.emissive = new THREE.Color(0xffe6b0);
      side.emissiveIntensity = 0;
      this.windowMats.push(side);

      const cx = (b.tx + b.tw / 2) * TILE;
      const cz = (b.ty + b.th / 2) * TILE;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, roof, roof, side, side]);
      mesh.position.set(cx, h / 2, cz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      // Rooftop detail for skyline interest.
      if (b.kind === "office") {
        const ac = new THREE.Mesh(
          new THREE.BoxGeometry(w * 0.3, 8, d * 0.3),
          new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 1 }),
        );
        ac.position.set(cx + (rng() - 0.5) * w * 0.3, h + 4, cz + (rng() - 0.5) * d * 0.3);
        ac.castShadow = true;
        this.scene.add(ac);
      }

      // Neon storefront sign that glows at night.
      if (b.kind === "shop") {
        const col = neonColors[Math.floor(rng() * neonColors.length)];
        const sign = makeNeonSign(b.name, col);
        sign.mesh.position.set(cx, 22, cz + d / 2 + 1.2);
        this.scene.add(sign.mesh);
        this.neonMats.push(sign.mat);
        const back = new THREE.Mesh(sign.mesh.geometry.clone(),
          new THREE.MeshStandardMaterial({ map: sign.tex, transparent: true, emissive: col, emissiveMap: sign.tex, emissiveIntensity: 0 }));
        back.position.set(cx, 22, cz - d / 2 - 1.2);
        back.rotation.y = Math.PI;
        this.scene.add(back);
        this.neonMats.push(back.material);
      }
    }
  }

  buildTrees(city) {
    const trunkG = new THREE.CylinderGeometry(1.6, 2.4, 12, 6);
    const trunkM = new THREE.MeshStandardMaterial({ color: 0x4f3a24, roughness: 1 });
    const leafM = new THREE.MeshStandardMaterial({ color: 0x2c6b2e, roughness: 1, flatShading: true });
    for (const tr of city.trees) {
      const grp = new THREE.Group();
      const trunk = new THREE.Mesh(trunkG, trunkM);
      trunk.position.y = 6;
      trunk.castShadow = true;
      const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(tr.r * 1.2, 1), leafM);
      leaves.position.y = 14 + tr.r * 0.5;
      leaves.castShadow = true;
      leaves.scale.y = 1.2;
      grp.add(trunk, leaves);
      grp.position.set(tr.x, 0, tr.y);
      this.scene.add(grp);
    }
  }

  buildStreetlights(city) {
    // Lamp posts along road-adjacent sidewalks, drawn as instanced geometry.
    this.lampPositions = [];
    for (let ty = 2; ty < city.h - 2; ty += 1) {
      for (let tx = 2; tx < city.w - 2; tx += 1) {
        if (city.tileAt(tx, ty) !== SIDEWALK) continue;
        // Sidewalk columns sit at tx%10 === 2 or 9; drop a lamp every few rows.
        if ((tx % 10 !== 2 && tx % 10 !== 9) || ty % 6 !== 0) continue;
        const nearRoad = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => city.tileAt(tx + dx, ty + dy) === ROAD);
        if (!nearRoad) continue;
        this.lampPositions.push(new THREE.Vector3((tx + 0.5) * TILE, 0, (ty + 0.5) * TILE));
      }
    }
    this.bulbMat = new THREE.MeshStandardMaterial({ color: 0xffe39a, emissive: 0xffd27a, emissiveIntensity: 0 });
    const n = this.lampPositions.length;
    if (!n) return;
    const postG = new THREE.CylinderGeometry(0.8, 1.1, 30, 6);
    const postM = new THREE.MeshStandardMaterial({ color: 0x2c2e33, roughness: 0.7, metalness: 0.6 });
    const posts = new THREE.InstancedMesh(postG, postM, n);
    const bulbG = new THREE.SphereGeometry(2.2, 8, 6);
    const bulbs = new THREE.InstancedMesh(bulbG, this.bulbMat, n);
    const m = new THREE.Matrix4();
    this.lampPositions.forEach((p, i) => {
      m.makeTranslation(p.x, 15, p.z);
      posts.setMatrixAt(i, m);
      m.makeTranslation(p.x, 30, p.z);
      bulbs.setMatrixAt(i, m);
    });
    posts.castShadow = true;
    this.scene.add(posts, bulbs);
  }

  buildStreetProps(city) {
    const rng = mulberry32(202);
    this.trafficLights = [];

    // Reusable geometry/materials.
    const poleG = new THREE.CylinderGeometry(0.7, 0.9, 26, 6);
    const poleM = new THREE.MeshStandardMaterial({ color: 0x23252a, roughness: 0.6, metalness: 0.7 });
    const housG = new THREE.BoxGeometry(3, 9, 3.5);
    const housM = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 });
    const lensG = new THREE.SphereGeometry(1.1, 8, 6);

    const placeTrafficLight = (px, pz, faceY) => {
      const grp = new THREE.Group();
      const pole = new THREE.Mesh(poleG, poleM);
      pole.position.y = 13;
      pole.castShadow = true;
      const housing = new THREE.Mesh(housG, housM);
      housing.position.set(0, 24, 2);
      grp.add(pole, housing);
      const reds = [];
      const ambers = [];
      const greens = [];
      const mk = (color, y) => {
        const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.2 });
        const lens = new THREE.Mesh(lensG, m);
        lens.position.set(0, y, 3.8);
        grp.add(lens);
        return m;
      };
      reds.push(mk(0xff2a2a, 27));
      ambers.push(mk(0xffb12a, 24));
      greens.push(mk(0x2aff5a, 21));
      grp.position.set(px, 0, pz);
      grp.rotation.y = faceY;
      this.scene.add(grp);
      // Axis decides phase so cross-streets show opposite signals.
      this.trafficLights.push({ red: reds[0], amber: ambers[0], green: greens[0], phase: faceY > 0.1 ? 0 : 0.5 });
    };

    const placeBox = (geo, mat, px, py, pz, ry = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(px, py, pz);
      m.rotation.y = ry;
      m.castShadow = true;
      this.scene.add(m);
    };

    const hydrantG = new THREE.CylinderGeometry(1.3, 1.5, 5, 8);
    const hydrantM = new THREE.MeshStandardMaterial({ color: 0xcc3322, roughness: 0.6 });
    const canG = new THREE.CylinderGeometry(2, 1.8, 6, 8);
    const canM = new THREE.MeshStandardMaterial({ color: 0x2f5d3a, roughness: 0.8, metalness: 0.3 });
    const benchSeatG = new THREE.BoxGeometry(12, 1.2, 4);
    const benchM = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 1 });

    for (let ty = 2; ty < city.h - 2; ty++) {
      for (let tx = 2; tx < city.w - 2; tx++) {
        const t = city.tileAt(tx, ty);
        const px = (tx + 0.5) * TILE;
        const pz = (ty + 0.5) * TILE;
        // Traffic lights on the corner sidewalk of each intersection.
        if (t === SIDEWALK && tx % 10 === 2 && ty % 10 === 2) {
          placeTrafficLight(px, pz, (tx / 10 + ty / 10) % 2 < 1 ? 0 : Math.PI / 2);
          continue;
        }
        if (t === SIDEWALK) {
          if (rng() < 0.03) placeBox(hydrantG, hydrantM, px, 2.5, pz);
          else if (rng() < 0.03) placeBox(canG, canM, px, 3, pz);
        } else if (t === PARK && rng() < 0.04) {
          placeBox(benchSeatG, benchM, px, 4, pz, rng() * Math.PI);
        }
      }
    }
  }

  buildRain() {
    const N = 1800;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 900;
      pos[i * 3 + 1] = Math.random() * 600;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 900;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.rainMat = new THREE.PointsMaterial({ color: 0xaecbe0, size: 2.4, transparent: true, opacity: 0, depthWrite: false, fog: true });
    this.rain = new THREE.Points(g, this.rainMat);
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  buildLightPools() {
    this.streetLights = [];
    for (let i = 0; i < STREETLIGHT_POOL; i++) {
      const l = new THREE.PointLight(0xffd27a, 0, 220, 1.6);
      l.visible = false;
      this.scene.add(l);
      this.streetLights.push(l);
    }
    this.headLights = [];
    for (let i = 0; i < HEADLIGHT_POOL; i++) {
      const s = new THREE.SpotLight(0xfff4d6, 0, 360, Math.PI / 7, 0.5, 1.4);
      s.visible = false;
      this.scene.add(s, s.target);
      this.headLights.push(s);
    }
    this.sirenLights = [
      new THREE.PointLight(0xff2222, 0, 160, 2),
      new THREE.PointLight(0x2244ff, 0, 160, 2),
    ];
    for (const s of this.sirenLights) { s.visible = false; this.scene.add(s); }
  }

  setupComposer(w, h) {
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    if (this.quality === "high") {
      this.ssao = new SSAOPass(this.scene, this.camera, w, h);
      this.ssao.kernelRadius = 10;
      this.ssao.minDistance = 0.0015;
      this.ssao.maxDistance = 0.08;
      this.composer.addPass(this.ssao);
    }
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.cinematic = new ShaderPass(CinematicShader);
    this.composer.addPass(this.cinematic);
    this.composer.addPass(new OutputPass());
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.composer) this.setupComposer(w, h);
    this.composer.setSize(w, h);
    if (this.ssao) this.ssao.setSize(w, h);
    if (this.bloom) this.bloom.setSize(w, h);
  }

  // --- dynamic entities -------------------------------------------------------

  vehicleMesh(v) {
    let g = this.vehicleMeshes.get(v);
    if (g) return g;
    g = new THREE.Group();
    const bodyM = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(v.color), metalness: 0.45, roughness: 0.32,
      clearcoat: 1, clearcoatRoughness: 0.18, envMapIntensity: 1.1,
    });
    const glassM = new THREE.MeshPhysicalMaterial({
      color: 0x10141c, metalness: 0, roughness: 0.06, transmission: 0.2,
      clearcoat: 1, envMapIntensity: 1.3,
    });
    // Lower body + tapered cabin for a car-like silhouette.
    const body = new THREE.Mesh(new THREE.BoxGeometry(v.length, 8, v.width), bodyM);
    body.position.y = 7;
    body.castShadow = true;
    const hood = new THREE.Mesh(new THREE.BoxGeometry(v.length * 0.5, 6, v.width * 0.92), bodyM);
    hood.position.set(v.length * 0.02, 13, 0);
    hood.castShadow = true;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(v.length * 0.42, 7, v.width * 0.82), glassM);
    cabin.position.set(-v.length * 0.05, 17.5, 0);
    cabin.castShadow = true;
    g.add(body, hood, cabin);

    const wheelG = new THREE.CylinderGeometry(4.2, 4.2, 3.4, 12);
    const wheelM = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.85 });
    const hubM = new THREE.MeshStandardMaterial({ color: 0x999, metalness: 0.9, roughness: 0.3 });
    for (const [wx, wz] of [[13, 9.5], [13, -9.5], [-13, 9.5], [-13, -9.5]]) {
      const wheel = new THREE.Mesh(wheelG, [wheelM, hubM, hubM]);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(wx, 4.2, wz);
      g.add(wheel);
    }

    const headM = new THREE.MeshStandardMaterial({ color: 0xfff6cc, emissive: 0xfff2c0, emissiveIntensity: 0 });
    const tailM = new THREE.MeshStandardMaterial({ color: 0x440000, emissive: 0xff1818, emissiveIntensity: 0.4 });
    g.userData.headM = headM;
    g.userData.tailM = tailM;
    for (const z of [7, -7]) {
      const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.5, 3.5), headM);
      head.position.set(v.length / 2, 8, z);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.5, 3.5), tailM);
      tail.position.set(-v.length / 2, 8, z);
      g.add(head, tail);
    }

    if (v.police) {
      bodyM.color.set(0xf4f4f8);
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(v.length * 0.32, 8.4, v.width + 0.4),
        new THREE.MeshStandardMaterial({ color: 0x12142a }),
      );
      stripe.position.y = 7;
      g.add(stripe);
      const red = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff2222, emissiveIntensity: 1 });
      const blue = new THREE.MeshStandardMaterial({ color: 0x2244ff, emissive: 0x2244ff, emissiveIntensity: 1 });
      const lr = new THREE.Mesh(new THREE.BoxGeometry(4, 2.5, 6), red);
      lr.position.set(2, 22, 4);
      const lb = new THREE.Mesh(new THREE.BoxGeometry(4, 2.5, 6), blue);
      lb.position.set(2, 22, -4);
      g.add(lr, lb);
      this.lightbars.push({ red, blue, group: g });
    }

    this.scene.add(g);
    this.vehicleMeshes.set(v, g);
    return g;
  }

  personMesh(p, color) {
    let g = this.personMeshes.get(p);
    if (g) return g;
    g = new THREE.Group();
    const shirtMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.85 });
    const torso = new THREE.Mesh(this.peopleParts.body, shirtMat);
    torso.position.y = 9;
    torso.castShadow = true;
    const head = new THREE.Mesh(this.peopleParts.head, this.peopleParts.skin);
    head.position.y = 18;
    head.castShadow = true;
    // Legs and arms pivot from the hip/shoulder (geometry offset downward).
    const legL = new THREE.Mesh(this.peopleParts.limb, this.peopleParts.pants);
    const legR = new THREE.Mesh(this.peopleParts.limb, this.peopleParts.pants);
    legL.position.set(0, 7, 1.6);
    legR.position.set(0, 7, -1.6);
    const armL = new THREE.Mesh(this.peopleParts.arm, shirtMat);
    const armR = new THREE.Mesh(this.peopleParts.arm, shirtMat);
    armL.position.set(0, 14, 4);
    armR.position.set(0, 14, -4);
    legL.castShadow = legR.castShadow = armL.castShadow = armR.castShadow = true;
    g.add(torso, head, legL, legR, armL, armR);
    g.userData.legL = legL;
    g.userData.legR = legR;
    g.userData.armL = armL;
    g.userData.armR = armR;
    this.scene.add(g);
    this.personMeshes.set(p, g);
    return g;
  }

  // --- frame ------------------------------------------------------------------

  render(dt, t) {
    const world = this.world;
    const pl = world.player;

    for (const v of world.vehicles) {
      const g = this.vehicleMesh(v);
      g.position.set(v.x, 0, v.y);
      g.rotation.y = -v.angle;
      if (g.userData.tailM) {
        const braking = (v === pl.vehicle) ? (v.speed < -2) : false;
        g.userData.tailM.emissiveIntensity = braking ? 2.5 : 0.5;
      }
    }
    this.animatePerson(this.personMesh(pl, "#eef0f4"), pl, t, !pl.vehicle, false);
    for (const npc of world.npcs) {
      const g = this.personMesh(npc, npc.shirt);
      this.animatePerson(g, npc, t, !npc.indoor, npc.state === NPC_STATE.DOWNED);
    }
    for (const cop of world.cops) this.animatePerson(this.personMesh(cop, "#243f7c"), cop, t, true, false);
    for (const [p, g] of this.personMeshes) {
      if (p.arrestTimer !== undefined && !world.cops.includes(p)) {
        this.scene.remove(g);
        this.personMeshes.delete(p);
      }
    }

    // --- day / night driving --------------------------------------------------
    const hr = world.time.hour + world.time.minute / 60;
    const elev = Math.sin(((hr - 6) / 12) * Math.PI);
    const day = clamp01(elev * 1.5 + 0.04);
    const night = 1 - clamp01(day * 2.2);
    const dawn = clamp01(1 - Math.abs(hr - 6.5) / 1.5) + clamp01(1 - Math.abs(hr - 18) / 1.5);

    this.sun.intensity = day * 2.4;
    this.hemi.intensity = 0.24 + day * 0.46;
    this.moon.intensity = night * 0.5;
    this.renderer.toneMappingExposure = 1.0 + day * 0.25;

    // sky + fog colors
    const skyTop = new THREE.Color(0x05060f).lerp(new THREE.Color(0x2b6fc4), day);
    const skyMid = new THREE.Color(0x0a0e1f).lerp(new THREE.Color(0x9ec4ea), day);
    const skyBot = new THREE.Color(0x141019).lerp(new THREE.Color(0xcdd6dd), day);
    const warm = new THREE.Color(0xff7a3c).multiplyScalar(dawn * 0.5);
    skyMid.add(warm);
    skyBot.add(warm);
    this.skyMat.uniforms.top.value.copy(skyTop);
    this.skyMat.uniforms.mid.value.copy(skyMid);
    this.skyMat.uniforms.bottom.value.copy(skyBot);
    this.scene.fog.color.copy(skyMid);
    this.scene.fog.density = 0.00035 + night * 0.0004;
    this.starMat.opacity = night;
    this.groundMat.envMapIntensity = 0.4 + night * 1.4; // wet sheen at night

    // Roads turn reflective (wet) only after dark; saves a full reflection
    // render pass during the day. Toggle on transition to avoid recompiles.
    if (this.reflections) {
      const wet = night > 0.15;
      if (wet !== this._wet) {
        this._wet = wet;
        this.groundMat.transparent = wet;
        this.groundMat.needsUpdate = true;
        if (this.roadReflector) this.roadReflector.visible = wet;
      }
    }

    // sun/moon position relative to player
    const az = 2.2;
    const sunY = Math.max(-0.3, elev) * 1100;
    this.sun.position.set(pl.x + Math.cos(az) * 900, sunY + 60, pl.y + Math.sin(az) * 900);
    this.sun.target.position.set(pl.x, 0, pl.y);
    this.sun.target.updateMatrixWorld();
    this.moon.position.set(pl.x - Math.cos(az) * 900, 700, pl.y - Math.sin(az) * 900);
    this.moon.target.position.set(pl.x, 0, pl.y);
    this.moon.target.updateMatrixWorld();
    const sd = this.sun.position.clone().sub(this.sun.target.position).normalize();
    this.skyMat.uniforms.sunDir.value.copy(sd);
    this.skyMat.uniforms.moonDir.value.copy(this.moon.position.clone().sub(this.moon.target.position).normalize());
    this.skyMat.uniforms.sunColor.value.set(dawn > 0.3 ? 0xff8a4a : 0xfff0d0);
    this.skyMat.uniforms.time.value = t;
    this.skyMat.uniforms.night.value = night;

    // emissive windows / neon / streetlamp bulbs come up at dusk
    const lit = clamp01(night * 1.5);
    for (const m of this.windowMats) m.emissiveIntensity = lit * 0.9;
    for (const m of this.neonMats) m.emissiveIntensity = lit * 2.2;
    this.bulbMat.emissiveIntensity = lit * 2;
    if (this.bloom) this.bloom.strength = 0.4 + lit * 0.55;

    this.updateDynamicLights(lit, pl);
    this.updateRain(dt, night, pl);

    for (const lb of this.lightbars) {
      const on = Math.floor(t * 6) % 2 === 0;
      lb.red.emissiveIntensity = on ? 3 : 0.1;
      lb.blue.emissiveIntensity = on ? 0.1 : 3;
    }

    if (this.trafficLights) {
      const cyc = (t * 0.1) % 1; // ~10s full cycle
      for (const tl of this.trafficLights) {
        const p = (cyc + tl.phase) % 1;
        tl.green.emissiveIntensity = p < 0.42 ? 1.8 : 0.05;
        tl.amber.emissiveIntensity = p >= 0.42 && p < 0.5 ? 1.8 : 0.05;
        tl.red.emissiveIntensity = p >= 0.5 ? 1.8 : 0.05;
      }
    }

    // --- chase camera ---------------------------------------------------------
    const driving = !!pl.vehicle;
    const heading = driving ? pl.vehicle.angle : pl.angle;
    const back = driving ? 195 : 135;
    const height = driving ? 155 : 120;
    const desired = new THREE.Vector3(pl.x - Math.cos(heading) * back, height, pl.y - Math.sin(heading) * back);
    this.camPos.lerp(desired, 1 - Math.pow(0.0015, dt));
    this.camera.position.copy(this.camPos);
    this.lookAt.lerp(new THREE.Vector3(pl.x + Math.cos(heading) * 40, 16, pl.y + Math.sin(heading) * 40), 1 - Math.pow(0.002, dt));
    this.camera.lookAt(this.lookAt);

    this.stars.position.copy(this.camera.position);
    if (this.cinematic) {
      this.cinematic.uniforms.time.value = t;
      this.cinematic.uniforms.grain.value = 0.022 + night * 0.028;
    }
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  animatePerson(g, e, t, visible, downed) {
    g.visible = visible;
    if (!visible) return;
    g.position.set(e.x, 0, e.y);
    g.rotation.y = -e.angle;
    if (downed) {
      g.rotation.z = Math.PI / 2;
      g.position.y = -3;
      return;
    }
    g.rotation.z = 0;
    const moving = e.path ? e.pathIdx < (e.path.length || 0) : true;
    const swing = moving ? Math.sin(t * 9 + e.id * 1.3) * 0.5 : 0;
    g.userData.legL.rotation.z = swing;
    g.userData.legR.rotation.z = -swing;
    g.userData.armL.rotation.z = -swing * 0.8; // arms counter the legs
    g.userData.armR.rotation.z = swing * 0.8;
    g.position.y = Math.abs(Math.sin(t * 9 + e.id)) * (moving ? 1 : 0.2);
  }

  updateDynamicLights(lit, pl) {
    // Assign the streetlight pool to the lamps nearest the player.
    if (this.lampPositions && this.streetLights.length) {
      const near = this.lampPositions
        .map((p) => ({ p, d: (p.x - pl.x) ** 2 + (p.z - pl.y) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, this.streetLights.length);
      this.streetLights.forEach((l, i) => {
        if (lit > 0.05 && near[i]) {
          l.position.set(near[i].p.x, 30, near[i].p.z);
          l.intensity = lit * 900;
          l.visible = true;
        } else l.visible = false;
      });
    }

    // Headlights for the player's car + nearest AI cars at night.
    const world = this.world;
    const cars = world.vehicles
      .filter((v) => v.driver)
      .map((v) => ({ v, d: (v.x - pl.x) ** 2 + (v.y - pl.y) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.headLights.length);
    this.headLights.forEach((s, i) => {
      const e = cars[i];
      const headM = e && this.vehicleMeshes.get(e.v)?.userData.headM;
      if (headM) headM.emissiveIntensity = lit > 0.05 ? 3 : 0;
      if (e && lit > 0.05) {
        const v = e.v;
        const fx = Math.cos(v.angle), fz = Math.sin(v.angle);
        s.position.set(v.x + fx * v.length * 0.5, 10, v.y + fz * v.length * 0.5);
        s.target.position.set(v.x + fx * 200, 0, v.y + fz * 200);
        s.target.updateMatrixWorld();
        s.intensity = lit * 1400;
        s.visible = true;
      } else s.visible = false;
    });

    // Siren glow follows the nearest visible police car.
    const cop = world.vehicles.find((v) => v.police && v.driver);
    if (cop) {
      this.sirenLights[0].position.set(cop.x, 26, cop.y);
      this.sirenLights[1].position.set(cop.x, 26, cop.y);
      const on = Math.floor(performance.now() / 160) % 2 === 0;
      this.sirenLights[0].intensity = on ? 800 : 0;
      this.sirenLights[1].intensity = on ? 0 : 800;
      this.sirenLights[0].visible = this.sirenLights[1].visible = true;
    } else {
      this.sirenLights[0].visible = this.sirenLights[1].visible = false;
    }
  }

  updateRain(dt, night, pl) {
    const wet = night; // rain only really shows at night here
    this.rainMat.opacity = wet * 0.5;
    if (wet < 0.05) return;
    const pos = this.rain.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let y = pos.getY(i) - 700 * dt;
      if (y < 0) {
        y = 600;
        pos.setX(i, pl.x + (Math.random() - 0.5) * 900);
        pos.setZ(i, pl.y + (Math.random() - 0.5) * 900);
      }
      pos.setY(i, y);
    }
    this.rain.position.set(0, 0, 0);
    pos.needsUpdate = true;
  }

  project(x, height, z, vw, vh) {
    const v = new THREE.Vector3(x, height, z).project(this.camera);
    if (v.z > 1 || Math.abs(v.x) > 1.3 || Math.abs(v.y) > 1.3) return null;
    return { x: ((v.x + 1) / 2) * vw, y: ((1 - v.y) / 2) * vh };
  }
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function makeFacadeMaterials() {
  const out = [];
  const rng = mulberry32(77);
  for (let i = 0; i < 5; i++) {
    const cv = document.createElement("canvas");
    cv.width = 128;
    cv.height = 256;
    const g = cv.getContext("2d");
    const base = 90 + rng() * 40;
    g.fillStyle = `rgb(${base | 0},${(base - 4) | 0},${(base + 6) | 0})`;
    g.fillRect(0, 0, 128, 256);
    const lit = document.createElement("canvas");
    lit.width = 128;
    lit.height = 256;
    const gl = lit.getContext("2d");
    gl.fillStyle = "#000";
    gl.fillRect(0, 0, 128, 256);
    // One "floor" band; the building tiles this vertically.
    g.fillStyle = "#1c1f26";
    g.fillRect(0, 0, 128, 4);
    for (let wx = 0; wx < 4; wx++) {
      const x = 14 + wx * 28;
      const isLit = rng() < 0.45;
      g.fillStyle = isLit ? "#cfd8e8" : "#252932";
      g.fillRect(x, 30, 18, 36);
      g.fillStyle = "rgba(255,255,255,0.12)";
      g.fillRect(x, 30, 18, 6);
      if (isLit) {
        gl.fillStyle = "#ffe1a0";
        gl.fillRect(x, 30, 18, 36);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const emis = new THREE.CanvasTexture(lit);
    emis.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: emis, emissive: 0xffe6b0, emissiveIntensity: 0, roughness: 0.85, metalness: 0.05,
    });
    out.push({ mat });
  }
  return out;
}

function makeNeonSign(text, color) {
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 64;
  const g = cv.getContext("2d");
  g.clearRect(0, 0, 256, 64);
  g.font = "bold 30px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const hex = "#" + new THREE.Color(color).getHexString();
  g.shadowColor = hex;
  g.shadowBlur = 14;
  g.fillStyle = "#fff";
  g.fillText(text, 128, 34);
  g.fillStyle = hex;
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, emissive: color, emissiveMap: tex, emissiveIntensity: 0, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(40, 10), mat);
  return { mesh, mat, tex };
}

function makePeopleParts() {
  // Limbs are offset so their origin sits at the pivot (hip/shoulder).
  const limb = new THREE.CylinderGeometry(1.5, 1.3, 8, 8);
  limb.translate(0, -4, 0);
  const arm = new THREE.CylinderGeometry(1.1, 1.0, 8, 8);
  arm.translate(0, -4, 0);
  return {
    body: new THREE.CapsuleGeometry(3.2, 7, 4, 10),
    limb,
    arm,
    head: new THREE.SphereGeometry(2.8, 12, 10),
    skin: new THREE.MeshStandardMaterial({ color: 0xe0b48c, roughness: 0.8 }),
    pants: new THREE.MeshStandardMaterial({ color: 0x2c3040, roughness: 1 }),
  };
}
