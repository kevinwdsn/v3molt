// Procedural city: tile grid, buildings, road flow field for traffic, and A* pathfinding.

import { mulberry32, pick, SHOP_NAMES } from "./util.js";

export const TILE = 32;
export const ROAD = 0;
export const SIDEWALK = 1;
export const BUILDING = 2;
export const PARK = 3;

const PERIOD = 10; // block layout repeats every 10 tiles: 2 road, 1 sidewalk, 6 interior, 1 sidewalk

export class City {
  constructor(seed = 1337, w = 70, h = 70) {
    this.w = w;
    this.h = h;
    this.rng = mulberry32(seed);
    this.grid = new Uint8Array(w * h);
    this.buildings = [];
    this.trees = [];
    this.generate();
  }

  generate() {
    const { w, h, grid } = this;
    const band = (t) => {
      const m = t % PERIOD;
      if (m < 2) return ROAD;
      if (m === 2 || m === 9) return SIDEWALK;
      return BUILDING;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bx = band(x);
        const by = band(y);
        // Roads win over everything, then sidewalks ring the blocks.
        grid[y * w + x] = bx === ROAD || by === ROAD
          ? ROAD
          : bx === SIDEWALK || by === SIDEWALK
            ? SIDEWALK
            : BUILDING;
      }
    }

    // Block interiors become a named building or a park.
    const kinds = ["shop", "house", "office"];
    let shopIdx = 0;
    for (let by = 3; by < h - 6; by += PERIOD) {
      for (let bx = 3; bx < w - 6; bx += PERIOD) {
        if (this.rng() < 0.22) {
          for (let y = by; y < by + 6; y++) {
            for (let x = bx; x < bx + 6; x++) grid[y * w + x] = PARK;
          }
          for (let i = 0; i < 7; i++) {
            this.trees.push({
              x: (bx + 0.5 + this.rng() * 5) * TILE,
              y: (by + 0.5 + this.rng() * 5) * TILE,
              r: 8 + this.rng() * 7,
            });
          }
        } else {
          const kind = pick(this.rng, kinds);
          const name = kind === "shop"
            ? SHOP_NAMES[shopIdx++ % SHOP_NAMES.length]
            : kind === "office" ? "Office Block" : "Apartments";
          const hue = 18 + Math.floor(this.rng() * 200);
          this.buildings.push({
            tx: bx, ty: by, tw: 6, th: 6, kind, name,
            color: `hsl(${hue}, 18%, ${30 + Math.floor(this.rng() * 18)}%)`,
            // Door faces the sidewalk on the south side.
            doorX: (bx + 2.5) * TILE + TILE,
            doorY: (by + 6) * TILE + TILE / 2,
          });
        }
      }
    }
  }

  tileAt(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return BUILDING;
    return this.grid[ty * this.w + tx];
  }

  tileAtPx(x, y) {
    return this.tileAt(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  isWalkablePx(x, y) {
    return this.tileAtPx(x, y) !== BUILDING;
  }

  isDrivablePx(x, y) {
    return this.tileAtPx(x, y) === ROAD;
  }

  // Right-hand traffic flow for a road tile. Returns [dx, dy] or null at intersections.
  roadDir(tx, ty) {
    const mx = tx % PERIOD;
    const my = ty % PERIOD;
    const vert = mx < 2;
    const horiz = my < 2;
    if (vert && horiz) return null; // intersection: car decides
    if (vert) return mx === 0 ? [0, 1] : [0, -1];
    if (horiz) return my === 0 ? [-1, 0] : [1, 0];
    return null;
  }

  isIntersection(tx, ty) {
    return tx % PERIOD < 2 && ty % PERIOD < 2;
  }

  randomTileOfType(rng, type) {
    for (let tries = 0; tries < 500; tries++) {
      const tx = Math.floor(rng() * this.w);
      const ty = Math.floor(rng() * this.h);
      if (this.tileAt(tx, ty) === type) return { tx, ty };
    }
    return { tx: 2, ty: 2 };
  }

  // A* over tiles. costFn(tileType) returns cost or Infinity for impassable.
  findPath(sx, sy, gx, gy, costFn, maxExpand = 4200) {
    const { w, h } = this;
    if (sx === gx && sy === gy) return [];
    const key = (x, y) => y * w + x;
    const open = [{ x: sx, y: sy, g: 0, f: 0 }];
    const came = new Map();
    const gScore = new Map([[key(sx, sy), 0]]);
    let expanded = 0;

    while (open.length && expanded < maxExpand) {
      // Small open sets: linear extract-min is fine at this scale.
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0];
      expanded++;
      if (cur.x === gx && cur.y === gy) {
        const path = [];
        let k = key(gx, gy);
        while (came.has(k)) {
          path.push({ x: k % w, y: Math.floor(k / w) });
          k = came.get(k);
        }
        return path.reverse();
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const c = costFn(this.tileAt(nx, ny));
        if (!isFinite(c)) continue;
        const nk = key(nx, ny);
        const ng = cur.g + c;
        if (ng < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, ng);
          came.set(nk, key(cur.x, cur.y));
          open.push({ x: nx, y: ny, g: ng, f: ng + Math.abs(gx - nx) + Math.abs(gy - ny) });
        }
      }
    }
    return null;
  }
}

// Pedestrians prefer sidewalks and parks, cross roads reluctantly, never enter buildings.
export const PED_COST = (t) =>
  t === SIDEWALK ? 1 : t === PARK ? 1.1 : t === ROAD ? 3.5 : Infinity;

export const CAR_COST = (t) => (t === ROAD ? 1 : Infinity);
