//
// mcp_steer.h -- move_to's per-tic steering law (overlay file, engine-neutral).
//
// Plain doubles and no engine types, modeling a tic as a' = a + yaw; u = v + thrust(a'); p' = p + u;
// v' = friction * u, with v' snapping to 0 on a tic with no move cmd whose u is under STOPSPEED on both axes.
//
#ifndef MCP_STEER_H
#define MCP_STEER_H

#include <math.h>
#include <stdlib.h>

// One movement axis: thrust per raw cmd unit below and at/above the regime split, and the cap.
struct MCPSteerAxis
{
	double gain1, gain2;
	int    regime2; // first raw value of the second regime (0x3200 forward, 0x2800 side)
	int    cap;     // largest raw value allowed
};

struct MCPSteerIn
{
	double px, py, vx, vy; // player position and velocity, read between tics
	double angle;          // heading in radians, 0 east, counter-clockwise
	double yawUnit;        // radians per ticcmd yaw unit
	double thrustQuantum;  // the thrust heading is truncated to a multiple of this; 0 = exact
	double friction, stopSpeed;
	MCPSteerAxis fwd, side;
	double brakeScale;     // braking authority over the current one (< 1 when it drops with speed)
	bool   onGround;
	double tx, ty;         // target centre
	double targetRadius, playerRadius;
	bool   solid;          // stand off by bounding boxes, not Euclidean distance
	double standoff;
	bool   pass;
	int    stuckTics;
};

enum { MCP_STEER_RUN, MCP_STEER_DONE, MCP_STEER_STUCK };

struct MCPSteerOut
{
	int    status;
	int    yaw, forward, side;
	double qx, qy, dist; // aim point and the distance to it
};

#define MCP_STEER_WINDOW 12 // tics a target's motion is averaged over (A_Chase strides 2-4)

struct MCPSteerState
{
	// Per walk timeline: learned thrust ratios and the last steered tic, for learning.
	double kf, ks;
	bool   hasPrev, prevGround;
	double prevPx, prevPy, prevVx, prevVy, prevHeading;
	int    prevFwd, prevSide;
	double prevPredF, prevPredS; // seeded thrust of the cmd sent, before the ratio
	int    prevCapF, prevCapS;
	bool   blocked; // the last steered tic's step was cut short (a wall)
	// Per entry: the last reads of target and player, for a target that moves in steps.
	double histTx[MCP_STEER_WINDOW + 1], histTy[MCP_STEER_WINDOW + 1];
	double histPx[MCP_STEER_WINDOW + 1], histPy[MCP_STEER_WINDOW + 1];
	int    nHist;
	double best;
	int    tics, bestTic, settles, still, near;
};

#define MCP_STEER_ARRIVE    0.05
#define MCP_STEER_ACCEPT    0.5   // after MCP_STEER_SETTLES settles
#define MCP_STEER_SETTLES   3
#define MCP_STEER_MARGIN    0.85  // braking authority assumed of the real one
#define MCP_STEER_FACE      8.0   // heading tracks the aim point while farther than this
#define MCP_STEER_PROGRESS  1.0   // closest approach must improve this much within stuckTics
#define MCP_STEER_BLOCKED_PROGRESS 8.0 // wall slides need more progress to keep the walk alive
#define MCP_STEER_LEARN_CMD 0.25  // of the cap, for a tic to be learned from
#define MCP_STEER_LEARN_COS 0.9659258262890683 // cos 15 degrees
#define MCP_STEER_CATCH     0.5   // moving target: aim point distance
#define MCP_STEER_CATCH_V   1.0   // moving target: relative speed
#define MCP_STEER_STILL     2     // reads stopped within MCP_STEER_ACCEPT that end a pinned walk
#define MCP_STEER_NEAR      8     // blocked tics within MCP_STEER_ACCEPT before a settle no longer needs MCP_STEER_ARRIVE
#define MCP_STEER_JUMP      64.0  // a target step beyond this (and the player's reach) is a re-target
#define MCP_STEER_GAP       4     // tics a single stride counts as moving (the longest A_Chase state)
#define MCP_STEER_FREE      0.01  // velocity read vs friction * step: more is a blocked move
#define MCP_STEER_TWO_PI    6.283185307179586

static inline double MCPS_Clamp( double v, double lo, double hi ) { return v < lo ? lo : v > hi ? hi : v; }

static inline double MCPS_AxisThrust( const MCPSteerAxis &a, int raw )
{
	int m = raw < 0 ? -raw : raw;
	return raw * ( m >= a.regime2 ? a.gain2 : a.gain1 );
}

// The largest thrust below which every value is reachable: braking must not count on a gap.
static inline double MCPS_AxisSmooth( const MCPSteerAxis &a )
{
	double full = MCPS_AxisThrust( a, a.cap );
	if ( a.cap < a.regime2 ) return full;
	double top1 = MCPS_AxisThrust( a, a.regime2 - 1 );
	return MCPS_AxisThrust( a, a.regime2 ) > top1 + a.gain1 ? top1 : full;
}

// Raw cmd for a wanted thrust t given the learned ratio k, rounding a t inside a gap between the
// regimes down into the first, never up.
static inline int MCPS_Invert( const MCPSteerAxis &a, double k, double t )
{
	double mag = fabs( t ) / k;
	if ( mag <= 0 || a.cap <= 0 ) return 0;
	int max1 = a.cap < a.regime2 - 1 ? a.cap : a.regime2 - 1;
	int c = int( floor( MCPS_Clamp( mag / a.gain1, 0, max1 ) + 0.5 ) );
	if ( a.cap >= a.regime2 && a.gain2 > 0 )
	{
		int c2 = int( floor( MCPS_Clamp( mag / a.gain2, a.regime2, a.cap ) + 0.5 ) );
		double t1 = c * a.gain1, t2 = c2 * a.gain2;
		bool ok1 = t1 <= mag + 0.5 * a.gain1, ok2 = t2 <= mag + 0.5 * a.gain2;
		if ( ok2 && ( !ok1 || fabs( t2 - mag ) < fabs( t1 - mag ) ) ) c = c2;
		else if ( !ok1 && !ok2 && t2 < t1 ) c = c2;
	}
	return t < 0 ? -c : c;
}

// Whether a player whose next read velocity is vel (toward the aim point) can stop within rem,
// braking with authority A per tic.
static inline bool MCPS_CanStop( double vel, double rem, double A, double f )
{
	double travelled = 0;
	for ( int i = 0; i < 16; i++ )
	{
		if ( vel <= A ) return travelled <= rem;
		double step = vel - A;
		travelled += step;
		if ( travelled > rem ) return false;
		vel = f * step;
	}
	// Still moving: bound the rest by an unbraked coast.
	return travelled + vel / ( 1 - f ) <= rem;
}

// The largest step this tic from which braking still stops within d.
static inline double MCPS_BrakeLimit( double d, double A, double f )
{
	if ( MCPS_CanStop( f * d, 0, A, f ) ) return d;
	double lo = 0, hi = d;
	for ( int i = 0; i < 40; i++ )
	{
		double mid = 0.5 * ( lo + hi );
		if ( MCPS_CanStop( f * mid, d - mid, A, f ) ) lo = mid;
		else hi = mid;
	}
	return lo;
}

static inline void MCP_SteerReset( MCPSteerState &st )
{
	st = MCPSteerState();
	st.kf = st.ks = 1;
}

// A new entry starts: the learned ratios carry over.
static inline void MCP_SteerBegin( MCPSteerState &st )
{
	st.nHist = 0;
	st.best = 1e30;
	st.tics = st.bestTic = st.settles = st.still = st.near = 0;
}

// Once per fresh tic, before any MCP_Steer call: learns from the tic the last MCP_Steer drove.
static inline void MCP_SteerObserve( MCPSteerState &st, const MCPSteerIn &in )
{
	st.blocked = false;
	if ( !st.hasPrev ) return;
	st.hasPrev = false;
	if ( !st.prevGround || !in.onGround ) return;
	double mx = in.px - st.prevPx, my = in.py - st.prevPy;
	double c = cos( st.prevHeading ), s = sin( st.prevHeading );
	// Observed thrust is the step taken minus the velocity it started from.
	double ox = mx - st.prevVx, oy = my - st.prevVy;
	double pf = st.prevPredF * st.kf, ps = st.prevPredS * st.ks;
	double cx = pf * c + ps * s, cy = pf * s - ps * c;
	double om = hypot( ox, oy ), cm = hypot( cx, cy );
	// Blocked: the velocity read isn't friction times the step (a wall cut it), or the push mostly
	// didn't happen (already against the wall).
	st.blocked = fabs( in.vx - in.friction * mx ) > MCP_STEER_FREE || fabs( in.vy - in.friction * my ) > MCP_STEER_FREE ||
		( cm > 0 && ox * cx + oy * cy < 0.25 * cm * cm );
	if ( st.blocked || cm <= 0 || om < 0.25 * cm || om > 4 * cm ) return;
	if ( ( ox * cx + oy * cy ) < MCP_STEER_LEARN_COS * om * cm ) return;
	double of = ox * c + oy * s, os = ox * s - oy * c;
	if ( abs( st.prevFwd ) >= MCP_STEER_LEARN_CMD * st.prevCapF && st.prevPredF != 0 && of * st.prevPredF > 0 )
		st.kf = MCPS_Clamp( of / st.prevPredF, 0.25, 4 );
	if ( abs( st.prevSide ) >= MCP_STEER_LEARN_CMD * st.prevCapS && st.prevPredS != 0 && os * st.prevPredS > 0 )
		st.ks = MCPS_Clamp( os / st.prevPredS, 0.25, 4 );
}

// The aim point: the target pulled back toward the player by the stand-off, by box gap for a
// solid target (Doom blocks on boxes).
static inline void MCPS_AimPoint( const MCPSteerIn &in, double &qx, double &qy )
{
	double dx = in.px - in.tx, dy = in.py - in.ty, d = hypot( dx, dy );
	double back = in.solid ? in.targetRadius + in.playerRadius + in.standoff + 1 : in.standoff;
	if ( back <= 0 ) { qx = in.tx; qy = in.ty; return; }
	double nx = 1, ny = 0;
	if ( d > 1e-9 ) { nx = dx / d; ny = dy / d; }
	double len = in.solid ? back / ( fabs( nx ) > fabs( ny ) ? fabs( nx ) : fabs( ny ) ) : back;
	qx = in.tx + nx * len;
	qy = in.ty + ny * len;
}

static inline void MCP_Steer( MCPSteerState &st, const MCPSteerIn &in, MCPSteerOut &out )
{
	out.status = MCP_STEER_RUN;
	out.yaw = out.forward = out.side = 0;
	double f = in.friction;
	double maxF = MCPS_AxisThrust( in.fwd, in.fwd.cap ) * st.kf;
	double maxS = MCPS_AxisThrust( in.side, in.side.cap ) * st.ks;
	double maxStep = maxF / ( 1 - f > 1e-6 ? 1 - f : 1e-6 );

	// The target's motion, averaged over the window since monsters stride every few tics, where a
	// jump beyond the player's reach and a monster's stride is a re-target.
	const int H = MCP_STEER_WINDOW + 1;
	if ( st.nHist > 0 )
	{
		int last = ( st.nHist - 1 ) % H;
		if ( hypot( in.tx - st.histTx[last], in.ty - st.histTy[last] ) > ( maxStep > MCP_STEER_JUMP ? maxStep : MCP_STEER_JUMP ) )
		{
			st.nHist = 0;
			st.best = 1e30;
			st.bestTic = st.tics;
			st.settles = st.still = st.near = 0;
		}
	}
	int head = st.nHist % H;
	st.histTx[head] = in.tx;
	st.histTy[head] = in.ty;
	st.histPx[head] = in.px;
	st.histPy[head] = in.py;
	st.nHist++;
	int span = st.nHist < H ? st.nHist - 1 : MCP_STEER_WINDOW;
	double wx = 0, wy = 0, ux = 0, uy = 0, stride = 0;
	if ( span > 0 )
	{
		int old = ( st.nHist - 1 - span ) % H;
		wx = ( in.tx - st.histTx[old] ) / span;
		wy = ( in.ty - st.histTy[old] ) / span;
		ux = ( in.px - st.histPx[old] ) / span;
		uy = ( in.py - st.histPy[old] ) / span;
	}
	// Moving while the last stride is no older than the gap between the last two.
	int since = -1, before = -1;
	for ( int i = 0; i < span; i++ )
	{
		int a = ( st.nHist - 1 - i ) % H, b = ( st.nHist - 2 - i ) % H;
		double j = hypot( st.histTx[a] - st.histTx[b], st.histTy[a] - st.histTy[b] );
		if ( j > stride ) stride = j;
		if ( j > 0 && since < 0 ) since = i;
		else if ( j > 0 && before < 0 ) before = i;
	}
	bool moving = since >= 0 && since <= ( before >= 0 ? before - since : MCP_STEER_GAP );
	if ( !moving ) wx = wy = 0;

	double qx, qy;
	MCPS_AimPoint( in, qx, qy );
	double dx = qx - in.px, dy = qy - in.py, d = hypot( dx, dy );
	out.qx = qx;
	out.qy = qy;
	out.dist = d;
	double speed = hypot( in.vx, in.vy );

	// Completion depends on the state read only.
	if ( in.pass )
	{
		if ( d <= ( speed > MCP_STEER_ARRIVE ? speed : MCP_STEER_ARRIVE ) ) { out.status = MCP_STEER_DONE; return; }
	}
	else if ( moving )
	{
		// Caught: keeping pace over the window, within the stride's sawtooth of the aim point.
		st.still = 0;
		double lag = stride - hypot( wx, wy );
		if ( d <= MCP_STEER_CATCH + ( lag > 0 ? lag : 0 ) && hypot( ux - wx, uy - wy ) < MCP_STEER_CATCH_V )
		{
			out.status = MCP_STEER_DONE;
			return;
		}
	}
	else
	{
		// Stopped just short, e.g. pinned against a wall, counts after MCP_STEER_STILL reads.
		bool still = in.vx == 0 && in.vy == 0;
		st.still = still && d <= MCP_STEER_ACCEPT ? st.still + 1 : 0;
		if ( still && ( d <= MCP_STEER_ARRIVE ||
			( ( st.settles >= MCP_STEER_SETTLES || st.still >= MCP_STEER_STILL ) && d <= MCP_STEER_ACCEPT ) ) )
		{
			out.status = MCP_STEER_DONE;
			return;
		}
	}

	// Stuck: the closest approach hasn't improved enough in stuckTics.
	double progress = st.blocked ? MCP_STEER_BLOCKED_PROGRESS : MCP_STEER_PROGRESS;
	if ( d < st.best - progress || d <= MCP_STEER_ACCEPT )
	{
		st.best = d;
		st.bestTic = st.tics;
	}
	if ( st.tics - st.bestTic >= in.stuckTics ) { out.status = MCP_STEER_STUCK; return; }
	st.tics++;

	// Settle with one tic of no move cmd so the engine's stop rule zeroes the velocity, also when held
	// up within MCP_STEER_ACCEPT (sliding along a wall short of the point).
	st.near = d <= MCP_STEER_ACCEPT && st.blocked ? st.near + 1 : 0;
	double settleAt = st.near >= MCP_STEER_NEAR ? MCP_STEER_ACCEPT : MCP_STEER_ARRIVE;
	if ( !in.pass && !moving && in.onGround && fabs( in.vx ) < in.stopSpeed && fabs( in.vy ) < in.stopSpeed &&
		hypot( qx - in.px - in.vx, qy - in.py - in.vy ) <= settleAt )
	{
		st.settles++;
		return;
	}

	// Heading: face the aim point while farther than MCP_STEER_FACE, then hold.
	double heading = in.angle;
	if ( d > MCP_STEER_FACE )
	{
		double want = atan2( dy, dx );
		double delta = remainder( want - in.angle, MCP_STEER_TWO_PI );
		double units = floor( delta / in.yawUnit + 0.5 );
		out.yaw = int( MCPS_Clamp( units, -32767, 32767 ) );
		heading = in.angle + out.yaw * in.yawUnit;
	}
	heading = fmod( heading, MCP_STEER_TWO_PI );
	if ( heading < 0 ) heading += MCP_STEER_TWO_PI;
	if ( in.thrustQuantum > 0 ) heading = floor( heading / in.thrustQuantum ) * in.thrustQuantum;
	double c = cos( heading ), s = sin( heading );

	// Wanted step: toward the aim point in the target's frame, no longer than braking allows.
	double ex = d > 0 ? dx / d : 0, ey = d > 0 ? dy / d : 0;
	double step = d;
	if ( !in.pass && in.onGround && d > 0 )
	{
		double ef = fabs( ex * c + ey * s ), es = fabs( ex * s - ey * c );
		double smoothF = MCPS_AxisSmooth( in.fwd ) * st.kf, smoothS = MCPS_AxisSmooth( in.side ) * st.ks;
		double A = 1e30;
		if ( ef > 1e-9 ) A = smoothF / ef;
		if ( es > 1e-9 && smoothS / es < A ) A = smoothS / es;
		A *= MCP_STEER_MARGIN * in.brakeScale;
		double limit = MCPS_BrakeLimit( d, A, f );
		if ( limit < step ) step = limit;
	}
	else if ( in.pass ) step = d > maxStep ? d : maxStep;
	double tx = wx + ex * step - in.vx, ty = wy + ey * step - in.vy;

	// Body frame, clamped to the authority box so drift is cancelled with strafe.
	double tf = MCPS_Clamp( tx * c + ty * s, -maxF, maxF );
	double ts = MCPS_Clamp( tx * s - ty * c, -maxS, maxS );
	out.forward = MCPS_Invert( in.fwd, st.kf, tf );
	out.side = MCPS_Invert( in.side, st.ks, ts );

	st.hasPrev = out.forward != 0 || out.side != 0;
	st.prevGround = in.onGround;
	st.prevPx = in.px;
	st.prevPy = in.py;
	st.prevVx = in.vx;
	st.prevVy = in.vy;
	st.prevHeading = heading;
	st.prevFwd = out.forward;
	st.prevSide = out.side;
	st.prevPredF = MCPS_AxisThrust( in.fwd, out.forward );
	st.prevPredS = MCPS_AxisThrust( in.side, out.side );
	st.prevCapF = in.fwd.cap;
	st.prevCapS = in.side.cap;
}

#endif
