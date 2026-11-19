/** move_to's closed-loop steering, behind a port so it runs against a simulated Doom kinematic model in tests and against the bridge in tools.ts. */
import { stallTracker } from "../sampler/stepping.js";

export type Waypoint = { x: number; y: number } | { tid: number } | { class: string };

export interface PlayerRead {
  x: number;
  y: number;
  z: number;
  /** Dead or spectating. */
  dead: boolean;
}

export interface TargetRead {
  x: number;
  y: number;
  radius: number;
}

export interface MovePort {
  /** The player, or null when there is none (e.g. a level change). */
  readPlayer(): Promise<PlayerRead | null>;
  /** The nearest actor with this tid/class, or null when none exists. */
  resolveTarget(w: { tid: number } | { class: string }): Promise<TargetRead | null>;
  setAngle(deg: number): Promise<void>;
  setForward(on: boolean): Promise<void>;
  /** Let the (unpaused) sim run about `n` tics. */
  waitTics(n: number): Promise<void>;
  /** The map tic of the last read; NaN when unreadable. */
  maptime(): number;
}

export interface MoveOptions {
  radius: number;
  maxTics: number;
  chunkTics: number;
  stuckTics: number;
  trail: boolean;
}

export type StopReason = "arrived" | "stuck" | "timeout" | "died" | "player_gone" | "target_gone" | "stalled";

export interface MoveResult {
  reason: StopReason;
  reached: number;
  waypoints: number;
  tics: number;
  x: number;
  y: number;
  z: number;
  distance?: number;
  /** Mean units/tic over the last period; above 0 the player is still sliding. */
  speed: number;
  target?: { x: number; y: number; tid?: number; class?: string };
  trail?: Array<[number, number, number]>;
}

/** Doom's default friction (0xE800 / 0x10000): the share of momentum kept per tic. */
export const FRICTION = 0xe800 / 0x10000;
/** Below this many units/tic the player counts as stopped. */
const SETTLED_SPEED = 1;
/** Closest approach must improve by this much within stuckTics. */
const STUCK_PROGRESS = 8;
/** A rise in closing speed (units/tic) that also counts as progress: a turn-back or a re-press. */
const CLOSING_PROGRESS = 0.5;
/** Tics per bridge call until the loop has measured its own; ~2 measured live. */
const DEFAULT_CALL_TICS = 2;
/** Re-aim only when the heading drifts by more than this, saving a round trip per period. */
const AIM_TOLERANCE_DEG = 1;
const MIN_FRICTION = 0.5;
const MAX_FRICTION = 0.99;
/** Running thrust per tic (forwardmove 0x32 << 11), until the loop has measured its own. */
export const RUN_THRUST = (0x32 * 2048) / 0x10000;
const MIN_THRUST = 0.1;
const MAX_THRUST = 10;

/** Doom heading in degrees [0, 360) from one point to another: 0 east, 90 north. */
export function headingDeg(from: { x: number; y: number }, to: { x: number; y: number }): number {
  const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Friction from the mean speeds of two back-to-back coasting periods `gap` tics apart. */
export function measureFriction(prevSpeed: number, speed: number, gap: number): number {
  return clamp((speed / prevSpeed) ** (1 / gap), MIN_FRICTION, MAX_FRICTION);
}

/** Thrust per tic from the mean speeds of two back-to-back held periods: u2 = f^n u1 + T(1 - f^n)/(1 - f). */
export function measureThrust(prevSpeed: number, speed: number, gap: number, friction: number): number {
  const fn = friction ** gap;
  return clamp(((speed - fn * prevSpeed) * (1 - friction)) / (1 - fn), MIN_THRUST, MAX_THRUST);
}

/** Under Doom's per-tic model, the fewest +forward tics from `speed` whose coast covers `distance`, or Infinity past `max`. */
export function holdTics(distance: number, speed: number, thrust: number, friction: number, max: number): number {
  let mom = speed * friction;
  let pos = 0;
  for (let n = 0; n <= max; n++) {
    if (pos + mom / (1 - friction) >= distance) return n;
    mom += thrust;
    pos += mom;
    mom *= friction;
  }
  return Infinity;
}

export interface ChunkState {
  /** To the target's centre. */
  distance: number;
  /** Arrival radius, target radius included. */
  arrive: number;
  /** Mean units/tic over the last control period. */
  speed: number;
  /** Estimated current units/tic toward the target (negative moving away). */
  closing: number;
  /** Measured map tics per control period. */
  period: number;
  /** Measured tics for one bridge call, i.e. until a -forward sent now lands. */
  latency: number;
  /** Measured once the player has coasted, else Doom's default. */
  friction: number;
  /** Measured once the player has run a while, else Doom's running thrust. */
  thrust: number;
  final: boolean;
  forward: boolean;
}

export type Decision = { advance: true } | { arrived: true } | { forward: boolean; after?: number; tap?: number };

/** One control period's choice, where `after` and `tap` count the tics to hold before releasing within the period. */
export function decide(s: ChunkState): Decision {
  // Passing at speed only counts a waypoint the player is closing on, never one left behind it.
  const pass = Math.max(s.arrive, s.closing * s.period);
  if (!s.final) return s.distance <= pass ? { advance: true } : { forward: true };
  if (s.distance <= s.arrive) return s.speed < SETTLED_SPEED ? { arrived: true } : { forward: false };
  // Tics until -forward must land for the coast to end on the target.
  const n = holdTics(s.distance, s.closing, s.thrust, s.friction, s.period + s.latency);
  if (!s.forward) {
    // Wait while still coasting in, else press again (re-aimed), a short hop as a tap.
    if (s.closing >= SETTLED_SPEED) return { forward: false };
    return n - s.latency < s.period ? { forward: true, tap: Math.max(0, n - s.latency) } : { forward: true };
  }
  const lead = n - s.latency;
  if (lead <= 0) return { forward: false };
  // Due before the next read could act on it: release on a timer within this period.
  return lead < s.period ? { forward: false, after: Math.round(lead) } : { forward: true };
}

/** Walk the player through `waypoints` from `start`; always releases +forward on the way out. */
export async function runMoveTo(
  port: MovePort,
  waypoints: Waypoint[],
  opts: MoveOptions,
  start: PlayerRead,
): Promise<MoveResult> {
  let result: MoveResult;
  try {
    result = await walk(port, waypoints, opts, start);
  } catch (e) {
    // The walk's own error is the one to report, even if the release fails too.
    await port.setForward(false).catch(() => {});
    throw e;
  }
  await port.setForward(false);
  return result;
}

async function walk(port: MovePort, waypoints: Waypoint[], opts: MoveOptions, start: PlayerRead): Promise<MoveResult> {
  const t0 = port.maptime();
  let p = start;
  let t = t0;
  // Mean velocity over the last two periods, for extrapolating to the current one.
  let v = { x: 0, y: 0 };
  let prevV = { x: 0, y: 0 };
  let prevPeriod = opts.chunkTics;
  let period = opts.chunkTics;
  let latency = DEFAULT_CALL_TICS;
  let friction = FRICTION;
  let thrust = RUN_THRUST;
  // Consecutive periods with +forward released (or held) throughout: two give a friction (thrust) reading.
  let coasting = 0;
  let holding = 0;
  let calls = 0;
  let waited = 0;
  let forward = false;
  let aim = NaN;
  let idx = 0;
  let target: TargetRead | null = null;
  let targetIdx = -1;
  let best = Infinity;
  let bestAt = t0;
  let lastClosing = 0;
  const trail: Array<[number, number, number]> = [[t0, p.x, p.y]];
  const track = stallTracker();

  const call = <T>(r: Promise<T>) => (calls++, r);
  const wait = (n: number) => ((waited += n), port.waitTics(n));
  const done = (reason: StopReason): MoveResult => {
    const w = waypoints[idx];
    return {
      reason,
      reached: reason === "arrived" ? waypoints.length : idx,
      waypoints: waypoints.length,
      tics: t - t0,
      x: p.x,
      y: p.y,
      z: p.z,
      speed: Math.hypot(v.x, v.y),
      ...(target ? { distance: Math.hypot(target.x - p.x, target.y - p.y), target: { ...w, x: target.x, y: target.y } } : {}),
      ...(opts.trail ? { trail } : {}),
    };
  };

  for (;;) {
    if (p.dead) return done("died");
    const w = waypoints[idx];
    if ("x" in w) target = { x: w.x, y: w.y, radius: 0 };
    else if (targetIdx !== idx) target = await call(port.resolveTarget(w));
    targetIdx = idx;
    if (!target) return done("target_gone");
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const distance = Math.hypot(dx, dy);
    const final = idx === waypoints.length - 1;
    const arrive = opts.radius + target.radius;
    // The means are centred mid-period; extrapolate their trend half a period on to now.
    const along = (u: { x: number; y: number }) => (distance > 0 ? (u.x * dx + u.y * dy) / distance : 0);
    const meanClosing = along(v);
    const accel = (meanClosing - along(prevV)) / ((period + prevPeriod) / 2);
    const closing = meanClosing + (accel * period) / 2;
    const speed = Math.hypot(v.x, v.y);
    const d = decide({ distance, arrive, speed, closing, period, latency, friction, thrust, final, forward });
    if ("advance" in d) {
      idx++;
      best = Infinity;
      bestAt = t;
      continue;
    }
    if ("arrived" in d) return done("arrived");
    // Settling inside the arrival radius or speeding up toward the target is progress too, and
    // the closest approach ratchets up while sliding away, so a slow turn-back isn't "stuck".
    if ((final && distance <= arrive) || meanClosing > lastClosing + CLOSING_PROGRESS) bestAt = t;
    lastClosing = meanClosing;
    if (distance < best - STUCK_PROGRESS) {
      best = distance;
      bestAt = t;
    } else if (distance > best) best = distance;
    if (t - bestAt >= opts.stuckTics) return done("stuck");
    if (t - t0 >= opts.maxTics) return done("timeout");
    calls = 0;
    waited = 0;
    const coasted = !forward && !d.forward;
    const held = forward && d.forward;
    const heading = headingDeg(p, target);
    if (d.forward && !(Math.abs(((heading - aim + 540) % 360) - 180) <= AIM_TOLERANCE_DEG)) {
      await call(port.setAngle(heading));
      aim = heading;
    }
    if (d.after) await wait(d.after);
    if (d.forward !== forward) {
      await call(port.setForward(d.forward));
      forward = d.forward;
    }
    if (d.tap !== undefined) {
      await wait(d.tap);
      await call(port.setForward(false));
      forward = false;
    }
    await wait(Math.max(0, Math.min(opts.chunkTics, opts.maxTics - (t - t0) - waited)));
    // A tid follows its actor, re-read just before the player so both are fresh when deciding;
    // a class is snapshotted once per leg, so "nearest" can't flip mid-walk.
    if ("tid" in w) target = await call(port.resolveTarget(w));
    const next = await call(port.readPlayer());
    if (!next) return done("player_gone");
    const now = port.maptime();
    // maptime going back is a new level, where the player's old position means nothing.
    const moved = track(t, now, Math.max(1, waited));
    if (moved === "level_change") return done("player_gone");
    if (moved === "stalled") return done("stalled");
    if (moved === "idle") continue;
    prevPeriod = period;
    period = now - t;
    latency = Math.max(0, (period - waited) / calls);
    prevV = v;
    v = { x: (next.x - p.x) / period, y: (next.y - p.y) / period };
    coasting = coasted ? coasting + 1 : 0;
    holding = held ? holding + 1 : 0;
    const was = Math.hypot(prevV.x, prevV.y);
    const is = Math.hypot(v.x, v.y);
    const gap = (period + prevPeriod) / 2;
    if (coasting >= 2 && is >= SETTLED_SPEED) friction = measureFriction(was, is, gap);
    // Only while speeding up or steady: a slowing hold is a wall or a turn, not the thrust.
    if (holding >= 2 && is >= was && is >= SETTLED_SPEED) thrust = measureThrust(was, is, gap, friction);
    p = next;
    t = now;
    trail.push([t, p.x, p.y]);
  }
}

/** The one-line text reply, e.g. "arrived at waypoint 2/2 after 87 tic(s) at (1024.0, -320.5), 6.2 from target". */
export function describeMove(r: MoveResult): string {
  const at = r.reason === "arrived" ? r.reached : r.reached + 1;
  const from = r.distance === undefined ? "" : `, ${r.distance.toFixed(1)} from target`;
  return `${r.reason} at waypoint ${at}/${r.waypoints} after ${r.tics} tic(s) at (${r.x.toFixed(1)}, ${r.y.toFixed(1)})${from}`;
}
