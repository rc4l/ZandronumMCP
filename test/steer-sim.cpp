// steer-sim.cpp: run mcp_steer.h against Zandronum (16.16 fixed point, truncating multiplies, 13-bit
// thrust heading) and floating-point (doubles) ground kinematics, exiting non-zero on any miss.
// By hand from the repo root: g++ -std=c++14 -O2 test/steer-sim.cpp && ./a.out
#include "../engine-bridge/overlay/mcp_steer.h"
#include <stdint.h>
#include <stdio.h>
#include <string>
#include <vector>

static const double PI = 3.14159265358979323846;
static const int FRAC = 65536;
static const int STOPSPEED = 0x1000;
static const int ORIG_FRICTION = 0xE800;
static const int ORIG_MOVEFACTOR = 2048;

static int FixedMul( int a, int b ) { return int( ( int64_t( a ) * b ) >> 16 ); }
static int ToFixed( double v ) { return int( v * FRAC ); }
static double FromFixed( int v ) { return v / double( FRAC ); }

static int finecosine[8192], finesine[8192];

struct Actor
{
	int tid;
	double x, y, radius;
	bool solid;
	double vx, vy;
	int moveTics;
	int period = 1; // moves (vx, vy) once every period tics, as A_Chase strides
};

// Blocks where nx * x + ny * y > c; the player slides along it.
struct Wall { double nx, ny, c; };

enum EntryKind { PT, TID };
struct Entry
{
	EntryKind kind;
	double x, y;
	int tid;
	double standoff;
	bool pass;
};

enum Expect { ARRIVE, CAUGHT, STUCK, TIMEOUT, STUCK_OR_TIMEOUT };

struct Scenario
{
	std::string name;
	double px = 0, py = 0, vx = 0, vy = 0, angleDeg = 0;
	std::vector<Entry> entries;
	std::vector<Actor> actors;
	std::vector<Wall> walls;
	int friction = ORIG_FRICTION, movefactor = ORIG_MOVEFACTOR;
	double F1 = 1, F2 = 1, S1 = 1, S2 = 1; // ForwardMove1/2, SideMove1/2
	double speedItem = 1;                  // a speed factor the seed doesn't know
	int health = 100, runHealth = 0;
	double seedScale = 1;                  // the controller's seed over the truth
	double speedCap = 1;
	int ignoreTics = 0;                    // cmds ignored (reactiontime)
	int limit = 2100, stuckTics = 35;
	Expect expect = ARRIVE;
	double maxOvershoot = 0.05;
	double maxDist = MCP_STEER_ARRIVE;
	int expectTics = -1;
	int maxTics = -1;
	bool ratioKept = false;                // the learned ratios stay near the truth
	double peakStep = 0;                   // expected peak step, +- 0.2, when set
	double minPassSpeed = 0;               // speed when the first entry (a pass) completes
};

struct Result
{
	std::string reason;
	int tics;
	double dist, overshoot, peak, endSpeed, passSpeed, kf, ks;
	bool velZero;
};

// The player body in either flavour; positions and velocities are fixed point in Z.
struct Body
{
	bool z;
	double x, y, vx, vy, angle; // U, radians
	int fx, fy, fvx, fvy;       // Z
	uint32_t bam;               // Z

	double X() const { return z ? FromFixed( fx ) : x; }
	double Y() const { return z ? FromFixed( fy ) : y; }
	double VX() const { return z ? FromFixed( fvx ) : vx; }
	double VY() const { return z ? FromFixed( fvy ) : vy; }
	double Angle() const { return z ? bam * ( 2 * PI / 4294967296.0 ) : angle; }
};

static int MoveFactor( const Scenario &s, const Body &b )
{
	int mf = s.movefactor;
	if ( s.friction < ORIG_FRICTION )
	{
		// P_GetMoveFactor's speed steps in mud, on P_AproxDistance.
		int ax = abs( b.z ? b.fvx : ToFixed( b.vx ) ), ay = abs( b.z ? b.fvy : ToFixed( b.vy ) );
		int vel = ax + ay - ( ax < ay ? ax : ay ) / 2;
		if ( vel > 0x15000 << 2 ) mf <<= 3;
		else if ( vel > 0x15000 << 1 ) mf <<= 2;
		else if ( vel > 0x15000 ) mf <<= 1;
	}
	return mf;
}

// TweakSpeeds: health clamp, the two regimes, then the speed factor.
static double Tweak( const Scenario &s, int v, bool fwd, bool z )
{
	if ( s.health <= s.runHealth ) v = fwd ? ( v < -0x1900 ? -0x1900 : v > 0x1900 ? 0x1900 : v ) : ( v < -0x1800 ? -0x1800 : v > 0x1800 ? 0x1800 : v );
	bool r1 = fwd ? unsigned( v + 0x31ff ) < 0x63ff : unsigned( v + 0x27ff ) < 0x4fff;
	double g = fwd ? ( r1 ? s.F1 : s.F2 ) : ( r1 ? s.S1 : s.S2 );
	if ( z )
	{
		int t = FixedMul( v, ToFixed( g ) );
		return FixedMul( t, ToFixed( s.speedItem ) );
	}
	return v * g * s.speedItem;
}

static void Physics( const Scenario &s, Body &b, int yaw, int fwd, int side, bool ignore )
{
	int mf = MoveFactor( s, b );
	if ( ignore ) fwd = side = yaw = 0;
	if ( b.z )
	{
		b.bam += uint32_t( yaw ) << 16;
		if ( fwd | side )
		{
			int fm = int( Tweak( s, fwd, true, true ) ), sm = int( Tweak( s, side, false, true ) );
			int fmove = int( int64_t( fm ) * ( mf * 35 ) / ( 35 << 8 ) );
			int smove = int( int64_t( sm ) * ( mf * 35 ) / ( 35 << 8 ) );
			if ( fmove )
			{
				int a = b.bam >> 19;
				b.fvx += FixedMul( fmove, finecosine[a] );
				b.fvy += FixedMul( fmove, finesine[a] );
			}
			if ( smove )
			{
				int a = ( b.bam - 0x40000000u ) >> 19;
				b.fvx += FixedMul( smove, finecosine[a] );
				b.fvy += FixedMul( smove, finesine[a] );
			}
		}
	}
	else
	{
		b.angle += yaw * ( 2 * PI / 65536 );
		if ( fwd | side )
		{
			double scale = mf / 256.0 / FRAC;
			double f = Tweak( s, fwd, true, false ) * scale, sd = Tweak( s, side, false, false ) * scale;
			b.vx += f * cos( b.angle ) + sd * cos( b.angle - PI / 2 );
			b.vy += f * sin( b.angle ) + sd * sin( b.angle - PI / 2 );
		}
	}
	// Move up to any wall the step would cross, keeping only the velocity along it.
	double ux = b.VX(), uy = b.VY(), mx = ux, my = uy;
	for ( const Wall &w : s.walls )
	{
		double excess = w.nx * ( b.X() + mx ) + w.ny * ( b.Y() + my ) - w.c;
		if ( excess > 0 )
		{
			mx -= w.nx * excess;
			my -= w.ny * excess;
			double into = w.nx * ux + w.ny * uy;
			ux -= w.nx * into;
			uy -= w.ny * into;
		}
	}
	bool stop = !( fwd | side );
	if ( b.z )
	{
		int iux = ToFixed( ux ), iuy = ToFixed( uy );
		b.fx += ToFixed( mx );
		b.fy += ToFixed( my );
		if ( stop && iux > -STOPSPEED && iux < STOPSPEED && iuy > -STOPSPEED && iuy < STOPSPEED ) b.fvx = b.fvy = 0;
		else
		{
			b.fvx = FixedMul( iux, s.friction );
			b.fvy = FixedMul( iuy, s.friction );
		}
	}
	else
	{
		b.x += mx;
		b.y += my;
		double ss = STOPSPEED / double( FRAC );
		double f = s.friction / double( FRAC );
		if ( stop && fabs( ux ) < ss && fabs( uy ) < ss ) b.vx = b.vy = 0;
		else
		{
			b.vx = ux * f;
			b.vy = uy * f;
		}
	}
}

// Seeded thrust per raw unit, as each engine's glue computes it (no speed item, scaled seed).
static MCPSteerAxis Axis( const Scenario &s, bool fwd, int mf, bool z )
{
	MCPSteerAxis a;
	a.regime2 = fwd ? 0x3200 : 0x2800;
	int full = fwd ? 12800 : 10240;
	a.cap = int( floor( full * s.speedCap + 0.5 ) );
	int clampTo = fwd ? 0x1900 : 0x1800;
	if ( s.health <= s.runHealth && a.cap > clampTo ) a.cap = clampTo;
	double scale = mf / 256.0 / FRAC * s.seedScale;
	int p1 = a.cap < a.regime2 - 1 ? a.cap : a.regime2 - 1;
	Scenario seed = s;
	seed.speedItem = 1;
	a.gain1 = p1 > 0 ? Tweak( seed, p1, fwd, z ) / p1 * scale : 0;
	a.gain2 = a.cap >= a.regime2 ? Tweak( seed, a.cap, fwd, z ) / a.cap * scale : a.gain1;
	return a;
}

static Result Run( const Scenario &s, bool z )
{
	Body b;
	b.z = z;
	b.x = s.px; b.y = s.py; b.vx = s.vx; b.vy = s.vy; b.angle = s.angleDeg * PI / 180;
	b.fx = ToFixed( s.px ); b.fy = ToFixed( s.py ); b.fvx = ToFixed( s.vx ); b.fvy = ToFixed( s.vy );
	b.bam = uint32_t( int64_t( s.angleDeg / 360.0 * 4294967296.0 ) );
	std::vector<Actor> actors = s.actors;

	MCPSteerState st;
	MCP_SteerReset( st );
	Result r = Result();
	size_t idx = 0;
	bool begun = false;
	int tics = 0, ignore = s.ignoreTics;
	double legX = 0, legY = 0, lastX = b.X(), lastY = b.Y();
	MCPSteerOut out = MCPSteerOut();
	double dist = 0;
	r.passSpeed = -1;

	for ( ;; )
	{
		MCPSteerIn in;
		in.px = b.X(); in.py = b.Y(); in.vx = b.VX(); in.vy = b.VY();
		in.angle = b.Angle();
		in.yawUnit = 2 * PI / 65536;
		in.thrustQuantum = z ? 2 * PI / 8192 : 0;
		in.friction = s.friction / double( FRAC );
		in.stopSpeed = STOPSPEED / double( FRAC );
		int mf = MoveFactor( s, b );
		in.fwd = Axis( s, true, mf, z );
		in.side = Axis( s, false, mf, z );
		in.brakeScale = double( s.movefactor ) / mf;
		in.onGround = true;
		in.playerRadius = 16;
		MCP_SteerObserve( st, in );

		std::string reason;
		for ( ;; )
		{
			if ( idx == s.entries.size() ) { reason = "done"; break; }
			const Entry &e = s.entries[idx];
			if ( !begun )
			{
				MCP_SteerBegin( st );
				begun = true;
				legX = in.px; legY = in.py;
				r.overshoot = 0;
			}
			in.standoff = e.standoff;
			in.pass = e.pass;
			in.stuckTics = s.stuckTics;
			in.solid = false;
			in.targetRadius = 0;
			if ( e.kind == PT ) { in.tx = e.x; in.ty = e.y; }
			else
			{
				const Actor *best = NULL;
				double bd = 1e30;
				for ( const Actor &a : actors )
				{
					double d = hypot( a.x - in.px, a.y - in.py );
					if ( a.tid == e.tid && d < bd ) { bd = d; best = &a; }
				}
				if ( best == NULL ) { reason = "target_gone"; break; }
				in.tx = best->x; in.ty = best->y;
				in.targetRadius = best->radius;
				in.solid = best->solid;
			}
			MCP_Steer( st, in, out );
			dist = out.dist;
			if ( out.status == MCP_STEER_DONE )
			{
				if ( idx == 0 && e.pass ) r.passSpeed = hypot( in.vx, in.vy );
				idx++;
				begun = false;
				continue;
			}
			if ( out.status == MCP_STEER_STUCK ) reason = "stuck";
			break;
		}
		if ( reason.empty() && tics >= s.limit ) reason = "timeout";
		if ( !reason.empty() )
		{
			r.reason = reason;
			r.tics = tics;
			r.dist = dist;
			r.velZero = z ? ( b.fvx == 0 && b.fvy == 0 ) : ( b.vx == 0 && b.vy == 0 );
			r.endSpeed = hypot( b.VX(), b.VY() );
			r.kf = st.kf;
			r.ks = st.ks;
			return r;
		}

		Physics( s, b, out.yaw, out.forward, out.side, ignore > 0 );
		if ( ignore > 0 ) ignore--;
		tics++;
		double step = hypot( b.X() - lastX, b.Y() - lastY );
		if ( step > r.peak ) r.peak = step;
		lastX = b.X(); lastY = b.Y();
		// Overshoot past the current aim point along this leg.
		double ex = out.qx - legX, ey = out.qy - legY, el = hypot( ex, ey );
		if ( el > 1e-9 && !s.entries[idx].pass )
		{
			double past = ( ( b.X() - out.qx ) * ex + ( b.Y() - out.qy ) * ey ) / el;
			if ( past > r.overshoot ) r.overshoot = past;
		}
		for ( Actor &a : actors )
		{
			if ( a.moveTics > 0 )
			{
				if ( tics % a.period == 0 ) { a.x += a.vx; a.y += a.vy; }
				a.moveTics--;
			}
		}
	}
}

static int failures = 0;

static void Check( const Scenario &s, bool z, const Result &r )
{
	std::vector<std::string> miss;
	char buf[256];
	switch ( s.expect )
	{
	case ARRIVE:
		if ( r.reason != "done" ) miss.push_back( "reason " + r.reason );
		if ( r.dist > s.maxDist ) { snprintf( buf, sizeof buf, "dist %.4f", r.dist ); miss.push_back( buf ); }
		if ( !r.velZero ) { snprintf( buf, sizeof buf, "end speed %.5f", r.endSpeed ); miss.push_back( buf ); }
		break;
	case CAUGHT:
		// While the target still moves: a stopped one would end done by an ordinary arrival.
		if ( r.reason != "done" ) miss.push_back( "reason " + r.reason );
		if ( r.tics >= s.actors[0].moveTics ) { snprintf( buf, sizeof buf, "tics %d, target stopped", r.tics ); miss.push_back( buf ); }
		break;
	case STUCK:
		if ( r.reason != "stuck" ) miss.push_back( "reason " + r.reason );
		break;
	case TIMEOUT:
		if ( r.reason != "timeout" ) miss.push_back( "reason " + r.reason );
		break;
	case STUCK_OR_TIMEOUT:
		if ( r.reason != "stuck" && r.reason != "timeout" ) miss.push_back( "reason " + r.reason );
		break;
	}
	if ( r.overshoot > s.maxOvershoot ) { snprintf( buf, sizeof buf, "overshoot %.4f", r.overshoot ); miss.push_back( buf ); }
	if ( s.expectTics >= 0 && r.tics != s.expectTics ) { snprintf( buf, sizeof buf, "tics %d, want %d", r.tics, s.expectTics ); miss.push_back( buf ); }
	if ( s.maxTics >= 0 && r.tics > s.maxTics ) { snprintf( buf, sizeof buf, "tics %d, max %d", r.tics, s.maxTics ); miss.push_back( buf ); }
	if ( s.ratioKept && ( fabs( r.kf - 1 ) > 0.02 || fabs( r.ks - 1 ) > 0.02 ) ) { snprintf( buf, sizeof buf, "ratios %.3f %.3f", r.kf, r.ks ); miss.push_back( buf ); }
	if ( s.peakStep > 0 && fabs( r.peak - s.peakStep ) > 0.2 ) { snprintf( buf, sizeof buf, "peak step %.3f", r.peak ); miss.push_back( buf ); }
	if ( s.minPassSpeed > 0 && r.passSpeed < s.minPassSpeed ) { snprintf( buf, sizeof buf, "pass speed %.3f", r.passSpeed ); miss.push_back( buf ); }
	std::string line;
	for ( const std::string &m : miss ) line += ( line.empty() ? "" : ", " ) + m;
	printf( "%s %-3s %-28s %-11s tics=%-4d dist=%.4f over=%.4f peak=%.3f k=%.3f/%.3f%s%s\n",
		miss.empty() ? "ok  " : "MISS", z ? "Z" : "U", s.name.c_str(), r.reason.c_str(), r.tics, r.dist,
		r.overshoot, r.peak, r.kf, r.ks, miss.empty() ? "" : "  <- ", line.c_str() );
	if ( !miss.empty() ) failures++;
}

static Entry Pt( double x, double y, double standoff = 0, bool pass = false ) { return Entry{ PT, x, y, 0, standoff, pass }; }
static Entry Tid( int tid ) { return Entry{ TID, 0, 0, tid, 0, false }; }

static Scenario Far( const std::string &name )
{
	Scenario s;
	s.name = name;
	s.angleDeg = 90;
	s.entries.push_back( Pt( 512, 0 ) );
	return s;
}

int main()
{
	for ( int i = 0; i < 8192; i++ )
	{
		finecosine[i] = int( floor( cos( i * 2 * PI / 8192 ) * FRAC + 0.5 ) );
		finesine[i] = int( floor( sin( i * 2 * PI / 8192 ) * FRAC + 0.5 ) );
	}
	std::vector<Scenario> all;
	all.push_back( Far( "far 512 from rest" ) );
	{
		Scenario s;
		s.name = "diagonal, sideways drift 10";
		s.vx = 7.0710678; s.vy = -7.0710678;
		s.entries.push_back( Pt( 300, 300 ) );
		all.push_back( s );
	}
	{
		Scenario s;
		s.name = "already there";
		s.px = 40; s.py = 40;
		s.entries.push_back( Pt( 40, 40 ) );
		s.expectTics = 0;
		all.push_back( s );
	}
	{
		Scenario s;
		s.name = "hop 3";
		s.entries.push_back( Pt( 3, 0 ) );
		all.push_back( s );
		s.name = "hop 0.3";
		s.entries[0] = Pt( 0.3, 0 );
		all.push_back( s );
	}
	{
		Scenario s = Far( "ice" );
		s.entries[0] = Pt( 256, 0 );
		s.friction = 0xF900;
		s.movefactor = ( ( 0x10092 - 0xF900 ) * 0x70 ) / 0x158;
		all.push_back( s );
	}
	{
		Scenario s;
		s.name = "mud entered at speed";
		s.vx = 8;
		s.entries.push_back( Pt( 160, 0 ) );
		s.friction = 0xE000;
		s.movefactor = ( ( 0xE000 - 0xDB34 ) * 0xA ) / 0x80;
		all.push_back( s );
	}
	{
		Scenario s = Far( "regime gap F1 0.5 F2 1" );
		s.F1 = 0.5;
		s.S1 = 0.5;
		all.push_back( s );
	}
	{
		Scenario s = Far( "seed 2x high" );
		s.seedScale = 2;
		s.maxOvershoot = 2;
		all.push_back( s );
		s.name = "seed 2x low";
		s.seedScale = 0.5;
		all.push_back( s );
		s.name = "hop 3 seed 2x high";
		s.entries[0] = Pt( 3, 0 );
		s.angleDeg = 0;
		s.seedScale = 2;
		s.maxOvershoot = 3;
		all.push_back( s );
		s.name = "hop 3 seed 2x low";
		s.seedScale = 0.5;
		all.push_back( s );
	}
	{
		Scenario s = Far( "speed item 1.5 unseeded" );
		s.speedItem = 1.5;
		s.maxOvershoot = 2;
		all.push_back( s );
	}
	{
		Scenario s = Far( "RunHealth clamp" );
		s.health = 5;
		s.runHealth = 10;
		all.push_back( s );
	}
	{
		// Slow enough that the last 0.5 takes many tics: still lands within 0.05, no wall.
		Scenario s;
		s.name = "speed 0.02, 20 units";
		s.entries.push_back( Pt( 20, 0 ) );
		s.speedCap = 0.02;
		all.push_back( s );
		// Gains more than 1 but less than 8 units per stuck window, without a wall.
		s.name = "speed 0.003, 20 units";
		s.speedCap = 0.003;
		all.push_back( s );
	}
	{
		Scenario s = Far( "speed 0.5" );
		s.speedCap = 0.5;
		s.peakStep = 8.33;
		all.push_back( s );
	}
	{
		Scenario s = Far( "stand-off 64" );
		s.entries[0] = Pt( 512, 0, 64 );
		all.push_back( s );
	}
	{
		Scenario s;
		s.name = "solid actor, diagonal";
		s.actors.push_back( Actor{ 5, 300, 200, 20, true, 0, 0, 0 } );
		s.entries.push_back( Tid( 5 ) );
		all.push_back( s );
		s.name = "non-solid actor";
		s.actors[0].solid = false;
		all.push_back( s );
	}
	{
		Scenario s;
		s.name = "pass, then a 90-degree stop";
		s.entries.push_back( Pt( 256, 0, 0, true ) );
		s.entries.push_back( Pt( 256, 256 ) );
		s.minPassSpeed = 5;
		all.push_back( s );
		s.name = "two stops";
		s.entries[0].pass = false;
		s.minPassSpeed = 0;
		all.push_back( s );
	}
	{
		Scenario s;
		s.name = "head-on wall";
		s.entries.push_back( Pt( 300, 0 ) );
		s.walls.push_back( Wall{ 1, 0, 150 } );
		s.expect = STUCK;
		s.ratioKept = true;
		s.maxOvershoot = 1e9;
		s.expectTics = 52;
		all.push_back( s );
		s.name = "oblique wall 30";
		s.walls[0] = Wall{ cos( PI / 6 ), sin( PI / 6 ), 150 };
		s.expectTics = -1;
		all.push_back( s );
	}
	{
		// A slow slide used to reset the stuck timer repeatedly for tiny gains.
		Scenario s;
		s.name = "slow oblique wall slide";
		s.entries.push_back( Pt( 300, 150 ) );
		s.walls.push_back( Wall{ 1, 0, 0 } );
		s.speedCap = 0.2;
		s.expect = STUCK;
		s.maxTics = s.stuckTics;
		s.ratioKept = true;
		all.push_back( s );
	}
	{
		// Pinned 0.05-0.5 short never settles on the point: stopped there is accepted.
		Scenario s;
		s.name = "wall 0.3 short";
		s.entries.push_back( Pt( 300, 0 ) );
		s.walls.push_back( Wall{ 1, 0, 299.7 } );
		s.maxDist = MCP_STEER_ACCEPT;
		s.ratioKept = true;
		all.push_back( s );
		s.name = "wall 0.45 short, oblique leg";
		s.entries[0] = Pt( 300, 100 );
		s.walls[0] = Wall{ 1, 0, 299.55 };
		all.push_back( s );
	}
	{
		Scenario s = Far( "18 ignored tics" );
		s.ignoreTics = 18;
		s.ratioKept = true;
		all.push_back( s );
	}
	{
		Scenario s;
		s.name = "tid receding at 4";
		s.actors.push_back( Actor{ 7, 200, 0, 20, true, 4, 0, 1000 } );
		s.entries.push_back( Tid( 7 ) );
		s.expect = CAUGHT;
		s.maxOvershoot = 1e9;
		all.push_back( s );
		s.name = "tid crossing at 4";
		s.actors[0] = Actor{ 7, 200, -100, 20, true, 0, 4, 1000 };
		all.push_back( s );
		// A_Chase: a stride every few tics, so the per-tic step alternates stride and 0.
		s.name = "tid A_Chase receding 8/3";
		s.actors[0] = Actor{ 7, 200, 0, 20, true, 8, 0, 1000, 3 };
		all.push_back( s );
		s.name = "tid A_Chase crossing 8/4";
		s.actors[0] = Actor{ 7, 200, -100, 20, true, 0, 8, 1000, 4 };
		all.push_back( s );
		s.name = "tid A_Chase diagonal 10/2";
		s.actors[0] = Actor{ 7, 200, 0, 20, true, 7.0710678, 7.0710678, 1000, 2 };
		all.push_back( s );
		s.name = "tid A_Chase 10/2, speed 0.5";
		s.actors[0] = Actor{ 7, 200, 0, 20, true, 10, 0, 1000, 2 };
		s.speedCap = 0.5;
		all.push_back( s );
		s.speedCap = 1;
		s.name = "tid one stride, then stands";
		s.actors[0] = Actor{ 7, 200, 0, 20, true, 8, 0, 1, 1 };
		s.expect = ARRIVE;
		all.push_back( s );
		s.expect = CAUGHT;
		s.name = "tid receding at 20";
		s.actors[0] = Actor{ 7, 200, 0, 20, true, 20, 0, 10000 };
		s.expect = STUCK_OR_TIMEOUT;
		s.limit = 300;
		all.push_back( s );
	}
	{
		Scenario s;
		s.name = "same-TID nearest flips";
		s.actors.push_back( Actor{ 9, 400, 0, 20, true, 0, 0, 0 } );
		s.actors.push_back( Actor{ 9, 200, 600, 20, true, 0, -20, 25 } );
		s.entries.push_back( Tid( 9 ) );
		// Arrived means at the nearest one when it ended; the overshoot is toward the old one.
		s.maxOvershoot = 1e9;
		all.push_back( s );
	}

	for ( int zi = 1; zi >= 0; zi-- )
	{
		bool z = zi == 1;
		for ( const Scenario &s : all ) Check( s, z, Run( s, z ) );
		// The limit: a walk that needs exactly N tics is done at limit N and times out at N - 1.
		Scenario s = Far( "limit = tics needed" );
		int need = Run( s, z ).tics;
		s.limit = need;
		s.expectTics = need;
		Check( s, z, Run( s, z ) );
		s.name = "limit = tics needed - 1";
		s.limit = need - 1;
		s.expectTics = need - 1;
		s.expect = TIMEOUT;
		Check( s, z, Run( s, z ) );
	}
	printf( "%s\n", failures ? "FAILED" : "all scenarios passed" );
	return failures ? 1 : 0;
}
