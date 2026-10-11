/* ============================================================
   DAILY PUTT -- nine greens, stroke play: up to 6 putts each.
   Fewest total strokes wins. Original code. Top-down putting,
   date-seeded daily set.

   Controls (owner spec, 2026-10-10 -- follow to the letter):
   1. AIM LINE FIRST: a bold, unmissable line starts at the ball.
      Drag anywhere on the green to rotate it and set direction.
   2. PULL/STRETCH for distance: drag farther = longer line =
      farther putt (slingshot feel). Distance readout while
      stretching; dots along the line keep it countable (8 ft each).
   3. VERTICAL TOUCH BAR to strike: always visible during every
      putt. BOTTOM = soft/slow, TOP = firm/fast. TAP the bar to
      hit -- tap position sets the speed. A gold mark on the bar
      shows where to tap for exactly the stretched distance;
      tap the mark = PURE (perfect input rewarded).
   4. Repeat until it goes in (6-putt cap; ball stays where it stops).

   Camera is STATIC: the whole green always fits on screen, ball
   and hole always visible together -- nothing pans or zooms.
   Slopes read via animated downhill chevrons tiled across the
   green. Physics and chevrons sample the SAME numeric gradient,
   so the picture and the ball always agree.
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
var DOT_FT=8;            /* aim-line dots: 1 dot = 8 ft of carry     */
var BAR_MAX=1.15;        /* bar top = 1.15 power (overhit headroom)  */
var STRETCH_MIN=4;       /* shortest aim-line stretch (ft)           */
var STRETCH_MAX=92;      /* longest stretch = DMAX*BAR_MAX (ft)      */
var DT=1/240;

/* ================= green archetypes =================
   Each archetype builds a height-field closure h(x,y) plus metadata.
   Physics AND the drawn slope chevrons both sample the same numeric
   gradient, so they always agree. */
var ARCHES=[
  {id:'gentle',  name:'Gentle tilt',   R:[26,34], dMin:14, dMax:26},
  {id:'steep',   name:'Side slope',    R:[24,30], dMin:12, dMax:22},
  {id:'tier',    name:'Two-tier',      R:[28,36], dMin:16, dMax:30},
  {id:'ridge',   name:'Center ridge',  R:[26,34], dMin:16, dMax:28},
  {id:'bowl',    name:'Bowl',          R:[24,32], dMin:12, dMax:24},
  {id:'sbreak',  name:'S-break',       R:[28,36], dMin:18, dMax:32},
  {id:'pinch',   name:'Bunker pinch',  R:[26,32], dMin:14, dMax:26},
  {id:'lag',     name:'Long lag',      R:[36,44], dMin:52, dMax:66},
  {id:'tiny',    name:'Tiny green',    R:[12,16], dMin:10, dMax:18}
];

/* numeric gradient of h -- single source of truth for physics + chevrons */
function gradOf(h,x,y){
  var e=0.06;
  return {x:(h(x+e,y)-h(x-e,y))/(2*e), y:(h(x,y+e)-h(x,y-e))/(2*e)};
}

function blobPoly(rng,cx,cy,R,waist){
  var pts=[],n=26;
  for(var i=0;i<n;i++){
    var a=i/n*Math.PI*2;
    var w=1+0.10*Math.sin(3*a+rng()*6.28)+0.06*Math.sin(5*a+rng()*6.28);
    var r=R*w;
    if(waist) r*=(1-waist*Math.pow(Math.abs(Math.sin(a)),6)); /* pinch top/bottom */
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
function randInside(rng,poly,cx,cy,R){
  for(var k=0;k<200;k++){
    var a=rng()*Math.PI*2,r=Math.sqrt(rng())*R*0.72;
    var x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r;
    if(inPoly(x,y,poly))return{x:x,y:y};
  }
  return{x:cx,y:cy};
}

/* Build one green. rng is seeded. */
function buildGreen(rng,archId){
  var A=null;
  for(var i=0;i<ARCHES.length;i++)if(ARCHES[i].id===archId)A=ARCHES[i];
  var R=A.R[0]+rng()*(A.R[1]-A.R[0]);
  var waist=(archId==='pinch')?0.34:0;
  var poly=blobPoly(rng,0,0,R,waist);
  /* place ball+cup as a pair so both are always on the green:
     symmetric about a jittered center at the wanted distance apart */
  var wantD=A.dMin+rng()*(A.dMax-A.dMin);
  var ball=null,cup=null,k2,a2,dx2,dy2,bx2,by2,cx3,cy3;
  for(var k=0;k<400&&!ball;k++){
    var a=rng()*Math.PI*2, dx=Math.cos(a), dy=Math.sin(a);
    var jx=(rng()-0.5)*R*0.5, jy=(rng()-0.5)*R*0.5;
    bx2=jx+dx*wantD/2; by2=jy+dy*wantD/2;
    cx3=jx-dx*wantD/2; cy3=jy-dy*wantD/2;
    if(inPoly(bx2,by2,poly)&&inPoly(cx3,cy3,poly)){ball={x:bx2,y:by2};cup={x:cx3,y:cy3};}
  }
  if(!ball){ /* green too small for wantD: shrink until a pair fits */
    var wd=wantD;
    while(wd>A.dMin*0.5&&!ball){
      wd*=0.9;
      for(k2=0;k2<200&&!ball;k2++){
        a2=rng()*Math.PI*2; dx2=Math.cos(a2); dy2=Math.sin(a2);
        bx2=dx2*wd/2; by2=dy2*wd/2; cx3=-dx2*wd/2; cy3=-dy2*wd/2;
        if(inPoly(bx2,by2,poly)&&inPoly(cx3,cy3,poly)){ball={x:bx2,y:by2};cup={x:cx3,y:cy3};}
      }
    }
  }
  if(!ball){ball={x:-R*0.3,y:0};cup={x:R*0.3,y:0};}
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
    s=0.55+rng()*0.3;
    h=(function(s,R){return function(x,y){
      var r=Math.sqrt(x*x+y*y)/R; return s*r*r;
    };})(s,R);
  }else if(archId==='sbreak'){
    s=0.022+rng()*0.014;
    var W=R*1.6, rot=rng()*Math.PI;
    var ca=Math.cos(rot),sa=Math.sin(rot);
    h=(function(s,W,ca,sa){return function(x,y){
      var u=x*ca+y*sa, v=-x*sa+y*ca;
      return s*v*Math.sin(Math.PI*u/W);
    };})(s,W,ca,sa);
  }else if(archId==='pinch'){
    s=0.007+rng()*0.005; /* softened 2026-10-10: was 0.012-0.020, which demanded
      ~8deg aim corrections on top of the bunker thread -- helpless, not nasty */
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
    s=0.008+rng()*0.006;
    h=(function(s,tA){return function(x,y){return s*(x*Math.cos(tA)+y*Math.sin(tA));};})(s,tA);
  }else{ /* tiny */
    s=0.014+rng()*0.010;
    h=(function(s,tA){return function(x,y){return s*(x*Math.cos(tA)+y*Math.sin(tA));};})(s,tA);
  }
  var xs=poly.map(function(p){return p.x;}),ys=poly.map(function(p){return p.y;});
  return {
    arch:archId, name:A.name, R:R, poly:poly, ball:ball, cup:cup,
    dist:d, lineA:lineA, h:h, bunkers:bunk||[],
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

/* ================= control mapping (pure -- testable) =================
   stretch (ft) -> power: on a flat green, power p carries DMAX*p feet,
   so stretching L feet aims for an L-foot putt. The bar maps its full
   height to [0, BAR_MAX]; the gold mark sits where a tap reproduces
   the stretched distance exactly. */
function stretchToPower(ft){return clamp(ft/DMAX,0,BAR_MAX);}
function tapFracToPower(frac){return clamp(frac,0,1)*BAR_MAX;}
function tapYToPower(tapY,top,h){return tapFracToPower(1-(tapY-top)/h);}
/* grade the strike: absolute deviation of tap power from the mark.
   PURE = within +/-0.0575 power units (5% of bar height) -- the same
   absolute window the old meter used, so perfect input is rewarded. */
function gradeTap(power,mark){
  var d=power-mark,ad=Math.abs(d);
  if(ad<=0.0575)return'PURE';
  if(ad<=0.115)return'SOLID';
  return d<0?'SOFT':'FIRM';
}

/* ================= rendering ================= */
var canvas=document.getElementById('game'),ctx=canvas.getContext('2d');
var cw=0,ch=0;
function resize(){
  var dpr=Math.min(2,window.devicePixelRatio||1);
  cw=window.innerWidth;ch=window.innerHeight;
  canvas.width=Math.round(cw*dpr);canvas.height=Math.round(ch*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  sizeBar();
}
window.addEventListener('resize',resize);

/* STATIC camera: the whole green always fits on screen. Ball and cup
   are always visible together. Nothing pans, nothing zooms mid-putt. */
var PANEL_H=150,TOP_H=110;
var cam={scale:1,ox:0,oy:0,vcx:0,vcy:0};
function fitStatic(green){
  var bb=green.bbox,pad=7;
  var vx0=10,vx1=cw-100,vy0=TOP_H+10,vy1=ch-PANEL_H-10;
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

/* slope chevrons: tiled across the green, pointing DOWNHILL.
   size + count = steepness. Animated so they flow downhill.
   Samples the same numeric gradient the physics uses. */
var nowS=0; /* seconds, updated in the main loop */
function slopeDirOf(h,x,y){
  var g=gradOf(h,x,y);
  var m=Math.sqrt(g.x*g.x+g.y*g.y);
  if(m<0.004)return null;
  return {x:-g.x/m, y:-g.y/m, steep:m};
}
function drawChevrons(green){
  var SP=6.5, bb=green.bbox;
  ctx.lineCap='round';ctx.lineJoin='round';
  for(var gx=bb.x0+3;gx<=bb.x1-3;gx+=SP){
    for(var gy=bb.y0+3;gy<=bb.y1-3;gy+=SP){
      if(!inPoly(gx,gy,green.poly))continue;
      if(dist2(gx,gy,green.cup.x,green.cup.y)<2.4)continue;
      if(dist2(gx,gy,G.ballX,G.ballY)<2.4)continue;
      var d=slopeDirOf(green.h,gx,gy);
      if(!d)continue;
      var n=d.steep<0.015?1:(d.steep<0.030?2:3);
      var size=clamp(9+d.steep*380,10,30);
      var alpha=clamp(0.38+d.steep*11,0.38,0.85);
      var ang=Math.atan2(d.y,d.x);
      var flow=((nowS*0.9+(gx*0.7+gy*1.3)*0.05)%1+1)%1;
      var gap=size*1.15;
      ctx.strokeStyle='rgba(13,28,52,'+alpha.toFixed(3)+')';
      ctx.lineWidth=Math.max(2.5,size*0.22);
      for(var k=0;k<n;k++){
        var off=(k-flow)*gap;
        var s=w2s(gx+d.x*off,gy+d.y*off);
        var r=size*0.5;
        ctx.save();ctx.translate(s.x,s.y);ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(-r*0.7,-r);ctx.lineTo(r*0.7,0);ctx.lineTo(-r*0.7,r);
        ctx.stroke();ctx.restore();
      }
    }
  }
}

/* the aim line: bold red-cased white line, countable dots (8 ft each),
   arrowhead, distance pill. Unmissable. */
function drawAimLine(){
  if(G.phase!=='aim')return;
  var ex=G.ballX+Math.cos(G.aimA)*G.stretchFt,
      ey=G.ballY+Math.sin(G.aimA)*G.stretchFt;
  var bs=w2s(G.ballX,G.ballY),be=w2s(ex,ey);
  ctx.lineCap='round';
  ctx.strokeStyle='#dc2626';ctx.lineWidth=8;
  ctx.beginPath();ctx.moveTo(bs.x,bs.y);ctx.lineTo(be.x,be.y);ctx.stroke();
  ctx.strokeStyle='#ffffff';ctx.lineWidth=4.5;
  ctx.beginPath();ctx.moveTo(bs.x,bs.y);ctx.lineTo(be.x,be.y);ctx.stroke();
  var ndots=Math.floor(G.stretchFt/DOT_FT);
  for(var k=1;k<=ndots;k++){
    var dp=w2s(G.ballX+Math.cos(G.aimA)*k*DOT_FT,
               G.ballY+Math.sin(G.aimA)*k*DOT_FT);
    ctx.fillStyle='rgba(0,0,0,0.25)';
    ctx.beginPath();ctx.arc(dp.x+1.5,dp.y+2,3.4,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#ffffff';
    ctx.beginPath();ctx.arc(dp.x,dp.y,3.4,0,Math.PI*2);ctx.fill();
  }
  /* arrowhead */
  ctx.save();ctx.translate(be.x,be.y);ctx.rotate(G.aimA);
  ctx.fillStyle='#dc2626';
  ctx.beginPath();ctx.moveTo(15,0);ctx.lineTo(-5,-11);ctx.lineTo(-5,11);ctx.closePath();ctx.fill();
  ctx.fillStyle='#ffffff';
  ctx.beginPath();ctx.moveTo(10,0);ctx.lineTo(-5,-7);ctx.lineTo(-5,7);ctx.closePath();ctx.fill();
  ctx.restore();
  /* distance pill */
  var lbl=Math.round(G.stretchFt)+' FT';
  ctx.font='800 13px -apple-system,sans-serif';
  var tw=ctx.measureText(lbl).width;
  var lx=be.x+16,ly=be.y-16;
  ctx.fillStyle='rgba(17,24,39,0.88)';
  roundRectP(lx-9,ly-14,tw+18,26,9);ctx.fill();
  ctx.fillStyle='#ffffff';ctx.textAlign='left';
  ctx.fillText(lbl,lx,ly+5);
}

function drawGreen(green,state){
  /* backdrop */
  var bg=ctx.createLinearGradient(0,0,0,ch);
  bg.addColorStop(0,'#2c6e35');bg.addColorStop(1,'#1d4a26');
  ctx.fillStyle=bg;ctx.fillRect(0,0,cw,ch);

  /* green body */
  ctx.save();
  pathOf(green.poly);
  ctx.fillStyle='#3a7d3f';ctx.fill();
  /* mowing stripes clipped to green */
  ctx.clip();
  var s0=w2s(green.bbox.x0-4,green.bbox.y0-4),s1=w2s(green.bbox.x1+4,green.bbox.y1+4);
  var wpx=Math.abs(s1.x-s0.x),hpx=Math.abs(s1.y-s0.y);
  var stripeH=Math.max(14,cam.scale*2.2),yy=s0.y,flip=false;
  while(yy<s1.y){
    ctx.fillStyle=flip?'#55a04a':'#5cab52';
    ctx.fillRect(s0.x-4,yy,wpx+8,stripeH);
    yy+=stripeH;flip=!flip;
  }
  /* inner shading toward edges (radii must be >= 0 -- negative throws) */
  var cc=w2s((green.bbox.x0+green.bbox.x1)/2,(green.bbox.y0+green.bbox.y1)/2);
  var rg=ctx.createRadialGradient(cc.x,cc.y,Math.min(wpx,hpx)*0.28,cc.x,cc.y,Math.max(wpx,hpx)*0.62);
  rg.addColorStop(0,'rgba(0,0,0,0)');rg.addColorStop(1,'rgba(20,60,25,0.35)');
  ctx.fillStyle=rg;ctx.fillRect(s0.x-4,s0.y-4,wpx+8,hpx+8);
  ctx.restore();
  /* fringe outline */
  pathOf(green.poly);
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

  /* slope chevrons (same gradient the physics uses) */
  drawChevrons(green);

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

  /* aim line (only while aiming) */
  drawAimLine();

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

  /* green name + distance (bottom-left of the green view, clear of the HUD strip) */
  ctx.fillStyle='rgba(255,255,255,0.92)';
  ctx.font='800 13px -apple-system,sans-serif';ctx.textAlign='left';
  ctx.fillText(green.name.toUpperCase()+'  •  '+Math.round(green.dist)+' FT',14,ch-PANEL_H-24);
}

/* ================= game state / flow ================= */
var LEADERBOARD_URL='';
var GAME_ID='daily-putt';
var LS='dailyputt.v2';

var holeLabel=document.getElementById('holeLabel'),modeTag=document.getElementById('modeTag'),
    scoreStrip=document.getElementById('scoreStrip'),
    phaseHint=document.getElementById('phaseHint'),phaseBtn=document.getElementById('phaseBtn'),
    resultLine=document.getElementById('resultLine'),
    puttBar=document.getElementById('puttBar'),barTrack=document.getElementById('barTrack'),
    barMark=document.getElementById('barMark'),barMarkLbl=document.getElementById('barMarkLbl'),
    startScreen=document.getElementById('startScreen'),playBtn=document.getElementById('playBtn'),
    practiceBtn=document.getElementById('practiceBtn'),lockBox=document.getElementById('lockBox'),
    lockTime=document.getElementById('lockTime'),lockScore=document.getElementById('lockScore'),
    nameScreen=document.getElementById('nameScreen'),nameInput=document.getElementById('nameInput'),
    phraseInput=document.getElementById('phraseInput'),phraseWrap=document.getElementById('phraseWrap'),
    nameMsg=document.getElementById('nameMsg'),nameGo=document.getElementById('nameGo'),
    nameSub=document.getElementById('nameSub'),nameBtn=document.getElementById('nameBtn'),
    boardBtn=document.getElementById('boardBtn'),
    resultsScreen=document.getElementById('resultsScreen'),resTitle=document.getElementById('resTitle'),
    resScore=document.getElementById('resScore'),lbTitle=document.getElementById('lbTitle'),
    lbList=document.getElementById('lbList'),histList=document.getElementById('histList'),
    logoutBtn=document.getElementById('logoutBtn'),resultsClose=document.getElementById('resultsClose');

function sizeBar(){
  /* vertical touch bar: sized to the green viewport, right side */
  var gh=(ch-PANEL_H-10)-(TOP_H+10);
  var bh=Math.round(clamp(gh-64,190,360));
  puttBar.style.height=bh+'px';
  puttBar.style.top=((TOP_H+10)+(gh-bh)/2)+'px';
}
function updateBarMark(){
  /* gold mark: tap HERE to reproduce the stretched distance exactly */
  var p=stretchToPower(G.stretchFt)/BAR_MAX; /* 0 = bottom(soft) .. 1 = top(firm) */
  barMark.style.bottom='calc('+(p*100).toFixed(2)+'% - 3px)';
  barMarkLbl.textContent=Math.round(G.stretchFt)+' FT';
}

function load(){try{var s=JSON.parse(localStorage.getItem(LS));return s||{days:{}};}catch(e){return{days:{}};}}
function save(s){try{localStorage.setItem(LS,JSON.stringify(s));}catch(e){}}
function msToMidnight(nowMs){var d=new Date(nowMs);d.setHours(24,0,0,0);return d.getTime()-nowMs;}
function fmtCountdown(ms){var s=Math.max(0,Math.floor(ms/1000));
  var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
  return h+':'+('0'+m).slice(-2)+':'+('0'+ss).slice(-2);}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

var G={
  mode:'daily', greens:[], hole:0,
  putts:0,               /* putts taken on the current hole (cap 6) */
  phase:'idle',            /* aim | roll | drop | done */
  aimA:null, stretchFt:20, /* aim direction + line length in feet */
  dragging:false,
  ballX:0, ballY:0, trail:[], holed:false, holeT:0,
  ballScale:null,          /* set during the hole-out drop */
  dropT:0, dropFrom:null,
  parts:[],                /* confetti particles (screen space) */
  results:[],              /* per hole: {putts} */
  rolling:null
};

function fmtDist(ft){
  var inch=Math.round(ft*12);
  if(inch<12)return inch+'"';
  return Math.floor(inch/12)+"'"+(inch%12)+'"';
}

function renderStrip(){
  var html='',cum=0;
  for(var i=0;i<9;i++){
    var r=G.results[i],cls='scell'+(i===G.hole?' cur':'')+(r?' done':'');
    if(r)cum+=r.putts;
    /* live putt count on the current hole, running total under finished ones */
    var pv=r?r.putts:(i===G.hole&&G.putts>0?G.putts:null);
    var mark='<div class="r">'+(pv!=null?pv:'&middot;')+'</div>';
    var dd='<div class="d">'+(r?cum:'&nbsp;')+'</div>';
    html+='<div class="'+cls+'"><div class="n">'+(i+1)+'</div>'+mark+dd+'</div>';
  }
  scoreStrip.innerHTML=html;
  var t=totals();
  holeLabel.textContent=(G.hole<9?('HOLE '+(G.hole+1)+' / 9'):'DONE')+'  •  '+t.strokes+' putts';
}

function startRound(mode){
  G.mode=mode;
  var seed=mode==='daily'?dateStr():'prac|'+Date.now()+'|'+((Math.random()*1e9)|0);
  G.greens=genGreens(seed);
  G.hole=0;G.results=[];
  modeTag.textContent=mode==='daily'?'DAILY':'PRACTICE';
  modeTag.className=mode==='daily'?'':'prac';
  startScreen.classList.add('hidden');
  startHole();
}

function startHole(){
  var g=G.greens[G.hole];
  fitStatic(g);
  G.phase='aim';
  G.aimA=g.lineA;
  G.stretchFt=clamp(g.dist,STRETCH_MIN,STRETCH_MAX);
  G.ballX=g.ball.x;G.ballY=g.ball.y;
  G.putts=0;G.dragging=false;
  G.trail=[];G.holed=false;G.holeT=0;G.rolling=null;
  updateBarMark();
  puttBar.classList.remove('hidden');
  phaseHint.textContent='Drag the line to aim \u00B7 stretch for distance \u00B7 tap the bar to putt';
  phaseBtn.classList.add('hidden');
  resultLine.classList.add('hidden');
  renderStrip();
}

/* ---- input: drag the line to aim + stretch ---- */
function aimFromPoint(cx,cy){
  var w=s2w(cx,cy);
  var dx=w.x-G.ballX,dy=w.y-G.ballY;
  var d=Math.sqrt(dx*dx+dy*dy);
  if(d<1.2)return; /* finger basically on the ball: keep the line */
  G.aimA=Math.atan2(dy,dx);
  G.stretchFt=clamp(d,STRETCH_MIN,STRETCH_MAX);
  updateBarMark();
}
canvas.addEventListener('pointerdown',function(e){
  if(G.phase!=='aim')return;
  G.dragging=true;
  try{canvas.setPointerCapture(e.pointerId);}catch(err){}
  aimFromPoint(e.clientX,e.clientY);
});
canvas.addEventListener('pointermove',function(e){
  if(!G.dragging||G.phase!=='aim')return;
  aimFromPoint(e.clientX,e.clientY);
});
canvas.addEventListener('pointerup',function(){G.dragging=false;});
canvas.addEventListener('pointercancel',function(){G.dragging=false;});

/* ---- the vertical touch bar: TAP to strike.
        bottom = SOFT, top = FIRM. Always visible during every putt. ---- */
puttBar.addEventListener('pointerdown',function(e){
  e.preventDefault();
  if(G.phase!=='aim')return;
  var r=barTrack.getBoundingClientRect();
  var frac=1-(e.clientY-r.top)/r.height;
  /* instant visual feedback (<100ms): the bar flashes */
  puttBar.classList.add('tapped');
  setTimeout(function(){puttBar.classList.remove('tapped');},120);
  strike(tapFracToPower(frac));
});

/* ---- phase button: next hole / results only ---- */
phaseBtn.addEventListener('click',function(){
  if(G.phase==='done')nextHole();
});

function strike(power){
  if(G.phase!=='aim')return;
  var g=G.greens[G.hole];
  var mark=stretchToPower(G.stretchFt);
  var grade=gradeTap(power,mark);
  G.putts++;
  var res=simulate(g,G.aimA,clamp(power,0,BAR_MAX),
    {pure:grade==='PURE',from:{x:G.ballX,y:G.ballY}});
  G.phase='roll';G.trail=[];G.dragging=false;
  G.rolling={res:res,grade:grade,t:0,shown:0,power:power,mark:mark};
  puttBar.classList.add('hidden');
  phaseHint.textContent='Rolling\u2026';
  phaseBtn.classList.add('hidden');
  resultLine.classList.add('hidden');
}

function finishHole(){
  var g=G.greens[G.hole],r=G.rolling.res;
  G.ballX=r.x;G.ballY=r.y;
  G.phase='done';G.holed=r.holed;G.holeT=0.001;
  if(r.holed){
    /* confetti burst at the cup (screen space; visual only) */
    var cs=w2s(g.cup.x,g.cup.y);
    var crng=mulberry32((Date.now()^0x5f3d)>>>0);
    var cols=['#ffd23c','#ffffff','#22c55e','#e23b3b'];
    for(var ci=0;ci<16;ci++){
      var ca=crng()*Math.PI*2, csp=60+crng()*170;
      G.parts.push({x:cs.x,y:cs.y,vx:Math.cos(ca)*csp,vy:Math.sin(ca)*csp-130,
        rot:crng()*6.28,vr:(crng()-0.5)*14,life:0.85,c:cols[ci%4]});
    }
  }
  var dft=dist2(r.x,r.y,g.cup.x,g.cup.y);
  var gc=G.rolling.grade;
  var gcls=gc==='PURE'?'g-pure':gc==='SOLID'?'g-solid':gc==='SOFT'?'g-soft':'g-firm';
  var gradeHtml='<span class="grade '+gcls+'">'+gc+'</span>';
  if(r.holed){
    /* holed: the hole is over, record the putt count */
    G.results[G.hole]={putts:G.putts};
    resultLine.innerHTML=gradeHtml+'<span style="color:#15803d">HOLED in '+G.putts+'!</span>'+
      (gc==='PURE'?' Right on the mark.':'');
    showNextHoleUI();
    return;
  }
  if(G.putts>=6){
    /* six-putt cap: max out and move on */
    G.results[G.hole]={putts:6};
    resultLine.innerHTML=gradeHtml+'That\u2019s 6 \u2014 maxed out.';
    showNextHoleUI();
    return;
  }
  /* putt again from where it lies (real golf) */
  var missTxt=r.plugged?'Plugged in the bunker.':
    r.offGreen?'Off the green.':
    r.lipped?'Lipped out \u2014 too hot.':
    'Missed \u2014 '+fmtDist(dft)+(dft>g.dist?' long.':' short.');
  resultLine.innerHTML=gradeHtml+missTxt;
  resultLine.classList.remove('hidden');
  /* re-aim from the lie; default line points at the cup at cup distance */
  G.phase='aim';
  G.aimA=Math.atan2(g.cup.y-G.ballY,g.cup.x-G.ballX);
  G.stretchFt=clamp(dist2(G.ballX,G.ballY,g.cup.x,g.cup.y),STRETCH_MIN,STRETCH_MAX);
  G.trail=[];G.rolling=null;
  updateBarMark();
  puttBar.classList.remove('hidden');
  phaseHint.textContent='Putt '+(G.putts+1)+' of 6 \u2014 drag the line, tap the bar.';
  phaseBtn.classList.add('hidden');
  renderStrip();
}

/* hole finished (holed or capped at 6): record + offer the next hole */
function showNextHoleUI(){
  resultLine.classList.remove('hidden');
  phaseHint.textContent=G.hole<8?'On to the next green.':'That\u2019s all nine.';
  phaseBtn.textContent=G.hole<8?'Next hole':'See results';
  phaseBtn.classList.remove('hidden');
  renderStrip();
  if(G.mode==='daily'){
    var st=load();st.days[dateStr()]={results:G.results,done:G.hole>=8};
    save(st);
  }
}

function nextHole(){
  if(G.hole>=8){showResults();return;}
  G.hole++;startHole();
}

function totals(){
  var s=0,done=0;
  for(var i=0;i<G.results.length;i++){var r=G.results[i];if(!r)continue;s+=r.putts;done++;}
  return{strokes:s,done:done};
}

/* ---- main loop ---- */
var lastT=0;
function loop(t){
  requestAnimationFrame(loop);
  var dt=Math.min(0.05,(t-lastT)/1000||0.016);lastT=t;
  nowS=t/1000;
  if(G.greens.length&&G.hole<9){
    var g=G.greens[G.hole];
    if(G.phase==='roll'&&G.rolling){
      var rr=G.rolling;
      rr.t+=dt;
      var want=Math.min(rr.res.trail.length,Math.floor(rr.t*90));
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
          if(dist2(G.ballX,G.ballY,rr.res.x,rr.res.y)<0.05)finishHole();
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
      if(dk>=1){G.ballScale=null;finishHole();}
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
    drawGreen(g,{phase:G.phase,aimA:G.aimA,ballX:G.ballX,ballY:G.ballY,
      trail:G.trail,holed:G.holed,holeT:G.holeT,ballScale:G.ballScale,parts:G.parts});
  }
}

/* ================= lock screen ================= */
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
document.getElementById('nameCancel').addEventListener('click',closeName);
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
  var per=G.results.map(function(r){return r?r.putts:'\u2013';}).join(' \u00B7 ');
  resScore.innerHTML=t.strokes+'<small> putts</small><br><small>'+per+'</small>';
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
requestAnimationFrame(loop);

/* test hooks (node) */
var PuttTest={hashStr:hashStr,mulberry32:mulberry32,genGreens:genGreens,simulate:simulate,
  gradeTap:gradeTap,stretchToPower:stretchToPower,tapFracToPower:tapFracToPower,
  tapYToPower:tapYToPower,gradOf:gradOf,slopeDirOf:slopeDirOf,inPoly:inPoly,
  ARCHES:ARCHES,fitStatic:fitStatic,w2s:w2s,s2w:s2w,cam:cam,
  DOT_FT:DOT_FT,PANEL_H:PANEL_H,TOP_H:TOP_H,
  consts:{FRICTION:FRICTION,SLOPE_G:SLOPE_G,CUP_R:CUP_R,V_CAP:V_CAP,DMAX:DMAX,
    BAR_MAX:BAR_MAX,STRETCH_MIN:STRETCH_MIN,STRETCH_MAX:STRETCH_MAX}};
if(typeof module!=='undefined'&&module.exports)module.exports=PuttTest;

})();
