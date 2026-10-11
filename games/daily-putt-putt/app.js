/* ============================================================
   PUTT-PUTT -- nine mini-golf holes, stroke play.
   The little sibling of Daily Putt: same proven shot mechanic
   (tap to place the marker, LOCK THE LINE, oscillating needle,
   STOP in the gold), but every hole is a putt-putt classic --
   windmills, bumpers, ramps, water, tunnels.

   THE SHOT -- three steps:
   1. AIM (7 seconds): tap/drag to place the marker; line shows
      ball->marker with power notches. When the timer hits zero
      the aim AUTO-LOCKS wherever the marker is.
   2. POWER: press PUTT and the needle SWEEPS UP AND BACK DOWN.
      PURE BAND is 82-87 (near the top, NOT at the top); the very
      top is the OVER zone. Press STOP to stop the needle.
      The sweep gets 3% FASTER every hole (hole 9 is twitchy).
   3. OUTCOMES: PURE = perfect pace + truest roll. OVERSWING =
      too hot: blows past AND bends offline. EASED = short.

   Moving obstacles (windmill blades, sliding gates) run on
   date-seeded phase + a clock that starts when the hole starts,
   so every player faces the same pattern and what you see is
   what you get. Water hazards send the ball back to where the
   stroke started (the stroke counts).

   Rules: 9 date-seeded holes (same for everyone), par 2-4,
   up to 6 putts per hole -- after 6 the ball is PICKED UP.
   One ranked round per day, unlimited practice.
   Score = total strokes vs par. Original code and art.
   ============================================================ */
(function(){
'use strict';

/* ================= utils ================= */
function clamp(v,a,b){return v<a?a:(v>b?b:v);}
function lerp(a,b,t){return a+(b-a)*t;}
function dist2(ax,ay,bx,by){var dx=ax-bx,dy=ay-by;return Math.sqrt(dx*dx+dy*dy);}
function hashStr(s){var h=2166136261>>>0;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function dateStr(d){d=d||new Date();return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);}
function smoothstep(t){t=clamp(t,0,1);return t*t*(3-2*t);}

/* ================= physics constants (feet, seconds) ================= */
var FRICTION=2.3;        /* kinetic decel opposing motion            */
var SLOPE_G=32.0;        /* accel = SLOPE_G * slope (rise/run)       */
var CUP_R=0.42;          /* cup capture radius (generous for feel)   */
var BALL_R=0.30;         /* ball radius (also the collision radius)  */
var V_CAP=4.0;           /* max speed at cup for a clean drop        */
var V_STOP=0.12;         /* below this the ball is at rest           */
var DMAX=60;             /* putt distance at full (1.0) power        */
var BAR_MAX=1.15;        /* power headroom above 1.0                 */
var DT=1/240;            /* physics substep: no tunneling, ever      */
var RAIL_REST=0.82;      /* wooden rails: lively, bank shots work       */
var AIM_SECS=7;          /* aim timer: auto-lock when it hits zero   */

/* ================= the needle (signature timing mechanic) ==============
   0..100, sweeps up and back down repeatedly. PURE BAND 82-87 sits near
   the top but NOT at the top; 87-100 is the OVER zone. STOP JUST UNDER 100.
   The sweep is EASED (sqrt): fast off zero, lingering near the top so the
   gold band is a ~127ms window per pass -- snappy but hittable.
   The sweep gets 3% faster every hole: hole n uses SWEEP_T / 1.03^(n-1). */
var PURE_LO=82, PURE_HI=87, PURE_MID=84.5;
var SWEEP_T=1.5;         /* seconds for 0 -> 100 on hole 1 */
var OVER_BEND_MAX=4*Math.PI/180; /* max offline bend at a 100 stop   */

function sweepDur(holeIdx){return SWEEP_T/Math.pow(1.03,holeIdx);}

function needleGrade(n){
  if(n>=PURE_LO&&n<=PURE_HI)return'PURE';
  return n>PURE_HI?'OVERSWING':'EASED';
}
/* PURE stop (84.5) carries exactly the marked distance on flat felt. */
function needleToPower(n,markerDist){
  return clamp((n/PURE_MID)*(markerDist/DMAX),0,BAR_MAX);
}
/* Overswing bends offline (push/pull): up to 4deg at a 100 stop, signed
   by a seeded rng so it's deterministic per putt. */
function overswingBend(n,seed){
  if(n<=PURE_HI)return 0;
  var dir=mulberry32(seed>>>0)()<0.5?-1:1;
  return dir*((n-PURE_HI)/(100-PURE_HI))*OVER_BEND_MAX;
}

/* ================= geometry ================= */
function inPoly(px,py,poly){
  var inside=false;
  for(var i=0,j=poly.length-1;i<poly.length;j=i++){
    var xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
    if(((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi))inside=!inside;
  }
  return inside;
}
function inHazard(hole,x,y){
  for(var k=0;k<hole.hazards.length;k++){
    if(inPoly(x,y,hole.hazards[k].poly))return true;
  }
  return false;
}
/* closest point on a polygon boundary (safety net: the ball can never
   leave the lane even if a collision is missed) */
function closestOnPoly(px,py,poly){
  var best=null,bd=1e18;
  for(var i=0,j=poly.length-1;i<poly.length;j=i++){
    var ax=poly[j].x,ay=poly[j].y,bx=poly[i].x,by=poly[i].y;
    var dx=bx-ax,dy=by-ay,L2=dx*dx+dy*dy;
    var t=L2>1e-9?clamp(((px-ax)*dx+(py-ay)*dy)/L2,0,1):0;
    var qx=ax+dx*t,qy=ay+dy*t;
    var d=(px-qx)*(px-qx)+(qy-py)*(qy-py);
    if(d<bd){bd=d;best={x:qx,y:qy,nx:px-qx,ny:py-qy};}
  }
  return best;
}
/* lane polygon from a centerline spine + half-width (averaged normals;
   spines use gentle curves so joins stay smooth) */
function lanePoly(spine,w){
  var n=spine.length,left=[],right=[],i;
  for(i=0;i<n;i++){
    var p0=spine[Math.max(0,i-1)],p1=spine[Math.min(n-1,i+1)];
    var dx=p1[0]-p0[0],dy=p1[1]-p0[1],L=Math.hypot(dx,dy)||1;
    var nx=-dy/L,ny=dx/L;
    left.push({x:spine[i][0]+nx*w,y:spine[i][1]+ny*w});
    right.push({x:spine[i][0]-nx*w,y:spine[i][1]-ny*w});
  }
  return left.concat(right.reverse());
}
/* polygon edges -> wall segments (the wooden rails) */
function polyWalls(poly,rest){
  var segs=[];
  for(var i=0,j=poly.length-1;i<poly.length;j=i++){
    segs.push({x1:poly[j].x,y1:poly[j].y,x2:poly[i].x,y2:poly[i].y,
      vx1:0,vy1:0,vx2:0,vy2:0,rest:rest,halfW:0});
  }
  return segs;
}

/* numeric gradient of h -- single source of truth for physics + art */
function gradOf(h,x,y){
  var e=0.06;
  return {x:(h(x+e,y)-h(x-e,y))/(2*e), y:(h(x,y+e)-h(x,y-e))/(2*e)};
}
function slopeInfo(h,x,y){
  var g=gradOf(h,x,y);
  var m=Math.sqrt(g.x*g.x+g.y*g.y);
  if(m<0.004)return{pct:0,dx:0,dy:0,flat:true};
  return{pct:m*100,dx:-g.x/m,dy:-g.y/m,flat:false};
}

/* height-field pieces (ramps, mounds, tilts) */
function stepField(s,w,px,py,nx,ny){
  return function(x,y){
    var dd=(x-px)*nx+(y-py)*ny;
    return s*smoothstep(0.5+dd/w);
  };
}
function tiltField(s,tA){
  return function(x,y){return s*(x*Math.cos(tA)+y*Math.sin(tA));};
}
function moundField(hh,r,cx,cy){
  return function(x,y){
    var dx=x-cx,dy=y-cy;
    return hh*Math.exp(-(dx*dx+dy*dy)/(r*r));
  };
}
function addFields(){
  var fs=arguments,n=fs.length;
  return function(x,y){var t=0;for(var i=0;i<n;i++)t+=fs[i](x,y);return t;};
}
function flatField(){return function(){return 0;};}

/* hillshade baked from the height field -- mounds and ramps get visible
   depth; what you see is what breaks the putt */
function shadeGrid(hole,W,H){
  var bb=hole.bbox,pad=4;
  var x0=bb.x0-pad,x1=bb.x1+pad,y0=bb.y0-pad,y1=bb.y1+pad;
  var dx=(x1-x0)/(W-1),dy=(y1-y0)/(H-1);
  var hg=new Float32Array(W*H),hmin=1e9,hmax=-1e9,i,j;
  for(j=0;j<H;j++)for(i=0;i<W;i++){
    var hv=hole.h(x0+i*dx,y0+j*dy);
    hg[j*W+i]=hv;if(hv<hmin)hmin=hv;if(hv>hmax)hmax=hv;
  }
  var hr=hmax-hmin;if(hr<1e-6)hr=1e-6;
  var out=new Float32Array(W*H*3);
  for(j=0;j<H;j++)for(i=0;i<W;i++){
    var hx0=hg[j*W+Math.max(0,i-1)],hx1=hg[j*W+Math.min(W-1,i+1)];
    var hy0=hg[Math.max(0,j-1)*W+i],hy1=hg[Math.min(H-1,j+1)*W+i];
    var gx=(hx1-hx0)/(2*dx),gy=(hy1-hy0)/(2*dy);
    var inv=1/Math.sqrt(gx*gx+gy*gy+1);
    var li=clamp((-gx*inv)*-0.55+(-gy*inv)*-0.55+inv*0.72,0,1);
    var shade=0.72+0.48*li;
    var t=(hg[j*W+i]-hmin)/hr;
    /* putt-putt felt: vivid green, lows deeper, highs sunlit */
    var r=52+t*44,gg=138+t*52,b=66+t*26;
    var k=shade,o=(j*W+i)*3;
    out[o]=clamp(r*k,0,255);out[o+1]=clamp(gg*k,0,255);out[o+2]=clamp(b*k,0,255);
  }
  return{data:out,w:W,h:H,x0:x0,y0:y0,dx:dx,dy:dy};
}

/* ================= movers (windmill blades, sliding gates) =============
   Deterministic: phase/omega are date-seeded per hole; the motion is a
   pure function of hole-time T (seconds since the hole's aim phase
   began). Every player sees the same pattern; timing the stroke IS the
   skill. During a stroke the sim advances the same clock, so the art
   can never disagree with the physics. */
function moverSegs(mv,T){
  var segs=[],b,a,ca,sa;
  if(mv.type==='blade'){
    for(b=0;b<mv.arms;b++){
      a=mv.phase+mv.omega*T+b*2*Math.PI/mv.arms;
      ca=Math.cos(a);sa=Math.sin(a);
      var x2=mv.cx+ca*mv.len,y2=mv.cy+sa*mv.len;
      segs.push({x1:mv.cx,y1:mv.cy,x2:x2,y2:y2,
        vx1:0,vy1:0,
        vx2:-mv.omega*(y2-mv.cy),vy2:mv.omega*(x2-mv.cx),
        rest:mv.rest,halfW:mv.wid/2,kind:'blade'});
    }
  }else if(mv.type==='gate'){
    var off=mv.amp*Math.sin(mv.omega*T+mv.phase);
    var voff=mv.amp*mv.omega*Math.cos(mv.omega*T+mv.phase);
    var vx=voff*mv.ax,vy=voff*mv.ay;
    segs.push({x1:mv.x1+mv.ax*off,y1:mv.y1+mv.ay*off,
      x2:mv.x2+mv.ax*off,y2:mv.y2+mv.ay*off,
      vx1:vx,vy1:vy,vx2:vx,vy2:vy,
      rest:mv.rest,halfW:mv.wid/2,kind:'gate'});
  }
  return segs;
}

/* ball (circle) vs moving segment: push out + reflect about the normal
   in the surface's frame. Returns null when clear. */
function collideSeg(px,py,vx,vy,s){
  var dx=s.x2-s.x1,dy=s.y2-s.y1;
  var L2=dx*dx+dy*dy;
  if(L2<1e-9)return null;
  var t=clamp(((px-s.x1)*dx+(py-s.y1)*dy)/L2,0,1);
  var qx=s.x1+dx*t,qy=s.y1+dy*t;
  var svx=s.vx1+(s.vx2-s.vx1)*t,svy=s.vy1+(s.vy2-s.vy1)*t;
  var nx=px-qx,ny=py-qy;
  var d=Math.sqrt(nx*nx+ny*ny);
  var minD=BALL_R+(s.halfW||0);
  if(d>=minD)return null;
  if(d<1e-6){nx=-dy;ny=dx;var nl=Math.hypot(nx,ny)||1;nx/=nl;ny/=nl;}
  else{nx/=d;ny/=d;}
  var rvx=vx-svx,rvy=vy-svy;
  var vn=rvx*nx+rvy*ny;
  var ox=qx+nx*minD,oy=qy+ny*minD;
  if(vn>=0)return{x:ox,y:oy,vx:vx,vy:vy,hit:false};
  var j=-(1+s.rest)*vn;
  return{x:ox,y:oy,vx:vx+j*nx,vy:vy+j*ny,hit:true};
}
function collideBumper(px,py,vx,vy,b){
  var nx=px-b.x,ny=py-b.y;
  var d=Math.sqrt(nx*nx+ny*ny),minD=BALL_R+b.r;
  if(d>=minD||d<1e-6)return null;
  nx/=d;ny/=d;
  var vn=vx*nx+vy*ny;
  var ox=b.x+nx*minD,oy=b.y+ny*minD;
  if(vn>=0)return{x:ox,y:oy,vx:vx,vy:vy,hit:false};
  var j=-(1+b.rest)*vn;
  return{x:ox,y:oy,vx:vx+j*nx,vy:vy+j*ny,hit:true};
}
/* ================= the 9 holes =================
   A designed course: easy opener, classics in the middle, a testing
   finish. Fixed order every day (it's a course), but obstacle speeds,
   phases, mound sizes and exact placements are date-seeded -- the
   same fresh challenge for everyone each day. */
var HOLE_DEFS=[
  {id:'firsttee',  name:'First Tee',    par:2},
  {id:'windmill',  name:'Windmill',     par:3},
  {id:'bankjob',   name:'Bank Job',     par:3},
  {id:'volcano',   name:'Volcano',      par:3},
  {id:'bumpers',   name:'Bumpers',      par:3},
  {id:'drawbridge',name:'Drawbridge',   par:3},
  {id:'ramp',      name:'The Ramp',     par:3},
  {id:'slalom',    name:'Slalom',       par:4},
  {id:'tunnel',    name:'Tunnel Vision',par:4}
];

function buildHole(rng,defIdx){
  var def=HOLE_DEFS[defIdx];
  var id=def.id;
  var spine,w,ball,cup,h,movers,bumpers,hazards,deco;
  movers=[];bumpers=[];hazards=[];deco={};
  var j1=function(a){return (rng()*2-1)*a;}; /* symmetric jitter */

  if(id==='firsttee'){
    /* the gentle opener: straight lane, faint uphill finish */
    spine=[[0,0],[38,0]];w=4.75;
    ball={x:5,y:0};cup={x:33,y:j1(1)};
    h=tiltField(0.004,0);
  }else if(id==='windmill'){
    /* the classic: four blades sweep the lane -- thread the gaps.
       blades stay well short of the rails so there's always room */
    spine=[[0,0],[46,0]];w=4.75;
    ball={x:5,y:0};cup={x:41,y:j1(1)};
    h=flatField();
    movers.push({type:'blade',cx:23,cy:0,len:2.6,wid:0.55,arms:4,
      omega:(0.8+rng()*0.25)*(rng()<0.5?1:-1),
      phase:rng()*Math.PI*2,rest:0.72});
    deco.windmill={cx:23};
  }else if(id==='bankjob'){
    /* dogleg left: the outer rail is your friend -- bank it round.
       lively rails make the bank shot sing */
    spine=[[0,0],[17,0],[21.5,2],[23.5,6.5],[24,11],[24,26]];w=4.75;
    ball={x:5,y:0};cup={x:24,y:21+j1(1)};
    h=flatField();
  }else if(id==='volcano'){
    /* a big cone sits mid-lane: go around, or die it over the top.
       the cone stays well inside the rails -- flat road around it */
    spine=[[0,0],[44,0]];w=5;
    ball={x:5,y:0};cup={x:38,y:j1(1)};
    var vh=1.05+rng()*0.25,vr=3.1+rng()*0.5;
    h=moundField(vh,vr,22,0);
    deco.crater={x:22,y:0,r:vr*0.35};
  }else if(id==='bumpers'){
    /* three lively bumpers staggered down the lane -- room to dodge */
    spine=[[0,0],[46,0]];w=4.75;
    ball={x:5,y:0};cup={x:41,y:j1(1)};
    h=flatField();
    bumpers.push({x:16,y:1.6+j1(0.4),r:1.15,rest:1.02});
    bumpers.push({x:24,y:-1.6+j1(0.4),r:1.15,rest:1.02});
    bumpers.push({x:32,y:1.6+j1(0.4),r:1.15,rest:1.02});
  }else if(id==='drawbridge'){
    /* a plank bridge over water: stay on the boards or re-hit.
       the deck is wide enough for an imperfect bounce */
    spine=[[0,0],[50,0]];w=4.75;
    ball={x:5,y:0};cup={x:45,y:j1(0.8)};
    h=flatField();
    var wx0=19,wx1=35;
    hazards.push({poly:[{x:wx0,y:-4.75},{x:wx1,y:-4.75},{x:wx1,y:-2.2},{x:wx0,y:-2.2}]});
    hazards.push({poly:[{x:wx0,y:2.2},{x:wx1,y:2.2},{x:wx1,y:4.75},{x:wx0,y:4.75}]});
    deco.bridge={x0:wx0,x1:wx1,hw:2.2};
  }else if(id==='ramp'){
    /* the lane climbs to an upper tier: bring enough pace */
    spine=[[0,0],[46,0]];w=4.75;
    ball={x:5,y:0};cup={x:40,y:j1(1)};
    h=addFields(
      stepField(0.85+rng()*0.15,5,24,0,1,0),
      tiltField(0.003,0));
    deco.rampEdge={x:24};
  }else if(id==='slalom'){
    /* two gates slide across the lane in opposite rhythm. each gate is
       SHORTER than the lane is wide, so a gap always slides with it */
    spine=[[0,0],[50,0]];w=5.5;
    ball={x:5,y:0};cup={x:45,y:j1(1)};
    h=flatField();
    movers.push({type:'gate',x1:18,y1:-3,x2:18,y2:3,ax:0,ay:1,
      amp:1.8+rng()*0.4,omega:0.85+rng()*0.25,phase:rng()*Math.PI*2,
      wid:0.7,rest:0.75});
    movers.push({type:'gate',x1:34,y1:-3,x2:34,y2:3,ax:0,ay:1,
      amp:1.8+rng()*0.4,omega:0.85+rng()*0.25,phase:rng()*Math.PI*2+Math.PI,
      wid:0.7,rest:0.75});
  }else{ /* tunnel */
    /* the finale: an S-lane, a dark tunnel, a mound guarding the cup.
       the mound guards -- it doesn't wall off */
    spine=[[0,0],[18,0],[30,10],[46,10]];w=4.75;
    ball={x:5,y:0};cup={x:43,y:10+j1(0.8)};
    h=addFields(moundField(0.5+rng()*0.15,2.4,37,10),tiltField(0.003,0.4));
    deco.tunnel={x:24,y:5};
  }

  var poly=lanePoly(spine,w);
  var wallSegs=polyWalls(poly,RAIL_REST);
  var xs=poly.map(function(p){return p.x;}),ys=poly.map(function(p){return p.y;});
  var d=dist2(ball.x,ball.y,cup.x,cup.y);
  return {
    idx:defIdx,id:id,name:def.name,par:def.par,
    poly:poly,wallSegs:wallSegs,spine:spine,w:w,
    ball:ball,cup:cup,dist:d,
    lineA:Math.atan2(cup.y-ball.y,cup.x-ball.x),
    h:h,movers:movers,bumpers:bumpers,hazards:hazards,deco:deco,
    bbox:{x0:Math.min.apply(null,xs),x1:Math.max.apply(null,xs),
          y0:Math.min.apply(null,ys),y1:Math.max.apply(null,ys)},
    seed:(rng()*1e9)|0
  };
}

/* the course: fixed order (it's a course), date-seeded obstacles */
function genHoles(seedStr){
  var rng=mulberry32(hashStr('puttputt|'+seedStr));
  var holes=[];
  for(var i=0;i<HOLE_DEFS.length;i++)holes.push(buildHole(rng,i));
  return holes;
}

/* Smarter default aim: follow the fairway's natural line instead of the
   straight ball->cup line (which on doglegs points into the inner rail).
   Walks D units along the spine from the ball's projection, then pulls the
   marker back out of any mover/bumper discs so it never starts inside an
   obstacle. The player can still move it freely. */
function spinePointAt(spine,sTarget){
  var s=0;
  for(var i=0;i<spine.length-1;i++){
    var ax=spine[i][0],ay=spine[i][1],bx=spine[i+1][0],by=spine[i+1][1];
    var L=Math.hypot(bx-ax,by-ay);
    if(sTarget<=s+L||i===spine.length-2){
      var t=L>1e-9?Math.max(0,Math.min(1,(sTarget-s)/L)):0;
      return{x:ax+(bx-ax)*t,y:ay+(by-ay)*t};
    }
    s+=L;
  }
  return{x:spine[spine.length-1][0],y:spine[spine.length-1][1]};
}
function defaultAim(h,bx,by){
  var s0=0,bestD=1e9,s=0,i,ax,ay,dx,dy,L2,t;
  for(i=0;i<h.spine.length-1;i++){
    ax=h.spine[i][0];ay=h.spine[i][1];
    dx=h.spine[i+1][0]-ax;dy=h.spine[i+1][1]-ay;L2=dx*dx+dy*dy||1e-9;
    t=Math.max(0,Math.min(1,((bx-ax)*dx+(by-ay)*dy)/L2));
    var px=ax+dx*t,py=ay+dy*t,d=Math.hypot(bx-px,by-py);
    if(d<bestD){bestD=d;s0=s+Math.sqrt(L2)*t;}
    s+=Math.sqrt(L2);
  }
  var distBC=Math.hypot(h.cup.x-bx,h.cup.y-by);
  var D=Math.max(12,Math.min(20,distBC*0.5));
  var m=spinePointAt(h.spine,Math.min(s0+D,Math.max(0,s-0.5)));
  /* keep the marker out of mover discs / bumpers: pull back toward ball */
  var mx=m.x,my=m.y;
  var ux=mx-bx,uy=my-by,Lm=Math.hypot(ux,uy)||1;ux/=Lm;uy/=Lm;
  function clearR(cx,cy,r){
    var d=Math.hypot(mx-cx,my-cy);
    if(d<r){
      var nl=Math.max(3,Lm-r-0.05);
      mx=bx+ux*nl;my=by+uy*nl;
      Lm=Math.hypot(mx-bx,my-by)||1;ux=(mx-bx)/Lm;uy=(my-by)/Lm;
    }
  }
  for(i=0;i<h.movers.length;i++){
    var mv=h.movers[i];
    if(mv.type==='blade')clearR(mv.cx,mv.cy,mv.len+1.2);
    else if(mv.type==='gate')clearR((mv.x1+mv.x2)/2,(mv.y1+mv.y2)/2,(mv.amp||0)+1.5);
  }
  for(i=0;i<h.bumpers.length;i++)clearR(h.bumpers[i].x,h.bumpers[i].y,h.bumpers[i].r+1.2);
  return{x:mx,y:my};
}

/* Generous tap region: the whole playable lane, including near-rail areas.
   inPoly alone wrongly rejects inside-lane points where the dogleg's offset
   polygon folds (even-odd rule), so also accept the spine-offset "capsule
   chain" (dist to spine <= half-width + margin), without extending past the
   spine ends where the rails stop. */
function laneOk(h,x,y){
  if(inPoly(x,y,h.poly))return true;
  var sp=h.spine,n=sp.length,lim=h.w+0.15;
  for(var i=0;i<n-1;i++){
    var ax=sp[i][0],ay=sp[i][1],bx=sp[i+1][0],by=sp[i+1][1];
    var dx=bx-ax,dy=by-ay,L2=dx*dx+dy*dy||1e-9;
    var t=((x-ax)*dx+(y-ay)*dy)/L2;
    if(i===0&&t<0)continue;
    if(i===n-2&&t>1)continue;
    var tc=t<0?0:(t>1?1:t);
    var ddx=x-(ax+dx*tc),ddy=y-(ay+dy*tc);
    if(ddx*ddx+ddy*ddy<=lim*lim)return true;
  }
  return false;
}

/* ================= physics sim (pure -- testable) =================
   Deterministic given (hole, aim, power, t0, puttSeed): movers are a
   pure function of hole-time, so the art can never disagree with the
   physics. t0 = hole-time (seconds) when the stroke starts. */
function simulate(hole,aimA,powerM,opts){
  opts=opts||{};
  var pureBonus=(opts.pure===true);
  var vCap=pureBonus?V_CAP*1.5:V_CAP;
  var cupR=pureBonus?CUP_R*1.15:CUP_R;
  var v0=Math.sqrt(2*FRICTION*DMAX*clamp(powerM,0,BAR_MAX));
  var sx=opts.from.x,sy=opts.from.y;
  var x=sx,y=sy;
  var vx=Math.cos(aimA)*v0,vy=Math.sin(aimA)*v0;
  var t0=opts.t0||0;
  var jrng=mulberry32((hole.seed^0x9e37)>>>0);
  var trail=[],t=0,steps=0,lipped=false;
  var walls=hole.wallSegs,bumpers=hole.bumpers,movers=hole.movers;
  while(steps++<240*14){
    var sp=Math.sqrt(vx*vx+vy*vy);
    if(sp<V_STOP)break;
    t+=DT;
    var T=t0+t;
    var g=gradOf(hole.h,x,y);
    var ax=-FRICTION*vx/sp - SLOPE_G*g.x;
    var ay=-FRICTION*vy/sp - SLOPE_G*g.y;
    vx+=ax*DT;vy+=ay*DT;
    sp=Math.sqrt(vx*vx+vy*vy);
    if(sp<V_STOP){vx=vy=0;break;}
    x+=vx*DT;y+=vy*DT;
    /* rails */
    var i,seg,c;
    for(i=0;i<walls.length;i++){
      c=collideSeg(x,y,vx,vy,walls[i]);
      if(c){x=c.x;y=c.y;vx=c.vx;vy=c.vy;}
    }
    /* moving obstacles at this exact stroke-time */
    for(i=0;i<movers.length;i++){
      var ms=moverSegs(movers[i],T);
      for(var k=0;k<ms.length;k++){
        c=collideSeg(x,y,vx,vy,ms[k]);
        if(c){x=c.x;y=c.y;vx=c.vx;vy=c.vy;}
      }
    }
    /* bumpers */
    for(i=0;i<bumpers.length;i++){
      c=collideBumper(x,y,vx,vy,bumpers[i]);
      if(c){x=c.x;y=c.y;vx=c.vx;vy=c.vy;}
    }
    /* safety net: never leave the lane -- bounce off the closest rail
       like a real rail instead of stalling */
    if(!inPoly(x,y,hole.poly)){
      var cp=closestOnPoly(x,y,hole.poly);
      var snx=cp.nx,sny=cp.ny;
      var snl=Math.sqrt(snx*snx+sny*sny);
      if(snl<1e-9){snx=1;sny=0;}else{snx/=snl;sny/=snl;}
      x=cp.x+snx*BALL_R;y=cp.y+sny*BALL_R;
      var svn=vx*snx+vy*sny;
      if(svn>0){var sj=-(1+RAIL_REST)*svn;vx+=sj*snx;vy+=sj*sny;}
    }
    if(trail.length===0||dist2(x,y,trail[trail.length-1].x,trail[trail.length-1].y)>0.8)
      trail.push({x:x,y:y,t:t});
    /* water: back to where the stroke started (the stroke counts) */
    if(inHazard(hole,x,y))
      return{hazard:true,x:sx,y:sy,trail:trail,t:t,from:{x:sx,y:sy}};
    var dc=dist2(x,y,hole.cup.x,hole.cup.y);
    var spd=Math.sqrt(vx*vx+vy*vy);
    if(dc<cupR){
      if(spd<vCap)return{holed:true,x:x,y:y,trail:trail,t:t,from:{x:sx,y:sy}};
      lipped=true;
      var nx3=(x-hole.cup.x)/(dc||1),ny3=(y-hole.cup.y)/(dc||1);
      var dot=vx*nx3+vy*ny3;
      var jit=(jrng()-0.5)*0.5;
      vx=(vx-1.6*dot*nx3)*0.62+(-ny3)*jit;
      vy=(vy-1.6*dot*ny3)*0.62+(nx3)*jit;
      x=hole.cup.x+nx3*(cupR+0.05);y=hole.cup.y+ny3*(cupR+0.05);
    }else if(dc<cupR*2.2&&spd<vCap*0.55){
      return{holed:true,x:hole.cup.x,y:hole.cup.y,trail:trail,t:t,from:{x:sx,y:sy}};
    }
  }
  return{holed:false,x:x,y:y,trail:trail,t:t,lipped:lipped,from:{x:sx,y:sy}};
}

/* One full stroke, pure: marker distance + aim + needle value + stroke
   start time -> outcome. puttSeed makes the overswing bend deterministic
   per putt; t0 is the hole-time at STOP (movers keep their clock). */
function resolveStroke(hole,ball,markerDist,aimA,n,t0,puttSeed){
  var grade=needleGrade(n);
  var power=needleToPower(n,markerDist);
  var bend=overswingBend(n,puttSeed);
  var res=simulate(hole,aimA+bend,power,{pure:grade==='PURE',from:ball,t0:t0});
  return{grade:grade,power:power,bend:bend,res:res};
}

/* post-putt decision: holed | pickup (6 reached) | splash | again */
function puttOutcome(puttsUsed,res){
  if(res.holed)return'holed';
  if(res.hazard)return'splash';
  if(puttsUsed>=6)return'pickup';
  return'again';
}

/* ================= scoring vs par ================= */
function scoreName(strokes,par){
  if(strokes===1)return'ACE';
  var d=strokes-par;
  if(d<=-2)return'EAGLE';
  if(d===-1)return'BIRDIE';
  if(d===0)return'PAR';
  if(d===1)return'BOGEY';
  if(d===2)return'DOUBLE BOGEY';
  if(d===3)return'TRIPLE BOGEY';
  return(d>0?'+'+d:''+d);
}
function fmtVsPar(d){return d===0?'E':(d>0?'+'+d:''+d);}
/* ================= rendering ================= */
var canvas=(typeof document!=='undefined')?document.getElementById('game'):null;
var ctx=canvas?canvas.getContext('2d'):null;
var cw=0,ch=0;
function resize(){
  if(!canvas)return;
  var dpr=Math.min(2,window.devicePixelRatio||1);
  cw=window.innerWidth;ch=window.innerHeight;
  canvas.width=Math.round(cw*dpr);canvas.height=Math.round(ch*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  if(G.holes.length&&G.hole<9){
    fitStatic(G.holes[G.hole]);buildShade(G.holes[G.hole]);
  }
}

/* STATIC camera: the whole hole always fits on screen. Ball and cup
   are always visible together. Nothing pans, nothing zooms mid-putt. */
var PANEL_H=160,TOP_H=110;
var cam={scale:1,ox:0,oy:0,vcx:0,vcy:0};
function fitStatic(hole){
  var bb=hole.bbox,pad=6;
  var vx0=10,vx1=cw-10,vy0=TOP_H+10,vy1=ch-PANEL_H-10;
  var wcx=(bb.x0+bb.x1)/2,wcy=(bb.y0+bb.y1)/2;
  var hw=(bb.x1-bb.x0)/2+pad,hh=(bb.y1-bb.y0)/2+pad;
  cam.scale=Math.min((vx1-vx0)/(2*hw),(vy1-vy0)/(2*hh));
  cam.ox=wcx;cam.oy=wcy;
  cam.vcx=(vx0+vx1)/2;cam.vcy=(vy0+vy1)/2;
}
function w2s(x,y){return{x:(x-cam.ox)*cam.scale+cam.vcx,y:(y-cam.oy)*cam.scale+cam.vcy};}
function s2w(sx,sy){return{x:(sx-cam.vcx)/cam.scale+cam.ox,y:(sy-cam.vcy)/cam.scale+cam.oy};}

function pathOf(poly){
  ctx.beginPath();
  for(var i=0;i<poly.length;i++){
    var p=w2s(poly[i].x,poly[i].y);
    if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);
  }
  ctx.closePath();
}
function roundRectP(x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}
function segPath(x1,y1,x2,y2){
  var a=w2s(x1,y1),b=w2s(x2,y2);
  ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
}

var nowS=0;

/* ---- obstacle drawing (movers drawn at hole-time T) ---- */
function drawWindmill(hole,T){
  var d=hole.deco.windmill;if(!d)return;
  var mv=hole.movers[0];
  var c=w2s(mv.cx,mv.cy);
  /* posts at the lane edges */
  ctx.fillStyle='#5d3a17';
  var pw=Math.max(6,cam.scale*0.35);
  [-1,1].forEach(function(s){
    var p=w2s(mv.cx,mv.cy+s*(hole.w+0.9));
    ctx.fillRect(p.x-pw/2,p.y-pw*1.6,pw,pw*3.2);
  });
  /* crossbar */
  var p0=w2s(mv.cx,mv.cy-(hole.w+0.9)),p1=w2s(mv.cx,mv.cy+(hole.w+0.9));
  ctx.strokeStyle='#5d3a17';ctx.lineWidth=pw;
  ctx.beginPath();ctx.moveTo(p0.x,p0.y);ctx.lineTo(p1.x,p1.y);ctx.stroke();
  /* blades */
  for(var b=0;b<mv.arms;b++){
    var a=mv.phase+mv.omega*T+b*2*Math.PI/mv.arms;
    var tip=w2s(mv.cx+Math.cos(a)*mv.len,mv.cy+Math.sin(a)*mv.len);
    ctx.lineCap='round';
    ctx.strokeStyle='#b91c1c';ctx.lineWidth=Math.max(8,mv.wid*cam.scale);
    ctx.beginPath();ctx.moveTo(c.x,c.y);ctx.lineTo(tip.x,tip.y);ctx.stroke();
    ctx.strokeStyle='#f8fafc';ctx.lineWidth=Math.max(3,mv.wid*cam.scale*0.35);
    ctx.beginPath();ctx.moveTo(c.x,c.y);ctx.lineTo(tip.x,tip.y);ctx.stroke();
  }
  /* hub */
  ctx.fillStyle='#fbbf24';
  ctx.beginPath();ctx.arc(c.x,c.y,Math.max(7,cam.scale*0.4),0,Math.PI*2);ctx.fill();
  ctx.strokeStyle='#92400e';ctx.lineWidth=2.5;
  ctx.beginPath();ctx.arc(c.x,c.y,Math.max(7,cam.scale*0.4),0,Math.PI*2);ctx.stroke();
}
function drawGates(hole,T){
  for(var i=0;i<hole.movers.length;i++){
    var mv=hole.movers[i];
    if(mv.type!=='gate')continue;
    var segs=moverSegs(mv,T),s=segs[0];
    /* striped bar: alternate red/white along its length */
    var len=dist2(s.x1,s.y1,s.x2,s.y2);
    var n=Math.max(6,Math.round(len/1.2));
    for(var k=0;k<n;k++){
      var t0=k/n,t1=(k+1)/n;
      segPath(lerp(s.x1,s.x2,t0),lerp(s.y1,s.y2,t0),lerp(s.x1,s.x2,t1),lerp(s.y1,s.y2,t1));
      ctx.strokeStyle=k%2?'#f8fafc':'#dc2626';
      ctx.lineWidth=Math.max(10,mv.wid*cam.scale*1.6);
      ctx.lineCap='butt';ctx.stroke();
    }
    /* end caps */
    var e1=w2s(s.x1,s.y1),e2=w2s(s.x2,s.y2);
    ctx.fillStyle='#7f1d1d';
    ctx.beginPath();ctx.arc(e1.x,e1.y,Math.max(6,cam.scale*0.3),0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(e2.x,e2.y,Math.max(6,cam.scale*0.3),0,Math.PI*2);ctx.fill();
  }
}
function drawBumpers(hole){
  for(var i=0;i<hole.bumpers.length;i++){
    var b=hole.bumpers[i],c=w2s(b.x,b.y),r=Math.max(10,b.r*cam.scale);
    ctx.fillStyle='#dc2626';
    ctx.beginPath();ctx.arc(c.x,c.y,r,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#f8fafc';
    ctx.beginPath();ctx.arc(c.x,c.y,r*0.55,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#dc2626';
    ctx.beginPath();ctx.arc(c.x,c.y,r*0.28,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='#7f1d1d';ctx.lineWidth=2.5;
    ctx.beginPath();ctx.arc(c.x,c.y,r,0,Math.PI*2);ctx.stroke();
  }
}
function drawBridge(hole){
  var br=hole.deco.bridge;if(!br)return;
  for(var x=br.x0;x<br.x1;x+=1.5){
    var p0=w2s(x, -br.hw),p1=w2s(x+1.1, br.hw);
    ctx.fillStyle='#8b5a2b';
    ctx.fillRect(p0.x,p0.y,p1.x-p0.x,p1.y-p0.y);
    ctx.strokeStyle='#5d3a17';ctx.lineWidth=1.5;
    ctx.strokeRect(p0.x,p0.y,p1.x-p0.x,p1.y-p0.y);
  }
}
function drawTunnel(hole){
  var tn=hole.deco.tunnel;if(!tn)return;
  /* stone arch straddling the lane */
  var c=w2s(tn.x,tn.y),rw=(hole.w+1.2)*cam.scale,rh=(hole.w+1.2)*cam.scale*1.15;
  ctx.fillStyle='#6b7280';
  ctx.beginPath();ctx.ellipse(c.x,c.y,rw,rh,0,Math.PI,0);ctx.fill();
  ctx.fillStyle='#1f2937';
  ctx.beginPath();ctx.ellipse(c.x,c.y+rh*0.12,rw*0.72,rh*0.72,0,Math.PI,0);ctx.fill();
  ctx.strokeStyle='#4b5563';ctx.lineWidth=3;
  ctx.beginPath();ctx.ellipse(c.x,c.y,rw,rh,0,Math.PI,0);ctx.stroke();
}
function drawCrater(hole){
  var cr=hole.deco.crater;if(!cr)return;
  var c=w2s(cr.x,cr.y),r=Math.max(8,cr.r*cam.scale);
  ctx.fillStyle='rgba(90,50,20,0.85)';
  ctx.beginPath();ctx.ellipse(c.x,c.y,r,r*0.8,0,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle='rgba(60,32,12,0.9)';ctx.lineWidth=3;
  ctx.beginPath();ctx.ellipse(c.x,c.y,r,r*0.8,0,0,Math.PI*2);ctx.stroke();
}

/* the aim marker: tap to drop it, line shows ball->marker with power
   notches (25/50/75% of pure power); gold ring + distance pill */
function drawAim(hole){
  if(!G.markerSet)return;
  if(G.phase!=='aim'&&G.phase!=='locked')return;
  var locked=(G.phase==='locked');
  var bs=w2s(G.ballX,G.ballY),ms=w2s(G.markerX,G.markerY);
  ctx.lineCap='round';
  ctx.strokeStyle=locked?'rgba(120,70,0,0.6)':'rgba(15,40,25,0.55)';
  ctx.lineWidth=7;
  ctx.beginPath();ctx.moveTo(bs.x,bs.y);ctx.lineTo(ms.x,ms.y);ctx.stroke();
  ctx.strokeStyle=locked?'#fbbf24':'#ffffff';
  ctx.lineWidth=3.5;
  ctx.beginPath();ctx.moveTo(bs.x,bs.y);ctx.lineTo(ms.x,ms.y);ctx.stroke();
  var md0=dist2(G.ballX,G.ballY,G.markerX,G.markerY);
  if(md0>0.5){
    var ux=(G.markerX-G.ballX)/md0,uy=(G.markerY-G.ballY)/md0;
    var px0=-uy,py0=ux;
    var hl=Math.max(7,cam.scale*0.35);
    [0.25,0.5,0.75].forEach(function(f){
      var sp=w2s(G.ballX+ux*md0*f,G.ballY+uy*md0*f);
      ctx.strokeStyle='rgba(15,40,25,0.65)';ctx.lineWidth=5;
      ctx.beginPath();
      ctx.moveTo(sp.x-px0*hl,sp.y-py0*hl);ctx.lineTo(sp.x+px0*hl,sp.y+py0*hl);
      ctx.stroke();
      ctx.strokeStyle='#ffffff';ctx.lineWidth=2.5;
      ctx.beginPath();
      ctx.moveTo(sp.x-px0*hl,sp.y-py0*hl);ctx.lineTo(sp.x+px0*hl,sp.y+py0*hl);
      ctx.stroke();
    });
  }
  var mr=Math.max(9,cam.scale*0.45);
  ctx.strokeStyle='#b45309';ctx.lineWidth=4;
  ctx.beginPath();ctx.arc(ms.x,ms.y,mr,0,Math.PI*2);ctx.stroke();
  ctx.fillStyle=locked?'#fbbf24':'#ffffff';
  ctx.beginPath();ctx.arc(ms.x,ms.y,mr*0.35,0,Math.PI*2);ctx.fill();
  var d=dist2(G.ballX,G.ballY,G.markerX,G.markerY);
  var lbl=Math.round(d)+' FT';
  ctx.font='800 13px -apple-system,sans-serif';
  var tw=ctx.measureText(lbl).width;
  var lx=ms.x+mr+8,ly=ms.y-mr-8;
  ctx.fillStyle='rgba(17,24,39,0.88)';
  roundRectP(lx-9,ly-14,tw+18,26,9);ctx.fill();
  ctx.fillStyle='#ffffff';ctx.textAlign='left';
  ctx.fillText(lbl,lx,ly+5);
}

/* slope % badge near the ball (the green-reading aid) */
function drawSlopeBadge(hole){
  if(G.phase!=='aim'&&G.phase!=='locked')return;
  var si=slopeInfo(hole.h,G.ballX,G.ballY);
  var s=w2s(G.ballX,G.ballY);
  ctx.font='800 13px -apple-system,sans-serif';
  var txt=si.flat?'FLAT':si.pct.toFixed(1)+'%';
  var tw=ctx.measureText(txt).width;
  var bw=tw+(si.flat?18:40);
  var bx=s.x-bw/2,by=s.y-52;
  if(by<TOP_H+34)by=s.y+30;
  ctx.fillStyle='rgba(17,24,39,0.88)';
  roundRectP(bx,by,bw,26,9);ctx.fill();
  var tx=bx+9;
  if(!si.flat){
    var ang=Math.atan2(si.dy,si.dx);
    ctx.save();ctx.translate(bx+16,by+13);ctx.rotate(ang);
    ctx.strokeStyle='#7dd3fc';ctx.lineWidth=3;ctx.lineCap='round';
    ctx.beginPath();ctx.moveTo(-7,0);ctx.lineTo(7,0);
    ctx.moveTo(3,-4);ctx.lineTo(7,0);ctx.lineTo(3,4);ctx.stroke();
    ctx.restore();
    tx=bx+28;
  }
  ctx.fillStyle=si.flat?'#a7f3d0':'#ffffff';ctx.textAlign='left';
  ctx.fillText(txt,tx,by+18);
}

/* hillshade canvas, baked once per hole */
var shadeCv=null,shadeMeta=null;
function buildShade(hole){
  if(!ctx)return;
  var bb=hole.bbox,pad=4;
  var wWorld=(bb.x1-bb.x0)+2*pad,hWorld=(bb.y1-bb.y0)+2*pad;
  var longPx=Math.max(wWorld,hWorld)*cam.scale;
  var sf=Math.min(1,420/Math.max(1,longPx));
  var W=Math.max(64,Math.round(wWorld*cam.scale*sf));
  var H=Math.max(64,Math.round(hWorld*cam.scale*sf));
  var sg=shadeGrid(hole,W,H);
  var cv=document.createElement('canvas');cv.width=W;cv.height=H;
  var c2=cv.getContext('2d');
  var img=c2.createImageData(W,H),dd=img.data;
  for(var i=0;i<W*H;i++){
    dd[i*4]=sg.data[i*3];dd[i*4+1]=sg.data[i*3+1];dd[i*4+2]=sg.data[i*3+2];dd[i*4+3]=255;
  }
  c2.putImageData(img,0,0);
  shadeCv=cv;
  shadeMeta={x0:sg.x0,y0:sg.y0,w:wWorld,h:hWorld};
}

function drawHole(hole,state){
  var T=state.moverT||0;
  /* night-mini-golf backdrop */
  var bg=ctx.createLinearGradient(0,0,0,ch);
  bg.addColorStop(0,'#0e4d2c');bg.addColorStop(1,'#082a18');
  ctx.fillStyle=bg;ctx.fillRect(0,0,cw,ch);

  /* felt lane with baked hillshade */
  ctx.save();
  pathOf(hole.poly);
  ctx.fillStyle='#3f9e4f';ctx.fill();
  ctx.clip();
  if(shadeCv&&shadeMeta){
    var sh0=w2s(shadeMeta.x0,shadeMeta.y0);
    ctx.drawImage(shadeCv,sh0.x,sh0.y,shadeMeta.w*cam.scale,shadeMeta.h*cam.scale);
  }
  ctx.restore();

  /* wooden rails */
  pathOf(hole.poly);
  ctx.lineJoin='round';
  ctx.strokeStyle='#5d3a17';ctx.lineWidth=Math.max(13,cam.scale*0.7);ctx.stroke();
  pathOf(hole.poly);
  ctx.strokeStyle='#8b5a2b';ctx.lineWidth=Math.max(9,cam.scale*0.45);ctx.stroke();

  /* water hazards (drawn over the felt, inside the rails) */
  for(var hi2=0;hi2<hole.hazards.length;hi2++){
    pathOf(hole.hazards[hi2].poly);
    ctx.fillStyle='#1d4ed8';ctx.fill();
    ctx.strokeStyle='rgba(147,197,253,0.7)';ctx.lineWidth=2;
    for(var wy=0;wy<3;wy++){
      var wp=w2s(hole.hazards[hi2].poly[0].x+2, (hole.hazards[hi2].poly[0].y+hole.hazards[hi2].poly[2].y)/2 + (wy-1)*1.1);
      ctx.beginPath();ctx.arc(wp.x,wp.y,6,0.3,Math.PI-0.3);ctx.stroke();
    }
  }

  /* start pad */
  var sp0=w2s(hole.ball.x,hole.ball.y);
  ctx.fillStyle='rgba(20,40,25,0.55)';
  ctx.beginPath();ctx.arc(sp0.x,sp0.y,Math.max(12,cam.scale*0.7),0,Math.PI*2);ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,0.5)';ctx.lineWidth=2;
  ctx.beginPath();ctx.arc(sp0.x,sp0.y,Math.max(12,cam.scale*0.7),0,Math.PI*2);ctx.stroke();

  /* obstacles under the ball */
  drawBridge(hole);
  drawTunnel(hole);
  drawCrater(hole);
  drawBumpers(hole);
  drawGates(hole,T);
  drawWindmill(hole,T);

  /* cup: dark, gold pulse ring, tall flag */
  var cp=w2s(hole.cup.x,hole.cup.y);
  var cupRpx=Math.max(10,CUP_R*cam.scale*1.35);
  var pulse=0.5+0.5*Math.sin(nowS*3.4);
  ctx.strokeStyle='rgba(255,205,60,'+(0.45+0.35*pulse).toFixed(3)+')';
  ctx.lineWidth=3.5;
  ctx.beginPath();ctx.arc(cp.x,cp.y,cupRpx+7+5*pulse,0,Math.PI*2);ctx.stroke();
  var cg=ctx.createRadialGradient(cp.x-2,cp.y-2,1,cp.x,cp.y,cupRpx);
  cg.addColorStop(0,'#232b3d');cg.addColorStop(1,'#04060a');
  ctx.fillStyle=cg;ctx.beginPath();ctx.arc(cp.x,cp.y,cupRpx,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,0.85)';ctx.lineWidth=2.5;
  ctx.beginPath();ctx.arc(cp.x,cp.y,cupRpx,0,Math.PI*2);ctx.stroke();
  var fh=cupRpx*6.4;
  ctx.strokeStyle='#7f1a1a';ctx.lineWidth=Math.max(3.5,cam.scale*0.16);ctx.lineCap='round';
  ctx.beginPath();ctx.moveTo(cp.x,cp.y);ctx.lineTo(cp.x,cp.y-fh);ctx.stroke();
  var wave=(state.holed&&state.holeT<1.4)?Math.sin(state.holeT*14)*(1-state.holeT/1.4)*cupRpx*0.9:0;
  ctx.fillStyle='#e23b3b';
  ctx.beginPath();ctx.moveTo(cp.x,cp.y-fh);
  ctx.lineTo(cp.x+cupRpx*3.1,cp.y-fh+cupRpx*1.0+wave);
  ctx.lineTo(cp.x,cp.y-fh+cupRpx*2.0);ctx.closePath();ctx.fill();

  /* aim marker + line */
  drawAim(hole);
  /* slope badge */
  drawSlopeBadge(hole);

  /* ball trail */
  if(state.trail&&state.trail.length>1){
    ctx.fillStyle='rgba(255,255,255,0.65)';
    for(var t2=0;t2<state.trail.length;t2+=2){
      var tp=w2s(state.trail[t2].x,state.trail[t2].y);
      ctx.beginPath();ctx.arc(tp.x,tp.y,2.2,0,Math.PI*2);ctx.fill();
    }
  }

  /* ball */
  if(!state.holed){
    var bp2=w2s(state.ballX,state.ballY);
    var brpx=Math.max(6,BALL_R*cam.scale)*(state.ballScale==null?1:state.ballScale);
    ctx.fillStyle='rgba(0,0,0,0.28)';
    ctx.beginPath();ctx.ellipse(bp2.x+2,bp2.y+brpx*0.55,brpx*0.95,brpx*0.4,0,0,Math.PI*2);ctx.fill();
    var bgr=ctx.createRadialGradient(bp2.x-brpx*0.3,bp2.y-brpx*0.35,brpx*0.1,bp2.x,bp2.y,brpx);
    bgr.addColorStop(0,'#ffffff');bgr.addColorStop(1,'#cfd6da');
    ctx.fillStyle=bgr;ctx.beginPath();ctx.arc(bp2.x,bp2.y,brpx,0,Math.PI*2);ctx.fill();
  }

  /* confetti */
  if(state.parts&&state.parts.length){
    for(var pi2=0;pi2<state.parts.length;pi2++){
      var pt2=state.parts[pi2];
      ctx.save();ctx.translate(pt2.x,pt2.y);ctx.rotate(pt2.rot);
      ctx.globalAlpha=Math.max(0,Math.min(1,pt2.life/0.4));
      ctx.fillStyle=pt2.c;ctx.fillRect(-3,-2,6,4);
      ctx.restore();
    }
    ctx.globalAlpha=1;
  }

  /* hole name + par + distance */
  ctx.fillStyle='rgba(255,255,255,0.92)';
  ctx.font='800 13px -apple-system,sans-serif';ctx.textAlign='left';
  var labelY=ch-PANEL_H-24;
  if(state.phase==='sweep')labelY-=110;
  ctx.fillText(hole.name.toUpperCase()+'  \u2022  PAR '+hole.par+'  \u2022  '+Math.round(hole.dist)+' FT',14,labelY);
}
/* ================= game state / flow ================= */
var LEADERBOARD_URL='https://script.google.com/macros/s/AKfycbweCdB91evaNssQ8DwTslFAvNuwho8ivWnPsf5j29MVfXezYoWUFGatJ3cXqKBVUxTmsg/exec';
var GAME_ID='daily-putt-putt';
var LS='dailyputtputt.v2';

function $(id){return (typeof document!=='undefined')?document.getElementById(id):null;}
var holeLabel=$('holeLabel'),modeTag=$('modeTag'),
    scoreStrip=$('scoreStrip'),
    phaseHint=$('phaseHint'),phaseBtn=$('phaseBtn'),
    resultLine=$('resultLine'),
    timerPill=$('timerPill'),timerNum=$('timerNum'),
    needleBar=$('needleBar'),needleEl=$('needle'),
    tickLayer=$('tickLayer'),tickLabels=$('tickLabels'),
    startScreen=$('startScreen'),playBtn=$('playBtn'),
    practiceBtn=$('practiceBtn'),lockBox=$('lockBox'),
    lockTime=$('lockTime'),lockScore=$('lockScore'),
    nameScreen=$('nameScreen'),nameInput=$('nameInput'),
    phraseInput=$('phraseInput'),phraseWrap=$('phraseWrap'),
    nameMsg=$('nameMsg'),nameGo=$('nameGo'),
    nameSub=$('nameSub'),nameBtn=$('nameBtn'),
    boardBtn=$('boardBtn'),
    resultsScreen=$('resultsScreen'),resTitle=$('resTitle'),
    resScore=$('resScore'),lbTitle=$('lbTitle'),
    lbList=$('lbList'),histList=$('histList'),
    logoutBtn=$('logoutBtn'),resultsClose=$('resultsClose');

var G={
  mode:'daily', holes:[], hole:0,
  putts:0,               /* putts taken on the current hole (cap 6) */
  phase:'idle',            /* aim | locked | sweep | roll | drop | done */
  markerX:0, markerY:0, markerSet:false,
  ballX:0, ballY:0, trail:[], holed:false, holeT:0,
  ballScale:null,
  dropT:0, dropFrom:null,
  parts:[],
  results:[],              /* per hole: {putts} */
  rolling:null,
  needle:0, sweepT0:null,
  holeT:null,              /* ms timestamp: hole clock starts (movers) */
  holeElapsed:0,           /* seconds since hole start (mover clock) */
  aimElapsed:0,            /* seconds spent aiming this putt */
  strokeT0:0,              /* hole-time when the current stroke started */
  seedStr:''
};

function fmtDist(ft){
  var inch=Math.round(ft*12);
  if(inch<12)return inch+'"';
  return Math.floor(inch/12)+"'"+(inch%12)+'"';
}

/* scorecard strip: each tile shows PAR on top and the player's score on
   the bottom (0 until the hole is played, then their strokes, colored
   vs par); live vs-par total */
function renderStrip(){
  var html='',strokes=0,parSum=0;
  for(var i=0;i<9;i++){
    var g=G.holes[i],r=G.results[i];
    var cls='scell'+(i===G.hole?' cur':'');
    var score=0;
    if(r){
      strokes+=r.putts;parSum+=g.par;
      var d=r.putts-g.par;
      cls+=d<0?' under':(d>0?' over':' even');
      score=r.putts;
    }else if(i===G.hole){
      score=G.putts;
    }
    html+='<div class="'+cls+'"><div class="n">'+(i+1)+'</div>'+
      '<div class="p">PAR '+g.par+'</div><div class="s">'+score+'</div></div>';
  }
  scoreStrip.innerHTML=html;
  var diff=strokes-parSum;
  holeLabel.textContent=(G.hole<9?('HOLE '+(G.hole+1)+' / 9'):'DONE')+'  \u2022  '+fmtVsPar(diff);
}

function startRound(mode){
  G.mode=mode;
  G.seedStr=mode==='daily'?dateStr():'prac|'+Date.now();
  G.holes=genHoles(G.seedStr);
  G.hole=0;G.results=[];
  modeTag.textContent=mode==='daily'?'DAILY':'PRACTICE';
  modeTag.className=mode==='daily'?'':'prac';
  startScreen.classList.add('hidden');
  needleBar.classList.add('hidden');
  startHole();
}

function startHole(){
  var h=G.holes[G.hole];
  fitStatic(h);
  buildShade(h);
  G.phase='aim';
  var _da0=defaultAim(h,h.ball.x,h.ball.y);
  G.markerX=_da0.x;G.markerY=_da0.y;G.markerSet=true;
  G.ballX=h.ball.x;G.ballY=h.ball.y;
  G.putts=0;
  G.trail=[];G.holed=false;G.holeT=0;G.rolling=null;
  G.needle=0;G.sweepT0=null;
  G.holeElapsed=0;G.strokeT0=0;
  needleBar.classList.add('hidden');
  clearTicks();
  startAimTimer();
  setBtn('lock');
  phaseHint.textContent='Tap the green to place the marker \u00B7 7s, then it auto-locks';
  resultLine.classList.add('hidden');
  renderStrip();
}

/* 7-second aim timer: accumulates only while aiming (rAF halts in
   background tabs, so the timer can't steal an aim while hidden) */
function startAimTimer(){
  G.aimElapsed=0;
  timerPill.classList.remove('hidden');
  timerPill.classList.remove('low');
  timerNum.textContent=AIM_SECS;
}
function stopAimTimer(){timerPill.classList.add('hidden');}
function lockAim(){
  if(G.phase!=='aim'||!G.markerSet)return;
  G.phase='locked';
  stopAimTimer();
  setBtn('putt');
  phaseHint.textContent='Line locked \u2014 press PUTT, then STOP in the gold.';
}

function setBtn(kind){
  phaseBtn.classList.remove('hidden');
  phaseBtn.classList.remove('stop');
  if(kind==='lock')phaseBtn.textContent='LOCK THE LINE';
  else if(kind==='putt')phaseBtn.textContent='PUTT';
  else if(kind==='stop'){phaseBtn.textContent='STOP';phaseBtn.classList.add('stop');}
  else if(kind==='next')phaseBtn.textContent=G.hole<8?'Next hole':'See results';
  else phaseBtn.classList.add('hidden');
}

/* tap/drag placement: marker floats above the fingertip on touch */
var dragging=false,dragOff=0;
function placeMarkerAt(cx,cy,offPx){
  var h=G.holes[G.hole];
  var offs=offPx?[offPx,32,16,0]:[0];
  for(var i=0;i<offs.length;i++){
    var w=s2w(cx,cy-offs[i]);
    if(!laneOk(h,w.x,w.y))continue;
    if(dist2(w.x,w.y,G.ballX,G.ballY)<1.5)continue;
    G.markerX=w.x;G.markerY=w.y;G.markerSet=true;
    return true;
  }
  return false;
}
if(canvas){
canvas.addEventListener('pointerdown',function(e){
  if(G.phase==='aim'){
    dragging=true;dragOff=(e.pointerType==='mouse')?0:48;
    placeMarkerAt(e.clientX,e.clientY,dragOff);
  }else if(G.phase==='locked'){
    G.phase='aim';
    dragging=true;dragOff=(e.pointerType==='mouse')?0:48;
    placeMarkerAt(e.clientX,e.clientY,dragOff);
    startAimTimer();
    setBtn('lock');
    phaseHint.textContent='Tap the green to place the marker \u00B7 7s, then it auto-locks';
  }
});
canvas.addEventListener('pointermove',function(e){
  if(dragging&&G.phase==='aim')placeMarkerAt(e.clientX,e.clientY,dragOff);
});
var endDrag=function(){dragging=false;};
canvas.addEventListener('pointerup',endDrag);
canvas.addEventListener('pointercancel',endDrag);
if(typeof window!=='undefined')window.addEventListener('resize',resize);
}

/* distance calibration ticks on the needle bar */
function buildTicks(){
  var md=dist2(G.ballX,G.ballY,G.markerX,G.markerY);
  tickLayer.innerHTML='';tickLabels.innerHTML='';
  [0.25,0.5,0.75].forEach(function(f){
    var n=f*PURE_MID;
    var tk=document.createElement('div');
    tk.className='tick';tk.style.left=n+'%';
    tickLayer.appendChild(tk);
    var lb=document.createElement('div');
    lb.className='tickLab';lb.style.left=n+'%';
    lb.textContent='\u2248'+Math.round(md*f)+"'";
    tickLabels.appendChild(lb);
  });
}
function clearTicks(){tickLayer.innerHTML='';tickLabels.innerHTML='';}

/* ---- the action button: LOCK THE LINE -> PUTT -> STOP -> next ---- */
if(phaseBtn)phaseBtn.addEventListener('click',function(){
  if(G.phase==='aim'){lockAim();}
  else if(G.phase==='locked'){
    G.phase='sweep';
    G.sweepT0=null;G.needle=0;
    needleBar.classList.remove('hidden');
    buildTicks();
    setBtn('stop');
    phaseHint.textContent='STOP in the gold \u2014 just under 100!';
  }else if(G.phase==='sweep'){
    doStop();
  }else if(G.phase==='done'){
    nextHole();
  }
});

function doStop(){
  if(G.phase!=='sweep')return;
  var n=G.needle;
  needleBar.classList.add('hidden');
  clearTicks();
  var h=G.holes[G.hole];
  var sx=G.ballX,sy=G.ballY;
  var markerDist=dist2(sx,sy,G.markerX,G.markerY);
  var aimA=Math.atan2(G.markerY-sy,G.markerX-sx);
  var seed=hashStr(G.seedStr+'|'+G.hole+'|'+G.putts);
  var t0=G.holeElapsed; /* movers keep their clock: art == physics */
  var st=resolveStroke(h,{x:sx,y:sy},markerDist,aimA,n,t0,seed);
  G.putts++;
  G.strokeT0=t0;
  G.phase='roll';G.trail=[];
  G.rolling={res:st.res,grade:st.grade,bend:st.bend,t:0,shown:0,
    sx:sx,sy:sy,ax:Math.cos(aimA),ay:Math.sin(aimA)};
  setBtn('hide');
  phaseHint.textContent='Rolling\u2026';
  resultLine.classList.add('hidden');
}

function settleStroke(){
  var h=G.holes[G.hole],rr=G.rolling,r=rr.res,grade=rr.grade;
  G.ballX=r.x;G.ballY=r.y;
  G.phase='done';G.holed=r.holed;G.holeT=0.001;
  var gc=grade==='PURE'?'g-pure':grade==='OVERSWING'?'g-over':'g-ease';
  var gradeHtml='<span class="grade '+gc+'">'+grade+'</span>';
  if(r.hazard){
    /* SPLASH: back to where the stroke started, the stroke counts */
    G.phase='aim';
    var _da1=defaultAim(h,G.ballX,G.ballY);
    G.markerX=_da1.x;G.markerY=_da1.y;G.markerSet=true;
    G.trail=[];G.rolling=null;
    resultLine.innerHTML='<span class="grade g-splash">SPLASH</span>Re-hit from here \u2014 PUTT '+(G.putts+1)+' OF 6';
    resultLine.classList.remove('hidden');
    startAimTimer();
    setBtn('lock');
    phaseHint.textContent='Tap the green to place the marker \u00B7 7s, then it auto-locks';
    renderStrip();
    return;
  }
  if(r.holed){
    G.results[G.hole]={putts:G.putts};
    var cs=w2s(h.cup.x,h.cup.y);
    var crng=mulberry32((Date.now()^0x5f3d)>>>0);
    var cols=['#ffd23c','#ffffff','#22c55e','#e23b3b'];
    for(var ci=0;ci<16;ci++){
      var ca=crng()*Math.PI*2,csp=60+crng()*170;
      G.parts.push({x:cs.x,y:cs.y,vx:Math.cos(ca)*csp,vy:Math.sin(ca)*csp-130,
        rot:crng()*6.28,vr:(crng()-0.5)*14,life:0.85,c:cols[ci%4]});
    }
    var nm=scoreName(G.putts,h.par);
    resultLine.innerHTML=gradeHtml+'HOLE '+(G.hole+1)+' IN '+G.putts+' \u00B7 '+nm;
    showNextHoleUI();
    return;
  }
  if(G.putts>=6){
    G.results[G.hole]={putts:6};
    resultLine.innerHTML=gradeHtml+'PICKED UP \u00B7 6';
    showNextHoleUI();
    return;
  }
  var dft=dist2(r.x,r.y,h.cup.x,h.cup.y);
  var detail;
  var proj=(r.x-rr.sx)*rr.ax+(r.y-rr.sy)*rr.ay;
  var need=dist2(rr.sx,rr.sy,h.cup.x,h.cup.y);
  var dtxt=fmtDist(dft);
  if(proj<need-1)detail=dtxt+' SHORT';
  else if(proj>need+1)detail=dtxt+' PAST';
  else{
    var lat=(r.x-rr.sx)*(-rr.ay)+(r.y-rr.sy)*(rr.ax);
    detail=dtxt+(lat>0.5?' RIGHT':(lat<-0.5?' LEFT':''));
  }
  var bendTxt='';
  if(grade==='OVERSWING'&&rr.bend!==0){
    var bdeg=Math.round(Math.abs(rr.bend)*180/Math.PI);
    var lat2=(r.x-rr.sx)*(-rr.ay)+(r.y-rr.sy)*(rr.ax);
    bendTxt=' \u00D7 '+bdeg+'\u00B0 '+(lat2>=0?'PUSH':'PULL');
  }
  resultLine.innerHTML=gradeHtml+detail+bendTxt;
  resultLine.classList.remove('hidden');
  G.phase='aim';
  var _da2=defaultAim(h,G.ballX,G.ballY);
  G.markerX=_da2.x;G.markerY=_da2.y;G.markerSet=true;
  G.trail=[];G.rolling=null;
  startAimTimer();
  setBtn('lock');
  phaseHint.textContent='PUTT '+(G.putts+1)+' OF 6 \u2014 tap to move the marker \u00B7 7s, then it auto-locks';
  renderStrip();
}

function showNextHoleUI(){
  resultLine.classList.remove('hidden');
  phaseHint.textContent=G.hole<8?'On to the next hole.':'That\u2019s all nine.';
  setBtn('next');
  renderStrip();
  if(G.mode==='daily'){
    var st=load();st.days[G.seedStr]={results:G.results,done:G.hole>=8};
    save(st);
  }
}

function nextHole(){
  if(G.hole>=8){showResults();return;}
  G.hole++;startHole();
}

function totals(){
  var s=0,ps=0,done=0;
  for(var i=0;i<G.results.length;i++){
    var r=G.results[i];if(!r)continue;
    s+=r.putts;ps+=G.holes[i].par;done++;
  }
  return{strokes:s,par:ps,done:done};
}

/* ---- main loop ---- */
var lastT=0;
function frame(t){
  var dt=Math.min(0.05,(t-lastT)/1000||0.016);lastT=t;
  nowS=t/1000;
  var hidden=(typeof document!=='undefined')&&document.hidden;
  if(G.holes.length&&G.hole<9&&!hidden){
    var h=G.holes[G.hole];
    G.holeElapsed+=dt; /* the mover clock: same for every player */
    if(G.phase==='aim'){
      /* 7-second aim timer: auto-lock wherever the marker sits */
      G.aimElapsed+=dt;
      var remain=Math.max(0,AIM_SECS-G.aimElapsed);
      timerNum.textContent=Math.ceil(remain);
      timerPill.classList.toggle('low',remain<=3.05);
      if(remain<=0){lockAim();}
    }
    if(G.phase==='sweep'){
      /* Needle sweep: eased, not linear. It launches fast off zero and
         LINGERS near the top, so the gold band (82-87) is a ~127ms window
         per pass instead of 75ms on a triangle wave -- snappy but hittable.
         0 -> 100 still takes sd seconds (spec); the 3%/hole ramp is in
         sweepDur and is untouched. Turnaround keeps the instant reversal. */
      if(G.sweepT0==null)G.sweepT0=t;
      var el=(t-G.sweepT0)/1000;
      var sd=sweepDur(G.hole);
      var p=(el/sd)%2;
      G.needle=100*Math.sqrt(p<1?p:2-p);
      needleEl.style.left='calc('+G.needle.toFixed(2)+'% - 9px)';
    }
    if(G.phase==='roll'&&G.rolling){
      var rr=G.rolling;
      rr.t+=dt/1.1; /* 10% slower roll pacing (visual only) */
      var trail=rr.res.trail;
      var want=0;
      while(want<trail.length&&trail[want].t<=rr.t)want++;
      if(want>rr.shown){
        rr.shown=want;
        var tp=trail[want-1];
        G.ballX=tp.x;G.ballY=tp.y;
        G.trail=trail.slice(0,want);
      }
      if(want>=trail.length){
        if(rr.res.holed){
          G.phase='drop';G.dropT=0;G.ballScale=1;
          G.dropFrom={x:G.ballX,y:G.ballY};
        }else{
          var k=Math.min(1,dt*3);
          G.ballX+=(rr.res.x-G.ballX)*k;G.ballY+=(rr.res.y-G.ballY)*k;
          if(dist2(G.ballX,G.ballY,rr.res.x,rr.res.y)<0.05)settleStroke();
        }
      }
    }
    if(G.phase==='drop'){
      G.dropT+=dt;
      var gdr=G.holes[G.hole];
      var dk=Math.min(1,G.dropT/0.18),de=1-Math.pow(1-dk,3);
      G.ballX=G.dropFrom.x+(gdr.cup.x-G.dropFrom.x)*de;
      G.ballY=G.dropFrom.y+(gdr.cup.y-G.dropFrom.y)*de;
      G.ballScale=1-dk*0.92;
      if(dk>=1){G.ballScale=null;settleStroke();}
    }
    if(G.parts.length){
      for(var cpi=G.parts.length-1;cpi>=0;cpi--){
        var pt=G.parts[cpi];
        pt.life-=dt;
        if(pt.life<=0){G.parts.splice(cpi,1);continue;}
        pt.vy+=520*dt;pt.x+=pt.vx*dt;pt.y+=pt.vy*dt;pt.rot+=pt.vr*dt;
      }
    }
    if(G.holed)G.holeT+=dt;
    /* movers draw at the stroke clock so art == physics */
    var moverT=G.holeElapsed;
    if(G.phase==='roll'&&G.rolling)moverT=G.strokeT0+G.rolling.t;
    drawHole(h,{phase:G.phase,ballX:G.ballX,ballY:G.ballY,
      trail:G.trail,holed:G.holed,holeT:G.holeT,ballScale:G.ballScale,
      parts:G.parts,moverT:moverT});
  }
}
function loop(t){
  frame(t);
  requestAnimationFrame(loop);
}

/* ================= lock screen ================= */
function load(){try{var s=JSON.parse(localStorage.getItem(LS));return s||{days:{}};}catch(e){return{days:{}};}}
function save(s){try{localStorage.setItem(LS,JSON.stringify(s));}catch(e){}}
function msToMidnight(nowMs){var d=new Date(nowMs);d.setHours(24,0,0,0);return d.getTime()-nowMs;}
function fmtCountdown(ms){var s=Math.max(0,Math.floor(ms/1000));
  var hh=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
  return hh+':'+('0'+m).slice(-2)+':'+('0'+ss).slice(-2);}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

function refreshStart(){
  var st=load(),today=dateStr();
  var rec=st.days[today];
  if(rec&&rec.done&&rec.results.length>=9){
    lockBox.classList.remove('hidden');
    playBtn.classList.add('hidden');
    var s=0;for(var i=0;i<rec.results.length;i++)if(rec.results[i]&&rec.results[i].putts)s+=rec.results[i].putts;
    lockScore.textContent='Today: '+s+' putts';
    var tick=function(){
      lockTime.textContent=fmtCountdown(msToMidnight(Date.now()));
      setTimeout(tick,1000);
    };tick();
  }else{
    lockBox.classList.add('hidden');
    playBtn.classList.remove('hidden');
  }
}
if(playBtn)playBtn.addEventListener('click',function(){startRound('daily');});
if(practiceBtn)practiceBtn.addEventListener('click',function(){startRound('practice');});

/* ================= leaderboard (shared pattern) ================= */
function lbOn(){return !!LEADERBOARD_URL;}
function lbPost(obj){
  if(!lbOn())return Promise.resolve(null);
  return fetch(LEADERBOARD_URL,{method:'POST',redirect:'follow',
    headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(obj)})
    .then(function(r){return r.json();}).catch(function(){return null;});
}
function lbGet(params){
  if(!lbOn())return Promise.resolve(null);
  var q=Object.keys(params).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(params[k]);}).join('&');
  return fetch(LEADERBOARD_URL+'?'+q,{redirect:'follow'})
    .then(function(r){return r.json();}).catch(function(){return null;});
}
function lbBoard(){
  if(!lbOn())return Promise.resolve(null);
  return lbGet({action:'board',game:GAME_ID,date:dateStr()});
}
var USER_LS='dailyputtputt.user';
function getUser(){try{return JSON.parse(localStorage.getItem(USER_LS))||null;}catch(e){return null;}}
function setUser(u){try{localStorage.setItem(USER_LS,JSON.stringify(u));}catch(e){}}
function clearUser(){try{localStorage.removeItem(USER_LS);}catch(e){}}
function validName(n){return typeof n==='string'&&/^[A-Za-z0-9 ]{1,16}$/.test(n.trim());}
function sha256hex(str){
  if(!(window.crypto&&crypto.subtle))return Promise.reject(new Error('no crypto'));
  return crypto.subtle.digest('SHA-256',new TextEncoder().encode(str)).then(function(h){
    var b=new Uint8Array(h),s='';
    for(var i=0;i<b.length;i++)s+=('0'+b[i].toString(16)).slice(-2);
    return s;
  });
}
function refreshNameBtn(){
  var u=getUser();
  nameBtn.textContent='name: '+(u?u.name:'not set');
}
var nameState='name',pendingName='',nameAfter=null;
function openName(after){
  if(!lbOn()){if(after)after();return;}
  nameAfter=(typeof after==='function')?after:null;
  nameState='name';pendingName='';
  nameInput.value='';phraseInput.value='';
  phraseWrap.classList.add('hidden');nameMsg.textContent='';
  nameSub.textContent='Claim a name for the daily leaderboard.';
  nameGo.textContent='CHECK NAME';
  if($('nameCancel'))$('nameCancel').textContent='skip \u2014 play without leaderboard';
  nameScreen.classList.remove('hidden');
  setTimeout(function(){nameInput.focus();},60);
}
/* Close the name screen. runAfter=true only on successful claim/verify or
   explicit skip — cancel means play local-only, no leaderboard. */
function closeName(runAfter){
  nameScreen.classList.add('hidden');
  var f=nameAfter;nameAfter=null;
  if(runAfter&&f)f();
}
if(nameGo)nameGo.addEventListener('click',function(){
  if(nameState==='name'){
    var n=nameInput.value.trim();
    if(!validName(n)){nameMsg.textContent='Letters, numbers and spaces only, max 16 chars.';return;}
    nameMsg.textContent='checking\u2026';
    lbGet({action:'check',username:n}).then(function(res){
      if(!res){nameMsg.textContent='Could not reach the leaderboard. Try again.';return;}
      if(res.ok===false&&res.error==='invalid_name'){nameMsg.textContent='Letters, numbers and spaces only, max 16 chars.';return;}
      if(!(res&&res.ok)){nameMsg.textContent='Could not reach the leaderboard. Try again.';return;}
      pendingName=n;
      phraseWrap.classList.remove('hidden');nameMsg.textContent='';
      if(!res.taken){
        nameState='claim';
        nameSub.textContent='\u201C'+pendingName+'\u201D is yours \u2014 set a secret phrase to lock it in.';
        nameGo.textContent='CLAIM NAME';
      }else{
        nameState='verify';
        nameSub.textContent='\u201C'+pendingName+'\u201D is taken \u2014 enter its secret phrase to use it.';
        nameGo.textContent='UNLOCK NAME';
      }
      setTimeout(function(){phraseInput.focus();},60);
    });
  }else if(nameState==='claim'){
    var ph=phraseInput.value;
    if(ph.length<4){nameMsg.textContent='Phrase needs at least 4 characters.';return;}
    nameMsg.textContent='working\u2026';
    sha256hex(pendingName.toLowerCase()+'|'+ph).then(function(hash){
      return lbPost({action:'claim',username:pendingName,hash:hash})
        .then(function(res){return{res:res,hash:hash};});
    }).then(function(out){
      if(out.res&&out.res.ok){
        setUser({name:pendingName,hash:out.hash});
        refreshNameBtn();closeName(true);
      }else{
        var e=(out.res&&out.res.error)||'';
        nameMsg.textContent=e==='wrong_phrase'?'Wrong phrase \u2014 try again.'
          :(e?'Error: '+e:'Could not claim that name. Try again.');
      }
    }).catch(function(){nameMsg.textContent='Something went wrong. Try again.';});
  }else{
    var ph2=phraseInput.value;
    if(ph2.length<4){nameMsg.textContent='Phrase needs at least 4 characters.';return;}
    nameMsg.textContent='working\u2026';
    sha256hex(pendingName.toLowerCase()+'|'+ph2).then(function(hash){
      return lbGet({action:'verify',username:pendingName,hash:hash})
        .then(function(res){return{res:res,hash:hash};});
    }).then(function(out){
      if(out.res&&out.res.ok){
        setUser({name:pendingName,hash:out.hash});
        refreshNameBtn();closeName(true);
      }else{
        nameMsg.textContent='Wrong phrase \u2014 try again.';
      }
    }).catch(function(){nameMsg.textContent='Something went wrong. Try again.';});
  }
});
if($('nameCancel'))$('nameCancel').addEventListener('click',function(){closeName(true);});
if(nameBtn)nameBtn.addEventListener('click',function(){openName(null);});
if(logoutBtn)logoutBtn.addEventListener('click',function(){clearUser();refreshNameBtn();renderBoard();});

var RES_LS='dailyputtputt.results.v2';
function loadResults(){try{var a=JSON.parse(localStorage.getItem(RES_LS));return Array.isArray(a)?a:[];}catch(e){return[];}}
function recordResult(rec){
  var a=loadResults();a.push(rec);
  if(a.length>200)a=a.slice(-200);
  try{localStorage.setItem(RES_LS,JSON.stringify(a));}catch(e){}
}

function showResults(){
  var t=totals();
  resTitle.textContent=G.mode==='daily'?'Today\u2019s round':'Practice round';
  var per=G.results.map(function(r,i){return r?r.putts:'\u2013';}).join(' \u00B7 ');
  var vs=fmtVsPar(t.strokes-t.par);
  resScore.innerHTML=t.strokes+'<small> putts \u00B7 '+vs+'</small><br><small>'+per+'</small>';
  resultsScreen.classList.remove('hidden');
  if(G.mode==='daily'){
    recordResult({date:dateStr(),mode:'daily',strokes:t.strokes,
      perHole:G.results.map(function(r){return r?r.putts:0;})});
    var doSubmit=function(){
      var u=getUser();
      if(lbOn()&&u&&u.hash)lbPost({action:'submit',game:GAME_ID,date:dateStr(),
        username:u.name,hash:u.hash,score:t.strokes});
      renderBoard();
    };
    var u0=getUser();
    if(lbOn()&&(!u0||!u0.hash))openName(doSubmit);else doSubmit();
  }else renderBoard();
}
function renderBoard(){
  lbList.innerHTML='';histList.innerHTML='';
  if(!lbOn()){
    lbTitle.innerHTML='Leaderboard offline \u2014 set LEADERBOARD_URL to enable';
  }else{
    lbTitle.innerHTML='Today\u2019s leaderboard';
    lbBoard().then(function(res){
      var rows=(res&&res.ok&&res.entries)||[];
      if(!rows.length){lbList.innerHTML='<div class="lbRow"><span>No scores yet today.</span></div>';return;}
      var u=getUser(),html='';
      for(var i=0;i<rows.length;i++){
        var r=rows[i],me=u&&String(r.display).toLowerCase()===String(u.name).toLowerCase();
        html+='<div class="lbRow'+(me?' me':'')+'"><span>#'+(i+1)+' '+esc(r.display)+'</span><span>'+r.score+' putts</span></div>';
      }
      lbList.innerHTML=html;
    });
  }
  var hist=loadResults().slice().reverse(),html2='';
  for(var i=0;i<Math.min(12,hist.length);i++){
    var hh=hist[i];
    html2+='<div class="lbRow"><span>'+esc(hh.date)+'</span><span>'+hh.strokes+' putts</span></div>';
  }
  histList.innerHTML=html2||'<div class="lbRow"><span>No rounds yet.</span></div>';
}
if(boardBtn)boardBtn.addEventListener('click',function(){
  resTitle.textContent='Leaderboard';resScore.innerHTML='';
  resultsScreen.classList.remove('hidden');renderBoard();
});
if(resultsClose)resultsClose.addEventListener('click',function(){
  resultsScreen.classList.add('hidden');
  refreshStart();
  startScreen.classList.remove('hidden');
});

/* ================= boot ================= */
if(canvas&&typeof window!=='undefined'){
  resize();
  refreshNameBtn();
  refreshStart();
  if(typeof location!=='undefined'&&location.search&&location.search.indexOf('smoke')>=0){
    startRound('practice');
  }
  requestAnimationFrame(loop);
}

/* test hooks (node) */
var PuttPuttTest={
  hashStr:hashStr,mulberry32:mulberry32,genHoles:genHoles,buildHole:buildHole,
  simulate:simulate,gradOf:gradOf,slopeInfo:slopeInfo,inPoly:inPoly,
  lanePoly:lanePoly,polyWalls:polyWalls,moverSegs:moverSegs,
  collideSeg:collideSeg,collideBumper:collideBumper,
  HOLE_DEFS:HOLE_DEFS,
  needleGrade:needleGrade,needleToPower:needleToPower,overswingBend:overswingBend,
  resolveStroke:resolveStroke,puttOutcome:puttOutcome,
  scoreName:scoreName,fmtVsPar:fmtVsPar,shadeGrid:shadeGrid,
  sweepDur:sweepDur,AIM_SECS:AIM_SECS,
  defaultAim:defaultAim,laneOk:laneOk,spinePointAt:spinePointAt,
  consts:{FRICTION:FRICTION,SLOPE_G:SLOPE_G,CUP_R:CUP_R,V_CAP:V_CAP,DMAX:DMAX,
    BAR_MAX:BAR_MAX,V_STOP:V_STOP,BALL_R:BALL_R,RAIL_REST:RAIL_REST}
};
if(typeof module!=='undefined'&&module.exports)module.exports=PuttPuttTest;

})();
