// Intelligent pedestrians.
//
// Each NPC has:
//  - a personality (bravery, lawfulness, sociability, curiosity) that weights decisions
//  - a daily schedule (home/work/leisure destinations driven by the game clock)
//  - perception: witnesses nearby crime events and remembers them
//  - memory + gossip: witnessed crimes spread to other NPCs through conversation
//  - a utility scorer that picks between fleeing, hiding, calling the police,
//    filming the chaos, confronting the player, chatting, or going about its day
//
// The result: steal a car in front of one person and the whole block knows by lunch.

import { TILE, PED_COST, SIDEWALK, PARK } from "./world.js";
import { moveWithCollision } from "./entities.js";
import { clamp, dist, angleTo, pick, FIRST_NAMES } from "./util.js";

const WALK = 65;
const RUN = 165;
const PERCEPTION_RANGE = 280;

export const NPC_STATE = {
  COMMUTE: "commute",
  CHAT: "chat",
  FLEE: "flee",
  CALL_POLICE: "call_police",
  WATCH: "watch",
  CONFRONT: "confront",
  DOWNED: "downed",
};

let npcSerial = 0;

export class NPC {
  constructor(city, rng, time) {
    this.id = ++npcSerial;
    this.name = pick(rng, FIRST_NAMES);
    this.rng = rng;
    this.radius = 8;
    this.shirt = `hsl(${Math.floor(rng() * 360)}, 45%, 50%)`;

    this.personality = {
      bravery: rng(),
      lawfulness: rng(),
      sociability: rng(),
      curiosity: rng(),
    };

    // Anchors for the daily routine.
    this.home = city.randomTileOfType(rng, SIDEWALK);
    this.work = city.randomTileOfType(rng, SIDEWALK);
    this.leisure = city.randomTileOfType(rng, rng() < 0.5 ? PARK : SIDEWALK);

    const start = city.randomTileOfType(rng, SIDEWALK);
    this.x = (start.tx + 0.5) * TILE;
    this.y = (start.ty + 0.5) * TILE;
    this.angle = rng() * Math.PI * 2;

    this.state = NPC_STATE.COMMUTE;
    this.path = null;
    this.pathIdx = 0;
    this.goal = null;
    this.errand = null;
    this.fear = 0;
    this.threat = null; // { x, y, perp }
    this.memories = []; // { type, x, y, time, perp, heard, reported }
    this.lastEventId = 0;
    this.decideTimer = rng() * 0.5;
    this.stateTimer = 0;
    this.chatPartner = null;
    this.chatCooldown = 0;
    this.bubble = null;
    this.bubbleTimer = 0;
    this.indoor = false;
    this.downedTimer = 0;
  }

  say(text, dur = 2.5) {
    this.bubble = text;
    this.bubbleTimer = dur;
  }

  scheduleTarget(time) {
    const hour = time.hour;
    if (hour >= 8 && hour < 17) return this.work;
    if (hour >= 17 && hour < 21) return this.leisure;
    return this.home;
  }

  // --- Memory ---------------------------------------------------------------

  remember(ev, heard) {
    const existing = this.memories.find((m) => m.eventId === ev.id);
    if (existing) return;
    this.memories.push({
      eventId: ev.id, type: ev.type, x: ev.x, y: ev.y,
      time: ev.time, perp: ev.perp, severity: ev.severity,
      heard, reported: heard, // gossip isn't worth a 911 call, witnessing is
    });
    if (this.memories.length > 12) this.memories.shift();
  }

  unreportedCrime() {
    return this.memories.find((m) => !m.reported && m.perp);
  }

  knowsAboutPlayer() {
    return this.memories.some((m) => m.perp === "player");
  }

  sawPlayerCrime() {
    return this.memories.some((m) => m.perp === "player" && !m.heard);
  }

  // --- Perception -----------------------------------------------------------

  perceive(events, time) {
    const fresh = events.query(this.lastEventId, this.x, this.y, PERCEPTION_RANGE);
    if (events.nextId > 1) this.lastEventId = events.nextId - 1;
    for (const ev of fresh) {
      this.remember(ev, false);
      const proximity = 1 - dist(this.x, this.y, ev.x, ev.y) / PERCEPTION_RANGE;
      this.fear = clamp(
        this.fear + ev.severity * (0.4 + proximity) * (1.25 - this.personality.bravery),
        0, 1,
      );
      this.threat = { x: ev.x, y: ev.y, perp: ev.perp };
    }
  }

  // --- Decision making (utility AI) ------------------------------------------

  decide(world) {
    const p = this.personality;
    const threatDist = this.threat ? dist(this.x, this.y, this.threat.x, this.threat.y) : Infinity;
    const threatActive = this.threat && threatDist < 420 && this.fear > 0.05;
    const crime = this.unreportedCrime();

    const scores = [{ state: NPC_STATE.COMMUTE, score: 0.25 }];

    if (threatActive) {
      scores.push({ state: NPC_STATE.FLEE, score: this.fear * (1.3 - p.bravery) });
      scores.push({
        state: NPC_STATE.WATCH,
        score: threatDist > 130 ? p.curiosity * p.bravery * 0.9 : 0,
      });
      if (this.threat.perp === "player" && this.fear < 0.85) {
        scores.push({ state: NPC_STATE.CONFRONT, score: (p.bravery - 0.78) * 4 });
      }
    }
    if (crime && this.fear < 0.75) {
      // Law-abiding citizens stop and dial 911; cowards wait until they feel safe.
      scores.push({
        state: NPC_STATE.CALL_POLICE,
        score: p.lawfulness * crime.severity * (threatDist > 160 ? 1 : 0.3),
      });
    }
    if (!threatActive && this.fear < 0.2 && this.chatCooldown <= 0) {
      const buddy = world.findChatPartner(this);
      if (buddy) {
        scores.push({ state: NPC_STATE.CHAT, score: p.sociability * 0.6, buddy });
      }
    }

    let best = scores[0];
    for (const s of scores) if (s.score > best.score) best = s;
    if (best.state !== this.state) this.enterState(best, world);
  }

  enterState(choice, world) {
    this.state = choice.state;
    this.stateTimer = 0;
    this.path = null;
    switch (choice.state) {
      case NPC_STATE.FLEE: {
        const lines = ["HELP!", "Somebody call the cops!", "Get away from me!", "Not today!"];
        this.say(pick(this.rng, lines), 2);
        break;
      }
      case NPC_STATE.CALL_POLICE:
        this.say("911? Yeah, I'd like to report a crime...", 3.5);
        break;
      case NPC_STATE.WATCH:
        this.say(pick(this.rng, ["Oh this is going on my feed.", "Are you seeing this?!"]), 2.5);
        break;
      case NPC_STATE.CONFRONT:
        this.say(pick(this.rng, ["Hey! You can't do that!", "Come here, punk!"]), 2);
        break;
      case NPC_STATE.CHAT: {
        this.chatPartner = choice.buddy;
        choice.buddy.chatPartner = this;
        choice.buddy.state = NPC_STATE.CHAT;
        choice.buddy.stateTimer = 0;
        choice.buddy.path = null;
        this.exchangeGossip(choice.buddy, world.time);
        break;
      }
      default:
        break;
    }
  }

  exchangeGossip(other, time) {
    // Pass along the juiciest recent memory in each direction.
    for (const [from, to] of [[this, other], [other, this]]) {
      const story = from.memories
        .filter((m) => m.perp && time.total - m.time < 600)
        .sort((a, b) => b.severity - a.severity)[0];
      if (story) {
        to.remember(
          { id: story.eventId, type: story.type, x: story.x, y: story.y,
            perp: story.perp, severity: story.severity * 0.8, time: story.time },
          true,
        );
        from.say(pick(from.rng, [
          "You won't believe what I saw...",
          "Someone's been causing trouble around here.",
          "Stay away from that block, trust me.",
        ]), 2.5);
        return;
      }
    }
    this.say(pick(this.rng, ["Nice weather, huh?", "How's the family?", "Crazy traffic today."]), 2.5);
  }

  // --- Update ---------------------------------------------------------------

  update(dt, world) {
    this.bubbleTimer -= dt;
    if (this.bubbleTimer <= 0) this.bubble = null;
    this.chatCooldown -= dt;
    this.stateTimer += dt;
    this.fear = Math.max(0, this.fear - dt * 0.03);

    if (this.state === NPC_STATE.DOWNED) {
      this.downedTimer -= dt;
      if (this.downedTimer <= 0) {
        this.state = NPC_STATE.COMMUTE;
        this.fear = 1;
        this.threat = { x: world.player.x, y: world.player.y, perp: "player" };
      }
      return;
    }
    if (this.indoor) {
      // Re-emerge when the schedule says so.
      const target = this.scheduleTarget(world.time);
      if (target !== this.home || (world.time.hour >= 6 && world.time.hour < 21)) {
        this.indoor = false;
      } else return;
    }

    this.perceive(world.events, world.time);
    this.decideTimer -= dt;
    if (this.decideTimer <= 0) {
      this.decideTimer = 0.4 + this.rng() * 0.3;
      this.decide(world);
    }

    switch (this.state) {
      case NPC_STATE.COMMUTE: this.updateCommute(dt, world); break;
      case NPC_STATE.CHAT: this.updateChat(dt); break;
      case NPC_STATE.FLEE: this.updateFlee(dt, world); break;
      case NPC_STATE.CALL_POLICE: this.updateCallPolice(dt, world); break;
      case NPC_STATE.WATCH: this.updateWatch(dt, world); break;
      case NPC_STATE.CONFRONT: this.updateConfront(dt, world); break;
      default: break;
    }
  }

  updateCommute(dt, world) {
    const base = this.scheduleTarget(world.time);
    const target = this.errand || base;
    if (this.goal !== target) {
      this.goal = target;
      this.path = null;
    }
    if (!this.path) {
      this.path = world.city.findPath(
        Math.floor(this.x / TILE), Math.floor(this.y / TILE),
        target.tx, target.ty, PED_COST,
      ) || [];
      this.pathIdx = 0;
    }
    if (this.pathIdx >= this.path.length) {
      // Arrived. At night, head indoors; by day, linger then run an errand.
      if (!this.errand && base === this.home && (world.time.hour >= 21 || world.time.hour < 6)) {
        this.indoor = true;
        return;
      }
      if (this.stateTimer > 3 + this.rng() * 5) {
        this.errand = this.errand
          ? null // errand done, head back to the scheduled spot
          : world.city.randomTileOfType(this.rng, this.rng() < 0.3 ? PARK : SIDEWALK);
        this.stateTimer = 0;
      }
      return;
    }
    this.followPath(dt, WALK, world.city);
  }

  updateChat(dt) {
    const buddy = this.chatPartner;
    if (buddy) this.angle = angleTo(this.x, this.y, buddy.x, buddy.y);
    if (this.stateTimer > 5 || !buddy || buddy.state !== NPC_STATE.CHAT) {
      if (buddy && buddy.chatPartner === this) buddy.chatPartner = null;
      this.chatPartner = null;
      this.chatCooldown = 20 + this.rng() * 20;
      this.state = NPC_STATE.COMMUTE;
    }
  }

  updateFlee(dt, world) {
    if (!this.threat || this.fear < 0.05) {
      this.state = NPC_STATE.COMMUTE;
      return;
    }
    if (!this.path || this.pathIdx >= this.path.length) {
      // Pick a tile roughly opposite the threat and route to it on sidewalks.
      const away = angleTo(this.threat.x, this.threat.y, this.x, this.y);
      const gx = clamp(Math.floor((this.x + Math.cos(away) * 12 * TILE) / TILE), 1, world.city.w - 2);
      const gy = clamp(Math.floor((this.y + Math.sin(away) * 12 * TILE) / TILE), 1, world.city.h - 2);
      let goal = { tx: gx, ty: gy };
      if (world.city.tileAt(gx, gy) === 2 /* BUILDING */) {
        goal = world.city.randomTileOfType(this.rng, SIDEWALK);
      }
      this.path = world.city.findPath(
        Math.floor(this.x / TILE), Math.floor(this.y / TILE), goal.tx, goal.ty, PED_COST,
      ) || [];
      this.pathIdx = 0;
    }
    this.followPath(dt, RUN, world.city);
    if (dist(this.x, this.y, this.threat.x, this.threat.y) > 500) {
      this.fear *= 0.5;
      this.threat = null;
      this.state = NPC_STATE.COMMUTE;
    }
  }

  updateCallPolice(dt, world) {
    // Stand still, phone out. Takes a few seconds; getting scared interrupts the call.
    if (this.fear > 0.8) {
      this.state = NPC_STATE.FLEE;
      return;
    }
    if (this.stateTimer > 3.5) {
      const crime = this.unreportedCrime();
      if (crime) {
        crime.reported = true;
        if (crime.perp === "player") world.wanted.report(crime.severity);
      }
      this.say("They're on their way.", 2);
      this.state = NPC_STATE.COMMUTE;
    }
  }

  updateWatch(dt, world) {
    if (!this.threat) {
      this.state = NPC_STATE.COMMUTE;
      return;
    }
    const d = dist(this.x, this.y, this.threat.x, this.threat.y);
    this.angle = angleTo(this.x, this.y, this.threat.x, this.threat.y);
    if (d < 120) {
      // Too close for comfort: back off while filming.
      const away = this.angle + Math.PI;
      moveWithCollision(this, Math.cos(away) * WALK * dt, Math.sin(away) * WALK * dt, world.city);
    }
    if (this.stateTimer > 8 || this.fear > 0.85) this.state = NPC_STATE.COMMUTE;
  }

  updateConfront(dt, world) {
    const pl = world.player;
    const d = dist(this.x, this.y, pl.x, pl.y);
    if (d > 350 || this.stateTimer > 12 || pl.vehicle) {
      this.say("Yeah, you better run!", 2);
      this.state = NPC_STATE.COMMUTE;
      return;
    }
    this.angle = angleTo(this.x, this.y, pl.x, pl.y);
    if (d > 24) {
      moveWithCollision(
        this, Math.cos(this.angle) * RUN * 0.9 * dt, Math.sin(this.angle) * RUN * 0.9 * dt, world.city,
      );
    } else if (this.stateTimer > 0.8) {
      this.stateTimer = 0;
      pl.health -= 8;
      world.flashHit();
    }
  }

  followPath(dt, speed, city) {
    if (!this.path || this.pathIdx >= this.path.length) return;
    const node = this.path[this.pathIdx];
    const cx = (node.x + 0.5) * TILE;
    const cy = (node.y + 0.5) * TILE;
    const d = dist(this.x, this.y, cx, cy);
    if (d < 6) {
      this.pathIdx++;
      return;
    }
    this.angle = angleTo(this.x, this.y, cx, cy);
    moveWithCollision(
      this, Math.cos(this.angle) * speed * dt, Math.sin(this.angle) * speed * dt, city,
    );
  }

  knockDown(world, byVehicle) {
    if (this.state === NPC_STATE.DOWNED) return;
    this.state = NPC_STATE.DOWNED;
    this.downedTimer = byVehicle ? 14 : 8;
    this.bubble = null;
    if (this.chatPartner) {
      if (this.chatPartner.chatPartner === this) this.chatPartner.chatPartner = null;
      this.chatPartner = null;
    }
  }
}
