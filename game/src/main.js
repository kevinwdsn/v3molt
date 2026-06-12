// Game bootstrap: world state, input, simulation loop, and all rendering.

import { City, TILE, ROAD, SIDEWALK, PARK } from "./world.js";
import { Player, Vehicle, CAR_COLORS } from "./entities.js";
import { NPC, NPC_STATE } from "./npc.js";
import { WantedSystem, Cop } from "./police.js";
import { npcGreeting, npcReply, dialogueOptions } from "./dialogue.js";
import { mulberry32, clamp, dist, EventLog } from "./util.js";

const NPC_COUNT = 90;
const TRAFFIC_COUNT = 26;
const PARKED_COUNT = 30;

// --- World setup -------------------------------------------------------------

export function createWorld(seed = 20260612) {
  const rng = mulberry32(seed);
  const city = new City(seed);
  const world = {
    rng,
    city,
    events: new EventLog(),
    wanted: new WantedSystem(),
    time: { total: 0, hour: 8, minute: 0 },
    npcs: [],
    vehicles: [],
    cops: [],
    player: null,
    hitFlash: 0,
    overlay: null, // { kind: 'busted'|'wasted', timer }
    dialogue: null, // { npc, line, options }
    hint: "",
    hintTimer: 0,
  };

  const center = city.randomTileOfType(rng, SIDEWALK);
  world.player = new Player((center.tx + 0.5) * TILE, (center.ty + 0.5) * TILE);

  for (let i = 0; i < NPC_COUNT; i++) world.npcs.push(new NPC(city, rng, world.time));

  for (let i = 0; i < TRAFFIC_COUNT; i++) {
    const v = spawnTrafficCar(world);
    if (v) world.vehicles.push(v);
  }
  for (let i = 0; i < PARKED_COUNT; i++) {
    const t = city.randomTileOfType(rng, ROAD);
    if (city.isIntersection(t.tx, t.ty)) continue;
    const dir = city.roadDir(t.tx, t.ty) || [1, 0];
    const v = new Vehicle((t.tx + 0.5) * TILE, (t.ty + 0.5) * TILE, Math.atan2(dir[1], dir[0]), rng);
    world.vehicles.push(v); // driver === null → parked
  }

  world.flashHit = () => { world.hitFlash = 0.25; };
  world.findChatPartner = (npc) => {
    for (const other of world.npcs) {
      if (other === npc || other.indoor || other.chatCooldown > 0) continue;
      if (other.state !== NPC_STATE.COMMUTE) continue;
      if (other.personality.sociability < 0.35) continue;
      if (dist(npc.x, npc.y, other.x, other.y) < 50) return other;
    }
    return null;
  };
  world.setHint = (text, dur = 4) => {
    world.hint = text;
    world.hintTimer = dur;
  };

  world.setHint("WASD move · E enter/exit car · T talk · SPACE punch / handbrake", 10);
  return world;
}

function spawnTrafficCar(world) {
  const { city, rng } = world;
  for (let tries = 0; tries < 60; tries++) {
    const t = city.randomTileOfType(rng, ROAD);
    if (city.isIntersection(t.tx, t.ty)) continue;
    const dir = city.roadDir(t.tx, t.ty);
    if (!dir) continue;
    const v = new Vehicle((t.tx + 0.5) * TILE, (t.ty + 0.5) * TILE, Math.atan2(dir[1], dir[0]), rng);
    v.driver = "ai";
    v.speed = 100;
    return v;
  }
  return null;
}

// --- Simulation --------------------------------------------------------------

export function updateWorld(world, dt, input) {
  const pl = world.player;

  // Game clock: 1 real second = 1 game minute.
  world.time.total += dt;
  const mins = Math.floor(world.time.total) + 8 * 60;
  world.time.hour = Math.floor(mins / 60) % 24;
  world.time.minute = mins % 60;

  world.hitFlash = Math.max(0, world.hitFlash - dt);
  if (world.hintTimer > 0) world.hintTimer -= dt;

  if (world.overlay) {
    world.overlay.timer -= dt;
    if (world.overlay.timer <= 0) respawn(world);
    return;
  }
  if (world.dialogue) return; // world pauses while talking

  // -- player actions --
  if (input.consume("interact")) handleEnterExit(world);
  if (input.consume("talk")) handleTalk(world);
  if (!pl.vehicle && input.consume("punch")) handlePunch(world);

  pl.update(dt, input, world.city);

  // Hit-and-run detection while driving.
  if (pl.vehicle && Math.abs(pl.vehicle.speed) > 80) {
    for (const npc of world.npcs) {
      if (npc.indoor || npc.state === NPC_STATE.DOWNED) continue;
      if (dist(pl.x, pl.y, npc.x, npc.y) < 24) {
        npc.knockDown(world, true);
        world.events.push("hit_and_run", npc.x, npc.y, "player", 2.2, world.time.total);
        pl.lastCrimeTime = world.time.total;
        reportIfNearPatrol(world, npc.x, npc.y, 2.2);
      }
    }
  }

  // -- traffic --
  const obstacles = [...world.vehicles, pl, ...world.cops];
  for (const v of world.vehicles) {
    if (v === pl.vehicle) continue;
    v.aiUpdate(dt, world.city, world.rng, obstacles);
    if (v.driver === "ai" && v.stuckTimer > 6) {
      // Quietly recycle gridlocked cars far from the player.
      if (dist(v.x, v.y, pl.x, pl.y) > 700) {
        const nv = spawnTrafficCar(world);
        if (nv) Object.assign(v, { x: nv.x, y: nv.y, angle: nv.angle, speed: 80, stuckTimer: 0 });
      }
    }
  }

  // -- pedestrians --
  for (const npc of world.npcs) npc.update(dt, world);

  // -- police --
  updatePolice(world, dt);

  if (pl.health <= 0) {
    world.overlay = { kind: "wasted", timer: 3 };
  }
}

function handleEnterExit(world) {
  const pl = world.player;
  if (pl.vehicle) {
    pl.vehicle.driver = null;
    // Step out beside the car.
    pl.x = pl.vehicle.x + Math.cos(pl.vehicle.angle + Math.PI / 2) * 26;
    pl.y = pl.vehicle.y + Math.sin(pl.vehicle.angle + Math.PI / 2) * 26;
    if (!world.city.isWalkablePx(pl.x, pl.y)) {
      pl.x = pl.vehicle.x;
      pl.y = pl.vehicle.y - 26;
    }
    pl.vehicle = null;
    return;
  }
  let best = null;
  let bestD = 50;
  for (const v of world.vehicles) {
    const d = dist(pl.x, pl.y, v.x, v.y);
    if (d < bestD) {
      best = v;
      bestD = d;
    }
  }
  if (best) {
    const wasMoving = best.driver === "ai";
    best.driver = "player";
    pl.vehicle = best;
    pl.lastCrimeTime = world.time.total;
    world.events.push("car_theft", best.x, best.y, "player", wasMoving ? 1.6 : 1.0, world.time.total);
    reportIfNearPatrol(world, best.x, best.y, 1.2);
    world.setHint("You stole a car. Witnesses remember — and they talk.");
  }
}

function handlePunch(world) {
  const pl = world.player;
  if (pl.punchCooldown > 0) return;
  pl.punchCooldown = 0.5;
  for (const npc of world.npcs) {
    if (npc.indoor || npc.state === NPC_STATE.DOWNED) continue;
    if (dist(pl.x, pl.y, npc.x, npc.y) < 28) {
      npc.knockDown(world, false);
      world.events.push("assault", npc.x, npc.y, "player", 1.4, world.time.total);
      pl.lastCrimeTime = world.time.total;
      reportIfNearPatrol(world, npc.x, npc.y, 1.4);
      return;
    }
  }
}

function handleTalk(world) {
  const pl = world.player;
  if (pl.vehicle) return;
  let best = null;
  let bestD = 45;
  for (const npc of world.npcs) {
    if (npc.indoor) continue;
    const d = dist(pl.x, pl.y, npc.x, npc.y);
    if (d < bestD) {
      best = npc;
      bestD = d;
    }
  }
  if (best) {
    world.dialogue = { npc: best, line: npcGreeting(best, world), options: dialogueOptions() };
  }
}

export function chooseDialogueOption(world, idx) {
  const dlg = world.dialogue;
  if (!dlg) return;
  const reply = npcReply(dlg.npc, world, idx);
  if (reply.scare) {
    dlg.npc.fear = Math.max(dlg.npc.fear, 0.7);
    dlg.npc.threat = { x: world.player.x, y: world.player.y, perp: "player" };
    if (dlg.npc.personality.lawfulness > 0.55) {
      dlg.npc.remember(
        { id: world.events.nextId++, type: "assault", x: world.player.x, y: world.player.y,
          perp: "player", severity: 0.8, time: world.time.total },
        false,
      );
    }
  }
  if (reply.anger) {
    dlg.npc.threat = { x: world.player.x, y: world.player.y, perp: "player" };
    dlg.npc.state = NPC_STATE.CONFRONT;
    dlg.npc.stateTimer = 0;
  }
  dlg.line = reply.text;
  dlg.options = null; // show reply, any key closes
}

function reportIfNearPatrol(world, x, y, severity) {
  for (const cop of world.cops) {
    if (dist(cop.x, cop.y, x, y) < 320) {
      world.wanted.report(severity);
      return;
    }
  }
}

function updatePolice(world, dt) {
  const { wanted, cops, player } = world;
  const want = wanted.level * 2;
  while (cops.length < want) {
    // Spawn just off-screen near the player so the response feels local.
    const ang = world.rng() * Math.PI * 2;
    let x = player.x + Math.cos(ang) * 520;
    let y = player.y + Math.sin(ang) * 520;
    x = clamp(x, TILE, (world.city.w - 1) * TILE);
    y = clamp(y, TILE, (world.city.h - 1) * TILE);
    if (!world.city.isWalkablePx(x, y)) {
      const t = world.city.randomTileOfType(world.rng, SIDEWALK);
      x = (t.tx + 0.5) * TILE;
      y = (t.ty + 0.5) * TILE;
    }
    const cop = new Cop(x, y, world.rng);
    cop.lastKnown = { x: player.x, y: player.y };
    cops.push(cop);
  }
  while (cops.length > want) cops.pop();

  let seen = false;
  for (const cop of cops) {
    cop.update(dt, world);
    if (cop.seesPlayer) seen = true;
    if (cop.tryArrest(dt, world)) {
      world.overlay = { kind: "busted", timer: 3 };
      return;
    }
  }
  wanted.update(dt, seen);
}

function respawn(world) {
  const pl = world.player;
  const kind = world.overlay.kind;
  world.overlay = null;
  world.wanted.clear();
  world.cops.length = 0;
  if (pl.vehicle) {
    pl.vehicle.driver = null;
    pl.vehicle = null;
  }
  pl.health = 100;
  const t = world.city.randomTileOfType(world.rng, SIDEWALK);
  pl.x = (t.tx + 0.5) * TILE;
  pl.y = (t.ty + 0.5) * TILE;
  world.setHint(kind === "busted" ? "Busted. They took your stuff and let you walk." : "You woke up outside the hospital.");
}

// --- Input ---------------------------------------------------------------

export function createInput() {
  const state = {
    up: false, down: false, left: false, right: false, brake: false,
    pressed: new Set(),
    consume(action) {
      if (state.pressed.has(action)) {
        state.pressed.delete(action);
        return true;
      }
      return false;
    },
  };
  return state;
}

const KEYMAP = {
  KeyW: "up", ArrowUp: "up",
  KeyS: "down", ArrowDown: "down",
  KeyA: "left", ArrowLeft: "left",
  KeyD: "right", ArrowRight: "right",
};

// --- Rendering ----------------------------------------------------------------

function drawCity(ctx, world, cam, vw, vh) {
  const { city } = world;
  const x0 = clamp(Math.floor(cam.x / TILE) - 1, 0, city.w - 1);
  const y0 = clamp(Math.floor(cam.y / TILE) - 1, 0, city.h - 1);
  const x1 = clamp(Math.ceil((cam.x + vw) / TILE) + 1, 0, city.w - 1);
  const y1 = clamp(Math.ceil((cam.y + vh) / TILE) + 1, 0, city.h - 1);

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const t = city.tileAt(tx, ty);
      const px = tx * TILE - cam.x;
      const py = ty * TILE - cam.y;
      if (t === ROAD) {
        ctx.fillStyle = "#33363c";
        ctx.fillRect(px, py, TILE, TILE);
        // Dashed center line between the two opposing lanes.
        ctx.fillStyle = "#c9b24a";
        if (tx % 10 === 1 && ty % 10 >= 2 && ty % 4 < 2) ctx.fillRect(px - 1, py + 4, 2, TILE - 8);
        if (ty % 10 === 1 && tx % 10 >= 2 && tx % 4 < 2) ctx.fillRect(px + 4, py - 1, TILE - 8, 2);
      } else if (t === SIDEWALK) {
        ctx.fillStyle = "#8e8e96";
        ctx.fillRect(px, py, TILE, TILE);
        ctx.strokeStyle = "#7c7c84";
        ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
      } else if (t === PARK) {
        ctx.fillStyle = "#4a7a44";
        ctx.fillRect(px, py, TILE, TILE);
      } else {
        ctx.fillStyle = "#23252a";
        ctx.fillRect(px, py, TILE, TILE);
      }
    }
  }

  for (const b of city.buildings) {
    const px = b.tx * TILE - cam.x;
    const py = b.ty * TILE - cam.y;
    const w = b.tw * TILE;
    const h = b.th * TILE;
    if (px > vw || py > vh || px + w < 0 || py + h < 0) continue;
    ctx.fillStyle = b.color;
    ctx.fillRect(px + 3, py + 3, w - 6, h - 6);
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 3, py + 3, w - 6, h - 6);
    ctx.fillStyle = "rgba(255,255,230,0.18)";
    for (let wy = 0; wy < b.th; wy++) {
      for (let wx = 0; wx < b.tw; wx++) {
        ctx.fillRect(px + 10 + wx * TILE, py + 10 + wy * TILE, 10, 10);
      }
    }
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.fillText(b.name, px + w / 2, py + h / 2);
  }

  ctx.textAlign = "left";
  for (const tr of city.trees) {
    const px = tr.x - cam.x;
    const py = tr.y - cam.y;
    if (px < -20 || py < -20 || px > vw + 20 || py > vh + 20) continue;
    ctx.fillStyle = "#2f5a2c";
    ctx.beginPath();
    ctx.arc(px, py, tr.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawVehicle(ctx, v, cam, flash) {
  ctx.save();
  ctx.translate(v.x - cam.x, v.y - cam.y);
  ctx.rotate(v.angle);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(-v.length / 2 + 3, -v.width / 2 + 3, v.length, v.width);
  ctx.fillStyle = v.color;
  ctx.fillRect(-v.length / 2, -v.width / 2, v.length, v.width);
  ctx.fillStyle = "rgba(20,30,40,0.85)";
  ctx.fillRect(-4, -v.width / 2 + 3, 12, v.width - 6); // windshield
  if (v.police) {
    ctx.fillStyle = "#223";
    ctx.fillRect(-v.length / 2, -v.width / 2, 12, v.width);
    ctx.fillStyle = flash ? "#f33" : "#33f";
    ctx.fillRect(-2, -v.width / 2 - 2, 6, 4);
  }
  ctx.restore();
}

function drawPerson(ctx, e, cam, color, downed) {
  const px = e.x - cam.x;
  const py = e.y - cam.y;
  ctx.save();
  if (downed) {
    ctx.translate(px, py);
    ctx.rotate(Math.PI / 2);
    ctx.translate(-px, -py);
    ctx.globalAlpha = 0.8;
  }
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath();
  ctx.arc(px + 2, py + 2, e.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(px, py, e.radius, 0, Math.PI * 2);
  ctx.fill();
  // Face direction nub.
  ctx.fillStyle = "#e8c9a0";
  ctx.beginPath();
  ctx.arc(px + Math.cos(e.angle) * 5, py + Math.sin(e.angle) * 5, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBubble(ctx, npc, cam) {
  if (!npc.bubble) return;
  ctx.font = "11px sans-serif";
  const w = ctx.measureText(npc.bubble).width + 10;
  const px = npc.x - cam.x;
  const py = npc.y - cam.y - 22;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillRect(px - w / 2, py - 14, w, 18);
  ctx.fillStyle = "#111";
  ctx.textAlign = "center";
  ctx.fillText(npc.bubble, px, py - 1);
  ctx.textAlign = "left";
}

function drawStar(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fill();
}

function drawHUD(ctx, world, vw, vh) {
  const { time, wanted, player } = world;
  ctx.font = "16px monospace";
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(12, 12, 110, 52);
  ctx.fillStyle = "#fff";
  ctx.fillText(`${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`, 24, 34);
  // Health bar
  ctx.fillStyle = "#400";
  ctx.fillRect(24, 44, 86, 10);
  ctx.fillStyle = "#d33";
  ctx.fillRect(24, 44, 86 * clamp(player.health / 100, 0, 1), 10);

  // Wanted stars
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i < wanted.level ? "#ffd34d" : "rgba(255,255,255,0.18)";
    drawStar(ctx, vw - 150 + i * 28, 28, 11);
  }

  if (world.hintTimer > 0 && world.hint) {
    ctx.font = "14px sans-serif";
    const w = ctx.measureText(world.hint).width + 24;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(vw / 2 - w / 2, vh - 46, w, 28);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(world.hint, vw / 2, vh - 27);
    ctx.textAlign = "left";
  }
}

function drawMinimap(ctx, world, vw, vh) {
  const size = 150;
  const mx = vw - size - 14;
  const my = vh - size - 14;
  const sx = size / (world.city.w * TILE);
  const sy = size / (world.city.h * TILE);
  ctx.fillStyle = "rgba(10,12,16,0.8)";
  ctx.fillRect(mx - 2, my - 2, size + 4, size + 4);
  // Roads
  ctx.fillStyle = "#555a64";
  for (let ty = 0; ty < world.city.h; ty += 2) {
    for (let tx = 0; tx < world.city.w; tx += 2) {
      if (world.city.tileAt(tx, ty) === ROAD) {
        ctx.fillRect(mx + tx * TILE * sx, my + ty * TILE * sy, 3, 3);
      }
    }
  }
  ctx.fillStyle = "#4af";
  for (const cop of world.cops) ctx.fillRect(mx + cop.x * sx - 2, my + cop.y * sy - 2, 4, 4);
  ctx.fillStyle = "#fff";
  ctx.fillRect(mx + world.player.x * sx - 2, my + world.player.y * sy - 2, 5, 5);
}

function drawDialogue(ctx, world, vw, vh) {
  const dlg = world.dialogue;
  if (!dlg) return;
  const h = dlg.options ? 130 : 86;
  ctx.fillStyle = "rgba(8,10,14,0.88)";
  ctx.fillRect(40, vh - h - 20, vw - 80, h);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.strokeRect(40.5, vh - h - 19.5, vw - 81, h - 1);
  ctx.fillStyle = "#ffd34d";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText(dlg.npc.name, 58, vh - h + 4);
  ctx.fillStyle = "#eee";
  ctx.font = "14px sans-serif";
  ctx.fillText(`“${dlg.line}”`, 58, vh - h + 26);
  ctx.font = "13px sans-serif";
  ctx.fillStyle = "#9fc4ff";
  if (dlg.options) {
    dlg.options.forEach((opt, i) => {
      ctx.fillText(`[${i + 1}] ${opt}`, 58, vh - h + 52 + i * 20);
    });
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText("[ESC] leave", vw - 140, vh - h + 4);
  } else {
    ctx.fillText("press any key to continue", 58, vh - h + 56);
  }
}

export function renderWorld(ctx, world, vw, vh, t) {
  const pl = world.player;
  const cam = {
    x: clamp(pl.x - vw / 2, 0, world.city.w * TILE - vw),
    y: clamp(pl.y - vh / 2, 0, world.city.h * TILE - vh),
  };

  ctx.fillStyle = "#1a1c20";
  ctx.fillRect(0, 0, vw, vh);
  drawCity(ctx, world, cam, vw, vh);

  for (const v of world.vehicles) drawVehicle(ctx, v, cam, Math.floor(t * 6) % 2 === 0);

  for (const npc of world.npcs) {
    if (npc.indoor) continue;
    if (npc.x - cam.x < -30 || npc.y - cam.y < -30 || npc.x - cam.x > vw + 30 || npc.y - cam.y > vh + 30) continue;
    drawPerson(ctx, npc, cam, npc.shirt, npc.state === NPC_STATE.DOWNED);
  }
  for (const cop of world.cops) drawPerson(ctx, cop, cam, "#2a4fd0", false);
  if (!pl.vehicle) drawPerson(ctx, pl, cam, "#f0f0f0", false);

  for (const npc of world.npcs) {
    if (!npc.indoor) drawBubble(ctx, npc, cam);
  }

  // Day/night tint from the game clock.
  const hr = world.time.hour + world.time.minute / 60;
  const darkness = hr < 5 || hr > 21 ? 0.45 : hr < 7 ? (7 - hr) * 0.22 : hr > 19 ? (hr - 19) * 0.22 : 0;
  if (darkness > 0) {
    ctx.fillStyle = `rgba(10, 14, 40, ${darkness})`;
    ctx.fillRect(0, 0, vw, vh);
  }

  if (world.hitFlash > 0) {
    ctx.fillStyle = `rgba(255,0,0,${world.hitFlash})`;
    ctx.fillRect(0, 0, vw, vh);
  }

  drawHUD(ctx, world, vw, vh);
  drawMinimap(ctx, world, vw, vh);
  drawDialogue(ctx, world, vw, vh);

  if (world.overlay) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, 0, vw, vh);
    ctx.fillStyle = world.overlay.kind === "busted" ? "#7ea0ff" : "#ff5a5a";
    ctx.font = "bold 64px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(world.overlay.kind.toUpperCase(), vw / 2, vh / 2);
    ctx.textAlign = "left";
  }
}

// --- Boot ----------------------------------------------------------------------

export function boot(doc, win) {
  const canvas = doc.getElementById("game");
  const ctx = canvas.getContext("2d");
  const world = createWorld();
  const input = createInput();

  const resize = () => {
    canvas.width = win.innerWidth;
    canvas.height = win.innerHeight;
  };
  resize();
  win.addEventListener("resize", resize);

  win.addEventListener("keydown", (e) => {
    if (world.dialogue) {
      if (e.code === "Escape") world.dialogue = null;
      else if (world.dialogue.options) {
        const idx = ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
        if (idx >= 0) chooseDialogueOption(world, idx);
      } else {
        world.dialogue = null;
      }
      e.preventDefault();
      return;
    }
    if (KEYMAP[e.code]) input[KEYMAP[e.code]] = true;
    if (e.code === "Space") {
      input.brake = true;
      input.pressed.add("punch");
    }
    if (e.code === "KeyE") input.pressed.add("interact");
    if (e.code === "KeyT") input.pressed.add("talk");
    if (e.code !== "F5" && e.code !== "F12") e.preventDefault();
  });
  win.addEventListener("keyup", (e) => {
    if (KEYMAP[e.code]) input[KEYMAP[e.code]] = false;
    if (e.code === "Space") input.brake = false;
  });

  let last = 0;
  const frame = (ts) => {
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    updateWorld(world, dt, input);
    renderWorld(ctx, world, canvas.width, canvas.height, ts / 1000);
    win.requestAnimationFrame(frame);
  };
  win.requestAnimationFrame(frame);
  return world;
}

if (typeof document !== "undefined" && typeof document.getElementById === "function" && document.getElementById("game")) {
  boot(document, window);
}
