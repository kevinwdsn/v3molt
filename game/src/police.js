// Wanted system + cop AI. Cops only know where the player *was last seen*:
// they chase on sight, search the last known position otherwise, and give up
// (heat decays) once they lose the trail.

import { TILE, PED_COST } from "./world.js";
import { moveWithCollision } from "./entities.js";
import { clamp, dist, angleTo } from "./util.js";

const COP_SIGHT = 360;
const COP_RUN = 175;

export class WantedSystem {
  constructor() {
    this.heat = 0;
    this.evadeTimer = 0;
  }

  get level() {
    return clamp(Math.floor(this.heat), 0, 5);
  }

  report(severity) {
    this.heat = clamp(this.heat + severity, 0, 5.9);
  }

  update(dt, anyCopSeesPlayer) {
    if (this.heat <= 0) return;
    if (anyCopSeesPlayer) {
      this.evadeTimer = 0;
    } else {
      this.evadeTimer += dt;
      // Stay out of sight to cool off; higher heat takes longer to shake.
      if (this.evadeTimer > 8 + this.level * 4) {
        this.heat = Math.max(0, this.heat - dt * 0.25);
      }
    }
  }

  clear() {
    this.heat = 0;
    this.evadeTimer = 0;
  }
}

export class Cop {
  constructor(x, y, rng) {
    this.x = x;
    this.y = y;
    this.rng = rng;
    this.angle = 0;
    this.radius = 8;
    this.path = null;
    this.pathIdx = 0;
    this.repathTimer = 0;
    this.lastKnown = null;
    this.seesPlayer = false;
    this.arrestTimer = 0;
  }

  update(dt, world) {
    const pl = world.player;
    const d = dist(this.x, this.y, pl.x, pl.y);
    this.seesPlayer = d < COP_SIGHT;
    if (this.seesPlayer) this.lastKnown = { x: pl.x, y: pl.y };

    if (this.seesPlayer && d < 200 && !pl.vehicle) {
      // Direct pursuit: no pathfinding needed at close range.
      this.angle = angleTo(this.x, this.y, pl.x, pl.y);
      moveWithCollision(
        this, Math.cos(this.angle) * COP_RUN * dt, Math.sin(this.angle) * COP_RUN * dt, world.city,
      );
      this.path = null;
      return;
    }

    const goal = this.lastKnown;
    if (!goal) return;
    this.repathTimer -= dt;
    if (this.repathTimer <= 0 || !this.path) {
      this.repathTimer = 0.8;
      this.path = world.city.findPath(
        Math.floor(this.x / TILE), Math.floor(this.y / TILE),
        clamp(Math.floor(goal.x / TILE), 0, world.city.w - 1),
        clamp(Math.floor(goal.y / TILE), 0, world.city.h - 1),
        // Cops will cut across roads and parks without hesitation.
        (t) => (PED_COST(t) === Infinity ? Infinity : 1),
      ) || [];
      this.pathIdx = 0;
    }
    if (this.pathIdx < this.path.length) {
      const node = this.path[this.pathIdx];
      const cx = (node.x + 0.5) * TILE;
      const cy = (node.y + 0.5) * TILE;
      if (dist(this.x, this.y, cx, cy) < 6) this.pathIdx++;
      else {
        this.angle = angleTo(this.x, this.y, cx, cy);
        moveWithCollision(
          this, Math.cos(this.angle) * COP_RUN * dt, Math.sin(this.angle) * COP_RUN * dt, world.city,
        );
      }
    } else if (!this.seesPlayer) {
      this.lastKnown = null; // reached the last sighting and found nothing
    }
  }

  tryArrest(dt, world) {
    const pl = world.player;
    const d = dist(this.x, this.y, pl.x, pl.y);
    const playerStopped = !pl.vehicle || Math.abs(pl.vehicle.speed) < 30;
    if (d < 26 && playerStopped) {
      this.arrestTimer += dt;
      if (this.arrestTimer > (pl.vehicle ? 1.2 : 0.3)) return true;
    } else {
      this.arrestTimer = 0;
    }
    return false;
  }
}
