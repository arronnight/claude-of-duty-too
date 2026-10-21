import * as THREE from 'three';

/**
 * Behaviour tree.
 *
 * A tree rather than a state machine because the interesting behaviour here is
 * all *priority under interruption*: a bot that is flanking must abandon the
 * flank the instant it takes fire, and must resume patrol when the fight ends,
 * without anyone writing the transition. A selector re-evaluated top-down every
 * tick gives that for free, and the RUNNING/reset protocol below means a leaf
 * that gets pre-empted is told, so a bot cannot be left half-way through a
 * peek with its head above a wall.
 *
 * The whole tree is priority-ordered: stay alive, shoot what you can see,
 * chase what you saw, look into what you heard, otherwise patrol.
 */

export const SUCCESS = 1;
export const FAILURE = 2;
export const RUNNING = 3;

let _uid = 0;

/** Runs children in order; fails on the first failure. Remembers position. */
export function sequence(name, children) {
  const id = ++_uid;
  return {
    name, id,
    tick(b, dt, ctx) {
      let i = b.mem[id] || 0;
      for (; i < children.length; i++) {
        const r = children[i].tick(b, dt, ctx);
        if (r === RUNNING) { b.mem[id] = i; return RUNNING; }
        if (r === FAILURE) { b.mem[id] = 0; abortFrom(children, i + 1, b); return FAILURE; }
      }
      b.mem[id] = 0;
      return SUCCESS;
    },
    abort(b) { b.mem[id] = 0; abortFrom(children, 0, b); },
  };
}

/** Runs children in order; succeeds on the first success. */
export function selector(name, children) {
  const id = ++_uid;
  return {
    name, id,
    tick(b, dt, ctx) {
      for (let i = 0; i < children.length; i++) {
        const r = children[i].tick(b, dt, ctx);
        if (r === RUNNING) {
          // Anything below this branch was pre-empted; let it clean up.
          abortFrom(children, i + 1, b);
          b.active = children[i].name || b.active;
          return RUNNING;
        }
        if (r === SUCCESS) { abortFrom(children, i + 1, b); return SUCCESS; }
      }
      return FAILURE;
    },
    abort(b) { abortFrom(children, 0, b); },
  };
}

function abortFrom(children, from, b) {
  for (let i = from; i < children.length; i++) children[i].abort?.(b);
}

/** Leaf that passes or fails on a predicate. */
export function cond(name, fn) {
  return { name, tick: (b, dt, ctx) => (fn(b, dt, ctx) ? SUCCESS : FAILURE) };
}

/**
 * Stateful leaf. `enter` runs on the first tick of a fresh activation, `tick`
 * every tick, `exit` when the leaf is pre-empted or completes.
 */
export function action(name, { enter, tick, exit } = {}) {
  const id = ++_uid;
  return {
    name, id,
    tick(b, dt, ctx) {
      if (!b.mem[id]) {
        b.mem[id] = 1;
        b.state = name;
        b.stateTime = 0;
        enter?.(b, ctx);
      }
      b.stateTime += dt;
      const r = tick ? tick(b, dt, ctx) : SUCCESS;
      if (r !== RUNNING) { b.mem[id] = 0; exit?.(b, ctx); }
      return r;
    },
    abort(b, ctx) {
      if (b.mem[id]) { b.mem[id] = 0; exit?.(b, ctx); }
    },
  };
}

// --------------------------------------------------------------- the tree

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

const seesEnemy = (b, dt, ctx) =>
  b.sense.target && b.sense.visible && b.sense.alerted(ctx.time, b.reactionTime);

const knowsEnemy = (b, dt, ctx) =>
  b.sense.hasLastKnown && ctx.time - b.sense.lastSeen < 9;

/** Cover that faces the threat and is not behind the bot's own line of fire. */
function pickCover(b, ctx, opts = {}) {
  const points = ctx.level?.coverPoints;
  if (!points || !points.length) return null;
  const threat = b.sense.hasLastKnown ? b.sense.lastKnown : null;
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const cp = points[i];
    if (!cp?.position) continue;
    if (b.ai.coverTaken.get(cp) && b.ai.coverTaken.get(cp) !== b) continue;
    const d = b.position.distanceTo(cp.position);
    if (d > (opts.maxDist || 26) || d < (opts.minDist || 0)) continue;
    let score = -d * (opts.distWeight ?? 0.32);
    if (threat) {
      // The cover has to be between the bot and the threat: its normal should
      // point at the threat, and it should not be further from the threat than
      // we want to be.
      _v.copy(threat).sub(cp.position).setY(0);
      const dt2 = _v.length();
      if (dt2 > 1e-3) _v.multiplyScalar(1 / dt2);
      const facing = cp.normal ? _v.x * cp.normal.x + _v.z * cp.normal.z : 0;
      score += facing * 9;
      if (opts.flank) {
        // Sideways of the threat's view of us: maximise the angle swept.
        _w.copy(b.position).sub(threat).setY(0).normalize();
        _v.copy(cp.position).sub(threat).setY(0).normalize();
        score += (1 - (_v.x * _w.x + _v.z * _w.z)) * 16 - Math.abs(dt2 - 16) * 0.25;
      } else {
        score -= Math.abs(dt2 - (opts.standoff ?? 14)) * 0.45;
      }
      if (opts.away) score += (dt2 - b.position.distanceTo(threat)) * 1.4;
    }
    score += (cp.height === 'high' ? 1.2 : 0);
    if (score > bestScore) { bestScore = score; best = cp; }
  }
  return best;
}

function releaseCover(b) {
  if (b.cover && b.ai.coverTaken.get(b.cover) === b) b.ai.coverTaken.delete(b.cover);
  b.cover = null;
  b.inCover = false;
}

function claimCover(b, cp) {
  releaseCover(b);
  if (!cp) return false;
  b.cover = cp;
  b.ai.coverTaken.set(cp, b);
  return true;
}

/** Stand at the covered side of a cover point, facing out. */
function coverStandPos(cp, out) {
  out.copy(cp.position);
  if (cp.normal) out.addScaledVector(cp.normal, -0.62);
  return out;
}

// ------------------------------------------------------------------- leaves

const Retreat = action('retreat', {
  enter(b, ctx) {
    const cp = pickCover(b, ctx, { away: true, maxDist: 34, standoff: 26 });
    claimCover(b, cp);
    b.crouch = 1;
    b.wantFire = false;
  },
  tick(b, dt, ctx) {
    if (b.health > b.maxHealth * 0.55) return FAILURE;      // recovered
    if (b.cover) {
      coverStandPos(b.cover, _v);
      b.moveTo(_v, 1.0);
      if (b.position.distanceTo(_v) < 0.9) {
        b.stop();
        b.crouch = 1;
        b.wantFire = false;
        b.health = Math.min(b.maxHealth, b.health + dt * 5.5);
        if (b.health > b.maxHealth * 0.55) return SUCCESS;
      }
    } else {
      // No cover to run to: back away from the threat while shooting.
      if (b.sense.hasLastKnown) {
        _v.copy(b.position).sub(b.sense.lastKnown).setY(0).normalize()
          .multiplyScalar(6).add(b.position);
        b.moveTo(_v, 1.0);
      }
      b.wantFire = b.sense.visible;
      b.health = Math.min(b.maxHealth, b.health + dt * 2.0);
    }
    b.aimAtKnown();
    return RUNNING;
  },
  exit(b) { releaseCover(b); b.crouch = 0; },
});

const Reload = action('reload', {
  enter(b) { b.wantFire = false; b.reloadTimer = 2.3; b.crouch = Math.max(b.crouch, b.inCover ? 1 : 0); },
  tick(b, dt) {
    b.reloadTimer -= dt;
    b.aimAtKnown();
    if (b.cover) { coverStandPos(b.cover, _v); b.moveTo(_v, 0.9); } else b.stop();
    if (b.reloadTimer <= 0) { b.ammo = b.magSize; return SUCCESS; }
    return RUNNING;
  },
});

/**
 * Fight from cover: get behind it, then alternate hidden and exposed. The
 * peek/hide cycle is the difference between a bot that uses cover and a bot
 * that merely stands near it.
 */
const FightFromCover = action('cover-fight', {
  enter(b, ctx) {
    if (!b.cover || b.position.distanceTo(b.cover.position) > 24) {
      claimCover(b, pickCover(b, ctx, { standoff: 13, maxDist: 22 }));
    }
    b.peekTimer = 0.6 + Math.random() * 0.8;
    b.peeking = false;
  },
  tick(b, dt, ctx) {
    if (!b.cover) return FAILURE;
    coverStandPos(b.cover, _v);
    const d = b.position.distanceTo(_v);
    if (d > 0.75) {
      b.moveTo(_v, 1.0);
      b.crouch = 0;
      b.wantFire = false;
      b.aimAtKnown();
      // Give up on a cover point we cannot get to.
      if (b.stateTime > 9) { releaseCover(b); return FAILURE; }
      return RUNNING;
    }

    b.stop();
    b.peekTimer -= dt;
    if (b.peekTimer <= 0) {
      b.peeking = !b.peeking;
      b.peekTimer = b.peeking
        ? 0.9 + Math.random() * 1.5
        : 0.7 + Math.random() * 1.1;
      if (b.peeking) b.sense.awareness = Math.min(1, b.sense.awareness + 0.4);
    }
    b.inCover = true;

    if (b.peeking) {
      // Lean out: step to the side of the cover and stand if it is low.
      b.crouch = b.cover.height === 'low' ? 0.15 : 0;
      _w.set(-(b.cover.normal?.z || 0), 0, b.cover.normal?.x || 1)
        .multiplyScalar(b.peekSide * 0.55);
      _v.add(_w);
      b.moveTo(_v, 0.55);
      b.aimAtKnown();
      b.wantFire = b.sense.visible && b.sense.alerted(ctx.time, b.reactionTime);
    } else {
      b.crouch = 1;
      b.wantFire = false;
      b.aimAtKnown();
    }
    return RUNNING;
  },
  exit(b) { b.peeking = false; b.crouch = 0; b.inCover = false; },
});

/** No cover worth having: fight in the open, moving, and look for cover. */
const FightOpen = action('engage', {
  enter(b) { b.strafeDir = Math.random() < 0.5 ? -1 : 1; b.strafeTimer = 0.8; },
  tick(b, dt, ctx) {
    b.aimAtKnown();
    b.wantFire = b.sense.visible && b.sense.alerted(ctx.time, b.reactionTime);
    b.crouch = b.sense.visible && b.stateTime > 1.5 ? 0.85 : 0;

    b.strafeTimer -= dt;
    if (b.strafeTimer <= 0) { b.strafeDir *= -1; b.strafeTimer = 0.9 + Math.random() * 1.2; }
    const dist = b.sense.hasLastKnown ? b.position.distanceTo(b.sense.lastKnown) : 20;
    _v.copy(b.sense.lastKnown).sub(b.position).setY(0);
    if (_v.lengthSq() < 1e-4) _v.set(0, 0, 1);
    _v.normalize();
    // Close if too far, back off if too close, and always slide sideways.
    const closing = THREE.MathUtils.clamp((dist - 11) * 0.35, -1, 1);
    _w.set(-_v.z, 0, _v.x).multiplyScalar(b.strafeDir * 0.8);
    _v.multiplyScalar(closing).add(_w).setLength(2.4).add(b.position);
    b.moveTo(_v, 0.62);
    return RUNNING;
  },
  exit(b) { b.crouch = 0; },
});

/** Go wide: take a cover point off the threat's current axis. */
const Flank = action('flank', {
  enter(b, ctx) {
    claimCover(b, pickCover(b, ctx, { flank: true, maxDist: 40, distWeight: 0.12 }));
    b.flankTimer = 6 + Math.random() * 4;
    b.ai.flanker = b;
  },
  tick(b, dt, ctx) {
    b.flankTimer -= dt;
    if (!b.cover || b.flankTimer <= 0) return FAILURE;
    coverStandPos(b.cover, _v);
    b.moveTo(_v, 1.0);
    b.aimAtKnown();
    // Shoot on the move only if the target is genuinely visible.
    b.wantFire = b.sense.visible && b.sense.alerted(ctx.time, b.reactionTime) && b.speed < 2.2;
    if (b.position.distanceTo(_v) < 0.9) return SUCCESS;
    return RUNNING;
  },
  exit(b) { if (b.ai.flanker === b) b.ai.flanker = null; b.combatTime = 0; },
});

/** Put rounds on the last known position to keep a head down. */
const Suppress = action('suppress', {
  enter(b) { b.suppressTimer = 1.4 + Math.random() * 2.2; },
  tick(b, dt, ctx) {
    b.suppressTimer -= dt;
    if (b.suppressTimer <= 0 || b.ammo <= 4) return SUCCESS;
    if (b.cover) { coverStandPos(b.cover, _v); b.moveTo(_v, 0.8); } else b.stop();
    b.crouch = b.cover ? 0.2 : 0;
    b.aimAtKnown(0.55);
    b.wantFire = true;
    b.suppressing = true;
    return RUNNING;
  },
  exit(b) { b.suppressing = false; b.wantFire = false; },
});

/** Move up on the last known position, expecting contact. */
const Reposition = action('reposition', {
  enter(b, ctx) {
    const cp = pickCover(b, ctx, { standoff: 10, maxDist: 30 });
    claimCover(b, cp);
    b.repoTimer = 5 + Math.random() * 4;
  },
  tick(b, dt, ctx) {
    b.repoTimer -= dt;
    if (b.repoTimer <= 0) return SUCCESS;
    if (b.cover) coverStandPos(b.cover, _v);
    else if (b.sense.hasLastKnown) {
      _v.copy(b.sense.lastKnown).sub(b.position).setY(0).normalize()
        .multiplyScalar(Math.max(0, b.position.distanceTo(b.sense.lastKnown) - 9))
        .add(b.position);
    } else return FAILURE;
    b.moveTo(_v, 0.85);
    b.aimAtKnown();
    b.wantFire = false;
    if (b.position.distanceTo(_v) < 1.0) return SUCCESS;
    return RUNNING;
  },
});

/** Walk to where the noise came from and look around. */
const Investigate = action('investigate', {
  enter(b) { b.investigateTimer = 12; },
  tick(b, dt, ctx) {
    b.investigateTimer -= dt;
    if (b.investigateTimer <= 0) { b.sense.hasNoise = false; return SUCCESS; }
    const goal = b.sense.hasNoise ? b.sense.noise : b.sense.lastKnown;
    const d = b.position.distanceTo(goal);
    if (d > 1.6) {
      b.moveTo(goal, 0.7);
      b.aimAt(goal);
    } else {
      b.stop();
      // Sweep the muzzle across the area rather than standing to attention.
      const t = b.stateTime * 0.9 + b.seed * 6;
      _v.set(goal.x + Math.sin(t) * 8, goal.y + 1.4, goal.z + Math.cos(t * 0.7) * 8);
      b.aimAt(_v);
      if (b.stateTime > 4.5) { b.sense.hasNoise = false; return SUCCESS; }
    }
    return RUNNING;
  },
});

/** Nothing is happening: walk a loop of the map. */
const Patrol = action('patrol', {
  enter(b, ctx) { b.pickPatrolPoint(ctx); b.patrolPause = 0; },
  tick(b, dt, ctx) {
    if (b.patrolPause > 0) {
      b.patrolPause -= dt;
      b.stop();
      const t = b.stateTime * 0.55 + b.seed * 4;
      _v.set(b.position.x + Math.sin(t) * 9, b.position.y + 1.55, b.position.z + Math.cos(t) * 9);
      b.aimAt(_v);
      if (b.patrolPause <= 0) b.pickPatrolPoint(ctx);
      return RUNNING;
    }
    if (!b.patrolPoint) { b.pickPatrolPoint(ctx); return RUNNING; }
    b.moveTo(b.patrolPoint, 0.42);
    b.aimAhead();
    b.wantFire = false;
    if (b.position.distanceTo(b.patrolPoint) < 1.4 || b.stateTime > 22) {
      b.patrolPause = 1.5 + Math.random() * 3;
      b.stateTime = 0;
    }
    return RUNNING;
  },
});

/**
 * Priority order. Everything above a node can interrupt it, nothing below can.
 */
export function buildTree() {
  return selector('root', [
    sequence('survive', [
      cond('hurt', (b) => b.health < b.maxHealth * 0.34 && b.sense.hasLastKnown),
      Retreat,
    ]),
    sequence('dry', [
      cond('empty', (b) => b.ammo <= 0),
      Reload,
    ]),
    sequence('fight', [
      cond('contact', seesEnemy),
      selector('fight-how', [
        sequence('flank-stale', [
          // Staggered per bot, and at most one flanker at a time: a whole
          // squad breaking cover together looks scripted and dies together.
          cond('stalemate', (b, dt, ctx) =>
            b.combatTime > 7 + b.seed * 9 && b.sense.visible &&
            b.position.distanceTo(b.sense.lastKnown) > 12 &&
            (b.ai.flanker === b || !b.ai.flanker || !b.ai.flanker.alive)),
          Flank,
        ]),
        FightFromCover,
        FightOpen,
      ]),
    ]),
    sequence('lost-contact', [
      cond('recent', knowsEnemy),
      selector('hunt', [
        sequence('suppress-it', [
          cond('worth-suppressing', (b, dt, ctx) =>
            ctx.time - b.sense.lastSeen < 3.5 && b.ammo > 8 &&
            b.position.distanceTo(b.sense.lastKnown) < 34),
          Suppress,
        ]),
        Reposition,
      ]),
    ]),
    sequence('heard', [
      cond('noise', (b, dt, ctx) => b.sense.hasNoise && ctx.time - b.sense.noiseTime < 16),
      Investigate,
    ]),
    Patrol,
  ]);
}
