// Headless smoke test: runs the full simulation under Node with a stub canvas
// context and asserts the NPC intelligence pipeline works end to end.
// Run with: npm run game:smoke

import assert from "node:assert/strict";
import { createWorld, updateWorld, renderOverlay, createInput } from "./src/main.js";
import { NPC_STATE } from "./src/npc.js";
import { dist } from "./src/util.js";

// A 2D-context stand-in: every property is callable and coerces to 0.
const anything = new Proxy(function () {}, {
  get(t, p) {
    if (p === Symbol.toPrimitive) return () => 0;
    return anything;
  },
  set: () => true,
  apply: () => anything,
});

const world = createWorld(42);
const input = createInput();
const DT = 1 / 60;
const run = (seconds) => {
  for (let i = 0; i < seconds * 60; i++) updateWorld(world, DT, input);
};

assert.equal(world.npcs.length, 90, "npcs spawned");
assert.ok(world.vehicles.length > 20, "vehicles spawned");

// 1. World ticks and citizens commute.
const before = world.npcs.map((n) => [n.x, n.y]);
run(5);
const moved = world.npcs.filter((n, i) => dist(n.x, n.y, before[i][0], before[i][1]) > 10);
assert.ok(moved.length > 20, `NPCs commute (${moved.length} moved)`);

// 2. Witnesses perceive a crime, remember it, and panic spreads.
const victims = world.npcs.filter((n) => !n.indoor).slice(0, 5);
for (const v of victims) {
  world.events.push("assault", v.x, v.y, "player", 1.5, world.time.total);
}
run(1);
const scared = world.npcs.filter((n) => n.fear > 0.1);
const remembering = world.npcs.filter((n) => n.knowsAboutPlayer());
assert.ok(scared.length >= 1, `witnesses got scared (${scared.length})`);
assert.ok(remembering.length >= 1, `witnesses formed memories (${remembering.length})`);

// 3. Reactions: someone flees, watches, confronts, or calls it in.
run(8);
const reacting = world.npcs.filter((n) =>
  [NPC_STATE.FLEE, NPC_STATE.WATCH, NPC_STATE.CONFRONT, NPC_STATE.CALL_POLICE].includes(n.state),
);
const reported = world.wanted.heat > 0;
assert.ok(
  reacting.length >= 1 || reported,
  `NPCs reacted to the crime (reacting=${reacting.length}, heat=${world.wanted.heat.toFixed(2)})`,
);

// 4. Wanted level spawns cops that pursue.
world.wanted.report(2.5);
run(2);
assert.ok(world.cops.length >= 2, `cops responded (${world.cops.length})`);
const closing = world.cops.some((c) => c.lastKnown || c.seesPlayer);
assert.ok(closing, "cops are tracking the player");

// 5. Player can steal the nearest car.
let nearest = world.vehicles[0];
for (const v of world.vehicles) {
  if (dist(world.player.x, world.player.y, v.x, v.y) < dist(world.player.x, world.player.y, nearest.x, nearest.y)) {
    nearest = v;
  }
}
world.player.x = nearest.x;
world.player.y = nearest.y;
input.pressed.add("interact");
updateWorld(world, DT, input);
assert.ok(world.player.vehicle, "player stole a car");
run(3);

// 6. Gossip eventually spreads secondhand memories.
run(30);
const heard = world.npcs.filter((n) => n.memories.some((m) => m.heard));
console.log(`  gossip spread to ${heard.length} NPCs secondhand`);

// 7. HUD overlay rendering runs without throwing (stub context + projector).
renderOverlay(anything, world, 1280, 720, () => null);

console.log("smoke test passed ✔");
console.log(`  heat=${world.wanted.heat.toFixed(2)} cops=${world.cops.length} events=${world.events.events.length}`);
