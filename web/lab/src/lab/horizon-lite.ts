import { calm } from './motion';
import { EMBER } from './palettes';
import { horizon, NOISE, SKY, type Scene } from './horizon';

/**
 * Baked version of the Horizon hole. The camera is fixed, so every light path is
 * integrated once and stored: where each pixel meets the disk (polar), how Doppler
 * shifted that light is, and what lies behind. A frame then costs a few texture
 * fetches instead of 150 integration steps. Scroll dimming is left to CSS.
 */
const VERT = `#version 300 es
void main(){vec2 p=vec2(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.);gl_Position=vec4(p,0,1);}`;
const R0 = '2.35', R1 = '9.6';

/* the same gas field as the original, unrolled into (angle, radius) */
const GAS = `#version 300 es
precision highp float; uniform vec2 res; out vec4 o;
${NOISE}
void main(){ vec2 uv=gl_FragCoord.xy/res; float a=uv.x*6.28318531, r=mix(${R0},${R1},uv.y); vec2 d=vec2(cos(a),sin(a));
  o=vec4(fbm(vec3(d*2.6,r*2.7))*.75+fbm(vec3(d*7.,r*6.))*.35,0,0,1); }`;

const DISK = /* glsl */ `
uniform sampler2D gasT; uniform float t; uniform vec3 c0,c1,c2,app,rec;
float gas(float a,float r,float tt){ return texture(gasT,vec2((a+tt*5.2*inversesqrt(r)/r)/6.28318531,(r-${R0})/(${R1}-${R0}))).r; }
vec4 disk(float a,float r,float dop){
  float T=14.,f1=fract(t/T),f2=fract(t/T+.5);
  float g=mix(gas(a,r,f2*T),gas(a+2.3,r,f1*T),1.-abs(2.*f1-1.));
  float edge=smoothstep(${R0},3.1,r)*smoothstep(${R1},${R1}*.54,r);
  float dens=pow(clamp(g*1.25-.22,0.,1.),1.7)*edge, heat=pow(2.9/r,1.35);
  vec3 e=mix(c0,c1,smoothstep(.18,.6,heat)); e=mix(e,c2,smoothstep(.5,1.,heat));
  vec3 col=mix(e,app,smoothstep(1.06,1.5,dop)*.85); col=mix(col,rec,smoothstep(.93,.66,dop)*.6);
  return vec4(col*dens*heat*dop*dop*dop*4.2,clamp(dens*1.5,0.,.93));
}`;

const BAKE = `#version 300 es
precision highp float; uniform vec2 res,off; uniform float incl,roll,zoom; uniform vec3 halo,skyA,skyB,starA,starB;
layout(location=0) out vec4 hits; layout(location=1) out vec4 dops; layout(location=2) out vec4 back;
${NOISE}${SKY}${DISK}
void main(){
  vec2 uv=(gl_FragCoord.xy-.5*res)/res.y-off; float cr=cos(roll),sr=sin(roll);uv=mat2(cr,-sr,sr,cr)*uv;
  vec3 ro=15.*vec3(0,sin(incl),-cos(incl)),f=-normalize(ro),rt=normalize(cross(vec3(0,1,0),f)),up=cross(f,rt);
  vec3 v=normalize(f*zoom+rt*uv.x+up*uv.y),p=ro; float h2=dot(cross(p,v),cross(p,v));
  hits=vec4(0);dops=vec4(1);vec3 extra=vec3(0);float tr=1.,glow=0.;bool cap=false;int n=0;
  for(int i=0;i<330;i++){
    float r=length(p); if(r<1.){cap=true;break;} if(r>17.&&dot(p,v)>0.)break;
    float dt=clamp(r*.05,.022,.4); vec3 pp=p; v+=-1.5*h2*p/pow(r,5.)*dt; p+=v*dt;
    glow+=dt*.006/(1.+pow(abs(r-1.6)*1.8,2.));
    if(pp.y*p.y<0.){ vec3 q=mix(pp,p,pp.y/(pp.y-p.y)); float qr=length(q.xz);
      if(qr>${R0}&&qr<${R1}){
        float a=atan(q.z,q.x),dop=1./(1.-.62/sqrt(qr*.55)*dot(normalize(vec3(-q.z,0,q.x)),-normalize(v)));
        if(n==0){hits.xy=vec2(a/3.14159265,qr/10.);dops.x=dop;} else if(n==1){hits.zw=vec2(a/3.14159265,qr/10.);dops.y=dop;}
        else { vec4 d=disk(a,qr,dop); extra+=tr*d.rgb; tr*=1.-d.a; } // photon ring: too thin to need motion
        n++; } }
  }
  vec3 c=glow*halo; if(!cap)c+=sky(normalize(v)); back=vec4(extra+tr*c,1);
}`;

const SHADE = `#version 300 es
precision highp float; uniform highp sampler2D hitT,dopT,backT; out vec4 o;
${DISK}
float n1(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))));}
void main(){
  ivec2 px=ivec2(gl_FragCoord.xy); vec4 h=texelFetch(hitT,px,0)*vec4(3.14159265,10.,3.14159265,10.); vec3 col=vec3(0); float tr=1.;
  if(h.y>0.){ vec2 k=texelFetch(dopT,px,0).xy; vec4 d=disk(h.x,h.y,k.x); col=d.rgb; tr=1.-d.a;
    if(h.w>0.){ d=disk(h.z,h.w,k.y); col+=tr*d.rgb; tr*=1.-d.a; } }
  col+=tr*texelFetch(backT,px,0).rgb;
  col=1.-exp(-col*1.25); col=pow(col,vec3(.86)); o=vec4(col+(n1(gl_FragCoord.xy)-.5)*.012,1);
}`;

const MAX_PIXELS = 1.1e6; // memory and fill cap: about 22 MB of textures
const STRIPS = 24; // the one-off bake is spread over frames so it never blocks

export function horizonLite(canvas: HTMLCanvasElement, scene: Scene, onFrame: (dt: number) => void) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false });
  if (!gl) { canvas.dataset.failed = ''; onFrame(0); return; }
  if (!gl.getExtension('EXT_color_buffer_float')) return horizon(canvas, scene, onFrame);

  const build = (frag: string) => {
    const p = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, frag]] as const) {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p); gl.useProgram(p);
    const cache = new Map<string, WebGLUniformLocation | null>();
    const u = (n: string) => { if (!cache.has(n)) cache.set(n, gl.getUniformLocation(p, n)); return cache.get(n)!; };
    for (const [k, v] of Object.entries(scene.light ?? EMBER)) gl.uniform3f(u(k), v[0], v[1], v[2]);
    ['gasT', 'hitT', 'dopT', 'backT'].forEach((n, i) => gl.uniform1i(u(n), i));
    return { p, u };
  };
  const tex = (unit: number, fmt: number, w: number, h: number, filter: number, wrapS: number) => {
    const t = gl.createTexture()!; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, wrapS], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  };
  const target = (...ts: WebGLTexture[]) => {
    const f = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    ts.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(ts.map((_, i) => gl.COLOR_ATTACHMENT0 + i)); return f;
  };
  const tri = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

  const gasP = build(GAS), bakeP = build(BAKE), shadeP = build(SHADE);
  const gasTex = tex(0, gl.R16F, 2048, 1024, gl.LINEAR, gl.REPEAT), gasFb = target(gasTex);
  gl.viewport(0, 0, 2048, 1024); gl.useProgram(gasP.p); gl.uniform2f(gasP.u('res'), 2048, 1024); tri();
  gl.deleteFramebuffer(gasFb);

  let W = 0, H = 0, strip = 0, bakeFb: WebGLFramebuffer | null = null, maps: WebGLTexture[] = [];
  const reset = () => {
    const k = Math.min(Math.min(devicePixelRatio, 1.5), Math.sqrt(MAX_PIXELS / (innerWidth * innerHeight)));
    W = canvas.width = Math.max(2, Math.round(innerWidth * k)); H = canvas.height = Math.max(2, Math.round(innerHeight * k));
    maps.forEach((m) => gl.deleteTexture(m)); if (bakeFb) gl.deleteFramebuffer(bakeFb);
    maps = [tex(1, gl.RGBA16F, W, H, gl.NEAREST, gl.CLAMP_TO_EDGE), tex(2, gl.RG16F, W, H, gl.NEAREST, gl.CLAMP_TO_EDGE), tex(3, gl.RGBA16F, W, H, gl.NEAREST, gl.CLAMP_TO_EDGE)];
    bakeFb = target(...maps); strip = 0; canvas.style.opacity = '0';
  };
  const bake = (count: number) => {
    // unbind the maps while they are render targets
    for (let i = 1; i < 4; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, null); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, bakeFb); gl.viewport(0, 0, W, H); gl.useProgram(bakeP.p);
    gl.uniform2f(bakeP.u('res'), W, H); gl.uniform2f(bakeP.u('off'), ...scene.off); gl.uniform1f(bakeP.u('t'), 0);
    for (const n of ['incl', 'roll', 'zoom'] as const) gl.uniform1f(bakeP.u(n), scene[n]);
    gl.enable(gl.SCISSOR_TEST);
    for (; count-- && strip < STRIPS; strip++) { const a = Math.floor((H * strip) / STRIPS), b = Math.floor((H * (strip + 1)) / STRIPS); gl.scissor(0, a, W, b - a); tri(); }
    gl.disable(gl.SCISSOR_TEST); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    maps.forEach((m, i) => { gl.activeTexture(gl.TEXTURE1 + i); gl.bindTexture(gl.TEXTURE_2D, m); });
    gl.useProgram(shadeP.p); gl.viewport(0, 0, W, H);
  };
  const draw = () => { gl.uniform1f(shadeP.u('t'), scene.t); tri(); };
  const fade = () => { if (strip >= STRIPS) canvas.style.opacity = String(1 - Math.min(1, scrollY / innerHeight) * 0.85); };

  const still = calm();
  reset();
  let timer = 0;
  addEventListener('resize', () => { clearTimeout(timer); timer = window.setTimeout(() => { reset(); if (still) once(); }, 180); });
  addEventListener('scroll', fade, { passive: true });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); canvas.style.opacity = '0'; canvas.dataset.lost = ''; });
  canvas.style.transition = still ? '' : 'opacity .7s';
  const once = () => { if (strip < STRIPS) bake(STRIPS); onFrame(0); draw(); fade(); };
  if (still) { scene.t = 20; once(); addEventListener('scroll', () => onFrame(0), { passive: true }); addEventListener('horizon:redraw', () => onFrame(0)); return; }

  /* 60 fps ceiling; a machine that cannot hold it gets a steady 30 instead of a ragged 45 */
  let prev = performance.now(), gap = 1000 / 60, late = 0, seen = 0;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const ms = now - prev;
    if (ms < gap - 4 || gl.isContextLost()) return;
    prev = now;
    if (strip < STRIPS) { bake(2); if (strip >= STRIPS) { canvas.style.transition = 'opacity .7s'; fade(); } else { onFrame(0); return; } }
    const dt = Math.min(0.1, ms / 1000);
    if (seen++ > 90 && gap < 20) { late = ms > 24 ? late + 1 : Math.max(0, late - 0.25); if (late > 25) gap = 1000 / 30; }
    scene.t += dt; onFrame(dt);
    if (scrollY < innerHeight * 0.95) draw(); // nothing to paint once the table covers the hole
  };
  requestAnimationFrame(loop);
}
