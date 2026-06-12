// Conversation system. Lines are assembled from the NPC's actual mental state:
// what they witnessed, what they heard through gossip, how scared they are,
// their personality, and real world geometry (direction-giving uses the map).
//
// To wire this to an LLM instead, see game/README.md — npcContext() below
// already produces the structured prompt context you'd send.

import { dist, angleTo, pick } from "./util.js";
import { NPC_STATE } from "./npc.js";

const CRIME_LABELS = {
  car_theft: "steal that car",
  assault: "attack someone",
  hit_and_run: "run somebody over",
};

export function npcGreeting(npc, world) {
  const p = npc.personality;

  if (npc.state === NPC_STATE.DOWNED) return "...ugh... just... leave me alone...";

  if (npc.fear > 0.6) {
    return pick(npc.rng, [
      "P-please, I don't want any trouble!",
      "Take whatever you want, just don't hurt me!",
      "Stay back! I'm warning you!",
    ]);
  }

  const witnessed = npc.memories.find((m) => m.perp === "player" && !m.heard);
  if (witnessed) {
    const crime = CRIME_LABELS[witnessed.type] || "do that";
    return p.lawfulness > 0.6
      ? `I saw you ${crime}! The police are going to hear about this.`
      : p.bravery > 0.7
        ? `I saw you ${crime}. Bold. Stupid, but bold.`
        : `I... I didn't see anything. I swear. Please go away.`;
  }

  const rumor = npc.memories.find((m) => m.perp === "player" && m.heard);
  if (rumor) {
    return pick(npc.rng, [
      "People are saying someone's been causing trouble around here. Be careful out there.",
      "Word on the street is there's a real menace in this neighborhood lately.",
    ]);
  }

  const hour = world.time.hour;
  const daypart = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  if (p.sociability > 0.65) {
    return pick(npc.rng, [
      `Good ${daypart}! Beautiful day in the city, isn't it?`,
      `Hey there! Haven't seen you around. I'm ${npc.name}.`,
      `Good ${daypart}! You new to the neighborhood?`,
    ]);
  }
  if (p.curiosity > 0.7) {
    return pick(npc.rng, [
      "You look like you're up to something interesting.",
      "I people-watch a lot. You walk like you have somewhere to be.",
    ]);
  }
  return pick(npc.rng, [
    `Hm? Oh. ${daypart === "morning" ? "Morning." : "Hey."}`,
    "Can I help you?",
    "I'm kind of in a hurry.",
  ]);
}

export function dialogueOptions() {
  return ["Ask for directions", "Make small talk", "Threaten"];
}

export function npcReply(npc, world, optionIdx) {
  const p = npc.personality;
  switch (optionIdx) {
    case 0: {
      // Real direction-giving: pick a landmark and describe where it actually is.
      const shops = world.city.buildings.filter((b) => b.kind === "shop");
      if (!shops.length) return { text: "Honestly? I'm lost myself.", end: true };
      let best = shops[0];
      for (const s of shops) {
        if (dist(npc.x, npc.y, s.doorX, s.doorY) < dist(npc.x, npc.y, best.doorX, best.doorY)) best = s;
      }
      const a = angleTo(npc.x, npc.y, best.doorX, best.doorY);
      const compass = ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"][
        Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8
      ];
      const blocks = Math.max(1, Math.round(dist(npc.x, npc.y, best.doorX, best.doorY) / 320));
      return {
        text: `Looking for ${best.name}? Head ${compass}, about ${blocks} block${blocks > 1 ? "s" : ""} from here. Can't miss it.`,
        end: true,
      };
    }
    case 1: {
      const gossip = npc.memories.filter((m) => m.perp).length;
      if (gossip && p.sociability > 0.4) {
        return {
          text: pick(npc.rng, [
            "Between you and me, this neighborhood's gone downhill. Crime everywhere lately.",
            "My friend swears she saw a carjacking last week. In broad daylight!",
          ]),
          end: true,
        };
      }
      return {
        text: pick(npc.rng, [
          `I work over by the ${pick(npc.rng, world.city.buildings).name}. It pays the bills.`,
          "Rent keeps going up, traffic keeps getting worse. Same old city.",
          "I just like walking, you know? Clears the head.",
        ]),
        end: true,
      };
    }
    case 2: {
      if (p.bravery > 0.8) {
        return { text: "Ha! You're going to threaten ME? Walk away, friend.", end: true, anger: true };
      }
      return {
        text: pick(npc.rng, [
          "Okay, okay! I'm leaving! Don't follow me!",
          "W-whoa, easy! I want no part of this!",
        ]),
        end: true, scare: true,
      };
    }
    default:
      return { text: "...", end: true };
  }
}

// Structured snapshot of an NPC's mind — ready to drop into an LLM prompt
// if you want fully generative dialogue (see README).
export function npcContext(npc, world) {
  return {
    name: npc.name,
    personality: npc.personality,
    mood: npc.fear > 0.6 ? "terrified" : npc.fear > 0.2 ? "uneasy" : "calm",
    state: npc.state,
    timeOfDay: `${String(world.time.hour).padStart(2, "0")}:${String(world.time.minute).padStart(2, "0")}`,
    memories: npc.memories.map((m) => ({
      type: m.type,
      source: m.heard ? "heard from a neighbor" : "witnessed personally",
      suspect: m.perp === "player" ? "the person they are talking to" : "a stranger",
    })),
  };
}
