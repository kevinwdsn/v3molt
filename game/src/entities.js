// Player and vehicles. Traffic cars follow the road flow field; the player can steal any car.

import { TILE, ROAD } from "./world.js";
import { clamp, angleDiff, dist, pick } from "./util.js";

export class Player {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.angle = 0;
    this.radius = 9;
    this.health = 100;
    this.vehicle = null;
    this.punchCooldown = 0;
    this.lastCrimeTime = -999;
  }

  get speed() {
    return 150;
  }

  update(dt, input, city) {
    this.punchCooldown = Math.max(0, this.punchCooldown - dt);
    if (this.vehicle) {
      this.vehicle.driveUpdate(dt, input, city);
      this.x = this.vehicle.x;
      this.y = this.vehicle.y;
      return;
    }
    let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      dx /= len;
      dy /= len;
      this.angle = Math.atan2(dy, dx);
      moveWithCollision(this, dx * this.speed * dt, dy * this.speed * dt, city);
    }
  }
}

export const CAR_COLORS = ["#b33", "#36a", "#caa23a", "#777", "#3a8a4d", "#915aa8", "#d07030", "#ddd"];

export class Vehicle {
  constructor(x, y, angle, rng, police = false) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.speed = 0;
    this.maxSpeed = police ? 380 : 330;
    this.color = police ? "#eef" : pick(rng, CAR_COLORS);
    this.police = police;
    this.driver = null; // 'ai' | 'player' | null (parked)
    this.length = 40;
    this.width = 20;
    this.brakeTimer = 0;
    this.stuckTimer = 0;
  }

  // --- Player driving -------------------------------------------------------
  driveUpdate(dt, input, city) {
    const accel = 280;
    if (input.up) this.speed += accel * dt;
    else if (input.down) this.speed -= accel * 0.9 * dt;
    else this.speed *= Math.pow(0.4, dt); // engine drag
    if (input.brake) this.speed *= Math.pow(0.02, dt);
    this.speed = clamp(this.speed, -120, this.maxSpeed);

    const steer = ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * 2.6;
    if (Math.abs(this.speed) > 8) {
      this.angle += steer * dt * Math.sign(this.speed) * Math.min(1, Math.abs(this.speed) / 120);
    }
    this.integrate(dt, city);
  }

  // --- Ambient traffic ------------------------------------------------------
  aiUpdate(dt, city, rng, obstacles) {
    if (this.driver !== "ai") return;
    const tx = Math.floor(this.x / TILE);
    const ty = Math.floor(this.y / TILE);

    let target = 160;
    // Brake for anything ahead of the bumper.
    const lookX = this.x + Math.cos(this.angle) * 55;
    const lookY = this.y + Math.sin(this.angle) * 55;
    for (const o of obstacles) {
      if (o === this) continue;
      if (dist(lookX, lookY, o.x, o.y) < 34) {
        target = 0;
        this.brakeTimer = 0.4;
        break;
      }
    }
    if (this.brakeTimer > 0) {
      this.brakeTimer -= dt;
      target = 0;
    }

    // Track whether we're wedged so we can despawn-respawn elsewhere.
    this.stuckTimer = target > 0 && Math.abs(this.speed) < 5 ? this.stuckTimer + dt : 0;

    let dir = city.roadDir(tx, ty);
    if (!dir) {
      // Intersection: keep heading if the road continues, otherwise turn legally.
      const heading = [Math.round(Math.cos(this.angle)), Math.round(Math.sin(this.angle))];
      const options = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ahead = city.tileAt(tx + dx * 2, ty + dy * 2);
        if (ahead !== ROAD) continue;
        const flow = city.roadDir(tx + dx * 2, ty + dy * 2);
        if (flow && (flow[0] !== dx || flow[1] !== dy)) continue; // wrong-way lane
        options.push([dx, dy]);
      }
      if (options.length) {
        const straight = options.find(([dx, dy]) => dx === heading[0] && dy === heading[1]);
        dir = straight && rng() < 0.65 ? straight : pick(rng, options);
      } else {
        dir = heading;
      }
    }
    const want = Math.atan2(dir[1], dir[0]);
    const diff = angleDiff(this.angle, want);
    this.angle += clamp(diff, -2.4 * dt, 2.4 * dt);
    if (Math.abs(diff) > 0.8) target = Math.min(target, 50);

    this.speed += clamp(target - this.speed, -300 * dt, 110 * dt);
    this.integrate(dt, city);
  }

  integrate(dt, city) {
    const nx = this.x + Math.cos(this.angle) * this.speed * dt;
    const ny = this.y + Math.sin(this.angle) * this.speed * dt;
    // Cars stay off buildings; sidewalks/parks are fair game for joyriders (slow them down).
    if (city.isWalkablePx(nx, ny)) {
      this.x = nx;
      this.y = ny;
      if (!city.isDrivablePx(nx, ny)) this.speed *= Math.pow(0.25, dt);
    } else {
      this.speed = -this.speed * 0.25; // crunch
    }
  }
}

// Axis-separated movement so agents slide along walls instead of sticking.
export function moveWithCollision(e, dx, dy, city) {
  if (city.isWalkablePx(e.x + dx, e.y)) e.x += dx;
  if (city.isWalkablePx(e.x, e.y + dy)) e.y += dy;
}
