/* ============================================================
   DAILY PUTT -- nine greens, one putt each.
   Original code. Top-down putting, date-seeded daily set.
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
var DMAX=80;             /* putt distance at full (100) power        */
var DOT_N=10;            /* Wii-style aim dots: 10 dots = full meter */
var DOT_FT=DMAX/DOT_N;   /* world feet between dots (8); 1 dot = 0.1 of meter */
var DT=1/240;

/* ================= green archetypes =================
   Each archetype builds a height-field closure h(x,y) plus metadata.
   Physics AND the drawn slope arrows both sample the same numeric
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

/* numeric gradient of h -- single source of truth for physics + arrows */
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
    pinM:clamp(d/DMAX,0.05,1.12),
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
  var v0=Math.sqrt(2*FRICTION*DMAX*clamp(powerM,0,1.15));
  var x=green.ball.x,y=green.ball.y;
  var vx=Math.cos(aimA)*v0,vy=Math.sin(aimA)*v0;
  var jrng=mulberry32(green.seed^0x9e37);
  var trail=[],maxBreak=0,lipped=false,steps=0,offGreen=false,plugged=false;
  var lineX=Math.cos(green.lineA),lineY=Math.sin(green.lineA);
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
    var rx=x-green.ball.x,ry=y-green.ball.y;
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

/* grade the stroke: absolute deviation from pin power.
   The needle sweeps 0->1.15 in 3.4s; PURE = within +/-0.0575 units =
   10% of the sweep on EVERY green (design: timing-window rule).
   Ratio-based bands made short putts brutally tight (2.2% of sweep)
   and lag putts trivial (11%) -- inverted difficulty. */
function gradeStroke(m,pinM){
  var d=Math.abs(m-pinM);
  if(d<=0.0575)return'PURE';
  if(d<=0.115)return'SOLID';
  return m<pinM?'EASED':'OVERHIT';
}

/* ================= rendering ================= */
var canvas=document.getElementById('game'),ctx=canvas.getContext('2d');
var cw=0,ch=0;
function resize(){
  var dpr=Math.min(2,window.devicePixelRatio||1);
  cw=window.innerWidth;ch=window.innerHeight;
  canvas.width=Math.round(cw*dpr);canvas.height=Math.round(ch*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize',resize);resize();

/* camera: always frame BOTH the ball and the cup -- the player must
   never wonder where the hole is. Fits the ball+cup box with padding,
   keeping at least ~1/3 of the green's extent for context. */
var PANEL_H=170,TOP_H=110;
var cam={scale:1,ox:0,oy:0,panX:0,panY:0};
function fitCam(green){
  var bb=green.bbox,pad=13;
  var x0=Math.min(green.ball.x,green.cup.x)-pad, x1=Math.max(green.ball.x,green.cup.x)+pad;
  var y0=Math.min(green.ball.y,green.cup.y)-pad, y1=Math.max(green.ball.y,green.cup.y)+pad;
  var hx=Math.max((x1-x0)/2,(bb.x1-bb.x0)*0.32);
  var hy=Math.max((y1-y0)/2,(bb.y1-bb.y0)*0.32);
  var aw=cw-56, ah=ch-PANEL_H-TOP_H-40;
  cam.scale=Math.min(aw/(2*hx),ah/(2*hy));
  cam.ox=(x0+x1)/2;cam.oy=(y0+y1)/2;
  cam.panX=0;cam.panY=0;
}
function w2s(x,y){ /* world -> screen */
  return {x:(x-cam.ox)*cam.scale+cw/2+cam.panX, y:(y-cam.oy)*cam.scale+ch/2-PANEL_H/2+TOP_H/3+cam.panY};
}
function s2w(sx,sy){
  return {x:(sx-cw/2-cam.panX)/cam.scale+cam.ox, y:(sy-ch/2+PANEL_H/2-TOP_H/3-cam.panY)/cam.scale+cam.oy};
}

function pathOf(poly){
  ctx.beginPath();
  for(var i=0;i<poly.length;i++){
    var p=w2s(poly[i].x,poly[i].y);
    if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);
  }
  ctx.closePath();
}

/* Wii-style drift grid: dots at grid intersections slide continuously
   downhill; drift speed is proportional to steepness. Samples the same
   numeric gradient the physics uses, so the picture and the ball agree. */
var nowS=0; /* seconds, updated in the main loop */
function driftDirOf(h,x,y){
  var g=gradOf(h,x,y);
  var m=Math.sqrt(g.x*g.x+g.y*g.y);
  if(m<0.004)return null;
  return {x:-g.x/m, y:-g.y/m, steep:m};
}
function drawDriftGrid(green){
  var SP=4.2, bb=green.bbox;
  ctx.fillStyle='rgba(18,32,56,0.68)';
  for(var gx=bb.x0+2;gx<=bb.x1-2;gx+=SP){
    for(var gy=bb.y0+2;gy<=bb.y1-2;gy+=SP){
      if(!inPoly(gx,gy,green.poly))continue;
      if(dist2(gx,gy,green.cup.x,green.cup.y)<1.8)continue;
      var d=driftDirOf(green.h,gx,gy);
      if(!d)continue;
      var phase=((gx*12.9898+gy*78.233)%1+1)%1*SP;
      var off=((nowS*60*d.steep+phase)%SP+SP)%SP-SP/2;
      var px=gx+d.x*off, py=gy+d.y*off;
      var s=w2s(px,py);
      ctx.beginPath();ctx.arc(s.x,s.y,2.1,0,Math.PI*2);ctx.fill();
    }
  }
}

function drawGreen(green,state){
  /* backdrop */
  var bg=ctx.createLinearGradient(0,0,0,ch);
  bg.addColorStop(0,'#2c6e35');bg.addColorStop(1,'#1d4a26');
  ctx.fillStyle=bg;ctx.fillRect(0,0,cw,ch);

  /* fringe ring (slightly larger blob, darker) */
  ctx.save();
  pathOf(green.poly);
  ctx.fillStyle='#3a7d3f';ctx.fill();
  /* mowing stripes clipped to green */
  ctx.clip();
  var s0=w2s(green.bbox.x0-4,green.bbox.y0-4),s1=w2s(green.bbox.x1+4,green.bbox.y1+4);
  var stripeH=Math.max(14,cam.scale*2.2),yy=s1.y,flip=false;
  while(yy<s0.y+stripeH){
    ctx.fillStyle=flip?'#55a04a':'#5cab52';
    ctx.fillRect(s1.x-4,yy,(s0.x-s1.x)+8,stripeH);
    yy+=stripeH;flip=!flip;
  }
  /* inner shading toward edges */
  var cc=w2s((green.bbox.x0+green.bbox.x1)/2,(green.bbox.y0+green.bbox.y1)/2);
  var rg=ctx.createRadialGradient(cc.x,cc.y,Math.min(s0.x-s1.x,s0.y-s1.y)*0.28,cc.x,cc.y,Math.max(s0.x-s1.x,s0.y-s1.y)*0.62);
  rg.addColorStop(0,'rgba(0,0,0,0)');rg.addColorStop(1,'rgba(20,60,25,0.35)');
  ctx.fillStyle=rg;ctx.fillRect(s1.x-4,s1.y-4,(s0.x-s1.x)+8,(s0.y-s1.y)+8);
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

  /* Wii-style drift grid (same gradient the physics uses) */
  drawDriftGrid(green);
  /* % labels near cup */
  var spots=[{x:green.cup.x,y:green.cup.y},
             {x:(green.cup.x+green.ball.x)/2,y:(green.cup.y+green.ball.y)/2}];
  ctx.fillStyle='rgba(20,35,60,0.85)';
  ctx.font='700 '+Math.max(11,cam.scale*0.55|0)+'px -apple-system,sans-serif';
  ctx.textAlign='center';
  for(var l=0;l<spots.length;l++){
    if(!inPoly(spots[l].x,spots[l].y,green.poly))continue;
    var g2=gradOf(green.h,spots[l].x,spots[l].y);
    var pct=Math.round(Math.sqrt(g2.x*g2.x+g2.y*g2.y)*100);
    var sp=w2s(spots[l].x,spots[l].y+1.2);
    ctx.fillText(pct+'%',sp.x,sp.y);
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

  /* edge arrow: if the cup is ever off-screen (panned away), point at it */
  var mrg=18,vx0=mrg,vx1=cw-mrg,vy0=TOP_H+mrg,vy1=ch-PANEL_H-mrg;
  if(cp.x<vx0||cp.x>vx1||cp.y<vy0||cp.y>vy1){
    var ang=Math.atan2(cp.y-ch/2,cp.x-cw/2);
    var exx=clamp(cp.x,vx0+16,vx1-16),eyy=clamp(cp.y,vy0+16,vy1-16);
    ctx.save();ctx.translate(exx,eyy);ctx.rotate(ang);
    ctx.fillStyle='#ffd23c';ctx.strokeStyle='rgba(0,0,0,0.35)';ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(22,0);ctx.lineTo(-8,-13);ctx.lineTo(-2,0);ctx.lineTo(-8,13);
    ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();
  }

  /* Wii dot aim line: evenly spaced dots, 1 dot = 0.1 of the power meter */
  if(state.phase==='aim'&&state.aimA!=null){
    var bs0=w2s(state.ballX,state.ballY);
    var bEnd=w2s(state.ballX+Math.cos(state.aimA)*DOT_N*DOT_FT,
                 state.ballY+Math.sin(state.aimA)*DOT_N*DOT_FT);
    ctx.strokeStyle='rgba(255,255,255,0.30)';ctx.lineWidth=3;ctx.lineCap='round';
    ctx.beginPath();ctx.moveTo(bs0.x,bs0.y);ctx.lineTo(bEnd.x,bEnd.y);ctx.stroke();
    for(var dk=1;dk<=DOT_N;dk++){
      var dp=w2s(state.ballX+Math.cos(state.aimA)*dk*DOT_FT,
                 state.ballY+Math.sin(state.aimA)*dk*DOT_FT);
      var dr=(dk%5===0)?4.6:3.1;
      ctx.fillStyle='rgba(0,0,0,0.30)';
      ctx.beginPath();ctx.arc(dp.x+1.5,dp.y+1.5,dr,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#ffffff';
      ctx.beginPath();ctx.arc(dp.x,dp.y,dr,0,Math.PI*2);ctx.fill();
      if(dk%5===0){
        ctx.fillStyle='#b91c1c';
        ctx.beginPath();ctx.arc(dp.x,dp.y,1.8,0,Math.PI*2);ctx.fill();
      }
    }
  }

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

  /* green name + distance */
  ctx.fillStyle='rgba(255,255,255,0.92)';
  ctx.font='800 13px -apple-system,sans-serif';ctx.textAlign='left';
  ctx.fillText(green.name.toUpperCase()+'  •  '+Math.round(green.dist)+' FT',14,TOP_H+4);
}

/* ================= game state / flow ================= */
var LEADERBOARD_URL='';
var GAME_ID='daily-putt';
var LS='dailyputt.v1';

var holeLabel=document.getElementById('holeLabel'),modeTag=document.getElementById('modeTag'),
    scoreStrip=document.getElementById('scoreStrip'),
    phaseHint=document.getElementById('phaseHint'),phaseBtn=document.getElementById('phaseBtn'),
    resultLine=document.getElementById('resultLine'),
    meterWrap=document.getElementById('meterWrap'),mNeedle=document.getElementById('mNeedle'),
    mPin=document.getElementById('mPin'),
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

function load(){try{var s=JSON.parse(localStorage.getItem(LS));return s||{days:{}};}catch(e){return{days:{}};}}
function save(s){try{localStorage.setItem(LS,JSON.stringify(s));}catch(e){}}
function msToMidnight(nowMs){var d=new Date(nowMs);d.setHours(24,0,0,0);return d.getTime()-nowMs;}
function fmtCountdown(ms){var s=Math.max(0,Math.floor(ms/1000));
  var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
  return h+':'+('0'+m).slice(-2)+':'+('0'+ss).slice(-2);}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

var G={
  mode:'daily', greens:[], hole:0,
  phase:'idle',            /* aim | power | roll | drop | done */
  aimA:null, ballX:0, ballY:0, trail:[], holed:false, holeT:0,
  ballScale:null,          /* set during the hole-out drop */
  dropT:0, dropFrom:null,
  parts:[],                /* confetti particles (screen space) */
  meterOn:false, meterT:0, meterM:0,
  results:[],              /* per hole: {holed, inches} */
  rolling:null
};

function fmtDist(ft){
  var inch=Math.round(ft*12);
  if(inch<12)return inch+'"';
  return Math.floor(inch/12)+"'"+(inch%12)+'"';
}

function renderStrip(){
  var html='';
  for(var i=0;i<9;i++){
    var r=G.results[i],cls='scell'+(i===G.hole?' cur':'')+(r?' done':'');
    var mark=r?(r.holed?'<div class="r ok">&#10003;</div>':'<div class="r no">&times;</div>'):'<div class="r">&middot;</div>';
    var dd=r?('<div class="d">'+(r.holed?'IN':fmtDist(r.ft))+'</div>'):'<div class="d">&nbsp;</div>';
    html+='<div class="'+cls+'"><div class="n">'+(i+1)+'</div>'+mark+dd+'</div>';
  }
  scoreStrip.innerHTML=html;
  var done=G.results.filter(Boolean).length;
  var holed=G.results.filter(function(r){return r&&r.holed;}).length;
  holeLabel.textContent=(G.hole<9?('HOLE '+(G.hole+1)+' / 9'):'DONE')+'  •  '+holed+'/'+done;
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
  fitCam(g);
  G.phase='aim';G.aimA=g.lineA;
  G.ballX=g.ball.x;G.ballY=g.ball.y;
  G.trail=[];G.holed=false;G.holeT=0;G.rolling=null;
  G.meterOn=false;
  phaseHint.textContent='Tap the green to aim. Count the dots to the hole \u2014 halves count! Each dot is one tick of power.';
  phaseBtn.textContent='Lock the line';
  phaseBtn.classList.remove('hidden');
  meterWrap.classList.add('hidden');
  resultLine.classList.add('hidden');
  renderStrip();
}

/* ---- input: tap to aim, drag to pan ---- */
var pdown=null;
canvas.addEventListener('pointerdown',function(e){
  pdown={x:e.clientX,y:e.clientY,t:Date.now(),moved:false};
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove',function(e){
  if(!pdown)return;
  var dx=e.clientX-pdown.x,dy=e.clientY-pdown.y;
  if(Math.abs(dx)+Math.abs(dy)>10)pdown.moved=true;
  if(pdown.moved){cam.panX=clamp(cam.panX+dx,-cw*0.4,cw*0.4);cam.panY=clamp(cam.panY+dy,-ch*0.4,ch*0.4);pdown.x=e.clientX;pdown.y=e.clientY;}
});
canvas.addEventListener('pointerup',function(e){
  if(!pdown)return;
  var wasTap=!pdown.moved&&(Date.now()-pdown.t<500);
  pdown=null;
  if(!wasTap||G.phase!=='aim')return;
  var w=s2w(e.clientX,e.clientY);
  var g=G.greens[G.hole];
  if(!inPoly(w.x,w.y,g.poly))return;
  var a=Math.atan2(w.y-G.ballY,w.x-G.ballX);
  if(dist2(w.x,w.y,G.ballX,G.ballY)>0.8)G.aimA=a;
});

/* ---- phase button ---- */
phaseBtn.addEventListener('click',function(){
  if(G.phase==='aim'){
    G.phase='power';G.meterOn=true;G.meterT=0;G.puttArmed=false;
    phaseHint.textContent='Tap PUTT to start the needle, then STOP it at the \u2691 pin \u2014 that\u2019s your dot count, exactly.';
    phaseBtn.textContent='PUTT';
    meterWrap.classList.remove('hidden');
    mPin.style.left=(clamp(G.greens[G.hole].pinM,0,1.12)/1.15*100)+'%';
  }else if(G.phase==='power'&&G.meterOn){
    /* tap PUTT once to arm, tap STOP to strike */
    if(!G.puttArmed){G.puttArmed=true;phaseBtn.textContent='STOP';}
    else strike();
  }else if(G.phase==='done'){
    nextHole();
  }
});

function strike(){
  var g=G.greens[G.hole];
  var m=G.meterM;
  G.meterOn=false;
  var grade=gradeStroke(m,g.pinM);
  var pure=(grade==='PURE');
  var res=simulate(g,G.aimA,m,{pure:pure});
  G.phase='roll';G.trail=[];
  G.rolling={res:res,grade:grade,t:0,shown:0};
  phaseHint.textContent='Rolling\u2026';
  phaseBtn.classList.add('hidden');
  meterWrap.classList.add('hidden');
}

function finishHole(){
  var g=G.greens[G.hole],r=G.rolling.res;
  G.phase='done';G.holed=r.holed;G.holeT=0.001;
  G.ballX=r.x;G.ballY=r.y;
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
  var rec={holed:r.holed,ft:dft,inches:Math.round(dft*12)};
  G.results[G.hole]=rec;
  var gc=G.rolling.grade;
  var gcls=gc==='PURE'?'g-pure':gc==='SOLID'?'g-solid':gc==='EASED'?'g-eased':'g-over';
  var along=(r.x-g.ball.x)*Math.cos(g.lineA)+(r.y-g.ball.y)*Math.sin(g.lineA);
  var missTxt=r.plugged?'Plugged in the bunker.':
    r.offGreen?'Off the green.':
    r.lipped?'Lipped out \u2014 too hot.':
    'Missed \u2014 '+fmtDist(dft)+(along>g.dist?' long.':' short.');
  resultLine.innerHTML='<span class="grade '+gcls+'">'+gc+'</span>'+
    (r.holed?'<span style="color:#15803d">HOLED!</span>':missTxt);
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
  var holed=0,inches=0;
  for(var i=0;i<G.results.length;i++){var r=G.results[i];if(!r)continue;
    if(r.holed)holed++;else inches+=r.inches;}
  return{holed:holed,inches:inches};
}

/* ---- main loop ---- */
var lastT=0;
function loop(t){
  requestAnimationFrame(loop);
  var dt=Math.min(0.05,(t-lastT)/1000||0.016);lastT=t;
  nowS=t/1000;
  if(G.greens.length&&G.hole<9){
    var g=G.greens[G.hole];
    if(G.phase==='power'&&G.meterOn){
      G.meterT+=dt;
      var cyc=(G.meterT/3.4)%2;
      G.meterM=1.15*(1-Math.abs(cyc-1));
      mNeedle.style.left=(G.meterM/1.15*100)+'%';
    }
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
    var h=0;for(var i=0;i<rec.results.length;i++)if(rec.results[i]&&rec.results[i].holed)h++;
    lockScore.textContent='Today: '+h+'/9 holed';
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

var RES_LS='dailyputt.results';
function loadResults(){try{var a=JSON.parse(localStorage.getItem(RES_LS));return Array.isArray(a)?a:[];}catch(e){return[];}}
function recordResult(rec){
  var a=loadResults();a.push(rec);
  if(a.length>200)a=a.slice(-200);
  try{localStorage.setItem(RES_LS,JSON.stringify(a));}catch(e){}
}
/* score: higher is better -> holed dominates, fewer inches wins ties */
function scoreOf(t){return t.holed*100000-t.inches;}

function showResults(){
  var t=totals();
  resTitle.textContent=G.mode==='daily'?'Today\u2019s round':'Practice round';
  resScore.innerHTML=t.holed+'<small>/9 holed</small><br><small>'+t.inches+'&Prime; left on misses</small>';
  resultsScreen.classList.remove('hidden');
  if(G.mode==='daily'){
    recordResult({date:dateStr(),mode:'daily',holed:t.holed,inches:t.inches});
    var doSubmit=function(){
      var u=getUser();
      if(lbOn()&&u&&u.hash)lbPost({action:'submit',game:GAME_ID,date:dateStr(),
        username:u.name,phrase_hash:u.hash,score:scoreOf(t)});
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
        var h9=Math.floor(r.score/100000),inch=100000-(r.score%100000);
        html+='<div class="lbRow'+(me?' me':'')+'"><span>#'+(i+1)+' '+esc(r.username)+'</span><span>'+h9+'/9 \u00B7 '+inch+'&Prime;</span></div>';
      }
      lbList.innerHTML=html;
    });
  }
  var hist=loadResults().slice().reverse(),html2='';
  for(var i=0;i<Math.min(12,hist.length);i++){
    var h=hist[i];
    html2+='<div class="lbRow"><span>'+esc(h.date)+'</span><span>'+h.holed+'/9 \u00B7 '+h.inches+'&Prime;</span></div>';
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
refreshNameBtn();
refreshStart();
requestAnimationFrame(loop);

/* test hooks (node) */
var PuttTest={hashStr:hashStr,mulberry32:mulberry32,genGreens:genGreens,simulate:simulate,
  gradeStroke:gradeStroke,gradOf:gradOf,inPoly:inPoly,ARCHES:ARCHES,
  fitCam:fitCam,w2s:w2s,cam:cam,driftDirOf:driftDirOf,DOT_FT:DOT_FT,DOT_N:DOT_N,
  PANEL_H:PANEL_H,TOP_H:TOP_H,
  consts:{FRICTION:FRICTION,SLOPE_G:SLOPE_G,CUP_R:CUP_R,V_CAP:V_CAP,DMAX:DMAX}};
if(typeof module!=='undefined'&&module.exports)module.exports=PuttTest;

})();
