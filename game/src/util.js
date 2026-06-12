// Math helpers, seeded RNG, and the world event log shared by every system.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const angleTo = (ax, ay, bx, by) => Math.atan2(by - ay, bx - ax);

export function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

export const FIRST_NAMES = [
  "Marcus", "Lena", "Theo", "Priya", "Dwayne", "Sofia", "Iris", "Carlos",
  "Maya", "Felix", "Nadia", "Omar", "Ruth", "Stan", "Bianca", "Jerome",
  "Kim", "Aldo", "Greta", "Yusuf", "Tasha", "Vince", "Elena", "Rocco",
];

export const SHOP_NAMES = [
  "Lucky Pawn", "Burger Czar", "24/7 Mart", "Chrome Cuts", "Noodle King",
  "Pixel Arcade", "Bail Bonds", "Donut Hole", "Vinyl Vault", "Taco Tower",
];

// Crimes and noises NPCs can witness. Each entry: { id, type, x, y, perp, time, severity }
export class EventLog {
  constructor() {
    this.events = [];
    this.nextId = 1;
  }

  push(type, x, y, perp, severity, time) {
    this.events.push({ id: this.nextId++, type, x, y, perp, severity, time });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  // Events newer than afterId, in range of a point.
  query(afterId, x, y, range) {
    const out = [];
    for (const e of this.events) {
      if (e.id > afterId && dist(x, y, e.x, e.y) <= range) out.push(e);
    }
    return out;
  }
}
