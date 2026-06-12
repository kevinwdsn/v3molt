// Three.js renderer: real-time 3D city built from the same simulation state.
// Extruded buildings with lit windows, sun with dynamic shadows, day/night sky,
// fog, headlights, and a GTA-style chase camera. The simulation stays 2D
// (x, y on the ground plane); here it maps to (x, height, z).

import * as THREE from "three";
import { TILE, ROAD, SIDEWALK, PARK } from "./world.js";
import { NPC_STATE } from "./npc.js";
import { mulberry32 } from "./util.js";

const SKY_DAY = new THREE.Color(0x87b5e8);
const SKY_NIGHT = new THREE.Color(0x0a0e24);

export class Renderer3D {
  constructor(canvas, world) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(SKY_DAY.clone(), 500, 2400);
    this.camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 4000);
    this.camPos = new THREE.Vector3(world.player.x, 150, world.player.y + 200);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 1.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -600; sc.right = 600; sc.top = 600; sc.bottom = -600;
    sc.near = 1; sc.far = 2500;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.moon = new THREE.DirectionalLight(0x8899ff, 0.0);
    this.moon.position.set(300, 500, -200);
    this.scene.add(this.moon);

    this.vehicleMeshes = new Map();
    this.personMeshes = new Map();
    this.lightbars = [];
    this.lampMats = []; // emissive headlight/window materials toggled at night

    this.buildGround(world.city);
    this.buildBuildings(world.city);
    this.buildTrees(world.city);

    this.peopleParts = makePeopleParts();
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // --- static scenery --------------------------------------------------------

  buildGround(city) {
    const S = 16; // texture pixels per tile
    const cv = document.createElement("canvas");
    cv.width = city.w * S;
    cv.height = city.h * S;
    const g = cv.getContext("2d");
    const rng = mulberry32(9);
    for (let ty = 0; ty < city.h; ty++) {
      for (let tx = 0; tx < city.w; tx++) {
        const t = city.tileAt(tx, ty);
        const x = tx * S;
        const y = ty * S;
        if (t === ROAD) {
          g.fillStyle = "#34373d";
          g.fillRect(x, y, S, S);
          g.fillStyle = "#c9b24a";
          if (tx % 10 === 1 && ty % 10 >= 2 && ty % 4 < 2) g.fillRect(x - 1, y + 2, 2, S - 4);
          if (ty % 10 === 1 && tx % 10 >= 2 && tx % 4 < 2) g.fillRect(x + 2, y - 1, S - 4, 2);
        } else if (t === SIDEWALK) {
          g.fillStyle = "#94949c";
          g.fillRect(x, y, S, S);
          g.strokeStyle = "#82828a";
          g.strokeRect(x + 0.5, y + 0.5, S - 1, S - 1);
        } else if (t === PARK) {
          g.fillStyle = "#4d7c46";
          g.fillRect(x, y, S, S);
          g.fillStyle = "#447040";
          for (let i = 0; i < 3; i++) g.fillRect(x + rng() * S, y + rng() * S, 3, 3);
        } else {
          g.fillStyle = "#2b2d31";
          g.fillRect(x, y, S, S);
        }
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const W = city.w * TILE;
    const H = city.h * TILE;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(W / 2, 0, H / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  buildBuildings(city) {
    const rng = mulberry32(31);
    const facades = makeFacadeMaterials();
    const roof = new THREE.MeshStandardMaterial({ color: 0x3a3c42, roughness: 1 });
    this.windowMats = facades.map((f) => f.mat);
    for (const b of city.buildings) {
      const h = b.kind === "office" ? 120 + rng() * 140
        : b.kind === "house" ? 60 + rng() * 50
          : 26 + rng() * 14;
      const w = b.tw * TILE - 8;
      const d = b.th * TILE - 8;
      const f = facades[Math.floor(rng() * facades.length)];
      const side = f.mat.clone();
      side.color = new THREE.Color(b.color).multiplyScalar(1.6);
      this.lampMats.push(side);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        [side, side, roof, roof, side, side],
      );
      mesh.position.set((b.tx + b.tw / 2) * TILE, h / 2, (b.ty + b.th / 2) * TILE);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  buildTrees(city) {
    const trunkG = new THREE.CylinderGeometry(1.6, 2.2, 10, 6);
    const trunkM = new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 1 });
    const leafM = new THREE.MeshStandardMaterial({ color: 0x2f6a2c, roughness: 1 });
    for (const tr of city.trees) {
      const grp = new THREE.Group();
      const trunk = new THREE.Mesh(trunkG, trunkM);
      trunk.position.y = 5;
      const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(tr.r * 1.1, 1), leafM);
      leaves.position.y = 12 + tr.r * 0.5;
      leaves.castShadow = true;
      grp.add(trunk, leaves);
      grp.position.set(tr.x, 0, tr.y);
      this.scene.add(grp);
    }
  }

  // --- dynamic entities -------------------------------------------------------

  vehicleMesh(v) {
    let g = this.vehicleMeshes.get(v);
    if (g) return g;
    g = new THREE.Group();
    const bodyM = new THREE.MeshStandardMaterial({
      color: new THREE.Color(v.color), metalness: 0.5, roughness: 0.4,
    });
    const glassM = new THREE.MeshStandardMaterial({ color: 0x111722, metalness: 0.8, roughness: 0.2 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(v.length, 9, v.width), bodyM);
    body.position.y = 8;
    body.castShadow = true;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(v.length * 0.45, 8, v.width * 0.8), glassM);
    cabin.position.set(-2, 16, 0);
    cabin.castShadow = true;
    g.add(body, cabin);

    const wheelG = new THREE.CylinderGeometry(4, 4, 3, 10);
    const wheelM = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    for (const [wx, wz] of [[12, 9], [12, -9], [-12, 9], [-12, -9]]) {
      const wheel = new THREE.Mesh(wheelG, wheelM);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(wx, 4, wz);
      g.add(wheel);
    }

    const headM = new THREE.MeshStandardMaterial({ color: 0xfff6cc, emissive: 0xfff6cc, emissiveIntensity: 0 });
    const tailM = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 0 });
    this.lampMats.push(headM, tailM);
    for (const z of [7, -7]) {
      const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.5, 3.5), headM);
      head.position.set(v.length / 2, 8, z);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.5, 3.5), tailM);
      tail.position.set(-v.length / 2, 8, z);
      g.add(head, tail);
    }

    if (v.police) {
      bodyM.color.set(0xf2f2f6);
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(v.length * 0.3, 9.4, v.width + 0.4),
        new THREE.MeshStandardMaterial({ color: 0x16182c }),
      );
      stripe.position.y = 8;
      g.add(stripe);
      const red = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff2222, emissiveIntensity: 1 });
      const blue = new THREE.MeshStandardMaterial({ color: 0x2244ff, emissive: 0x2244ff, emissiveIntensity: 1 });
      const lr = new THREE.Mesh(new THREE.BoxGeometry(4, 2.5, 6), red);
      lr.position.set(2, 21, 4);
      const lb = new THREE.Mesh(new THREE.BoxGeometry(4, 2.5, 6), blue);
      lb.position.set(2, 21, -4);
      g.add(lr, lb);
      this.lightbars.push({ red, blue });
    }

    this.scene.add(g);
    this.vehicleMeshes.set(v, g);
    return g;
  }

  personMesh(p, color) {
    let g = this.personMeshes.get(p);
    if (g) return g;
    g = new THREE.Group();
    const bodyM = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.9 });
    const body = new THREE.Mesh(this.peopleParts.body, bodyM);
    body.position.y = 8;
    body.castShadow = true;
    const head = new THREE.Mesh(this.peopleParts.head, this.peopleParts.skin);
    head.position.y = 17;
    head.castShadow = true;
    const legs = new THREE.Mesh(this.peopleParts.legs, this.peopleParts.pants);
    legs.position.y = 3;
    g.add(body, head, legs);
    this.scene.add(g);
    this.personMeshes.set(p, g);
    return g;
  }

  // --- frame ------------------------------------------------------------------

  render(dt, t) {
    const world = this.world;
    const pl = world.player;

    // entities
    for (const v of world.vehicles) {
      const g = this.vehicleMesh(v);
      g.position.set(v.x, 0, v.y);
      g.rotation.y = -v.angle;
    }
    for (const npc of world.npcs) {
      const g = this.personMesh(npc, npc.shirt);
      g.visible = !npc.indoor;
      g.position.set(npc.x, 0, npc.y);
      g.rotation.y = -npc.angle;
      if (npc.state === NPC_STATE.DOWNED) {
        g.rotation.z = Math.PI / 2;
        g.position.y = -4;
      } else {
        g.rotation.z = 0;
        // subtle walk bob
        g.position.y = Math.abs(Math.sin(t * 7 + npc.id)) * 1.2;
      }
    }
    for (const cop of world.cops) {
      const g = this.personMesh(cop, "#24407c");
      g.position.set(cop.x, 0, cop.y);
      g.rotation.y = -cop.angle;
    }
    // prune despawned cops
    for (const [p, g] of this.personMeshes) {
      if (p.arrestTimer !== undefined && !world.cops.includes(p)) {
        this.scene.remove(g);
        this.personMeshes.delete(p);
      }
    }
    const plMesh = this.personMesh(pl, "#e8e8ec");
    plMesh.visible = !pl.vehicle;
    plMesh.position.set(pl.x, 0, pl.y);
    plMesh.rotation.y = -pl.angle;

    for (const lb of this.lightbars) {
      const on = Math.floor(t * 6) % 2 === 0;
      lb.red.emissiveIntensity = on ? 2 : 0.1;
      lb.blue.emissiveIntensity = on ? 0.1 : 2;
    }

    // day/night
    const hr = world.time.hour + world.time.minute / 60;
    const elev = Math.sin(((hr - 6) / 12) * Math.PI); // 1 at noon, <0 at night
    const day = Math.max(0, Math.min(1, elev * 1.6));
    this.sun.intensity = day * 1.3;
    this.ambient.intensity = 0.16 + day * 0.62;
    this.moon.intensity = (1 - day) * 0.18;
    const sky = SKY_NIGHT.clone().lerp(SKY_DAY, day);
    this.scene.background = sky;
    this.scene.fog.color.copy(sky);
    const night = day < 0.25;
    for (const m of this.lampMats) m.emissiveIntensity = night ? 1 : 0;

    const az = 0.9;
    const se = Math.max(0.25, elev);
    this.sun.position.set(
      pl.x + Math.cos(az) * 700 * (1 - se * 0.5),
      se * 900,
      pl.y + Math.sin(az) * 700 * (1 - se * 0.5),
    );
    this.sun.target.position.set(pl.x, 0, pl.y);
    this.sun.target.updateMatrixWorld();

    // chase camera
    const driving = !!pl.vehicle;
    const heading = driving ? pl.vehicle.angle : pl.angle;
    const back = driving ? 185 : 130;
    const height = driving ? 150 : 115;
    const desired = new THREE.Vector3(
      pl.x - Math.cos(heading) * back,
      height,
      pl.y - Math.sin(heading) * back,
    );
    const k = 1 - Math.pow(0.02, dt);
    this.camPos.lerp(desired, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(pl.x, 14, pl.y);

    this.renderer.render(this.scene, this.camera);
  }

  // World point → screen pixels for HUD speech bubbles. Returns null if behind camera.
  project(x, height, z, vw, vh) {
    const v = new THREE.Vector3(x, height, z).project(this.camera);
    if (v.z > 1 || Math.abs(v.x) > 1.3 || Math.abs(v.y) > 1.3) return null;
    return { x: ((v.x + 1) / 2) * vw, y: ((1 - v.y) / 2) * vh };
  }
}

function makeFacadeMaterials() {
  const out = [];
  const rng = mulberry32(77);
  for (let i = 0; i < 5; i++) {
    const cv = document.createElement("canvas");
    cv.width = 128;
    cv.height = 256;
    const g = cv.getContext("2d");
    g.fillStyle = "#6b6b70";
    g.fillRect(0, 0, 128, 256);
    const lit = document.createElement("canvas");
    lit.width = 128;
    lit.height = 256;
    const gl = lit.getContext("2d");
    gl.fillStyle = "#000";
    gl.fillRect(0, 0, 128, 256);
    for (let wy = 0; wy < 10; wy++) {
      for (let wx = 0; wx < 5; wx++) {
        const x = 10 + wx * 24;
        const y = 12 + wy * 24;
        const isLit = rng() < 0.4;
        g.fillStyle = isLit ? "#cfd8e8" : "#23262e";
        g.fillRect(x, y, 14, 14);
        if (isLit) {
          gl.fillStyle = "#ffd98a";
          gl.fillRect(x, y, 14, 14);
        }
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const emis = new THREE.CanvasTexture(lit);
    emis.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: emis, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.9,
    });
    out.push({ mat });
  }
  return out;
}

function makePeopleParts() {
  return {
    body: new THREE.CapsuleGeometry(3.2, 6, 3, 8),
    legs: new THREE.CylinderGeometry(2.6, 2.2, 6, 8),
    head: new THREE.SphereGeometry(2.8, 10, 8),
    skin: new THREE.MeshStandardMaterial({ color: 0xe0b48c, roughness: 0.8 }),
    pants: new THREE.MeshStandardMaterial({ color: 0x2c3040, roughness: 1 }),
  };
}
