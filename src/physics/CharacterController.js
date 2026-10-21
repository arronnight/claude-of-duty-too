import * as THREE from 'three';
import { Sweeper } from './Sweeper.js';

/**
 * Swept-capsule character controller.
 *
 * The capsule is vertical and anchored at the feet, so `capsule.position` is
 * the point the player stands on and stance changes only move the top. Motion
 * is resolved in two passes — horizontal collide-and-slide with an optional
 * step-up retry, then vertical — because mixing them lets gravity shove the
 * capsule up ramps and off ledges. Every pass is a continuous sweep, so sprint
 * speed cannot tunnel through a wall, and a final Gauss-Seidel depenetration
 * guarantees the capsule ends the tick outside the world even if the slide
 * projections fought each other in a corner.
 */

export const STANCE_HEIGHT = { stand: 1.8, crouch: 1.2, prone: 0.6 };

const CONTACT = 1, WALL = 2, FLOOR = 4, CEILING = 8;
const RAD2DEG = 180 / Math.PI;

export class CharacterController {
  constructor(physics) {
    this.phys = physics;
    this.sweeper = new Sweeper(physics.bvh, 1024);
    this.walkableCos = Math.cos(45 * Math.PI / 180);
    this.stepHeight = 0.45;
    this.snapDistance = 0.36;
    this.maxDepenetration = 0.6;
    this._n = new THREE.Vector3();
    this._stepN = new THREE.Vector3();
    this.out = {
      position: null,
      velocity: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      wallNormal: new THREE.Vector3(),
      grounded: false,
      steppedUp: false,
      stepDelta: 0,
      hitWall: false,
      hitCeiling: false,
      slope: 0,
      groundMaterial: null,
      groundObject: null,
      contacts: 0,
    };
  }

  createCapsule(position, radius = 0.35, height = STANCE_HEIGHT.stand) {
    const cap = {
      position: new THREE.Vector3().copy(position || { x: 0, y: 0, z: 0 }),
      radius,
      height,
      grounded: false,
      mask: 0,
      _r: radius,
      _segA: new THREE.Vector3(),
      _segB: new THREE.Vector3(),
    };
    this.refresh(cap);
    return cap;
  }

  refresh(cap) {
    if (!cap._segA) { cap._segA = new THREE.Vector3(); cap._segB = new THREE.Vector3(); }
    const r = Math.min(cap.radius, cap.height * 0.5);
    cap._r = r;
    cap._segA.set(cap.position.x, cap.position.y + r, cap.position.z);
    cap._segB.set(cap.position.x, cap.position.y + cap.height - r, cap.position.z);
  }

  /** Is there room to grow the capsule to `height`? Only the new volume is tested. */
  canResize(cap, height, mask) {
    this.refresh(cap);
    if (height <= cap.height + 1e-4) return true;
    const r = Math.min(cap.radius, height * 0.5);
    const ay = cap.position.y + Math.max(cap.height - cap._r, r);
    const by = cap.position.y + height - r;
    if (by <= ay + 1e-5) return true;
    const sw = this.sweeper;
    const m = mask || cap.mask || this.phys.defaultMask;
    sw.depenetrate(cap.position.x, ay, cap.position.z, cap.position.x, by, cap.position.z, r * 0.98, m, 1);
    return sw.contactCount === 0;
  }

  setStance(cap, stance, mask) {
    const h = STANCE_HEIGHT[stance] ?? cap.height;
    if (h > cap.height && !this.canResize(cap, h, mask)) {
      return { ok: false, blocked: true, height: cap.height, stance: null };
    }
    cap.height = h;
    this.refresh(cap);
    return { ok: true, blocked: false, height: h, stance };
  }

  move(cap, vel, dt, mask) {
    const out = this.out;
    const phys = this.phys;
    const m = mask || cap.mask || phys.defaultMask;
    this.refresh(cap);
    out.position = cap.position;
    out.velocity.copy(vel);
    out.normal.set(0, 1, 0);
    out.wallNormal.set(0, 0, 0);
    out.grounded = false;
    out.steppedUp = false;
    out.stepDelta = 0;
    out.hitWall = false;
    out.hitCeiling = false;
    out.slope = 0;
    out.groundMaterial = null;
    out.groundObject = null;
    out.contacts = 0;

    if (!phys.bvh.triCount) {
      cap.position.addScaledVector(vel, dt);
      if (cap.position.y <= phys.groundY) {
        cap.position.y = phys.groundY;
        if (out.velocity.y < 0) out.velocity.y = 0;
        out.grounded = true;
      }
      this.refresh(cap);
      cap.grounded = out.grounded;
      return out;
    }

    // Sliding along a ramp turns forward speed into upward speed. That is the
    // right thing for the position but not for the velocity: left in place it
    // both double-counts the climb and makes the controller think it is
    // airborne. A deliberate jump (positive vertical input) keeps its lift.
    this._jumping = vel.y > 0.05;
    this._resolveOverlap(cap, m, out);
    const startGrounded = cap.grounded || this._probeGround(cap, 0.06, m, null);

    const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
    const subs = Math.min(4, Math.max(1, Math.ceil((speed * dt) / 1.2)));
    const sdt = dt / subs;
    for (let s = 0; s < subs; s++) {
      this._horizontal(cap, out.velocity.x * sdt, out.velocity.z * sdt, out, startGrounded, m);
      this._vertical(cap, out.velocity.y * sdt, out, m);
    }

    // Probing while rising would find the floor we just left and yank the
    // capsule back down, eating the jump.
    if (!this._jumping) {
      const snap = startGrounded && !out.hitCeiling;
      this._probeGround(cap, snap ? this.snapDistance : 0.06, m, out);
    }
    this._resolveOverlap(cap, m, out);
    cap.grounded = out.grounded;
    return out;
  }

  _translate(cap, x, y, z) {
    cap.position.x += x; cap.position.y += y; cap.position.z += z;
    cap._segA.x += x; cap._segA.y += y; cap._segA.z += z;
    cap._segB.x += x; cap._segB.y += y; cap._segB.z += z;
  }

  _setPos(cap, x, y, z) {
    cap.position.set(x, y, z);
    this.refresh(cap);
  }

  /** Sweep the capsule and return the fraction of (dx,dy,dz) that is free. */
  _sweepFree(cap, dx, dy, dz, mask, outNormal) {
    const sw = this.sweeper;
    const hit = sw.sweepCapsule(
      cap._segA.x, cap._segA.y, cap._segA.z,
      cap._segB.x, cap._segB.y, cap._segB.z,
      cap._r, dx, dy, dz, mask, sw.result,
    );
    if (outNormal) {
      if (hit) outNormal.copy(sw.result.normal); else outNormal.set(0, 0, 0);
    }
    return hit ? sw.result.t : 1;
  }

  /**
   * Collide-and-slide. When a second, differently-angled plane is hit the
   * remaining motion is projected onto the crease of the two rather than
   * clipped again — repeated single-plane clipping in a corner cancels itself
   * and the character stops dead a foot short of the wall.
   */
  _slide(cap, dx, dy, dz, iters, out, mask) {
    const sw = this.sweeper;
    let rx = dx, ry = dy, rz = dz;
    let flags = 0;
    let px = 0, py = 0, pz = 0, planes = 0;
    for (let it = 0; it < iters; it++) {
      if (rx * rx + ry * ry + rz * rz < 1e-14) break;
      const hit = sw.sweepCapsule(
        cap._segA.x, cap._segA.y, cap._segA.z,
        cap._segB.x, cap._segB.y, cap._segB.z,
        cap._r, rx, ry, rz, mask, sw.result,
      );
      if (!hit) { this._translate(cap, rx, ry, rz); break; }
      const t = sw.result.t;
      this._translate(cap, rx * t, ry * t, rz * t);
      const nx = sw.result.normal.x, ny = sw.result.normal.y, nz = sw.result.normal.z;
      flags |= CONTACT;
      // Anything short of a genuine overhead surface counts as a wall, so a
      // sloped ledge lip still qualifies for the step-up retry.
      if (ny >= this.walkableCos) flags |= FLOOR;
      else if (ny <= -this.walkableCos) flags |= CEILING;
      else {
        flags |= WALL;
        if (out) { out.hitWall = true; out.wallNormal.set(nx, ny, nz); }
      }
      if (out) {
        out.contacts++;
        const vd = out.velocity.x * nx + out.velocity.y * ny + out.velocity.z * nz;
        if (vd < 0) {
          out.velocity.x -= nx * vd;
          out.velocity.y -= ny * vd;
          out.velocity.z -= nz * vd;
        }
      }
      rx *= 1 - t; ry *= 1 - t; rz *= 1 - t;
      const before = rx * rx + ry * ry + rz * rz;
      if (planes && nx * px + ny * py + nz * pz < 0.98) {
        let cx = py * nz - pz * ny, cy = pz * nx - px * nz, cz = px * ny - py * nx;
        const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
        if (cl > 1e-5) {
          cx /= cl; cy /= cl; cz /= cl;
          const along = rx * cx + ry * cy + rz * cz;
          rx = cx * along; ry = cy * along; rz = cz * along;
        } else {
          rx = 0; ry = 0; rz = 0;
        }
      } else {
        const dp = rx * nx + ry * ny + rz * nz;
        if (dp < 0) { rx -= nx * dp; ry -= ny * dp; rz -= nz * dp; }
      }
      px = nx; py = ny; pz = nz; planes = 1;
      // A zero-time contact that clips nothing would spin the remaining
      // iterations without moving; bail rather than stall.
      if (t < 1e-6 && rx * rx + ry * ry + rz * rz >= before - 1e-12) break;
    }
    return flags;
  }

  _horizontal(cap, dx, dz, out, startGrounded, mask) {
    if (dx * dx + dz * dz < 1e-14) return;
    const sx = cap.position.x, sy = cap.position.y, sz = cap.position.z;
    const vy0 = out.velocity.y;
    const flags = this._slide(cap, dx, 0, dz, 4, out, mask);
    // Sliding up a ramp turns forward speed into climb speed, which is right
    // for the position but must not accumulate in the velocity: fed back by
    // the caller it cancels gravity and the capsule flies off the slope. A
    // jump's own upward velocity is untouched — only gains are capped.
    const vyCap = vy0 > 0 ? vy0 : 0;
    if (out.velocity.y > vyCap) out.velocity.y = vyCap;
    if (!(flags & WALL) || !startGrounded) return;

    const moveDist = Math.sqrt(dx * dx + dz * dz);
    const inv = 1 / moveDist;
    const ux = dx * inv, uz = dz * inv;
    const flatX = cap.position.x, flatY = cap.position.y, flatZ = cap.position.z;
    const flatProgress = (flatX - sx) * ux + (flatZ - sz) * uz;

    this._setPos(cap, sx, sy, sz);
    const up = this.stepHeight * this._sweepFree(cap, 0, this.stepHeight, 0, mask, null);
    if (up > 0.05) {
      // Probe a full capsule-radius ahead first. One frame of walking only
      // clears the lip by a couple of centimetres, and a rounded capsule
      // bottom resting on a lip edge reports a steep normal — judging the step
      // on that would reject every kerb. Probing far enough to sit on the face
      // itself answers the real question: is there walkable ground up there?
      this._translate(cap, 0, up, 0);
      const probe = Math.max(moveDist, cap._r + 0.06);
      this._slide(cap, ux * probe, 0, uz * probe, 3, null, mask);
      const downMax = up + 0.03;
      const probeT = this._sweepFree(cap, 0, -downMax, 0, mask, this._stepN);
      if (probeT < 1 && this._stepN.y >= this.walkableCos) {
        // Commit only this frame's motion, so the climb happens over a few
        // ticks with no teleport.
        this._setPos(cap, sx, sy + up, sz);
        this._slide(cap, dx, 0, dz, 3, null, mask);
        const downT = this._sweepFree(cap, 0, -downMax, 0, mask, this._stepN);
        this._translate(cap, 0, -downMax * downT, 0);
        const progress = (cap.position.x - sx) * ux + (cap.position.z - sz) * uz;
        if (downT < 1 && progress > flatProgress + 1e-4) {
          out.steppedUp = true;
          out.stepDelta += cap.position.y - flatY;
          out.grounded = true;
          out.normal.copy(this._stepN);
          return;
        }
      }
    }
    this._setPos(cap, flatX, flatY, flatZ);
  }

  _vertical(cap, dy, out, mask) {
    if (dy * dy < 1e-16) return;
    const flags = this._slide(cap, 0, dy, 0, 2, out, mask);
    if (flags & CEILING) {
      out.hitCeiling = true;
      if (out.velocity.y > 0) out.velocity.y = 0;
    }
    if (flags & FLOOR && out.velocity.y < 0) out.velocity.y = 0;
  }

  _probeGround(cap, distance, mask, out) {
    const t = this._sweepFree(cap, 0, -distance, 0, mask, this._n);
    if (t >= 1) return false;
    if (this._n.y < this.walkableCos) return false;
    if (!out) return true;
    this._translate(cap, 0, -distance * t, 0);
    out.grounded = true;
    out.normal.copy(this._n);
    out.slope = Math.acos(Math.min(1, this._n.y)) * RAD2DEG;
    const tri = this.sweeper.result.tri;
    if (tri >= 0) {
      out.groundMaterial = this.phys.materialOf(tri);
      out.groundObject = this.phys.objectOf(tri);
    }
    if (out.velocity.y < 0) out.velocity.y = 0;
    return true;
  }

  _resolveOverlap(cap, mask, out) {
    const sw = this.sweeper;
    const n = sw.depenetrate(
      cap._segA.x, cap._segA.y, cap._segA.z,
      cap._segB.x, cap._segB.y, cap._segB.z,
      cap._r, mask, 4,
    );
    if (!n) return;
    let px = sw.push.x, py = sw.push.y, pz = sw.push.z;
    const l = Math.sqrt(px * px + py * py + pz * pz);
    if (l > this.maxDepenetration) {
      const s = this.maxDepenetration / l;
      px *= s; py *= s; pz *= s;
    }
    this._translate(cap, px, py, pz);
    if (out) {
      out.contacts += n;
      if (sw.contactNormal.y >= this.walkableCos && !out.grounded) {
        out.normal.copy(sw.contactNormal);
      }
    }
  }
}
