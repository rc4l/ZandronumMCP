import { describe, it, expect, vi } from "vitest";
import type { InputRow, InputStatus } from "../src/parsers/input.js";
import {
  engineResult,
  runMoveTo,
  runPrecheck,
  legEnd,
  decide,
  headingDeg,
  describeMove,
  holdTics,
  measureFriction,
  measureThrust,
  FRICTION,
  RUN_THRUST,
  type MovePort,
  type MoveOptions,
  type Waypoint,
  type TargetRead,
  type PrecheckPort,
  type TraceReply,
} from "../src/movement/moveto.js";

const STOPSPEED = 0x1000 / 0x10000;

interface SimOptions {
  x?: number;
  y?: number;
  /** Starting momentum. */
  mx?: number;
  my?: number;
  friction?: number;
  /** Thrust per tic of +forward; ice and mud scale it (Boom movefactor). */
  thrust?: number;
  /** Tics that pass during each port call (the bridge round trip); measured at ~2. */
  cost?: number;
  /** True where the player can't go; a blocked move zeroes momentum. */
  wall?: (x: number, y: number) => boolean;
  /** Actors by tid or class, as a function of the tic (null = gone). */
  actors?: Record<string, (tic: number) => TargetRead | null>;
  diesAt?: number;
  goneAt?: number;
  freezeAt?: number;
  /** From here no tic runs until the second player read after it: one whole control period stands still. */
  hitchAt?: number;
  /** maptime restarts from 0 here, as on a level change. */
  newLevelAt?: number;
}

/** A Doom player on flat ground: thrust, move, friction, STOPSPEED snap. */
class Sim implements MovePort {
  x: number;
  y: number;
  mx: number;
  my: number;
  angle = 0;
  forward = false;
  tic = 100;
  readonly calls: string[] = [];
  /** Where the player was as each call landed. */
  readonly at: Array<{ call: string; x: number; y: number }> = [];
  readonly resolves: string[] = [];
  /** Player reads since the hitch began, -1 before it. */
  private hitchReads = -1;

  constructor(private readonly o: SimOptions = {}) {
    this.x = o.x ?? 0;
    this.y = o.y ?? 0;
    this.mx = o.mx ?? 0;
    this.my = o.my ?? 0;
  }

  private advance(n: number): void {
    for (let i = 0; i < n; i++) {
      if (this.o.freezeAt !== undefined && this.tic >= this.o.freezeAt) return;
      if (this.o.hitchAt !== undefined && this.tic >= this.o.hitchAt && this.hitchReads < 2) {
        this.hitchReads = Math.max(0, this.hitchReads);
        return;
      }
      if (this.forward) {
        const rad = (this.angle * Math.PI) / 180;
        const thrust = this.o.thrust ?? RUN_THRUST;
        this.mx += thrust * Math.cos(rad);
        this.my += thrust * Math.sin(rad);
      }
      const nx = this.x + this.mx;
      const ny = this.y + this.my;
      if (this.o.wall?.(nx, ny)) {
        this.mx = this.my = 0;
      } else {
        this.x = nx;
        this.y = ny;
      }
      const f = this.o.friction ?? FRICTION;
      this.mx *= f;
      this.my *= f;
      if (!this.forward && Math.hypot(this.mx, this.my) < STOPSPEED) this.mx = this.my = 0;
      this.tic++;
    }
  }

  private async call(name: string): Promise<void> {
    this.calls.push(name);
    this.advance(this.o.cost ?? 2);
    this.at.push({ call: name, x: this.x, y: this.y });
  }

  readPlayerNow() {
    return { x: this.x, y: this.y, z: 0, dead: this.o.diesAt !== undefined && this.tic >= this.o.diesAt };
  }

  async readPlayer() {
    await this.call("read");
    if (this.hitchReads >= 0 && this.hitchReads < 2) this.hitchReads++;
    if (this.o.goneAt !== undefined && this.tic >= this.o.goneAt) return null;
    return this.readPlayerNow();
  }

  async resolveTarget(w: { tid: number } | { class: string }) {
    await this.call("resolve");
    const key = "tid" in w ? `tid:${w.tid}` : `class:${w.class}`;
    this.resolves.push(key);
    return this.o.actors?.[key]?.(this.tic) ?? null;
  }

  async setAngle(deg: number) {
    await this.call("angle");
    this.angle = deg;
  }

  async setForward(on: boolean) {
    await this.call(on ? "+forward" : "-forward");
    this.forward = on;
  }

  async waitTics(n: number) {
    this.advance(n);
  }

  maptime() {
    const at = this.o.newLevelAt;
    return at !== undefined && this.tic >= at ? this.tic - at : this.tic;
  }

  speed() {
    return Math.hypot(this.mx, this.my);
  }
}

const OPTS: MoveOptions = { radius: 32, maxTics: 350, chunkTics: 3, stuckTics: 35, trail: false };
const go = (sim: Sim, to: Waypoint[], opts: Partial<MoveOptions> = {}) =>
  runMoveTo(sim, to, { ...OPTS, ...opts }, sim.readPlayerNow());

describe("move_to helpers", () => {
  it("computes Doom headings in [0, 360)", () => {
    expect(headingDeg({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
    expect(headingDeg({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe(90);
    expect(headingDeg({ x: 0, y: 0 }, { x: -10, y: 0 })).toBe(180);
    expect(headingDeg({ x: 0, y: 0 }, { x: 0, y: -10 })).toBe(270);
  });

  const state = {
    arrive: 32,
    speed: 0,
    closing: 0,
    period: 5,
    latency: 2,
    friction: FRICTION,
    thrust: RUN_THRUST,
    final: true,
    forward: false,
  };

  it("passes an intermediate waypoint at speed, never braking for it", () => {
    const base = { ...state, final: false, forward: true, speed: 16, closing: 16 };
    expect(decide({ ...base, distance: 70 })).toEqual({ advance: true });
    expect(decide({ ...base, distance: 90 })).toEqual({ forward: true });
  });

  it("holds, releases on a timer, or releases now as the coast nears the target", () => {
    const run = { ...state, forward: true, speed: 16.5, closing: 16.5 };
    expect(decide({ ...run, distance: 600 })).toEqual({ forward: true });
    expect(decide({ ...run, distance: 220 })).toEqual({ forward: false, after: 2 });
    expect(decide({ ...run, distance: 150 })).toEqual({ forward: false });
  });

  it("waits while coasting in, then hops the rest as a tap or a hold", () => {
    expect(decide({ ...state, distance: 100, speed: 3, closing: 3 })).toEqual({ forward: false });
    expect(decide({ ...state, distance: 60 })).toEqual({ forward: true, tap: 2 });
    expect(decide({ ...state, distance: 33 })).toEqual({ forward: true, tap: 0 });
    expect(decide({ ...state, distance: 300 })).toEqual({ forward: true });
  });

  it("arrives only once stopped inside the radius", () => {
    expect(decide({ ...state, distance: 20, speed: 0.5 })).toEqual({ arrived: true });
    expect(decide({ ...state, distance: 20, speed: 4, forward: true })).toEqual({ forward: false });
  });

  it("models Doom's thrust and friction per tic", () => {
    // From rest, running: ~4 tics of thrust then the coast cover ~60 units.
    expect(holdTics(60, 0, RUN_THRUST, FRICTION, 20)).toBe(4);
    expect(holdTics(0, 0, RUN_THRUST, FRICTION, 20)).toBe(0);
    expect(holdTics(5000, 0, RUN_THRUST, FRICTION, 20)).toBe(Infinity);
  });

  it("measures friction and thrust from mean speeds, clamped", () => {
    expect(measureFriction(10, 10 * 0.95 ** 5, 5)).toBeCloseTo(0.95, 6);
    expect(measureFriction(10, 0.001, 1)).toBe(0.5);
    expect(measureFriction(10, 20, 1)).toBe(0.99);
    // Steady at the running top speed: T = u(1 - f).
    expect(measureThrust(16.67, 16.67, 5, FRICTION)).toBeCloseTo(RUN_THRUST, 2);
    expect(measureThrust(16, 0, 5, FRICTION)).toBe(0.1);
    expect(measureThrust(0, 400, 5, FRICTION)).toBe(10);
  });

  it("describes a result in one line, without a distance when no target resolved", () => {
    const r = { reached: 0, waypoints: 1, tics: 0, x: 1, y: -2.25, z: 0 };
    expect(describeMove({ ...r, reason: "target_gone" })).toBe("target_gone at waypoint 1/1 after 0 tic(s) at (1.0, -2.3)");
    expect(describeMove({ ...r, reason: "arrived", reached: 1, distance: 6.21 })).toBe(
      "arrived at waypoint 1/1 after 0 tic(s) at (1.0, -2.3), 6.2 from target",
    );
  });
});

describe("runMoveTo against a simulated player", () => {
  it.each([0, 1, 2, 3])("arrives at a point 512 units away and stops (%i tic(s) per bridge call)", async (cost) => {
    const sim = new Sim({ cost });
    const r = await go(sim, [{ x: 512, y: 0 }]);
    expect(r).toMatchObject({ reason: "arrived", reached: 1, waypoints: 1, target: { x: 512, y: 0 } });
    expect(r.distance).toBeLessThanOrEqual(32);
    expect(Math.abs(sim.x - 512)).toBeLessThanOrEqual(32);
    expect(sim.forward).toBe(false);
    expect(sim.speed()).toBeLessThan(1);
    expect(sim.calls.at(-1)).toBe("-forward");
  });

  it("aims diagonally and reports the trail only when asked", async () => {
    const sim = new Sim();
    const r = await go(sim, [{ x: 300, y: 300 }], { trail: true });
    expect(r.reason).toBe("arrived");
    expect(Math.hypot(sim.x - 300, sim.y - 300)).toBeLessThanOrEqual(32);
    expect(r.trail?.[0]).toEqual([100, 0, 0]);
    expect(r.trail!.length).toBeGreaterThan(3);
    expect((await go(new Sim(), [{ x: 0, y: 0 }])).trail).toBeUndefined();
  });

  it("arrives at once when already there and settled", async () => {
    const sim = new Sim({ x: 10 });
    const r = await go(sim, [{ x: 0, y: 0 }]);
    expect(r).toMatchObject({ reason: "arrived", tics: 0 });
    expect(sim.calls).toEqual(["-forward"]);
  });

  it("passes intermediate waypoints without releasing +forward, around a corner", async () => {
    const sim = new Sim();
    const r = await go(sim, [
      { x: 400, y: 0 },
      { x: 400, y: 400 },
    ]);
    expect(r).toMatchObject({ reason: "arrived", reached: 2, waypoints: 2 });
    expect(Math.hypot(sim.x - 400, sim.y - 400)).toBeLessThanOrEqual(32);
    // The first release comes braking for the last waypoint, well into the second leg.
    expect(sim.at.find((a) => a.call === "-forward")!.y).toBeGreaterThan(200);
  });

  it("doesn't count a doubled-back waypoint as passed until it's reached", async () => {
    const sim = new Sim();
    const r = await go(
      sim,
      [
        { x: 400, y: 0 },
        { x: 300, y: 0 },
        { x: 300, y: 300 },
      ],
      { trail: true, maxTics: 700 },
    );
    expect(r).toMatchObject({ reason: "arrived", reached: 3 });
    expect(Math.min(...r.trail!.map(([, x, y]) => Math.hypot(x - 300, y)))).toBeLessThanOrEqual(32);
  });

  it("re-presses when high friction leaves it short", async () => {
    const sim = new Sim({ friction: 0.8 });
    const r = await go(sim, [{ x: 400, y: 0 }]);
    expect(r.reason).toBe("arrived");
    expect(sim.calls.filter((c) => c === "+forward").length).toBeGreaterThan(1);
  });

  it("walks at walking speed", async () => {
    const sim = new Sim({ thrust: RUN_THRUST / 2 });
    const r = await go(sim, [{ x: 400, y: 0 }]);
    expect(r.reason).toBe("arrived");
    expect(Math.abs(sim.x - 400)).toBeLessThanOrEqual(32);
  });

  it.each([1, 2, 3])("turns back after overshooting on ice (%i tic(s) per call)", async (cost) => {
    // Boom ice: friction 0.97, thrust scaled down so the top speed stays ~16.7.
    const sim = new Sim({ friction: 0.97, thrust: 0.5, cost });
    const r = await go(sim, [{ x: 400, y: 0 }], { trail: true });
    expect(r.reason).toBe("arrived");
    expect(Math.max(...r.trail!.map(([, x]) => x))).toBeGreaterThan(432);
    expect(Math.abs(sim.x - 400)).toBeLessThanOrEqual(32);
  });

  it("turns back when it starts already sliding past the target", async () => {
    const sim = new Sim({ mx: 20 });
    const r = await go(sim, [{ x: 40, y: 0 }], { trail: true });
    expect(r.reason).toBe("arrived");
    expect(Math.abs(sim.x - 40)).toBeLessThanOrEqual(32);
  });

  it("stops stuck against a wall, within stuckTics plus a few chunks", async () => {
    const sim = new Sim({ wall: (x) => x > 200 });
    const r = await go(sim, [{ x: 600, y: 0 }]);
    expect(r.reason).toBe("stuck");
    expect(r.tics).toBeLessThan(35 + 30);
    expect(sim.forward).toBe(false);
  });

  it("times out at maxTics, the last wait trimmed to what's left", async () => {
    const sim = new Sim({ cost: 0 });
    const r = await go(sim, [{ x: 5000, y: 0 }], { maxTics: 10 });
    expect(r).toMatchObject({ reason: "timeout", tics: 10, reached: 0 });
    expect(describeMove(r)).toMatch(/^timeout at waypoint 1\/1 after 10 tic\(s\)/);
  });

  it("follows a moving tid target, re-resolving it every period", async () => {
    const sim = new Sim({ actors: { "tid:5": (t) => ({ x: 300, y: Math.min(t - 100, 60) * 3, radius: 20 }) } });
    const r = await go(sim, [{ tid: 5 }], { maxTics: 700 });
    expect(r.reason).toBe("arrived");
    expect(r.target).toMatchObject({ tid: 5, x: 300, y: 180 });
    expect(r.distance).toBeLessThanOrEqual(32 + 20);
    expect(sim.resolves.length).toBeGreaterThan(5);
  });

  it("snapshots a class target once per leg", async () => {
    let x = 300;
    const sim = new Sim({ actors: { "class:Imp": () => ({ x: (x += 50), y: 0, radius: 20 }) } });
    const r = await go(sim, [{ class: "Imp" }]);
    expect(r).toMatchObject({ reason: "arrived", target: { class: "Imp", x: 350, y: 0 } });
    expect(sim.resolves).toEqual(["class:Imp"]);
  });

  it("stops target_gone when a tid has no actor, at start or mid-walk", async () => {
    const none = await go(new Sim(), [{ tid: 9 }]);
    expect(none).toMatchObject({ reason: "target_gone", reached: 0 });
    expect(none.distance).toBeUndefined();
    const sim = new Sim({ actors: { "tid:9": (t) => (t < 120 ? { x: 900, y: 0, radius: 0 } : null) } });
    expect((await go(sim, [{ tid: 9 }])).reason).toBe("target_gone");
    expect(sim.forward).toBe(false);
  });

  it("stops died when the player dies, at start or mid-walk", async () => {
    expect((await go(new Sim({ diesAt: 0 }), [{ x: 500, y: 0 }])).reason).toBe("died");
    const r = await go(new Sim({ diesAt: 115 }), [{ x: 500, y: 0 }]);
    expect(r.reason).toBe("died");
    expect(r.tics).toBeGreaterThan(0);
  });

  it("stops player_gone when the player disappears, keeping the last position", async () => {
    const sim = new Sim({ goneAt: 115 });
    const r = await go(sim, [{ x: 500, y: 0 }]);
    expect(r.reason).toBe("player_gone");
    expect(r.x).toBeGreaterThan(0);
  });

  it("stops player_gone when maptime restarts on a new level", async () => {
    const r = await go(new Sim({ newLevelAt: 115 }), [{ x: 900, y: 0 }]);
    expect(r.reason).toBe("player_gone");
  });

  it("stops stalled when maptime doesn't advance over a chunk", async () => {
    const sim = new Sim({ freezeAt: 110 });
    const r = await go(sim, [{ x: 500, y: 0 }]);
    expect(r.reason).toBe("stalled");
    expect(sim.calls.at(-1)).toBe("-forward");
  });

  it("rides out one control period in which no tic ran", async () => {
    const sim = new Sim({ hitchAt: 110 });
    const r = await go(sim, [{ x: 500, y: 0 }]);
    expect(r.reason).toBe("arrived");
  });

  it("releases +forward when a port call throws", async () => {
    const sim = new Sim();
    sim.waitTics = () => Promise.reject(new Error("bridge gone"));
    await expect(go(sim, [{ x: 500, y: 0 }])).rejects.toThrow("bridge gone");
    expect(sim.calls.at(-1)).toBe("-forward");
    expect(sim.forward).toBe(false);
    const press = sim.setForward.bind(sim);
    sim.setForward = (on) => (on ? press(on) : Promise.reject(new Error("release failed")));
    await expect(go(sim, [{ x: 500, y: 0 }])).rejects.toThrow("bridge gone");
  });

  it("reports the final speed, so a stop while running shows the player still sliding", async () => {
    const r = await go(new Sim({ cost: 0 }), [{ x: 5000, y: 0 }], { maxTics: 60 });
    expect(r.reason).toBe("timeout");
    expect(r.speed).toBeGreaterThan(10);
  });
});

describe("engineResult", () => {
  const row = (maptime: number, x: number, momx = 0): InputRow => ({
    maptime, seg: 1, x, y: 0, z: 0, angle: 0, pitch: 0, momx, momy: 0, momz: 0, health: 100, buttons: [],
  });
  const status = (over: Partial<InputStatus>): InputStatus => ({
    active: false, consumed: 0, total: 0, seg: 1, maptime: 0, reason: "done", ...over,
  });

  it("maps done to arrived with the last row's position and speed, and a per-tic trail", () => {
    const r = engineResult(status({ consumed: 2, done: 1, dist: 0.01, target: { x: 50, y: 0 } }), row(10, 0), [row(10, 20, 5), row(11, 50)], [{ x: 50, y: 0 }], true);
    expect(r).toEqual({
      reason: "arrived", reached: 1, waypoints: 1, tics: 2, x: 50, y: 0, z: 0, speed: 0, distance: 0.01,
      target: { x: 50, y: 0 }, trail: [[10, 0, 0], [11, 20, 0], [12, 50, 0]],
    });
  });

  it("uses the start row when no tic ran, and names the waypoint it stopped on", () => {
    const r = engineResult(status({ reason: "level_change" }), row(3, 7), [], [{ tid: 4 }, { class: "Imp" }], false);
    expect(r).toMatchObject({ reason: "player_gone", reached: 0, tics: 0, x: 7 });
    expect(r.trail).toBeUndefined();
    expect(r.distance).toBeUndefined();
    const stuck = engineResult(status({ reason: "stuck", done: 1, consumed: 40, dist: 90, target: { x: 1, y: 2 } }), row(3, 7), [row(42, 9, 1)], [{ tid: 4 }, { class: "Imp" }], false);
    expect(stuck).toMatchObject({ reason: "stuck", reached: 1, speed: 1, target: { class: "Imp", x: 1, y: 2 } });
    // A run whose last waypoint was already satisfied: reached counts it, the target is the last.
    const all = engineResult(status({ done: 2, dist: 0, target: { x: 1, y: 2 } }), row(3, 7), [], [{ tid: 4 }, { class: "Imp" }], false);
    expect(all).toMatchObject({ reason: "arrived", reached: 2, tics: 0, target: { class: "Imp" } });
  });
});

describe("runPrecheck", () => {
  const start = { x: 0, y: 0, z: 8, dead: false };
  const clear = (x: number, y = 0): TraceReply => ({ ok: true, x, y, z: 8, dist: 100, total: 100 });
  const block = (over: Partial<TraceReply> = {}): TraceReply => ({ ...clear(50), ok: false, reason: "line", line: 45, dist: 50, ...over });
  const opts = { stops: [true, true, true], standoff: 0, actors: true };
  const port = (replies: TraceReply[] = [], target: (TargetRead & { ref: string }) | null = null) => ({
    resolve: vi.fn<PrecheckPort["resolve"]>().mockResolvedValue(target),
    trace: vi.fn<PrecheckPort["trace"]>().mockImplementation(async ({ to }) => replies.shift() ?? clear(to.x, to.y)),
  });

  it("pulls stop points back along the leg, skipping legs wholly covered by stand-off", async () => {
    expect(legEnd({ x: 1, y: 2 }, { x: 4, y: 6 }, 2)).toEqual({ x: 2.8, y: 4.4 });
    expect(legEnd(start, start, 0)).toBeNull();
    expect(legEnd(start, { x: 10, y: 0 }, 10)).toBeNull();
    const p = port();
    expect(await runPrecheck(p, [{ x: 10, y: 0 }, { x: 100, y: 0 }], { ...opts, standoff: 20 }, start)).toEqual({ clear: true });
    expect(p.trace.mock.calls).toEqual([[{ from: { x: 0, y: 0 }, to: { x: 80, y: 0 }, actors: true }]]);
    expect(p.resolve).not.toHaveBeenCalled();
  });

  it("traces all clear legs, chaining the replies and distinguishing passes from stops", async () => {
    const p = port();
    expect(await runPrecheck(p, [{ x: 100, y: 0 }, { x: 100, y: 100 }], { ...opts, stops: [false, true], standoff: 20 }, start)).toEqual({ clear: true });
    expect(p.trace.mock.calls).toEqual([
      [{ to: { x: 100, y: 0 }, actors: true }],
      [{ from: { x: 100, y: 0 }, to: { x: 100, y: 80 }, actors: true }],
    ]);
  });

  it.each([0, 1])("returns a block on leg %i without changing the player's reported position", async (leg) => {
    const p = port([...(leg ? [clear(100)] : []), block({ rise: 32, drop: 48, blocker: "Imp#3" })]);
    const checked = await runPrecheck(p, [{ x: 100, y: 0 }, { x: 200, y: 0 }], opts, start);
    expect(checked).toEqual({ result: {
      reason: "blocked", reached: leg, waypoints: 2, tics: 0, x: 0, y: 0, z: 8, speed: 0,
      blocked: { leg: leg + 1, reason: "line", x: 50, y: 0, z: 8, dist: 50, total: 100, line: 45, rise: 32, drop: 48, blocker: "Imp#3" },
    } });
    expect(p.trace).toHaveBeenCalledTimes(leg + 1);
  });

  it("describes a block using its trace stop, not the unchanged player's start", async () => {
    const p = port([clear(100), block()]);
    const checked = await runPrecheck(p, [{ x: 100, y: 0 }, { x: 200, y: 0 }], opts, start);
    expect("result" in checked && describeMove(checked.result)).toBe("blocked at waypoint 2/2 (precheck, nothing moved): line 45 after 50.0 of 100.0 at (50.0, 0.0)");
  });

  it.each(["Imp#5", "player1"])("accepts a nearby self-block for %s and starts the next leg at the last clear stop", async (ref) => {
    const target = { x: 200, y: 0, radius: 20, ref };
    const p = port([block({ reason: "actor", blocker: ref, x: 160 })], target);
    expect(await runPrecheck(p, [{ tid: 5 }, { x: 160, y: 100 }], opts, start)).toEqual({ clear: true });
    expect(p.resolve).toHaveBeenCalledWith({ tid: 5 });
    expect(p.trace.mock.calls[0][0].to).toEqual({ x: 200, y: 0 });
    expect(p.trace.mock.calls[1][0].from).toEqual({ x: 160, y: 0 });
  });

  it.each([
    { reason: "actor", blocker: "Imp#5", x: 0 },
    { reason: "actor", blocker: "Other#5", x: 160 },
    { reason: "line", blocker: "Imp#5", x: 160 },
  ])("does not wave through a distant, different or non-actor block: %j", async (over) => {
    const p = port([block(over)], { x: 200, y: 0, radius: 20, ref: "Imp#5" });
    expect(await runPrecheck(p, [{ class: "Imp" }], opts, start)).toMatchObject({ result: { reason: "blocked", reached: 0 } });
  });

  it("uses the inclusive self-block bound and preserves optional fields only when reported", async () => {
    const distance = (32 + 20) * Math.SQRT2 + 32;
    const p = port([{ ok: false, reason: "actor", blocker: "Imp#0", x: 200 - distance, y: 0, z: 8, dist: 50, total: 200 }], { x: 200, y: 0, radius: 20, ref: "Imp#0" });
    expect(await runPrecheck(p, [{ tid: 5 }], opts, start)).toEqual({ clear: true });
    const bare = port([{ ok: false, reason: "ceiling", x: 10, y: 0, z: 8, dist: 10, total: 100 }]);
    const checked = await runPrecheck(bare, [{ x: 100, y: 0 }], opts, start);
    expect(checked).toMatchObject({ result: { blocked: { reason: "ceiling" } } });
    if ("result" in checked) expect(checked.result.blocked).not.toHaveProperty("line");
  });

  it("ignores actors in geometry mode, chaining from the target centre", async () => {
    const p = port([], { x: 100, y: 0, radius: 20, ref: "Imp#5" });
    expect(await runPrecheck(p, [{ class: "Imp" }, { x: 100, y: 100 }], { ...opts, actors: false }, start)).toEqual({ clear: true });
    expect(p.trace.mock.calls).toEqual([
      [{ to: { x: 100, y: 0 }, actors: false }],
      [{ from: { x: 100, y: 0 }, to: { x: 100, y: 100 }, actors: false }],
    ]);
  });

  it("returns target_gone at its leg with zero tics and no further traces", async () => {
    const p = port();
    expect(await runPrecheck(p, [{ x: 100, y: 0 }, { tid: 5 }], opts, start)).toEqual({ result: {
      reason: "target_gone", reached: 1, waypoints: 2, tics: 0, x: 0, y: 0, z: 8, speed: 0,
    } });
    expect(p.trace).toHaveBeenCalledTimes(1);
  });

  it("propagates probe failures without tracing later legs", async () => {
    const p = port();
    p.trace.mockRejectedValue(new Error("no mover"));
    await expect(runPrecheck(p, [{ x: 100, y: 0 }, { x: 200, y: 0 }], opts, start)).rejects.toThrow("no mover");
    expect(p.trace).toHaveBeenCalledTimes(1);
  });
});
