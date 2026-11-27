import { calm } from './motion';
import { EMBER, type Light } from './palettes';

export const NOISE = /* glsl */ `float h31(vec3 p){p=fract(p*.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
float n3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
 return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x),mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),
 mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x),mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){return n3(p)*.55+n3(p*2.1+7.)*.28+n3(p*4.4+3.)*.17;}
`;
export const SKY = /* glsl */ `vec3 sky(vec3 d){
  vec3 c=vec3(0);
  for(int i=0;i<2;i++){float k=i==0?70.:150.;vec3 q=d*k,id=floor(q);float h=h31(id);
    if(h>.985){vec3 f=fract(q)-.5;float s=smoothstep(.34,.0,length(f));c+=s*s*(h-.985)*66.*mix(starA,starB,h31(id+9.))*(i==0?1.:.55);}}
  float neb=fbm(d*2.6+4.);float neb2=fbm(d*5.+11.);
  c+=skyA*pow(neb,3.)*1.1+skyB*pow(neb2,3.)*1.2;
  return c;
}
`;

/**
 * Schwarzschild black hole. Each pixel integrates a light path (rs = 1), so the
 * accretion disk bends over and under the shadow as real lensing does.
 * The approaching side is blueshifted and the receding side redshifted, which is
 * the same code the interface uses for price.
 */
const FRAG = `#version 300 es
precision highp float;
uniform vec2 res; uniform float t, incl, roll, zoom, dim, tint, glowK, outer, dist, flip, jit, fall; uniform vec2 off; uniform vec3 c0,c1,c2,app,rec,halo,skyA,skyB,starA,starB;
out vec4 o;
${NOISE}float gas(vec2 p,float r,float tt){
  float a=-tt*5.2/pow(r,1.5); float c=cos(a),s=sin(a); p=mat2(c,-s,s,c)*p;
  vec2 d=p/r; return fbm(vec3(d*2.6,r*2.7))*.75+fbm(vec3(d*7.,r*6.))*.35;
}
vec4 disk(vec3 p,vec3 v){
  float r=length(p.xz); if(r<2.35||r>outer) return vec4(0);
  // two crossfaded phases keep the differential rotation from winding up forever
  float T=14.,f1=fract(t/T),f2=fract(t/T+.5);
  float g=mix(gas(p.xz,r,f2*T),gas(p.xz+3.1,r,f1*T),1.-abs(2.*f1-1.));
  float edge=smoothstep(2.35,3.1,r)*smoothstep(outer,outer*.54,r);
  float dens=pow(clamp(g*1.25-.22,0.,1.),1.7)*edge;
  vec3 orb=flip*normalize(vec3(-p.z,0,p.x));
  float beta=.62/sqrt(r*.55);
  float dop=1./(1.-beta*dot(orb,-normalize(v)));
  float heat=pow(2.9/r,fall);
  vec3 ember=mix(c0,c1,smoothstep(.18,.6,heat));
  ember=mix(ember,c2,smoothstep(.5,1.,heat));
  ember=mix(ember,ember.bgr*vec3(.9,1.15,1.),max(tint,0.));ember=mix(ember,ember*vec3(1.,.3,.2),max(-tint,0.));
  vec3 col=mix(ember,app,smoothstep(1.06,1.5,dop)*.85);
  col=mix(col,rec,smoothstep(.93,.66,dop)*.6);
  return vec4(col*dens*heat*pow(dop,3.)*4.2*glowK,clamp(dens*1.5,0.,.93));
}
${SKY}void main(){
  vec2 uv=(gl_FragCoord.xy-.5*res)/res.y-off;
  float cr=cos(roll),sr=sin(roll);uv=mat2(cr,-sr,sr,cr)*uv;
  vec3 ro=dist*vec3(0,sin(incl),-cos(incl)),f=-normalize(ro),rt=normalize(cross(vec3(0,1,0),f)),up=cross(f,rt);
  vec3 v=normalize(f*zoom+rt*uv.x+up*uv.y),p=ro;
  float h2=dot(cross(p,v),cross(p,v)); vec3 col=vec3(0); float tr=1.; bool cap=false; float glow=0.; p+=v*jit*h31(vec3(gl_FragCoord.xy,3.))*.6;
  for(int i=0;i<150;i++){
    float r=length(p); if(r<1.){cap=true;break;}
    if(r>max(17.,outer*1.15)&&dot(p,v)>0.)break;
    float dt=clamp(r*.095,.045,.7); vec3 pp=p;
    v+=-1.5*h2*p/pow(r,5.)*dt; p+=v*dt;
    glow+=dt*.006/(1.+pow(abs(r-1.6)*1.8,2.));
    if(pp.y*p.y<0.){vec3 q=mix(pp,p,pp.y/(pp.y-p.y));vec4 d=disk(q,v);col+=tr*d.rgb;tr*=1.-d.a;if(tr<.02)break;}
  }
  if(!cap)col+=tr*sky(normalize(v));
  col+=glow*mix(mix(halo,vec3(.3,.6,1.),max(tint,0.)),vec3(1.,.16,.08),max(-tint,0.))*tr*glowK;
  col=1.-exp(-col*1.25); col=pow(col,vec3(.86));
  col*=dim; col+=(h31(vec3(gl_FragCoord.xy,fract(t)*91.))-.5)*.022;
  o=vec4(col,1);
}`;
const VERT = `#version 300 es
void main(){vec2 p=vec2(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.);gl_Position=vec4(p,0,1);}`;

export interface Scene { incl: number; roll: number; zoom: number; dim: number; off: [number, number]; t: number;
  /** Optional, used by the variants. Defaults reproduce the original Horizon. */
  tint?: number;   // -1 redshifted disk, 0 ember, +1 blueshifted disk
  glow?: number;   // disk brightness
  outer?: number;  // disk outer radius (rs)
  dist?: number;   // camera distance (rs)
  flip?: 1 | -1;   // -1 puts the approaching (blue) side on the right
  jitter?: number; // dithers integration banding
  fall?: number;   // how fast the disk dims with radius
  speed?: number;  // rotation speed
  light?: Light;   // color theme, ember when absent
  box?: HTMLElement; // size source; the window when absent
}

const extent = (s: Scene): [number, number] => (s.box ? [s.box.clientWidth, s.box.clientHeight] : [innerWidth, innerHeight]);

export function horizon(canvas: HTMLCanvasElement, scene: Scene, onFrame: (dt: number) => void) {
  const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
  if (!gl) { canvas.dataset.failed = ''; onFrame(0); return; }
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
    const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog); gl.useProgram(prog);
  const u = Object.fromEntries(['res', 't', 'incl', 'roll', 'zoom', 'dim', 'off', 'tint', 'glowK', 'outer', 'dist', 'flip', 'jit', 'fall'].map((n) => [n, gl.getUniformLocation(prog, n)]));
  for (const [k, v] of Object.entries(scene.light ?? EMBER)) gl.uniform3f(gl.getUniformLocation(prog, k), v[0], v[1], v[2]);
  let scale = 0.62, slow = 0, fast = 0;
  const size = () => {
    const [W, H] = extent(scene), w = Math.max(2, Math.round(W * scale)), h = Math.max(2, Math.round(H * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
  };
  const draw = () => {
    size();
    gl.uniform2f(u.res, canvas.width, canvas.height); gl.uniform1f(u.t, scene.t); gl.uniform1f(u.incl, scene.incl);
    gl.uniform1f(u.roll, scene.roll); gl.uniform1f(u.zoom, scene.zoom); gl.uniform1f(u.dim, scene.dim); gl.uniform2f(u.off, ...scene.off);
    gl.uniform1f(u.tint, scene.tint ?? 0); gl.uniform1f(u.glowK, scene.glow ?? 1); gl.uniform1f(u.outer, scene.outer ?? 9.6); gl.uniform1f(u.dist, scene.dist ?? 15); gl.uniform1f(u.flip, scene.flip ?? 1); gl.uniform1f(u.jit, scene.jitter ?? 0); gl.uniform1f(u.fall, scene.fall ?? 1.35);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const still = calm();
  let prev = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
    // adaptive resolution: hold ~50fps on weak GPUs, sharpen on strong ones
    if (dt > 0.028) { slow++; fast = 0; } else { fast++; slow = 0; }
    if (slow > 12 && scale > 0.28) { scale *= 0.86; slow = 0; }
    if (fast > 240 && scale < 0.9) { scale *= 1.1; fast = 0; }
    scene.t += dt * (scene.speed ?? 1);
    onFrame(dt); draw(); requestAnimationFrame(loop);
  };
  if (still) {
    const once = () => { onFrame(0); draw(); };
    scene.t = 20; once(); addEventListener('scroll', once, { passive: true }); addEventListener('resize', once); addEventListener('horizon:redraw', once);
  } else requestAnimationFrame(loop);
}

/** Same camera as the shader, without lensing: places labels on the disk plane. CSS px. */
export function project(scene: Scene, x: number, z: number) {
  const [W, H] = extent(scene), D = scene.dist ?? 15, si = Math.sin(scene.incl), co = Math.cos(scene.incl);
  const f = [0, -si, co], up = [0, co, si]; // right is +x
  const d = [x, -D * si, z + D * co];
  const depth = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  let a = (x / depth) * scene.zoom, b = ((d[1] * up[1] + d[2] * up[2]) / depth) * scene.zoom;
  const c = Math.cos(scene.roll), s = Math.sin(scene.roll);
  // inverse of the GLSL column-major mat2(c,-s,s,c)
  [a, b] = [c * a - s * b, s * a + c * b];
  return { x: W / 2 + (a + scene.off[0]) * H, y: H / 2 - (b + scene.off[1]) * H, depth };
}
