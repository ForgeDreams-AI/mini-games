/* ============================================================
   DAILY PUTT -- nine greens, stroke play, dailyholes.com mechanics.
   Original code and art: a clean-room reimplementation of the FEEL
   of that game's systems (timing needle, aim marker, slope reads),
   adapted to putting-only. No assets, text, or code copied.

   THE SHOT -- three steps:
   1. AIM: tap the green to drop the marker; line shows ball->marker.
      Marker shows the distance. Press LOCK THE LINE when happy.
   2. POWER: press PUTT and the needle SWEEPS UP AND BACK DOWN,
      oscillating across a horizontal bar. PURE BAND is 82-87
      (near the top, NOT at the top); the very top is the OVER zone.
      Press STOP to stop the needle. STOP JUST UNDER 100.
   3. OUTCOMES: PURE (in the band) = perfect pace for the marked
      distance + truest roll. OVERSWING (above the band) = too hot:
      blows past AND bends offline (push/pull). EASED (below) =
      leaves it short. Every putt comes down to timing.

   Green reading: top-down green with hillshaded depth art generated
   from the same height field as the physics -- what you see is what
   breaks the putt. Flag always visible; slope shown as a % numeral +
   downhill-arrow pill by the ball. Reading the hills and adjusting
   the marker IS the skill. Every hole opens near the edge of the
   green: long putts (25-45ft) across real undulation.

   Rules: 9 date-seeded greens (same for everyone), par 2 (par 3 on
   long greens), up to 6 putts per green -- after 6 the ball is
   PICKED UP and the green scores 6. One ranked round per day,
   unlimited practice. Score = total strokes vs par.
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
var BALL_R=0.30;         /* visual ball radius                       */
var V_CAP=4.0;           /* max speed at cup for a clean drop        */
var V_STOP=0.12;         /* below this the ball is at rest           */
var DMAX=80;             /* putt distance at full (1.0) power        */
var BAR_MAX=1.15;        /* power headroom above 1.0                 */
var DT=1/240;

/* ================= the needle (signature timing mechanic) ==============
   0..100, sweeps up and back down repeatedly. PURE BAND 82-87 sits near
   the top but NOT at the top; 87-100 is the OVER zone. STOP JUST UNDER 100. */
var PURE_LO=82, PURE_HI=87, PURE_MID=84.5;
var SWEEP_T=1.5;         /* seconds for the needle to travel 0 -> 100 */
var OVER_BEND_MAX=4*Math.PI/180; /* max offline bend at a 100 stop   */

function needleGrade(n){
  if(n>=PURE_LO&&n<=PURE_HI)return'PURE';
  return n>PURE_HI?'OVERSWING':'EASED';
}
/* PURE stop (84.5) carries exactly the marked distance on a flat green. */
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

/* ================= green archetypes =================
   Each archetype builds a height-field closure h(x,y) plus metadata.
   Physics AND the drawn slope arrows both sample the same numeric
   gradient, so they always agree. */
var ARCHES=[
  {id:'gentle',  name:'Gentle tilt',   R:[26,34], dMin:25, dMax:35},
  {id:'steep',   name:'Side slope',    R:[24,30], dMin:25, dMax:34},
  {id:'tier',    name:'Two-tier',      R:[28,36], dMin:28, dMax:40},
  {id:'ridge',   name:'Center ridge',  R:[26,34], dMin:28, dMax:40},
  {id:'bowl',    name:'Bowl',          R:[26,34], dMin:25, dMax:35},
  {id:'sbreak',  name:'S-break',       R:[28,36], dMin:30, dMax:42},
  {id:'pinch',   name:'Bunker pinch',  R:[26,32], dMin:25, dMax:35},
  {id:'lag',     name:'Long lag',      R:[36,44], dMin:40, dMax:55},
  {id:'tiny',    name:'Tiny green',    R:[16,20], dMin:22, dMax:30}
];

/* numeric gradient of h -- single source of truth for physics + visuals */
function gradOf(h,x,y){
  var e=0.06;
  return {x:(h(x+e,y)-h(x-e,y))/(2*e), y:(h(x,y+e)-h(x,y-e))/(2*e)};
}
/* slope readout: % numeral + downhill direction (the green-reading aid) */
function slopeInfo(h,x,y){
  var g=gradOf(h,x,y);
  var m=Math.sqrt(g.x*g.x+g.y*g.y);
  if(m<0.004)return{pct:0,dx:0,dy:0,flat:true};
  return{pct:m*100,dx:-g.x/m,dy:-g.y/m,flat:false};
}

/* ============ depth art: hillshade generated FROM the height field ====
   The same h(x,y) that drives the physics gradient is sampled onto a
   grid; per-pixel hillshading (light from the NW) plus soft elevation
   contours give the green visible hills and levels. What you see IS
   what breaks the putt -- art and physics can never disagree. */
function shadeGrid(green,W,H){
  var bb=green.bbox,pad=7;
  var x0=bb.x0-pad,x1=bb.x1+pad,y0=bb.y0-pad,y1=bb.y1+pad;
  var dx=(x1-x0)/(W-1),dy=(y1-y0)/(H-1);
  var hg=new Float32Array(W*H),hmin=1e9,hmax=-1e9;
  var i,j;
  for(j=0;j<H;j++)for(i=0;i<W;i++){
    var hv=green.h(x0+i*dx,y0+j*dy);
    hg[j*W+i]=hv; if(hv<hmin)hmin=hv; if(hv>hmax)hmax=hv;
  }
  var hr=hmax-hmin; if(hr<1e-6)hr=1e-6;
  var out=new Float32Array(W*H*3); /* r,g,b 0..255 */
  for(j=0;j<H;j++)for(i=0;i<W;i++){
    var hx0=hg[j*W+Math.max(0,i-1)],hx1=hg[j*W+Math.min(W-1,i+1)];
    var hy0=hg[Math.max(0,j-1)*W+i],hy1=hg[Math.min(H-1,j+1)*W+i];
    var gx=(hx1-hx0)/(2*dx),gy=(hy1-hy0)/(2*dy);
    var inv=1/Math.sqrt(gx*gx+gy*gy+1);
    var li=clamp((-gx*inv)*-0.55+(-gy*inv)*-0.55+inv*0.72,0,1); /* N dot L */
    var shade=0.70+0.50*li;                 /* 0.70..1.20 luminance */
    var t=(hg[j*W+i]-hmin)/hr;              /* 0 low .. 1 high */
    var r=50+t*40, gg=115+t*45, b=56+t*22;  /* lows deeper, highs sunlit */
    var cf=Math.abs((((hg[j*W+i]/0.10)%1)+1)%1-0.5);
    var contour=cf<0.04?0.92:1.0;           /* soft contour every 0.10 ft */
    var k=shade*contour, o=(j*W+i)*3;
    out[o]=clamp(r*k,0,255);out[o+1]=clamp(gg*k,0,255);out[o+2]=clamp(b*k,0,255);
  }
  return{data:out,w:W,h:H,x0:x0,y0:y0,dx:dx,dy:dy};
}

/* Smooth, round green outline: a closed curve whose radius is a pure sum of
   low-frequency sinusoids, sampled densely (160 points). No straight facets,
   no sharp corners -- it renders like a normal golf green. The same point
   list is the physics boundary (inPoly), so the ball can never cross the
   visual edge. */
function blobPoly(rng,cx,cy,R,waist){
  var p1=rng()*6.28, p2=rng()*6.28, p3=rng()*6.28;
  var a1=0.05+0.04*rng(), a2=0.035+0.03*rng(), a3=0.02+0.02*rng();
  var n=160, pts=[];
  for(var i=0;i<n;i++){
    var a=i/n*Math.PI*2;
    var w=1+a1*Math.sin(2*a+p1)+a2*Math.sin(3*a+p2)+a3*Math.sin(5*a+p3);
    var r=R*w;
    if(waist) r*=(1-waist*Math.pow(Math.abs(Math.sin(a)),6)); /* smooth pinch */
    pts.push({x:cx+Math.cos(a)*r*1.06, y:cy+Math.sin(a)*r*0.94});
  }
  return pts;
}
function inPoly(px,py,poly){
  var inside=false;
  for(var i=0,j=poly.length-1;i<poly.length;j=i++){
    var xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
    if(((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi))inside=!inside;
  }
  return inside;
}

/* Build one green. rng is seeded. */
function buildGreen(rng,archId){
  var A=null;
  for(var i=0;i<ARCHES.length;i++)if(ARCHES[i].id===archId)A=ARCHES[i];
  var R=A.R[0]+rng()*(A.R[1]-A.R[0]);
  var waist=(archId==='pinch')?0.34:0;
  var poly=blobPoly(rng,0,0,R,waist);
  /* EDGE STARTS: the ball opens near the edge of the green and the cup
     sits roughly across from it, so every opening putt is long and
     crosses the green's features. Both verified inside the boundary,
     cup kept 2.5ft clear of the edge. */
  var wantD=A.dMin+rng()*(A.dMax-A.dMin);
  var ball=null,cup=null;
  function tryPair(wd){
    for(var k=0;k<600;k++){
      var a=rng()*Math.PI*2;
      var br=R*(0.76+rng()*0.14);            /* 76-90% of radius: near the edge */
      var bx=br*Math.cos(a), by=br*Math.sin(a);
      var ca=a+Math.PI+(rng()-0.5)*1.1;       /* cup roughly across the green */
      var cx=bx+Math.cos(ca)*wd, cy=by+Math.sin(ca)*wd;
      if(!inPoly(bx,by,poly)||!inPoly(cx,cy,poly))continue;
      var ok=true;
      for(var m=0;m<poly.length;m+=4){        /* cup margin from the edge */
        if(dist2(cx,cy,poly[m].x,poly[m].y)<2.5){ok=false;break;}
      }
      if(!ok)continue;
      return{ball:{x:bx,y:by},cup:{x:cx,y:cy}};
    }
    return null;
  }
  var wd=wantD,pair=null;
  while(wd>=18&&!pair){pair=tryPair(wd);wd*=0.92;}
  if(pair){ball=pair.ball;cup=pair.cup;}
  else{ball={x:-R*0.3,y:0};cup={x:R*0.3,y:0};}
  var d=dist2(ball.x,ball.y,cup.x,cup.y);
  var lineA=Math.atan2(cup.y-ball.y,cup.x-ball.x);

  /* height field per archetype (feet of elevation) */
  var h,tA=rng()*Math.PI*2,s,bunk=null;
  if(archId==='gentle'){
    s=0.008+rng()*0.006;
    h=(function(s,tA){return function(x,y){return s*(x*Math.cos(tA)+y*Math.sin(tA));};})(s,tA);
  }else if(archId==='steep'){
    s=0.028+rng()*0.012;
    tA=lineA+Math.PI/2+(rng()-0.5)*0.9;
    h=(function(s,tA){return function(x,y){return s*(x*Math.cos(tA)+y*Math.sin(tA));};})(s,tA);
  }else if(archId==='tier'){
    s=0.10+rng()*0.08; var w=5+rng()*3;
    var lx=ball.x+(cup.x-ball.x)*0.45, ly=ball.y+(cup.y-ball.y)*0.45;
    var nx=-(cup.y-ball.y)/d, ny=(cup.x-ball.x)/d;
    h=(function(s,w,lx,ly,nx,ny){return function(x,y){
      var dd=(x-lx)*nx+(y-ly)*ny;
      return s*smoothstep(0.5+dd/w);
    };})(s,w,lx,ly,nx,ny);
  }else if(archId==='ridge'){
    s=0.5+rng()*0.25; var w2=4+rng()*3;
    var mx=(ball.x+cup.x)/2, my=(ball.y+cup.y)/2;
    var nx2=(cup.x-ball.x)/d, ny2=(cup.y-ball.y)/d;
    h=(function(s,w2,mx,my,nx2,ny2){return function(x,y){
      var dd=(x-mx)*nx2+(y-my)*ny2;
      return s*Math.exp(-(dd*dd)/(w2*w2));
    };})(s,w2,mx,my,nx2,ny2);
  }else if(archId==='bowl'){
    /* depression centered at (not exactly on) the cup: everything feeds
       toward the hole, with a whisper of break to read. Low point at the
       geometric center confused players -- chevrons pointed away from
       the hole even though they were true downhill. */
    s=0.55+rng()*0.3;
    var ba=rng()*Math.PI*2, bd=2+rng()*2.5;
    var bcx=cup.x+Math.cos(ba)*bd, bcy=cup.y+Math.sin(ba)*bd;
    h=(function(s,R,bcx,bcy){return function(x,y){
      var dx=x-bcx,dy=y-bcy;
      var r=Math.sqrt(dx*dx+dy*dy)/R; return s*r*r;
    };})(s,R,bcx,bcy);
  }else if(archId==='sbreak'){
    s=0.022+rng()*0.014;
    var W=R*1.6, rot=rng()*Math.PI;
    var ca=Math.cos(rot),sa=Math.sin(rot);
    h=(function(s,W,ca,sa){return function(x,y){
      var u=x*ca+y*sa, v=-x*sa+y*ca;
      return s*v*Math.sin(Math.PI*u/W);
    };})(s,W,ca,sa);
  }else if(archId==='pinch'){
    s=0.007+rng()*0.005;
    tA=lineA+(rng()-0.5)*0.8;
    var bmx=(ball.x+cup.x)/2, bmy=(ball.y+cup.y)/2;
    var px2=-(cup.y-ball.y)/d, py2=(cup.x-ball.x)/d;
    var off=4.5+rng()*2;
    bunk=[
      {x:bmx+px2*off, y:bmy+py2*off, rx:3.2, ry:5.2, rot:Math.atan2(py2,px2)},
      {x:bmx-px2*off, y:bmy-py2*off, rx:3.2, ry:5.2, rot:Math.atan2(py2,px2)}
    ];
    h=(function(s,tA){return function(x,y){return s*(x*Math.cos(tA)+y*Math.sin(tA));};})(s,tA);
  }else if(archId==='lag'){
    s=0.006+rng()*0.004; /* kept gentle: a 45ft dead-uphill putt at 1.4%
      was only makeable on a knife-edge (n=87 + 15% extra mark) */
    h=(function(s,tA){return function(x,y){return s*(x*Math.cos(tA)+y*Math.sin(tA));};})(s,tA);
  }else{ /* tiny */
    s=0.014+rng()*0.010;
    h=(function(s,tA){return function(x,y){return s*(x*Math.cos(tA)+y*Math.sin(tA));};})(s,tA);
  }
  var xs=poly.map(function(p){return p.x;}),ys=poly.map(function(p){return p.y;});
  return {
    arch:archId, name:A.name, R:R, poly:poly, ball:ball, cup:cup,
    dist:d, lineA:lineA, h:h, bunkers:bunk||[],
    par:(d>=38?3:2), /* par 3 on long greens, par 2 standard */
    bbox:{x0:Math.min.apply(null,xs),x1:Math.max.apply(null,xs),
          y0:Math.min.apply(null,ys),y1:Math.max.apply(null,ys)},
    seed:(rng()*1e9)|0
  };
}

/* date-seeded set of 9: shuffled archetype order, seeded params */
function genGreens(seedStr){
  var rng=mulberry32(hashStr('putt|'+seedStr));
  var ids=ARCHES.map(function(a){return a.id;});
  for(var i=ids.length-1;i>0;i--){var j=(rng()*(i+1))|0;var t=ids[i];ids[i]=ids[j];ids[j]=t;}
  return ids.map(function(id){return buildGreen(rng,id);});
}

/* ================= physics sim (pure -- testable) ================= */
function simulate(green,aimA,powerM,opts){
  opts=opts||{};
  var pureBonus=(opts.pure===true);
  var vCap=pureBonus?V_CAP*1.5:V_CAP;
  var cupR=pureBonus?CUP_R*1.15:CUP_R;
  var v0=Math.sqrt(2*FRICTION*DMAX*clamp(powerM,0,BAR_MAX));
  /* stroke play: putts after the first start from where the ball stopped */
  var sx=(opts.from&&isFinite(opts.from.x))?opts.from.x:green.ball.x;
  var sy=(opts.from&&isFinite(opts.from.y))?opts.from.y:green.ball.y;
  var x=sx,y=sy;
  var vx=Math.cos(aimA)*v0,vy=Math.sin(aimA)*v0;
  var jrng=mulberry32(green.seed^0x9e37);
  var trail=[],maxBreak=0,lipped=false,steps=0,offGreen=false,plugged=false;
  /* break measured against the putt's own start line, not the tee line */
  var refA=(opts.from)?Math.atan2(green.cup.y-sy,green.cup.x-sx):green.lineA;
  var lineX=Math.cos(refA),lineY=Math.sin(refA);
  while(steps++<240*14){
    var sp=Math.sqrt(vx*vx+vy*vy);
    if(sp<V_STOP)break;
    var g=gradOf(green.h,x,y);
    var ax=-FRICTION*vx/sp - SLOPE_G*g.x;
    var ay=-FRICTION*vy/sp - SLOPE_G*g.y;
    vx+=ax*DT;vy+=ay*DT;
    sp=Math.sqrt(vx*vx+vy*vy);
    if(sp<V_STOP){vx=vy=0;break;}
    x+=vx*DT;y+=vy*DT;
    var rx=x-sx,ry=y-sy;
    var lat=Math.abs(rx*(-lineY)+ry*lineX);
    if(lat>maxBreak)maxBreak=lat;
    if(trail.length===0||dist2(x,y,trail[trail.length-1].x,trail[trail.length-1].y)>0.8)
      trail.push({x:x,y:y});
    var bk=green.bunkers;
    for(var b=0;b<bk.length;b++){
      var c=Math.cos(bk[b].rot),s2=Math.sin(bk[b].rot);
      var ex=x-bk[b].x,ey=y-bk[b].y;
      var lu=ex*c+ey*s2,lv=-ex*s2+ey*c;
      if((lu*lu)/(bk[b].rx*bk[b].rx)+(lv*lv)/(bk[b].ry*bk[b].ry)<1){plugged=true;vx=vy=0;}
    }
    if(plugged)break;
    if(!inPoly(x,y,green.poly)){offGreen=true;break;}
    var dc=dist2(x,y,green.cup.x,green.cup.y);
    var spd=Math.sqrt(vx*vx+vy*vy);
    if(dc<cupR){
      if(spd<vCap)return{holed:true,x:x,y:y,trail:trail,maxBreak:maxBreak,lipped:lipped,offGreen:false,plugged:false};
      lipped=true;
      var nx3=(x-green.cup.x)/(dc||1),ny3=(y-green.cup.y)/(dc||1);
      var dot=vx*nx3+vy*ny3;
      var jit=(jrng()-0.5)*0.5;
      vx=(vx-1.6*dot*nx3)*0.62+(-ny3)*jit;
      vy=(vy-1.6*dot*ny3)*0.62+(nx3)*jit;
      x=green.cup.x+nx3*(cupR+0.05);y=green.cup.y+ny3*(cupR+0.05);
    }else if(dc<cupR*2.2&&spd<vCap*0.55){
      return{holed:true,x:green.cup.x,y:green.cup.y,trail:trail,maxBreak:maxBreak,lipped:lipped,offGreen:false,plugged:false};
    }
  }
  return{holed:false,x:x,y:y,trail:trail,maxBreak:maxBreak,lipped:lipped,offGreen:offGreen,plugged:plugged};
}

/* One full stroke, pure: marker distance + aim + needle value -> outcome.
   puttSeed makes the overswing bend deterministic per putt. */
function resolveStroke(green,ball,markerDist,aimA,n,puttSeed){
  var grade=needleGrade(n);
  var power=needleToPower(n,markerDist);
  var bend=overswingBend(n,puttSeed);
  var res=simulate(green,aimA+bend,power,{pure:grade==='PURE',from:ball});
  return{grade:grade,power:power,bend:bend,res:res};
}

/* post-putt decision: holed | pickup (6 reached) | again */
function puttOutcome(puttsUsed,holed){
  if(holed)return'holed';
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
var canvas=document.getElementById('game'),ctx=canvas.getContext('2d');
var cw=0,ch=0;
function resize(){
  var dpr=Math.min(2,window.devicePixelRatio||1);
  cw=window.innerWidth;ch=window.innerHeight;
  canvas.width=Math.round(cw*dpr);canvas.height=Math.round(ch*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  if(G.greens.length&&G.hole<9){ /* keep camera + hillshade in sync */
    fitStatic(G.greens[G.hole]);buildShade(G.greens[G.hole]);
  }
}
window.addEventListener('resize',resize);

/* STATIC camera: the whole green always fits on screen. Ball and cup
   are always visible together. Nothing pans, nothing zooms mid-putt. */
var PANEL_H=150,TOP_H=110;
var cam={scale:1,ox:0,oy:0,vcx:0,vcy:0};
function fitStatic(green){
  var bb=green.bbox,pad=7;
  var vx0=10,vx1=cw-10,vy0=TOP_H+10,vy1=ch-PANEL_H-10;
  var wcx=(bb.x0+bb.x1)/2,wcy=(bb.y0+bb.y1)/2;
  var hw=(bb.x1-bb.x0)/2+pad,hh=(bb.y1-bb.y0)/2+pad;
  cam.scale=Math.min((vx1-vx0)/(2*hw),(vy1-vy0)/(2*hh));
  cam.ox=wcx;cam.oy=wcy;
  cam.vcx=(vx0+vx1)/2;cam.vcy=(vy0+vy1)/2;
}
function w2s(x,y){ /* world -> screen */
  return {x:(x-cam.ox)*cam.scale+cam.vcx, y:(y-cam.oy)*cam.scale+cam.vcy};
}
function s2w(sx,sy){
  return {x:(sx-cam.vcx)/cam.scale+cam.ox, y:(sy-cam.vcy)/cam.scale+cam.oy};
}

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

var nowS=0; /* seconds, updated in the main loop */

/* the aim marker: tap the green to drop it, line shows ball -> marker,
   gold ring + distance pill. Turns gold once the line is locked. */
function drawAim(green){
  if(!G.markerSet)return;
  if(G.phase!=='aim'&&G.phase!=='locked')return;
  var locked=(G.phase==='locked');
  var bs=w2s(G.ballX,G.ballY), ms=w2s(G.markerX,G.markerY);
  ctx.lineCap='round';
  ctx.strokeStyle=locked?'rgba(120,70,0,0.6)':'rgba(20,60,30,0.55)';
  ctx.lineWidth=7;
  ctx.beginPath();ctx.moveTo(bs.x,bs.y);ctx.lineTo(ms.x,ms.y);ctx.stroke();
  ctx.strokeStyle=locked?'#fbbf24':'#ffffff';
  ctx.lineWidth=3.5;
  ctx.beginPath();ctx.moveTo(bs.x,bs.y);ctx.lineTo(ms.x,ms.y);ctx.stroke();
  /* power notches: expected carry at the bar's 25/50/75% ticks, using the
     exact same mapping (carry = markerDist * f). Stop the needle at a
     tick and the ball dies at its notch -- on flat ground, exactly. */
  var md0=dist2(G.ballX,G.ballY,G.markerX,G.markerY);
  if(md0>0.5){
    var ux=(G.markerX-G.ballX)/md0, uy=(G.markerY-G.ballY)/md0;
    var px0=-uy, py0=ux; /* perpendicular */
    var hl=Math.max(7,cam.scale*0.35);
    [0.25,0.5,0.75].forEach(function(f){
      var sp=w2s(G.ballX+ux*md0*f,G.ballY+uy*md0*f);
      ctx.strokeStyle='rgba(20,60,30,0.65)';ctx.lineWidth=5;
      ctx.beginPath();
      ctx.moveTo(sp.x-px0*hl,sp.y-py0*hl);ctx.lineTo(sp.x+px0*hl,sp.y+py0*hl);
      ctx.stroke();
      ctx.strokeStyle='#ffffff';ctx.lineWidth=2.5;
      ctx.beginPath();
      ctx.moveTo(sp.x-px0*hl,sp.y-py0*hl);ctx.lineTo(sp.x+px0*hl,sp.y+py0*hl);
      ctx.stroke();
    });
  }
  /* marker ring */
  var mr=Math.max(9,cam.scale*0.45);
  ctx.strokeStyle=locked?'#b45309':'#b45309';
  ctx.lineWidth=4;
  ctx.beginPath();ctx.arc(ms.x,ms.y,mr,0,Math.PI*2);ctx.stroke();
  ctx.fillStyle=locked?'#fbbf24':'#ffffff';
  ctx.beginPath();ctx.arc(ms.x,ms.y,mr*0.35,0,Math.PI*2);ctx.fill();
  /* distance pill -- nudged below the marker if it would cover the
     slope badge (stops "5 FT"+"FLAT" reading as "5 FLAT") */
  var d=dist2(G.ballX,G.ballY,G.markerX,G.markerY);
  var lbl=Math.round(d)+' FT';
  ctx.font='800 13px -apple-system,sans-serif';
  var tw=ctx.measureText(lbl).width;
  var lx=ms.x+mr+8,ly=ms.y-mr-8;
  var br=slopeBadgeRect(green);
  if(rectsOverlap(lx-9,ly-14,tw+18,26,br.x,br.y,br.w,br.h))ly=ms.y+mr+22;
  ctx.fillStyle='rgba(17,24,39,0.88)';
  roundRectP(lx-9,ly-14,tw+18,26,9);ctx.fill();
  ctx.fillStyle='#ffffff';ctx.textAlign='left';
  ctx.fillText(lbl,lx,ly+5);
}

/* slope badge rect (no drawing): used for drawing AND for keeping the
   distance pill from overlapping it ("5 FT" + "FLAT" reading as "5 FLAT") */
function slopeBadgeRect(green){
  var si=slopeInfo(green.h,G.ballX,G.ballY);
  var s=w2s(G.ballX,G.ballY);
  ctx.font='800 13px -apple-system,sans-serif';
  var txt=si.flat?'FLAT':si.pct.toFixed(1)+'%';
  var tw=ctx.measureText(txt).width;
  var bw=tw+(si.flat?18:40);
  var bx=s.x-bw/2, by=s.y-52;
  if(by<TOP_H+34)by=s.y+30; /* ball near the top: badge goes below */
  return {x:bx,y:by,w:bw,h:26,si:si};
}
function rectsOverlap(ax,ay,aw,ah,bx,by,bw,bh){
  return ax<bx+bw&&ax+aw>bx&&ay<by+bh&&ay+ah>by;
}

/* slope % badge near the ball: the green-reading aid.
   "1.3%" + arrow pointing downhill (same gradient as physics). */
function drawSlopeBadge(green){
  if(G.phase!=='aim'&&G.phase!=='locked')return;
  var r=slopeBadgeRect(green), si=r.si;
  var txt=si.flat?'FLAT':si.pct.toFixed(1)+'%';
  var bx=r.x, by=r.y, bw=r.w;
  ctx.fillStyle='rgba(17,24,39,0.88)';
  roundRectP(bx,by,bw,26,9);ctx.fill();
  var tx=bx+9;
  if(!si.flat){
    /* downhill arrow */
    var ang=Math.atan2(si.dy,si.dx);
    var ax0=bx+16,ay0=by+13,r2=7;
    ctx.save();ctx.translate(ax0,ay0);ctx.rotate(ang);
    ctx.strokeStyle='#7dd3fc';ctx.lineWidth=3;ctx.lineCap='round';
    ctx.beginPath();ctx.moveTo(-r2,0);ctx.lineTo(r2,0);
    ctx.moveTo(r2-4,-4);ctx.lineTo(r2,0);ctx.lineTo(r2-4,4);ctx.stroke();
    ctx.restore();
    tx=bx+28;
  }
  ctx.fillStyle=si.flat?'#a7f3d0':'#ffffff';ctx.textAlign='left';
  ctx.fillText(txt,tx,by+18);
}

/* hillshade canvas: baked once per hole from shadeGrid (the height
   field), drawn clipped to the green every frame. Rebuilt when the
   camera changes (new hole / resize). */
var shadeCv=null,shadeMeta=null;
function buildShade(green){
  var bb=green.bbox,pad=7;
  var wWorld=(bb.x1-bb.x0)+2*pad, hWorld=(bb.y1-bb.y0)+2*pad;
  var longPx=Math.max(wWorld,hWorld)*cam.scale;
  var sf=Math.min(1,420/Math.max(1,longPx));
  var W=Math.max(64,Math.round(wWorld*cam.scale*sf));
  var H=Math.max(64,Math.round(hWorld*cam.scale*sf));
  var sg=shadeGrid(green,W,H);
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

function drawGreen(green,state){
  /* backdrop */
  var bg=ctx.createLinearGradient(0,0,0,ch);
  bg.addColorStop(0,'#2c6e35');bg.addColorStop(1,'#1d4a26');
  ctx.fillStyle=bg;ctx.fillRect(0,0,cw,ch);

  /* green body: hillshaded depth art baked from the height field --
     what you see is what breaks the putt */
  ctx.save();
  pathOf(green.poly);
  ctx.fillStyle='#3a7d3f';ctx.fill();
  /* hillshade layer, clipped to the green */
  ctx.clip();
  if(shadeCv&&shadeMeta){
    var sh0=w2s(shadeMeta.x0,shadeMeta.y0);
    ctx.drawImage(shadeCv,sh0.x,sh0.y,shadeMeta.w*cam.scale,shadeMeta.h*cam.scale);
  }
  /* mowing stripes, subtle over the shading */
  var s0=w2s(green.bbox.x0-4,green.bbox.y0-4),s1=w2s(green.bbox.x1+4,green.bbox.y1+4);
  var wpx=Math.abs(s1.x-s0.x),hpx=Math.abs(s1.y-s0.y);
  var stripeH=Math.max(14,cam.scale*2.2),yy=s0.y,flip=false;
  ctx.globalAlpha=0.10;
  while(yy<s1.y){
    ctx.fillStyle=flip?'#1d4a26':'#ffffff';
    ctx.fillRect(s0.x-4,yy,wpx+8,stripeH);
    yy+=stripeH;flip=!flip;
  }
  ctx.globalAlpha=1;
  /* inner shading toward edges (radii must be >= 0 -- negative throws) */
  var cc=w2s((green.bbox.x0+green.bbox.x1)/2,(green.bbox.y0+green.bbox.y1)/2);
  var rg=ctx.createRadialGradient(cc.x,cc.y,Math.min(wpx,hpx)*0.28,cc.x,cc.y,Math.max(wpx,hpx)*0.62);
  rg.addColorStop(0,'rgba(0,0,0,0)');rg.addColorStop(1,'rgba(20,60,25,0.35)');
  ctx.fillStyle=rg;ctx.fillRect(s0.x-4,s0.y-4,wpx+8,hpx+8);
  ctx.restore();
  /* fringe outline */
  pathOf(green.poly);
  ctx.lineJoin='round';
  ctx.strokeStyle='#2e6b33';ctx.lineWidth=Math.max(6,cam.scale*0.35);ctx.stroke();

  /* bunkers */
  for(var b=0;b<green.bunkers.length;b++){
    var bk=green.bunkers[b],bp=w2s(bk.x,bk.y);
    ctx.save();ctx.translate(bp.x,bp.y);ctx.rotate(bk.rot);
    ctx.fillStyle='#e8d194';
    ctx.beginPath();ctx.ellipse(0,0,bk.rx*cam.scale,bk.ry*cam.scale,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='rgba(120,90,40,0.25)';
    ctx.beginPath();ctx.ellipse(0,0,bk.rx*cam.scale*0.7,bk.ry*cam.scale*0.7,0,0,Math.PI*2);ctx.fill();
    ctx.restore();
  }

  /* cup: big, dark, impossible to miss -- with a pulsing gold ring */
  var cp=w2s(green.cup.x,green.cup.y);
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

  /* tall flagstick + red pennant (waves briefly on a make) */
  var fh=cupRpx*6.4;
  ctx.strokeStyle='#7f1a1a';ctx.lineWidth=Math.max(3.5,cam.scale*0.16);ctx.lineCap='round';
  ctx.beginPath();ctx.moveTo(cp.x,cp.y);ctx.lineTo(cp.x,cp.y-fh);ctx.stroke();
  var wave=(state.holed&&state.holeT<1.4)?Math.sin(state.holeT*14)*(1-state.holeT/1.4)*cupRpx*0.9:0;
  ctx.fillStyle='#e23b3b';
  ctx.beginPath();ctx.moveTo(cp.x,cp.y-fh);
  ctx.lineTo(cp.x+cupRpx*3.1,cp.y-fh+cupRpx*1.0+wave);
  ctx.lineTo(cp.x,cp.y-fh+cupRpx*2.0);ctx.closePath();ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,0.75)';ctx.lineWidth=1.5;
  ctx.beginPath();ctx.moveTo(cp.x,cp.y-fh);
  ctx.lineTo(cp.x+cupRpx*3.1,cp.y-fh+cupRpx*1.0+wave);
  ctx.lineTo(cp.x,cp.y-fh+cupRpx*2.0);ctx.closePath();ctx.stroke();

  /* aim marker + line */
  drawAim(green);

  /* slope % badge near the ball */
  drawSlopeBadge(green);

  /* ball trail */
  if(state.trail&&state.trail.length>1){
    ctx.fillStyle='rgba(255,255,255,0.65)';
    for(var t2=0;t2<state.trail.length;t2+=2){
      var tp=w2s(state.trail[t2].x,state.trail[t2].y);
      ctx.beginPath();ctx.arc(tp.x,tp.y,2.2,0,Math.PI*2);ctx.fill();
    }
  }

  /* ball (hidden once holed; shrinks during the drop) */
  if(!state.holed){
    var bp2=w2s(state.ballX,state.ballY);
    var brpx=Math.max(6,BALL_R*cam.scale)*(state.ballScale==null?1:state.ballScale);
    ctx.fillStyle='rgba(0,0,0,0.28)';
    ctx.beginPath();ctx.ellipse(bp2.x+2,bp2.y+brpx*0.55,brpx*0.95,brpx*0.4,0,0,Math.PI*2);ctx.fill();
    var bgr=ctx.createRadialGradient(bp2.x-brpx*0.3,bp2.y-brpx*0.35,brpx*0.1,bp2.x,bp2.y,brpx);
    bgr.addColorStop(0,'#ffffff');bgr.addColorStop(1,'#cfd6da');
    ctx.fillStyle=bgr;ctx.beginPath();ctx.arc(bp2.x,bp2.y,brpx,0,Math.PI*2);ctx.fill();
  }else{
    /* splash + flag wave on make */
    var t=state.holeT||0;
    ctx.strokeStyle='rgba(255,255,255,'+Math.max(0,0.8-t*0.5)+')';
    ctx.lineWidth=3;
    ctx.beginPath();ctx.arc(cp.x,cp.y,cupRpx+((t*60)%26),0,Math.PI*2);ctx.stroke();
  }

  /* confetti (screen space) */
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

  /* green name + par + distance (bottom-left of the green view, clear of the HUD strip;
     lifted while the needle bar is up so they don't overlap) */
  ctx.fillStyle='rgba(255,255,255,0.92)';
  ctx.font='800 13px -apple-system,sans-serif';ctx.textAlign='left';
  var labelY=ch-PANEL_H-24;
  if(state.phase==='sweep')labelY-=100;
  ctx.fillText(green.name.toUpperCase()+'  \u2022  PAR '+green.par+'  \u2022  '+Math.round(green.dist)+' FT',14,labelY);
}

/* ================= game state / flow ================= */
var LEADERBOARD_URL='';
var GAME_ID='daily-putt';
var LS='dailyputt.v2';

function $(id){return document.getElementById(id);}
var holeLabel=$('holeLabel'),modeTag=$('modeTag'),
    scoreStrip=$('scoreStrip'),
    phaseHint=$('phaseHint'),phaseBtn=$('phaseBtn'),
    resultLine=$('resultLine'),
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
  mode:'daily', greens:[], hole:0,
  putts:0,               /* putts taken on the current hole (cap 6) */
  phase:'idle',            /* aim | locked | sweep | roll | drop | done */
  markerX:0, markerY:0, markerSet:false,
  ballX:0, ballY:0, trail:[], holed:false, holeT:0,
  ballScale:null,          /* set during the hole-out drop */
  dropT:0, dropFrom:null,
  parts:[],                /* confetti particles (screen space) */
  results:[],              /* per hole: {putts} */
  rolling:null,
  needle:0, sweepT0:null,  /* needle sweep state */
  seedStr:''               /* daily date or practice seed, for determinism */
};

function fmtDist(ft){
  var inch=Math.round(ft*12);
  if(inch<12)return inch+'"';
  return Math.floor(inch/12)+"'"+(inch%12)+'"';
}

/* scorecard strip: per-hole strokes colored vs par; live vs-par total */
function renderStrip(){
  var html='',strokes=0,parSum=0;
  for(var i=0;i<9;i++){
    var g=G.greens[i],r=G.results[i];
    var cls='scell'+(i===G.hole?' cur':'');
    var txt='&middot;';
    if(r){
      strokes+=r.putts;parSum+=g.par;
      var d=r.putts-g.par;
      cls+=d<0?' under':(d>0?' over':' even');
      txt=r.putts;
    }else if(i===G.hole&&G.putts>0){
      txt=G.putts;
    }
    html+='<div class="'+cls+'"><div class="n">'+(i+1)+'</div>'+
      '<div class="r">'+txt+'</div><div class="d">P'+g.par+'</div></div>';
  }
  scoreStrip.innerHTML=html;
  var diff=strokes-parSum;
  holeLabel.textContent=(G.hole<9?('HOLE '+(G.hole+1)+' / 9'):'DONE')+'  \u2022  '+fmtVsPar(diff);
}

function startRound(mode){
  G.mode=mode;
  G.seedStr=mode==='daily'?dateStr():'prac|'+Date.now();
  G.greens=genGreens(G.seedStr);
  G.hole=0;G.results=[];
  modeTag.textContent=mode==='daily'?'DAILY':'PRACTICE';
  modeTag.className=mode==='daily'?'':'prac';
  startScreen.classList.add('hidden');
  needleBar.classList.add('hidden');
  startHole();
}

function startHole(){
  var g=G.greens[G.hole];
  fitStatic(g);
  buildShade(g); /* hillshade depth art for this green */
  G.phase='aim';
  /* marker defaults to the cup: tap the green to adjust */
  G.markerX=g.cup.x;G.markerY=g.cup.y;G.markerSet=true;
  G.ballX=g.ball.x;G.ballY=g.ball.y;
  G.putts=0;
  G.trail=[];G.holed=false;G.holeT=0;G.rolling=null;
  G.needle=0;G.sweepT0=null;
  needleBar.classList.add('hidden');
  clearTicks();
  setBtn('lock');
  phaseHint.textContent='Touch + drag the green to place the marker \u00B7 then LOCK THE LINE';
  resultLine.classList.add('hidden');
  renderStrip();
}

function setBtn(kind){
  /* kind: lock | putt | stop | next | hide */
  phaseBtn.classList.remove('hidden');
  phaseBtn.classList.remove('stop');
  if(kind==='lock')phaseBtn.textContent='LOCK THE LINE';
  else if(kind==='putt')phaseBtn.textContent='PUTT';
  else if(kind==='stop'){phaseBtn.textContent='STOP';phaseBtn.classList.add('stop');}
  else if(kind==='next')phaseBtn.textContent=G.hole<8?'Next hole':'See results';
  else phaseBtn.classList.add('hidden');
}

/* Tap/drag placement: on touch the marker floats ~48px ABOVE the
   fingertip (so the finger never covers it) with the line + distance
   pill updating live; it commits on release. Mouse uses no offset. */
var dragging=false,dragOff=0;
function placeMarkerAt(cx,cy,offPx){
  var g=G.greens[G.hole];
  var offs=offPx?[offPx,32,16,0]:[0];
  for(var i=0;i<offs.length;i++){
    var w=s2w(cx,cy-offs[i]);
    if(!inPoly(w.x,w.y,g.poly))continue;       /* must be on the green */
    if(dist2(w.x,w.y,G.ballX,G.ballY)<1.5)continue; /* not on top of the ball */
    G.markerX=w.x;G.markerY=w.y;G.markerSet=true;
    return true;
  }
  return false;
}
canvas.addEventListener('pointerdown',function(e){
  if(G.phase==='aim'){
    dragging=true;dragOff=(e.pointerType==='mouse')?0:48;
    placeMarkerAt(e.clientX,e.clientY,dragOff);
  }else if(G.phase==='locked'){
    /* tap-drag the green to go back and adjust in one gesture */
    G.phase='aim';
    dragging=true;dragOff=(e.pointerType==='mouse')?0:48;
    placeMarkerAt(e.clientX,e.clientY,dragOff);
    setBtn('lock');
    phaseHint.textContent='Touch + drag the green to place the marker \u00B7 then LOCK THE LINE';
  }
});
canvas.addEventListener('pointermove',function(e){
  if(dragging&&G.phase==='aim')placeMarkerAt(e.clientX,e.clientY,dragOff);
});
function endDrag(){dragging=false;}
canvas.addEventListener('pointerup',endDrag);
canvas.addEventListener('pointercancel',endDrag);

/* distance calibration ticks on the needle bar: at 25/50/75% of pure
   power, show the expected carry in feet for the CURRENT marker distance,
   so EASED stops can be calibrated. carry ~= markerDist * (n/PURE_MID). */
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
phaseBtn.addEventListener('click',function(){
  if(G.phase==='aim'&&G.markerSet){
    G.phase='locked';
    setBtn('putt');
    phaseHint.textContent='Line locked \u2014 press PUTT, then STOP in the gold.';
  }else if(G.phase==='locked'){
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
  var g=G.greens[G.hole];
  var sx=G.ballX,sy=G.ballY;
  var markerDist=dist2(sx,sy,G.markerX,G.markerY);
  var aimA=Math.atan2(G.markerY-sy,G.markerX-sx);
  var seed=hashStr(G.seedStr+'|'+G.hole+'|'+G.putts);
  var st=resolveStroke(g,{x:sx,y:sy},markerDist,aimA,n,seed);
  G.putts++;
  G.phase='roll';G.trail=[];
  G.rolling={res:st.res,grade:st.grade,bend:st.bend,
    t:0,shown:0,sx:sx,sy:sy,ax:Math.cos(aimA),ay:Math.sin(aimA)};
  setBtn('hide');
  phaseHint.textContent='Rolling\u2026';
  resultLine.classList.add('hidden');
}

function settleStroke(){
  var g=G.greens[G.hole],rr=G.rolling,r=rr.res,grade=rr.grade;
  G.ballX=r.x;G.ballY=r.y;
  G.phase='done';G.holed=r.holed;G.holeT=0.001;
  var gc=grade==='PURE'?'g-pure':grade==='OVERSWING'?'g-over':'g-ease';
  var gradeHtml='<span class="grade '+gc+'">'+grade+'</span>';
  if(r.holed){
    G.results[G.hole]={putts:G.putts};
    /* confetti burst at the cup (screen space; visual only) */
    var cs=w2s(g.cup.x,g.cup.y);
    var crng=mulberry32((Date.now()^0x5f3d)>>>0);
    var cols=['#ffd23c','#ffffff','#22c55e','#e23b3b'];
    for(var ci=0;ci<16;ci++){
      var ca=crng()*Math.PI*2, csp=60+crng()*170;
      G.parts.push({x:cs.x,y:cs.y,vx:Math.cos(ca)*csp,vy:Math.sin(ca)*csp-130,
        rot:crng()*6.28,vr:(crng()-0.5)*14,life:0.85,c:cols[ci%4]});
    }
    var nm=scoreName(G.putts,g.par);
    resultLine.innerHTML=gradeHtml+'HOLE '+(G.hole+1)+' IN '+G.putts+' \u00B7 '+nm;
    showNextHoleUI();
    return;
  }
  if(G.putts>=6){
    /* six-putt cap: the ball is picked up, green scores 6 */
    G.results[G.hole]={putts:6};
    resultLine.innerHTML=gradeHtml+'PICKED UP \u00B7 6';
    showNextHoleUI();
    return;
  }
  /* putt again from where it lies */
  var dft=dist2(r.x,r.y,g.cup.x,g.cup.y);
  var detail;
  if(r.plugged)detail='PLUGGED IN THE BUNKER';
  else if(r.offGreen)detail='OFF THE GREEN';
  else if(r.lipped)detail='LIPPED OUT \u2014 TOO HOT';
  else{
    var proj=(r.x-rr.sx)*rr.ax+(r.y-rr.sy)*rr.ay;
    var need=dist2(rr.sx,rr.sy,g.cup.x,g.cup.y);
    var dtxt=fmtDist(dft);
    if(proj<need-1)detail=dtxt+' SHORT';
    else if(proj>need+1)detail=dtxt+' PAST';
    else{
      /* pin-high but offline: which side? */
      var lat=(r.x-rr.sx)*(-rr.ay)+(r.y-rr.sy)*(rr.ax);
      detail=dtxt+(lat>0.5?' RIGHT':(lat<-0.5?' LEFT':''));
    }
  }
  var bendTxt='';
  if(grade==='OVERSWING'&&rr.bend!==0){
    var bdeg=Math.round(Math.abs(rr.bend)*180/Math.PI);
    var lat2=(r.x-rr.sx)*(-rr.ay)+(r.y-rr.sy)*(rr.ax);
    bendTxt=' \u00D7 '+bdeg+'\u00B0 '+(lat2>=0?'PUSH':'PULL');
  }
  resultLine.innerHTML=gradeHtml+detail+bendTxt;
  resultLine.classList.remove('hidden');
  /* re-aim from the lie; marker defaults back to the cup */
  G.phase='aim';
  G.markerX=g.cup.x;G.markerY=g.cup.y;G.markerSet=true;
  G.trail=[];G.rolling=null;
  setBtn('lock');
  phaseHint.textContent='PUTT '+(G.putts+1)+' OF 6 \u2014 tap the green to move the marker, then LOCK THE LINE.';
  renderStrip();
}

/* hole finished (holed or picked up): record + offer the next hole */
function showNextHoleUI(){
  resultLine.classList.remove('hidden');
  phaseHint.textContent=G.hole<8?'On to the next green.':'That\u2019s all nine.';
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
    s+=r.putts;ps+=G.greens[i].par;done++;
  }
  return{strokes:s,par:ps,done:done};
}

/* ---- main loop ---- */
var lastT=0;
function frame(t){
  var dt=Math.min(0.05,(t-lastT)/1000||0.016);lastT=t;
  nowS=t/1000;
  if(G.greens.length&&G.hole<9){
    var g=G.greens[G.hole];
    if(G.phase==='sweep'){
      /* the needle sweeps up and back down, repeatedly */
      if(G.sweepT0==null)G.sweepT0=t;
      var el=(t-G.sweepT0)/1000;
      var p=(el/SWEEP_T)%2;
      G.needle=p<1?p*100:(2-p)*100;
      needleEl.style.left='calc('+G.needle.toFixed(2)+'% - 5.5px)'; /* 11px needle, centered */
    }
    if(G.phase==='roll'&&G.rolling){
      var rr=G.rolling;
      rr.t+=dt;
      var want=Math.min(rr.res.trail.length,Math.floor(rr.t*90/1.1)); /* 10% slower roll pacing (visual only) */
      if(want>rr.shown){
        rr.shown=want;
        var tp=rr.res.trail[want-1];
        G.ballX=tp.x;G.ballY=tp.y;
        G.trail=rr.res.trail.slice(0,want);
      }
      if(rr.shown>=rr.res.trail.length){
        if(rr.res.holed){
          /* hole-out drop: ball sinks into the cup over 0.18s, then score */
          G.phase='drop';G.dropT=0;G.ballScale=1;
          G.dropFrom={x:G.ballX,y:G.ballY};
        }else{
          /* ease the ball to its rest spot */
          var k=Math.min(1,dt*3);
          G.ballX+=(rr.res.x-G.ballX)*k;G.ballY+=(rr.res.y-G.ballY)*k;
          if(dist2(G.ballX,G.ballY,rr.res.x,rr.res.y)<0.05)settleStroke();
        }
      }
    }
    if(G.phase==='drop'){
      /* ball drops into the cup: ease to cup center while shrinking */
      G.dropT+=dt;
      var gdr=G.greens[G.hole];
      var dk=Math.min(1,G.dropT/0.18), de=1-Math.pow(1-dk,3);
      G.ballX=G.dropFrom.x+(gdr.cup.x-G.dropFrom.x)*de;
      G.ballY=G.dropFrom.y+(gdr.cup.y-G.dropFrom.y)*de;
      G.ballScale=1-dk*0.92;
      if(dk>=1){G.ballScale=null;settleStroke();}
    }
    if(G.parts.length){
      /* confetti physics (screen space) */
      for(var cpi=G.parts.length-1;cpi>=0;cpi--){
        var pt=G.parts[cpi];
        pt.life-=dt;
        if(pt.life<=0){G.parts.splice(cpi,1);continue;}
        pt.vy+=520*dt;pt.x+=pt.vx*dt;pt.y+=pt.vy*dt;pt.rot+=pt.vr*dt;
      }
    }
    if(G.holed)G.holeT+=dt;
    drawGreen(g,{phase:G.phase,ballX:G.ballX,ballY:G.ballY,
      trail:G.trail,holed:G.holed,holeT:G.holeT,ballScale:G.ballScale,parts:G.parts});
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
  var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
  return h+':'+('0'+m).slice(-2)+':'+('0'+ss).slice(-2);}
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
playBtn.addEventListener('click',function(){startRound('daily');});
practiceBtn.addEventListener('click',function(){startRound('practice');});

/* ================= leaderboard (shared pattern) ================= */
function lbOn(){return !!LEADERBOARD_URL;}
function lbPost(obj){
  if(!lbOn())return Promise.resolve(null);
  return fetch(LEADERBOARD_URL,{method:'POST',redirect:'follow',
    headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(obj)})
    .then(function(r){return r.json();}).catch(function(){return null;});
}
function lbBoard(){
  if(!lbOn())return Promise.resolve(null);
  var url=LEADERBOARD_URL+'?game='+encodeURIComponent(GAME_ID)+'&date='+encodeURIComponent(dateStr());
  return fetch(url,{redirect:'follow'}).then(function(r){return r.json();}).catch(function(){return null;});
}
var USER_LS='dailyputt.user';
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
  nameAfter=after||null;nameState='name';pendingName='';
  nameInput.value='';phraseInput.value='';
  phraseWrap.classList.add('hidden');nameMsg.textContent='';
  nameSub.textContent='Claim a name for the daily leaderboard.';
  nameGo.textContent='CHECK NAME';
  nameScreen.classList.remove('hidden');
  setTimeout(function(){nameInput.focus();},60);
}
function closeName(){nameScreen.classList.add('hidden');nameAfter=null;}
nameGo.addEventListener('click',function(){
  if(nameState==='name'){
    var n=nameInput.value.trim();
    if(!validName(n)){nameMsg.textContent='Letters, numbers and spaces only, max 16 chars.';return;}
    nameMsg.textContent='checking\u2026';
    lbPost({action:'check',username:n}).then(function(res){
      if(!res){nameMsg.textContent='Could not reach the leaderboard. Try again.';return;}
      if(res.status==='invalid'){nameMsg.textContent='Letters, numbers and spaces only, max 16 chars.';return;}
      pendingName=res.display||n;
      phraseWrap.classList.remove('hidden');nameMsg.textContent='';
      if(res.status==='free'){
        nameState='claim';
        nameSub.textContent='\u201C'+pendingName+'\u201D is yours \u2014 set a secret phrase to lock it in.';
        nameGo.textContent='CLAIM NAME';
      }else{
        nameState='unlock';
        nameSub.textContent='\u201C'+pendingName+'\u201D is taken \u2014 enter its secret phrase to use it.';
        nameGo.textContent='UNLOCK NAME';
      }
      setTimeout(function(){phraseInput.focus();},60);
    });
  }else{
    var ph=phraseInput.value;
    if(ph.length<4){nameMsg.textContent='Phrase needs at least 4 characters.';return;}
    nameMsg.textContent='working\u2026';
    sha256hex(pendingName.toLowerCase()+'|'+ph).then(function(hash){
      return lbPost({action:nameState==='claim'?'claim':'verify',username:pendingName,phrase_hash:hash})
        .then(function(res){return{res:res,hash:hash};});
    }).then(function(out){
      if(out.res&&out.res.ok){
        setUser({name:pendingName,hash:out.hash});
        refreshNameBtn();closeName();
        var f=nameAfter;nameAfter=null;if(f)f();
      }else{nameMsg.textContent=(out.res&&out.res.error)||'Wrong phrase \u2014 try again.';}
    }).catch(function(){nameMsg.textContent='Something went wrong. Try again.';});
  }
});
$('nameCancel').addEventListener('click',closeName);
nameBtn.addEventListener('click',function(){openName(null);});
logoutBtn.addEventListener('click',function(){clearUser();refreshNameBtn();renderBoard();});

var RES_LS='dailyputt.results.v2';
function loadResults(){try{var a=JSON.parse(localStorage.getItem(RES_LS));return Array.isArray(a)?a:[];}catch(e){return[];}}
function recordResult(rec){
  var a=loadResults();a.push(rec);
  if(a.length>200)a=a.slice(-200);
  try{localStorage.setItem(RES_LS,JSON.stringify(a));}catch(e){}
}

function showResults(){
  var t=totals();
  resTitle.textContent=G.mode==='daily'?'Today\u2019s round':'Practice round';
  var per=G.results.map(function(r,i){
    return r?r.putts:'\u2013';
  }).join(' \u00B7 ');
  var vs=fmtVsPar(t.strokes-t.par);
  resScore.innerHTML=t.strokes+'<small> putts \u00B7 '+vs+'</small><br><small>'+per+'</small>';
  resultsScreen.classList.remove('hidden');
  if(G.mode==='daily'){
    recordResult({date:dateStr(),mode:'daily',strokes:t.strokes,
      perHole:G.results.map(function(r){return r?r.putts:0;})});
    var doSubmit=function(){
      var u=getUser();
      if(lbOn()&&u&&u.hash)lbPost({action:'submit',game:GAME_ID,date:dateStr(),
        username:u.name,phrase_hash:u.hash,score:t.strokes});
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
    lbBoard().then(function(rows){
      if(!rows||!rows.length){lbList.innerHTML='<div class="lbRow"><span>No scores yet today.</span></div>';return;}
      var u=getUser(),html='';
      for(var i=0;i<rows.length;i++){
        var r=rows[i],me=u&&r.username===u.name;
        html+='<div class="lbRow'+(me?' me':'')+'"><span>#'+(i+1)+' '+esc(r.username)+'</span><span>'+r.score+' putts</span></div>';
      }
      lbList.innerHTML=html;
    });
  }
  var hist=loadResults().slice().reverse(),html2='';
  for(var i=0;i<Math.min(12,hist.length);i++){
    var h=hist[i];
    html2+='<div class="lbRow"><span>'+esc(h.date)+'</span><span>'+h.strokes+' putts</span></div>';
  }
  histList.innerHTML=html2||'<div class="lbRow"><span>No rounds yet.</span></div>';
}
boardBtn.addEventListener('click',function(){
  resTitle.textContent='Leaderboard';resScore.innerHTML='';
  resultsScreen.classList.remove('hidden');renderBoard();
});
resultsClose.addEventListener('click',function(){
  resultsScreen.classList.add('hidden');
  refreshStart();
  startScreen.classList.remove('hidden');
});

/* ================= boot ================= */
resize();
refreshNameBtn();
refreshStart();
if(typeof location!=='undefined'&&location.search&&location.search.indexOf('smoke')>=0){
  startRound('practice'); /* smoke-test hook: skip the start screen */
}
requestAnimationFrame(loop);

/* test hooks (node) */
var PuttTest={
  hashStr:hashStr,mulberry32:mulberry32,genGreens:genGreens,simulate:simulate,
  gradOf:gradOf,slopeInfo:slopeInfo,inPoly:inPoly,
  ARCHES:ARCHES,fitStatic:fitStatic,w2s:w2s,s2w:s2w,cam:cam,
  needleGrade:needleGrade,needleToPower:needleToPower,overswingBend:overswingBend,
  resolveStroke:resolveStroke,puttOutcome:puttOutcome,
  scoreName:scoreName,fmtVsPar:fmtVsPar,shadeGrid:shadeGrid,buildShade:buildShade,
  PANEL_H:PANEL_H,TOP_H:TOP_H,PURE_LO:PURE_LO,PURE_HI:PURE_HI,PURE_MID:PURE_MID,
  SWEEP_T:SWEEP_T,
  consts:{FRICTION:FRICTION,SLOPE_G:SLOPE_G,CUP_R:CUP_R,V_CAP:V_CAP,DMAX:DMAX,
    BAR_MAX:BAR_MAX,V_STOP:V_STOP},
  flow:{ /* driven by the render smoke test */
    G:G,startRound:startRound,doStop:doStop,settleStroke:settleStroke,
    frame:frame,placeMarkerAt:placeMarkerAt,phaseBtn:phaseBtn
  }
};
if(typeof module!=='undefined'&&module.exports)module.exports=PuttTest;

})();
