import * as THREE from 'three';
import { Batch } from './lib.js';

/**
 * Where things go, and how they get drawn.
 *
 * Two problems, one file.
 *
 * **1. Placement must survive a level rewrite.** The blockout in `Level.js`
 * belongs to another agent and is expected to be replaced wholesale. Hard-coding
 * "the west facade is at x = -11.4" would make every prop in the game wrong the
 * moment that happens. So nothing here knows the map: `Site` *surveys* it at
 * init through `ctx.physics.raycast`, exactly the way the AI will survey it for
 * a navmesh. It builds an occupancy grid of walkable ground, a chamfer distance
 * transform to the nearest obstruction, and a list of exposed vertical facade
 * segments with their outward normals and heights. Every prop module then asks
 * questions in those terms — "give me a point 30 cm from a wall base", "walk the
 * facades" — and stays correct against any layout.
 *
 * The distance field is also the art direction. `ART_DIRECTION.md` rule 2 wants
 * debris where it is *not walked on*: heavy against wall bases and in corners,
 * thinning to almost nothing down the middle of the carriageway. That is a
 * falloff on distance-to-wall, and having the field means it is one line rather
 * than a hand-placed guess.
 *
 * **2. Draw calls are the scarce resource.** 350 budget, 178 already spent, and
 * every shadow-casting mesh costs one draw per cascade on top of its own. So
 * props never become one mesh each. `BatchSet` accumulates every piece into a
 * merge buffer keyed by `material x spatial zone x casts-shadow`, and emits one
 * mesh per bucket. A thousand rubble chunks in three zones across four materials
 * is a dozen draws, not a thousand, and the zone split keeps frustum culling
 * meaningful so looking away from half the street still costs half as much.
 */

// --------------------------------------------------------------------- consts

const GRID_STEP = 1.0;          // m between survey samples
const GRID_PAD = 3;             // m of grid beyond the level bounds
const MAX_FLOOR_Y = 0.75;       // ground above this is furniture, not floor
const MIN_HEADROOM = 1.9;       // m of clear space above a floor sample
const WALL_PROBE = 1.6;         // m horizontal reach when looking for a wall
const ZONE_LEN = 45;            // m of Z per batching zone

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

// ----------------------------------------------------------------------- site

/**
 * A surveyed model of the map: walkable ground, distance to the nearest
 * obstruction, and the exposed vertical faces of everything standing on it.
 */
export class Site {
  /** @param {any} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    const b = ctx.level?.bounds;
    const min = b ? b.min : new THREE.Vector3(-40, 0, -50);
    const max = b ? b.max : new THREE.Vector3(40, 20, 40);

    this.x0 = Math.floor(min.x) - GRID_PAD;
    this.z0 = Math.floor(min.z) - GRID_PAD;
    this.x1 = Math.ceil(max.x) + GRID_PAD;
    this.z1 = Math.ceil(max.z) + GRID_PAD;
    this.topY = Math.max(24, max.y + 4);

    this.nx = Math.max(2, Math.round((this.x1 - this.x0) / GRID_STEP));
    this.nz = Math.max(2, Math.round((this.z1 - this.z0) / GRID_STEP));
    const n = this.nx * this.nz;

    this.open = new Uint8Array(n);        // 1 = walkable floor sample
    this.gy = new Float32Array(n);        // floor height
    this.dist = new Float32Array(n);      // metres to nearest blocked cell
    this.wallN = new Int8Array(n * 2);    // outward normal of the nearest wall
    this.wallD = new Float32Array(n);     // measured metres to that wall face
    this.corner = new Uint8Array(n);      // how many of 4 probes hit a wall
    this.indoor = new Uint8Array(n);      // roofed over
    this.step = new Float32Array(n);      // biggest height step to a neighbour
    this.surf = new Array(n).fill('asphalt');
    this.taken = new Float32Array(n);     // radius of the prop occupying the cell
    this.lee = new Float32Array(n);       // 0..4 sheltered-ness downwind of an obstruction
    this.gutter = new Float32Array(n);    // 0..1 proximity to a kerb / height step
    this.kerbDist = new Float32Array(n).fill(60);  // metres to the nearest step
    /** Prevailing wind, radians. One direction shared by every consumer. */
    this.windYaw = 0;
    this.windX = 0;
    this.windZ = 1;

    /** @type {{ax:number,az:number,bx:number,bz:number,nx:number,nz:number,len:number,top:number,base:number,surface:string}[]} */
    this.facades = [];
    /** @type {{x:number,z:number,y:number,w:number,d:number}[]} */
    this.roofs = [];
    this.rayCount = 0;
  }

  index(ix, iz) { return iz * this.nx + ix; }
  ixOf(x) { return Math.round((x - this.x0) / GRID_STEP); }
  izOf(z) { return Math.round((z - this.z0) / GRID_STEP); }
  xOf(ix) { return this.x0 + ix * GRID_STEP; }
  zOf(iz) { return this.z0 + iz * GRID_STEP; }
  inside(ix, iz) { return ix >= 0 && iz >= 0 && ix < this.nx && iz < this.nz; }

  /** One downward probe. Returns null off the map or onto a non-floor. */
  _floorAt(x, z) {
    const phys = this.ctx.physics;
    if (!phys?.raycast) return null;
    let y = this.topY;
    for (let bounce = 0; bounce < 4; bounce++) {
      _o.set(x, y, z);
      _d.set(0, -1, 0);
      const hit = phys.raycast(_o, _d, y + 6);
      this.rayCount++;
      if (!hit) return null;
      const py = hit.point.y;
      const up = hit.normal.y;
      if (up > 0.55 && py <= MAX_FLOOR_Y && py >= -1.5) {
        return { y: py, surface: hit.material || 'asphalt' };
      }
      if (py <= -1.5) return null;
      y = py - 0.08;
    }
    return null;
  }

  /**
   * Axis-aligned world boxes of everything standing on the floor.
   *
   * A downward raycast alone cannot answer "is this point inside a building".
   * `Physics.raycast` flips every hit normal to oppose the ray, which is right
   * for shading and shooting and destroys the one bit needed here: a ray fired
   * down through a solid block reports the block's *underside* as an
   * upward-facing floor at y = 0, so the entire footprint of every building
   * surveyed as walkable open street. Parity counting does not rescue it either
   * — the blockout has coincident faces where one box sits exactly on another,
   * and a crossing gets lost.
   *
   * Bounding boxes are exact enough for the question actually being asked and
   * cost nothing. Anything under a metre tall is deliberately not an obstacle:
   * kerbs, thresholds and floor slabs are walkable, and their height *step* is
   * carried in its own channel because that is where silt collects.
   */
  _collectObstacles() {
    const boxes = [];
    const roots = [this.ctx.level?.root].filter(Boolean);
    if (!roots.length && this.ctx.scene) roots.push(this.ctx.scene);
    const box = new THREE.Box3();
    for (const root of roots) {
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        if (!o.isMesh || o.userData?.noCollide || !o.geometry) return;
        box.setFromObject(o);
        if (!isFinite(box.min.x) || !isFinite(box.max.x)) return;
        const sy = box.max.y - box.min.y;
        const sx = box.max.x - box.min.x;
        const sz = box.max.z - box.min.z;
        // The 400 m ground plane is not an obstacle; nor is anything flat.
        if (sy < 1.0 || sx > 200 || sz > 200) return;
        boxes.push([box.min.x, box.max.x, box.min.z, box.max.z, box.min.y, box.max.y]);
      });
    }
    return boxes;
  }

  /**
   * Fills the grid. ~6 k downward rays plus a horizontal probe on the cells the
   * distance field says are near something; the BVH eats that in a few ms and it
   * happens once, during init.
   */
  survey() {
    const { nx, nz } = this;
    const phys = this.ctx.physics;
    const obstacles = this._collectObstacles();

    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = this.index(ix, iz);
        const x = this.xOf(ix), z = this.zOf(iz);
        const f = this._floorAt(x, z);
        if (!f) continue;
        // Standing room: something whose body spans knee to chest height here
        // is a wall, a barrier or a lamp post, not a floor.
        // Overlap with the cell's *square*, not containment of its centre. A
        // 350 mm partition on a 1 m grid falls cleanly between two samples, so
        // the centre test leaves no blocked cell anywhere along it — the
        // distance transform then reads straight through the wall and the room
        // it encloses never produces a facade at all. That is exactly what
        // happened to the one enterable interior on this map: every wall in it
        // stayed clean because the survey did not believe it was there.
        let blocked = false;
        const lo = f.y + 0.28, hi = f.y + 1.5;
        const h = GRID_STEP * 0.5;
        for (let k = 0; k < obstacles.length; k++) {
          const b = obstacles[k];
          if (x + h <= b[0] || x - h >= b[1] || z + h <= b[2] || z - h >= b[3]) continue;
          if (b[5] < lo || b[4] > hi) continue;
          blocked = true;
          break;
        }
        if (blocked) continue;
        // Reject anything with a low ceiling sitting on it, but keep real
        // interiors: a 3.4 m room is content, a 0.9 m crevice is not.
        _o.set(x, f.y + 0.06, z);
        _d.set(0, 1, 0);
        const up = phys?.raycast ? phys.raycast(_o, _d, 14) : null;
        this.rayCount++;
        if (up && up.distance < MIN_HEADROOM) continue;
        this.open[i] = 1;
        this.gy[i] = f.y;
        this.surf[i] = f.surface;
        if (up) this.indoor[i] = 1;
      }
    }

    // Kerbs, kerbstones and door thresholds are not obstructions, so the
    // distance field is blind to them — but a gutter is exactly where silt
    // collects, so height steps get their own channel.
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = this.index(ix, iz);
        if (!this.open[i]) continue;
        let s = 0;
        for (const [dx, dz] of DIRS) {
          const jx = ix + dx, jz = iz + dz;
          if (!this.inside(jx, jz)) continue;
          const j = this.index(jx, jz);
          if (!this.open[j]) continue;
          const d = Math.abs(this.gy[j] - this.gy[i]);
          if (d > s) s = d;
        }
        this.step[i] = s;
      }
    }

    this._distanceTransform();
    this._probeWalls();
    this._findFacades();
    this._findRoofs();
    this.buildShelter();
    this.buildGutter();
    return this;
  }

  /**
   * Where the wind does not reach, and therefore where loose material piles up.
   *
   * Real streets are asymmetric in one consistent direction: drifts of grit,
   * leaves and litter bank on the downwind side of every kerb, step, wall base
   * and parked object, and they all bank the *same way*, because there is only
   * one prevailing wind. Placing each drift with an independent random
   * orientation is one of the strongest tells that a scene was generated
   * rather than photographed — so one direction is computed here and every
   * consumer reads it, rather than each rolling its own.
   *
   * The direction is the long axis of the largest facade, i.e. along the
   * street: wind channels down a street canyon, it does not blow through the
   * buildings. `facades` is sorted by length, so `facades[0]` is the longest.
   *
   * The field itself is a single upwind sweep. Cells are visited in order of
   * their projection onto the wind vector, so a cell's upwind neighbours are
   * always already final; shelter is inherited from upwind at 0.86 per metre
   * (an e-fold over about 6.6 m), seeded at 1.0 immediately downwind of
   * anything blocked and topped up by the local height step. O(n) over ~11 k
   * cells, plus one sort — sub-millisecond, once, at init.
   *
   * @param {number} [windYaw] override, radians; defaults to along the street
   */
  buildShelter(windYaw) {
    const { nx, nz, open, step, lee } = this;
    lee.fill(0);

    if (windYaw === undefined) {
      const f = this.facades[0];
      if (f) {
        const ux = f.bx - f.ax, uz = f.bz - f.az;
        const l = Math.hypot(ux, uz) || 1;
        windYaw = Math.atan2(ux / l, uz / l);
      } else {
        // No surveyed facade: blow along whichever way the map is longer.
        windYaw = nz >= nx ? 0 : Math.PI / 2;
      }
    }
    this.windYaw = windYaw;
    const wx = Math.sin(windYaw), wz = Math.cos(windYaw);
    this.windX = wx;
    this.windZ = wz;

    // Visit order: strictly increasing along the wind, so both upwind
    // neighbours of any cell have been finalised before it is read.
    const order = [];
    for (let i = 0; i < open.length; i++) if (open[i]) order.push(i);
    const proj = new Float32Array(open.length);
    for (const i of order) {
      const ix = i % nx, iz = (i / nx) | 0;
      proj[i] = ix * GRID_STEP * wx + iz * GRID_STEP * wz;
    }
    order.sort((a, b) => proj[a] - proj[b]);

    const ax = Math.abs(wx), az = Math.abs(wz);
    const sx = wx >= 0 ? 1 : -1, sz = wz >= 0 ? 1 : -1;
    const wsum = ax + az || 1;

    for (const i of order) {
      const ix = i % nx, iz = (i / nx) | 0;
      // Two axis neighbours weighted by the wind's components, so a diagonal
      // wind does not quantise onto one axis and produce a staircase.
      let acc = 0;
      if (ax > 1e-4) acc += ax * this._upwindTerm(ix - sx, iz);
      if (az > 1e-4) acc += az * this._upwindTerm(ix, iz - sz);
      const v = acc / wsum + step[i] * 2.2;
      lee[i] = v < 0 ? 0 : v > 4 ? 4 : v;
    }
    return this;
  }

  /**
   * Shelter contributed by one upwind neighbour: inherited, or seeded if the
   * neighbour blocks the wind.
   *
   * Off-map reads as 0, not as a seed. The alternative puts a 6 m band of
   * unexplained drift across the upwind edge of the map for no reason — wind
   * arrives from open ground, it is not sheltered by the edge of the grid.
   *
   * The `taken` branch is inert during `survey()`, where nothing has been
   * placed yet; it exists so a consumer may re-run `buildShelter()` after
   * placing large props and have them cast their own lee.
   */
  _upwindTerm(ix, iz) {
    if (!this.inside(ix, iz)) return 0;
    const u = this.index(ix, iz);
    if (!this.open[u]) return 1.0;                // wall, kerb face or building
    if (this.taken[u] > 0) return 1.0;            // a placed prop casts its own lee
    return this.lee[u] * 0.86;
  }

  /**
   * Distance-to-kerb, as a 0..1 weight. Silt, grit and standing water collect
   * in the 20-30 cm strip against a kerb face, and that strip reads in a photo
   * long before any individual piece of debris does.
   *
   * Kerbs are deliberately invisible to `dist`: anything under a metre tall is
   * walkable and therefore not an obstruction, which is right for placement and
   * useless here. So the same two-pass chamfer runs again, seeded on cells that
   * carry a height step instead of on blocked cells.
   *
   * CAVEAT for consumers: with a 0.30 m falloff on a 1 m grid, `gutter` is in
   * practice a one-cell binary mask — the first ring out is already at 0.036.
   * That is fine for "am I in the gutter", useless as a gradient. Anything that
   * wants a wider band should read `kerbDist` (metres to the nearest height
   * step, 60 where there is none) and shape its own falloff.
   */
  buildGutter(seedStep = 0.04, falloff = 0.30) {
    const { nx, nz, open, step, gutter } = this;
    const BIG = 1e4;
    const A = GRID_STEP, B = GRID_STEP * 1.41421356;
    const d = this.kerbDist || (this.kerbDist = new Float32Array(open.length));
    for (let i = 0; i < d.length; i++) d[i] = step[i] > seedStep ? 0 : BIG;

    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        if (!open[i]) continue;
        let v = d[i];
        if (ix > 0) v = Math.min(v, d[i - 1] + A);
        if (iz > 0) v = Math.min(v, d[i - nx] + A);
        if (ix > 0 && iz > 0) v = Math.min(v, d[i - nx - 1] + B);
        if (ix < nx - 1 && iz > 0) v = Math.min(v, d[i - nx + 1] + B);
        d[i] = v;
      }
    }
    for (let iz = nz - 1; iz >= 0; iz--) {
      for (let ix = nx - 1; ix >= 0; ix--) {
        const i = iz * nx + ix;
        if (!open[i]) continue;
        let v = d[i];
        if (ix < nx - 1) v = Math.min(v, d[i + 1] + A);
        if (iz < nz - 1) v = Math.min(v, d[i + nx] + A);
        if (ix < nx - 1 && iz < nz - 1) v = Math.min(v, d[i + nx + 1] + B);
        if (ix > 0 && iz < nz - 1) v = Math.min(v, d[i + nx - 1] + B);
        d[i] = v;
      }
    }
    for (let i = 0; i < d.length; i++) {
      if (!open[i] || d[i] > 900) { d[i] = 60; gutter[i] = 0; continue; }
      gutter[i] = Math.exp(-d[i] / falloff);
    }
    return this;
  }

  /** Two-pass chamfer distance from every open cell to the nearest blocked one. */
  _distanceTransform() {
    const { nx, nz, open, dist } = this;
    const BIG = 1e4;
    const A = GRID_STEP, B = GRID_STEP * 1.41421356;
    for (let i = 0; i < dist.length; i++) dist[i] = open[i] ? BIG : 0;

    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        if (!open[i]) continue;
        let d = dist[i];
        if (ix > 0) d = Math.min(d, dist[i - 1] + A);
        if (iz > 0) d = Math.min(d, dist[i - nx] + A);
        if (ix > 0 && iz > 0) d = Math.min(d, dist[i - nx - 1] + B);
        if (ix < nx - 1 && iz > 0) d = Math.min(d, dist[i - nx + 1] + B);
        dist[i] = d;
      }
    }
    for (let iz = nz - 1; iz >= 0; iz--) {
      for (let ix = nx - 1; ix >= 0; ix--) {
        const i = iz * nx + ix;
        if (!open[i]) continue;
        let d = dist[i];
        if (ix < nx - 1) d = Math.min(d, dist[i + 1] + A);
        if (iz < nz - 1) d = Math.min(d, dist[i + nx] + A);
        if (ix < nx - 1 && iz < nz - 1) d = Math.min(d, dist[i + nx + 1] + B);
        if (ix > 0 && iz < nz - 1) d = Math.min(d, dist[i + nx - 1] + B);
        dist[i] = d;
      }
    }
    // Cells that never reached a blocker (an unbounded plane) read as far away.
    for (let i = 0; i < dist.length; i++) if (dist[i] > 900) dist[i] = 60;
  }

  /** Outward wall normal and corner count, only where the field says it matters. */
  _probeWalls() {
    const phys = this.ctx.physics;
    if (!phys?.raycast) return;
    for (let i = 0; i < this.open.length; i++) {
      if (!this.open[i] || this.dist[i] > 2.4) continue;
      const ix = i % this.nx, iz = (i / this.nx) | 0;
      const x = this.xOf(ix), z = this.zOf(iz), y = this.gy[i] + 1.1;
      let best = -1, bx = 0, bz = 0, hits = 0;
      for (const [dx, dz] of DIRS) {
        _o.set(x, y, z);
        _d.set(dx, 0, dz);
        const hit = phys.raycast(_o, _d, WALL_PROBE);
        this.rayCount++;
        if (!hit || Math.abs(hit.normal.y) > 0.5) continue;
        hits++;
        if (best < 0 || hit.distance < best) { best = hit.distance; bx = -dx; bz = -dz; }
      }
      this.corner[i] = hits;
      this.wallN[i * 2] = bx;
      this.wallN[i * 2 + 1] = bz;
      this.wallD[i] = best < 0 ? 0 : best;
    }
  }

  /**
   * Contiguous runs of wall-adjacent cells sharing an outward normal, turned
   * into facade segments with a measured top height. These are what the facade
   * and overhead modules walk.
   */
  _findFacades() {
    const seen = new Uint8Array(this.open.length);
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const i = this.index(ix, iz);
        if (seen[i] || !this.open[i] || this.dist[i] > 1.35) continue;
        const nxv = this.wallN[i * 2], nzv = this.wallN[i * 2 + 1];
        if (!nxv && !nzv) continue;
        // Run perpendicular to the wall normal.
        const sx = nxv ? 0 : 1, sz = nxv ? 1 : 0;
        let jx = ix, jz = iz, len = 0;
        while (this.inside(jx, jz)) {
          const j = this.index(jx, jz);
          if (seen[j] || !this.open[j] || this.dist[j] > 1.35) break;
          if (this.wallN[j * 2] !== nxv || this.wallN[j * 2 + 1] !== nzv) break;
          seen[j] = 1;
          len++;
          jx += sx; jz += sz;
        }
        if (len < 3) continue;
        const ax = this.xOf(ix), az = this.zOf(iz);
        const bx = this.xOf(jx - sx), bz = this.zOf(jz - sz);
        const base = this.gy[i];
        // The horizontal probe measured the real distance to the face; the
        // chamfer distance is quantised to the grid and would put the facade
        // line up to half a cell inside the masonry.
        const off = this.wallD[i] || this.dist[i];
        const fx = ax - nxv * off, fz = az - nzv * off;
        // Sample the height 25 cm *inside* the wall. Probing outside it just
        // measures the pavement, which is why this used to reject every facade.
        const top = this._wallTop(fx - nxv * 0.25, fz - nzv * 0.25, base);
        if (top - base < 2.2) continue;
        this.facades.push({
          ax: fx, az: fz,
          bx: bx - nxv * off, bz: bz - nzv * off,
          nx: nxv, nz: nzv,
          len: Math.hypot(bx - ax, bz - az) + GRID_STEP,
          top, base,
          surface: this._surfaceAt(fx + nxv * 0.35, fz + nzv * 0.35, base + 1.4, -nxv, -nzv),
        });
      }
    }
    this.facades.sort((a, b) => b.len - a.len);
  }

  _surfaceAt(x, z, y, dx, dz) {
    const phys = this.ctx.physics;
    if (!phys?.raycast) return 'concrete_wall';
    _o.set(x, y, z);
    _d.set(dx, 0, dz);
    const hit = phys.raycast(_o, _d, 1.2);
    this.rayCount++;
    return hit?.material || 'concrete_wall';
  }

  /** Height of whatever stands at (x,z), measured from above. */
  _wallTop(x, z, base) {
    const phys = this.ctx.physics;
    if (!phys?.raycast) return base + 6;
    _o.set(x, this.topY, z);
    _d.set(0, -1, 0);
    const hit = phys.raycast(_o, _d, this.topY + 4);
    this.rayCount++;
    if (!hit) return base + 6;
    return hit.point.y;
  }

  /**
   * Flat upward-facing surfaces above head height, coarsely clustered into
   * rectangles. The establishing camera looks straight down at these and they
   * are currently bare — `ART_DIRECTION.md` rule 6.
   */
  _findRoofs() {
    const phys = this.ctx.physics;
    if (!phys?.raycast) return;
    const step = 2.0;
    const cells = new Map();
    for (let x = this.x0; x <= this.x1; x += step) {
      for (let z = this.z0; z <= this.z1; z += step) {
        _o.set(x, this.topY, z);
        _d.set(0, -1, 0);
        const hit = phys.raycast(_o, _d, this.topY + 4);
        this.rayCount++;
        if (!hit || hit.normal.y < 0.85) continue;
        const y = hit.point.y;
        if (y < 4.5) continue;
        const k = Math.round(y * 2);
        let g = cells.get(k);
        if (!g) { g = { y, pts: [] }; cells.set(k, g); }
        g.pts.push([x, z]);
      }
    }
    for (const g of cells.values()) {
      if (g.pts.length < 6) continue;
      // Split each height band into connected rectangles the crude way: one
      // bounding box per contiguous run in Z, merged across X.
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of g.pts) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      // Cluster in X so the two facade rows do not merge into one slab.
      const bins = new Map();
      for (const [x, z] of g.pts) {
        const b = Math.round(x / 8);
        let e = bins.get(b);
        if (!e) { e = { minX: x, maxX: x, minZ: z, maxZ: z, n: 0 }; bins.set(b, e); }
        e.minX = Math.min(e.minX, x); e.maxX = Math.max(e.maxX, x);
        e.minZ = Math.min(e.minZ, z); e.maxZ = Math.max(e.maxZ, z);
        e.n++;
      }
      // Stitch adjacent X bins that share a Z extent.
      const keys = [...bins.keys()].sort((a, b) => a - b);
      let cur = null;
      for (const k of keys) {
        const e = bins.get(k);
        if (cur && e.minX - cur.maxX < step * 1.6 && Math.abs(e.minZ - cur.minZ) < 6 && Math.abs(e.maxZ - cur.maxZ) < 6) {
          cur.maxX = Math.max(cur.maxX, e.maxX);
          cur.minZ = Math.min(cur.minZ, e.minZ);
          cur.maxZ = Math.max(cur.maxZ, e.maxZ);
          cur.n += e.n;
        } else {
          if (cur) this._pushRoof(cur, g.y);
          cur = { ...e };
        }
      }
      if (cur) this._pushRoof(cur, g.y);
    }
    this.roofs.sort((a, b) => b.w * b.d - a.w * a.d);
  }

  _pushRoof(e, y) {
    const w = e.maxX - e.minX, d = e.maxZ - e.minZ;
    if (w < 4 || d < 4 || e.n < 6) return;
    this.roofs.push({ x: (e.minX + e.maxX) / 2, z: (e.minZ + e.maxZ) / 2, y, w, d });
  }

  // ------------------------------------------------------------- queries

  /** Floor height at a world point, or null if that point is not on floor. */
  groundAt(x, z) {
    const ix = this.ixOf(x), iz = this.izOf(z);
    if (!this.inside(ix, iz)) return null;
    const i = this.index(ix, iz);
    return this.open[i] ? this.gy[i] : null;
  }

  cellAt(x, z) {
    const ix = this.ixOf(x), iz = this.izOf(z);
    if (!this.inside(ix, iz)) return -1;
    const i = this.index(ix, iz);
    return this.open[i] ? i : -1;
  }

  /** Metres to the nearest obstruction, 60 for open ground. */
  distAt(x, z) {
    const i = this.cellAt(x, z);
    return i < 0 ? 0 : this.dist[i];
  }

  /** 0..4 shelter from the prevailing wind. High = drifts settle here. */
  leeAt(x, z) {
    const i = this.cellAt(x, z);
    return i < 0 ? 0 : this.lee[i];
  }

  /** 0..1 proximity to a kerb face or height step. */
  gutterAt(x, z) {
    const i = this.cellAt(x, z);
    return i < 0 ? 0 : this.gutter[i];
  }

  /** True while nothing bigger has claimed the disc at (x,z). */
  free(x, z, r) {
    const ix0 = this.ixOf(x - r), ix1 = this.ixOf(x + r);
    const iz0 = this.izOf(z - r), iz1 = this.izOf(z + r);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        if (!this.inside(ix, iz)) return false;
        const i = this.index(ix, iz);
        if (!this.open[i]) return false;
        if (this.taken[i] > 0) return false;
      }
    }
    return true;
  }

  /** Claims the disc so later, smaller props do not grow out of this one. */
  occupy(x, z, r) {
    const ix0 = this.ixOf(x - r), ix1 = this.ixOf(x + r);
    const iz0 = this.izOf(z - r), iz1 = this.izOf(z + r);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        if (!this.inside(ix, iz)) continue;
        const i = this.index(ix, iz);
        if (r > this.taken[i]) this.taken[i] = r;
      }
    }
  }

  /**
   * A cumulative-weight sampler over the open cells.
   *
   * `weight(dist, corner, surface, x, z, indoor, step, lee, gutter)` returns
   * the relative density at a cell; the returned object can be sampled
   * thousands of times in O(log n) with no allocation. This is where "debris
   * accumulates where it is not walked on" is actually expressed.
   *
   * Arguments are only ever APPENDED to this callback, so every existing
   * caller keeps working unchanged.
   */
  field(weight) {
    const n = this.open.length;
    const idx = [];
    const cum = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (!this.open[i]) continue;
      const ix = i % this.nx, iz = (i / this.nx) | 0;
      const w = weight(
        this.dist[i], this.corner[i], this.surf[i], this.xOf(ix), this.zOf(iz),
        this.indoor[i], this.step[i], this.lee[i], this.gutter[i],
      );
      if (!(w > 0)) continue;
      total += w;
      idx.push(i);
      cum.push(total);
    }
    return new Field(this, idx, cum, total);
  }
}

/** A prebuilt weighted sample over grid cells. */
export class Field {
  constructor(site, idx, cum, total) {
    this.site = site;
    this.idx = idx;
    this.cum = cum;
    this.total = total;
    this.out = {
      x: 0, y: 0, z: 0, dist: 0, corner: 0, surface: 'asphalt',
      nx: 0, nz: 0, indoor: 0, step: 0, lee: 0, gutter: 0,
    };
  }

  get empty() { return this.total <= 0; }

  /** Samples a point. The returned object is reused — copy what you need. */
  sample(rand) {
    if (this.total <= 0) return null;
    const t = rand() * this.total;
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < t) lo = mid + 1; else hi = mid;
    }
    const site = this.site;
    const i = this.idx[lo];
    const ix = i % site.nx, iz = (i / site.nx) | 0;
    const o = this.out;
    o.x = site.xOf(ix) + (rand() - 0.5) * GRID_STEP;
    o.z = site.zOf(iz) + (rand() - 0.5) * GRID_STEP;
    o.y = site.gy[i];
    o.dist = site.dist[i];
    o.corner = site.corner[i];
    o.surface = site.surf[i];
    o.indoor = site.indoor[i];
    o.step = site.step[i];
    o.lee = site.lee[i];
    o.gutter = site.gutter[i];
    o.nx = site.wallN[i * 2];
    o.nz = site.wallN[i * 2 + 1];
    return o;
  }
}

// ------------------------------------------------------------------ batching

/**
 * Merge buffers keyed by material, spatial zone and shadow flag. One mesh comes
 * out per bucket, so prop count and draw count are decoupled.
 */
export class BatchSet {
  /**
   * @param {string} name
   * @param {number} [zoneLen] metres of Z per bucket. `Infinity` disables the
   *   spatial split, which is the right call for anything whose triangles are
   *   cheap and whose bucket count is not: culling saves fill rate, and fill
   *   rate for off-screen geometry is already zero.
   * @param {boolean} [allowShadow] false forces every bucket non-casting, so a
   *   tier of gravel does not cost three cascade draws per material.
   */
  constructor(name, zoneLen = ZONE_LEN, allowShadow = true) {
    this.name = name;
    this.allowShadow = allowShadow;
    this.zoneLen = zoneLen;
    /** @type {Map<string,{batch:Batch,key:string,shadow:boolean,overrides:object|null}>} */
    this.buckets = new Map();
    /** @type {Map<string,{key:string,overrides:object}>} */
    this.variants = new Map();
    this.pieces = 0;
    this.z0 = 40;
    /** @type {number|null} sticky ground height for the contact ramp; see bed(). */
    this._bedY = null;
  }

  /**
   * Registers a named material variant usable anywhere a material key is.
   *
   * A set applies ONE shared overrides object to every bucket it emits, which
   * cannot express car paint plus car trim plus glazing inside one set — and
   * splitting them into three sets would mean three sets' worth of zone
   * bookkeeping for one object. So a bucket may instead be keyed by a variant
   * name, and `build()` resolves `ctx.materials.get(key, overrides)` per
   * bucket. `Materials.get` caches non-structural overrides as a
   * program-inheriting clone, so a variant costs a draw call and zero shader
   * programs.
   *
   * @param {string} name what callers pass as `matKey`
   * @param {string} key the real material key it is based on
   * @param {object} overrides non-structural material properties
   */
  variant(name, key, overrides) {
    this.variants.set(name, { key, overrides: overrides || {} });
    return this;
  }

  zoneOf(z) {
    if (!isFinite(this.zoneLen)) return 0;
    return Math.max(0, Math.min(7, Math.floor((this.z0 - z) / this.zoneLen)));
  }

  _bucket(matKey, z, shadow) {
    if (!this.allowShadow) shadow = false;
    const id = `${matKey}|${this.zoneOf(z)}|${shadow ? 1 : 0}`;
    let b = this.buckets.get(id);
    if (!b) {
      const v = this.variants.get(matKey);
      b = {
        batch: new Batch(`${this.name}:${id}`),
        key: v ? v.key : matKey,
        overrides: v ? v.overrides : null,
        shadow,
      };
      this.buckets.set(id, b);
    }
    return b;
  }

  /**
   * Sets the ground height that subsequent adds bed into, or `null` to stop.
   *
   * Sticky rather than an extra positional argument on four already-long
   * signatures: a scatter loop places a whole prop — legs, body, lid, handle —
   * against one ground height, so `bs.bed(o.y)` once around the loop body is
   * both shorter and harder to get wrong than threading the value through
   * every call. `Batch` applies the ramp per vertex during the merge, so this
   * never clones a geometry.
   */
  bed(y) {
    this._bedY = typeof y === 'number' ? y : null;
    return this;
  }

  /** Adds a geometry under an explicit world matrix. */
  addMatrix(matKey, geo, m, color, shadow = false, groundY = undefined) {
    if (!geo) return this;
    if (!this.allowShadow) shadow = false;
    const gy = groundY === undefined ? (this._bedY ?? null) : groundY;
    this._bucket(matKey, m.elements[14], shadow).batch.addMatrix(geo, m, color || null, gy);
    this.pieces++;
    return this;
  }

  /** Adds with position / euler / scale, the common case. */
  add(matKey, geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx, color = null, shadow = false) {
    if (!geo) return this;
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _m4.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
    return this.addMatrix(matKey, geo, _m4, color, shadow);
  }

  /**
   * Adds with the rotation applied as yaw-then-pitch-then-roll (Euler `YXZ`).
   *
   * The default `XYZ` order rotates about *world* X after the yaw, which tips a
   * wall-mounted part about the wrong axis on any facade that does not happen
   * to face along Z — an awning pitched forward on an east wall ends up
   * standing on its edge. Anything that needs both a facing and a pitch has to
   * come through here.
   */
  addPitched(matKey, geo, x, y, z, yaw, pitch, roll, sx, sy = sx, sz = sx, color = null, shadow = false) {
    if (!geo) return this;
    _e.set(pitch, yaw, roll, 'YXZ');
    _q.setFromEuler(_e);
    _m4.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
    return this.addMatrix(matKey, geo, _m4, color, shadow);
  }

  /** Adds oriented so +Y maps onto `normal` — decals, wall-mounted parts. */
  addOriented(matKey, geo, x, y, z, normal, spin = 0, sx = 1, sy = sx, sz = sx, color = null, shadow = false) {
    _q.setFromUnitVectors(_up, normal);
    if (spin) _q.multiply(_q2.setFromAxisAngle(_up, spin));
    _m4.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
    return this.addMatrix(matKey, geo, _m4, color, shadow);
  }

  /**
   * Emits the merged meshes.
   * @param {any} ctx
   * @param {THREE.Object3D} parent
   * @param {{overrides?:object, renderOrder?:number, collide?:boolean}} [opts]
   */
  build(ctx, parent, opts = {}) {
    const made = [];
    for (const b of this.buckets.values()) {
      const geo = b.batch.build();
      if (!geo) continue;
      // Per-bucket variant overrides sit under the set-wide ones: a set built
      // with an explicit overrides object still wins, so nothing that already
      // passes `opts.overrides` changes behaviour.
      const overrides = { vertexColors: true, ...(b.overrides || null), ...(opts.overrides || null) };
      let mat;
      try {
        mat = ctx.materials?.get(b.key, overrides);
      } catch (e) { mat = null; }
      if (!mat) continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = geo.name;
      mesh.castShadow = !!b.shadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.userData.surface = b.key;
      if (!opts.collide) mesh.userData.noCollide = true;
      if (opts.renderOrder) mesh.renderOrder = opts.renderOrder;
      parent.add(mesh);
      made.push(mesh);
    }
    this.buckets.clear();
    return made;
  }
}

// -------------------------------------------------------------------- helpers

/** Chamfer-distance falloff shaped for "debris settles against walls". */
export function wallFalloff(dist, scale = 1.2, floor = 0.06) {
  return floor + Math.exp(-dist / scale);
}

/** Rotates (x,z) about Y by `a`, writing into the shared scratch vector. */
export function rotXZ(out, x, z, a) {
  const c = Math.cos(a), s = Math.sin(a);
  out.set(x * c - z * s, 0, x * s + z * c);
  return out;
}

export { GRID_STEP };
