import { calm } from './market';

/**
 * A ringed gnome, raymarched into a tiny buffer (one texel per character) and then
 * printed with the characters of a real Gno package, two inks slightly off register.
 */
const SCENE = `#version 300 es
precision highp float; uniform vec2 res; uniform float t,asp; uniform vec2 m,off; out vec4 o;
mat2 R(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
float smin(float a,float b,float k){float h=clamp(.5+.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.-h);}
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
// material: 1 hat, 2 beard, 3 face, 4 ring, 5 eyes, 6 brim
vec2 U(vec2 a,vec2 b){return a.x<b.x?a:b;}
vec2 map(vec3 p){
  vec3 q=p-vec3(0,.28,0); float y=clamp(q.y/1.9,0.,1.);
  q.x-=.34*y*y*sin(t*.7+.6)+.26*pow(y,3.); q.z+=.16*y*y;
  float rad=mix(.83,.03,pow(y,.82))+.035*sin(q.y*11.)*(1.-y);
  float hat=max(length(q.xz)-rad,max(-q.y,q.y-1.9))*.72;
  vec3 b=p-vec3(0,.28,0); float brim=length(vec2(length(b.xz)-.83,b.y))-.15;
  vec2 d=U(vec2(hat,1.),vec2(brim,6.));
  float head=length((p-vec3(0,-.12,0))*vec3(1.,.95,1.08))-.7; d=U(d,vec2(head,3.));
  float nose=length((p-vec3(0,-.14,-.74))*vec3(.92,1.05,1.))-.225; d=U(d,vec2(nose,3.));
  vec3 e=p;e.x=abs(e.x); d=U(d,vec2(length(e-vec3(.27,.0,-.64))-.085,5.));
  vec3 k=p-vec3(0,-.78,-.18); float taper=mix(1.,.34,clamp((-k.y+.3)/1.2,0.,1.));
  float an=atan(k.x,-k.z); float beard=length(k*vec3(1.05/taper,.82,1.05/taper))-.82; beard=beard*.45+.03*sin(an*15.+k.y*5.+sin(k.y*8.+t)*.9);
  vec3 mo=p;mo.x=abs(mo.x);float mus=length((mo-vec3(.25,-.38,-.68))*vec3(.75,1.6,1.1))-.2; beard=smin(beard,mus*.8,.09);
  beard=max(beard,p.y+.12-.5*smoothstep(.0,.7,p.z+.7)); d=U(d,vec2(beard,2.));
  vec3 r=p-vec3(0,1.02,0); r.xy=R(.2)*r.xy; r.yz=R(.13)*r.yz; float l=length(r.xz);
  float ring=max(abs(r.y)-.022,max(1.12-l,l-1.72)); ring=max(ring,.04-abs(l-1.36)); d=U(d,vec2(ring*.9,4.));
  return d;
}
void main(){
  vec2 uv=(gl_FragCoord.xy/res*2.-1.)*vec2(asp,1.)-off;
  vec3 ro=vec3(0,.28,-6.4),rd=normalize(vec3(uv*.355,1.));
  float yaw=sin(t*.45)*.38+m.x*.75,pit=m.y*.32+.03;
  float d=0.,mat=0.; vec3 p; bool hit=false;
  for(int i=0;i<80;i++){p=ro+rd*d;p.yz=R(pit)*p.yz;p.xz=R(yaw)*p.xz;vec2 s=map(p);if(s.x<.003){hit=true;mat=s.y;break;}d+=s.x;if(d>12.)break;}
  float lum=0.;
  if(hit){
    vec2 e=vec2(.004,0);vec3 n=normalize(vec3(map(p+e.xyy).x-map(p-e.xyy).x,map(p+e.yxy).x-map(p-e.yxy).x,map(p+e.yyx).x-map(p-e.yyx).x));
    vec3 L=vec3(-.55,.7,-.62);L.yz=R(pit)*L.yz;L.xz=R(yaw)*L.xz;L=normalize(L);
    float sh=1.,k=.06;for(int i=0;i<22;i++){float s=map(p+n*.02+L*k).x;sh=min(sh,9.*s/k);k+=clamp(s,.03,.2);if(sh<.02||k>3.)break;} sh=clamp(sh,0.,1.);
    lum=.1+.9*max(dot(n,L),0.)*clamp(sh,.12,1.); float rim=pow(1.-abs(dot(n,normalize(rd))),3.); lum=max(lum-.2*rim,.03);
    if(mat==4.){float l=length(p.xz);lum=.58+.16*sin(l*34.)+.24*sh;}
    if(mat==5.)lum=.02;
  } else {
    // galaxy arms behind
    vec2 g=R(.5)*(uv-vec2(.1,.1));g.y*=1.9;float r=length(g),a=atan(g.y,g.x);
    float arm=pow(.5+.5*cos(2.*a+log(r+.06)*5.2-t*.35),2.4)*exp(-r*.8)*smoothstep(.15,.5,r);
    float st=step(.985,h21(floor(gl_FragCoord.xy)))*(.4+.6*sin(t*2.+h21(gl_FragCoord.xy)*40.));
    lum=clamp(arm*.8+max(st,0.)*.8+(h21(gl_FragCoord.xy)-.5)*.07,0.,1.); mat=0.;
  }
  o=vec4(clamp(lum,0.,1.),mat/8.,0,1);
}`;
const PRINT = `#version 300 es
precision highp float; uniform sampler2D s,a; uniform vec2 res,grid; uniform float t,n,still; uniform vec2 mp; out vec4 o;
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
const vec3 INK=vec3(.075,.03,.42),PINK=vec3(1.,.40,.50),LEM=vec3(.925,1.,.25),PALE=vec3(1.,.90,.88),HOT=vec3(1.,.19,.16);
void main(){
  vec2 px=gl_FragCoord.xy; vec2 d=px-mp; float w=length(d);
  px+=normalize(d+.001)*sin(w*.055-t*5.)*9.*exp(-w*.011);
  vec2 cs=res/grid, c=floor(px/cs), f=fract(px/cs);
  vec4 v=texture(s,(c+.5)/grid); float mat=floor(v.g*8.+.5);
  float mis=floor(texture(s,(floor((px+vec2(7.,-6.))/cs)+.5)/grid).g*8.+.5); // second plate, off register
  vec3 col=PINK;
  if(mis==1.)col=LEM; else if(mis==2.)col=PALE; else if(mis==3.)col=HOT; else if(mis==4.)col=LEM; else if(mis==6.)col=PALE;
  float ink=mat==0.?v.r*.8:1.-v.r*.96; if(mat==5.)ink=1.;
  if(mat==1.){ink=pow(ink,.8);} if(mat==2.)ink*=.86; if(mat==6.)ink*=.7;
  float tick=floor(t*(1.2+2.*h21(c))+h21(c+5.)*9.)*(1.-still);
  float lvl=clamp(floor(ink*(n-1.)+(h21(c+tick)-.5)*1.6+.5),0.,n-1.);
  float g=texture(a,vec2((lvl+f.x)/n,1.-f.y)).r; if(ink<.035)g=0.; if(ink>.9)g=max(g,step(.93,ink));
  col=mix(col,INK,g);
  col-=(h21(gl_FragCoord.xy)-.5)*.035; // paper
  o=vec4(col,1);
}`;
const VERT = `#version 300 es
void main(){vec2 p=vec2(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.);gl_Position=vec4(p,0,1);}`;

export async function source(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl) { canvas.dataset.failed = ''; return; }
  await document.fonts.load('700 30px "Sometype Mono Variable"');
  const build = (frag: string) => {
    const p = gl.createProgram()!;
    for (const [ty, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, frag]] as const) {
      const s = gl.createShader(ty)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); gl.attachShader(p, s);
    }
    gl.linkProgram(p); return { p, u: (n: string) => gl.getUniformLocation(p, n) };
  };
  const A = build(SCENE), B = build(PRINT);

  /* glyph ramp: characters used in Gno source, sorted by measured ink */
  const CW = 24, CH = 36, chars = [...new Set(' .`:;,-=+/(){}[]<>!?&*|_irtlcvxznoaeugpdqbkhfmwyGNORTMBW#@%0123456789')];
  const cv = document.createElement('canvas'); cv.width = CW * chars.length; cv.height = CH;
  const c = cv.getContext('2d', { willReadFrequently: true })!;
  const paint = (list: string[]) => { c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, CH); c.fillStyle = '#fff'; c.font = '700 33px "Sometype Mono Variable", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle'; list.forEach((g, i) => c.fillText(g, i * CW + CW / 2, CH / 2 + 1)); };
  paint(chars);
  const ink = chars.map((g, i) => { const d = c.getImageData(i * CW, 0, CW, CH).data; let s = 0; for (let k = 0; k < d.length; k += 4) s += d[k]; return { g, s }; }).sort((a, b) => a.s - b.s);
  paint(ink.map((x) => x.g));
  const atlas = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, atlas);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);

  const buf = gl.createTexture(), fb = gl.createFramebuffer(); let gw = 0, gh = 0;
  const size = () => {
    const dpr = Math.min(devicePixelRatio, 2), r = canvas.getBoundingClientRect();
    canvas.width = Math.max(2, r.width * dpr); canvas.height = Math.max(2, r.height * dpr);
    gw = Math.round(r.width / 6.4); gh = Math.round(r.height / 9.6);
    gl.bindTexture(gl.TEXTURE_2D, buf); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gw, gh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, buf, 0);
  };
  const m = { x: 0, y: 0, tx: 0, ty: 0, px: -9999, py: -9999 };
  addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(), k = canvas.width / r.width; m.tx = (e.clientX / innerWidth) * 2 - 1; m.ty = (e.clientY / innerHeight) * 2 - 1; m.px = (e.clientX - r.left) * k; m.py = (r.bottom - e.clientY) * k; });
  const still = calm(); let t = 1.6;
  const draw = () => {
    m.x += (m.tx - m.x) * 0.06; m.y += (m.ty - m.y) * 0.06;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, gw, gh); gl.useProgram(A.p);
    gl.uniform2f(A.u('res'), gw, gh); gl.uniform1f(A.u('t'), t); gl.uniform1f(A.u('asp'), canvas.width / canvas.height); gl.uniform2f(A.u('m'), -m.x, m.y); const as = canvas.width / canvas.height; gl.uniform2f(A.u('off'), as > 1.15 ? as * 0.43 : 0, as > 1.15 ? -0.02 : 0.02);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(B.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, buf); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, atlas); gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(B.u('s'), 0); gl.uniform1i(B.u('a'), 1); gl.uniform2f(B.u('res'), canvas.width, canvas.height); gl.uniform2f(B.u('grid'), gw, gh);
    gl.uniform1f(B.u('t'), t); gl.uniform1f(B.u('n'), chars.length); gl.uniform1f(B.u('still'), still ? 1 : 0); gl.uniform2f(B.u('mp'), m.px, m.py);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  size(); new ResizeObserver(() => { size(); draw(); }).observe(canvas); draw();
  if (still) return;
  let on = true; new IntersectionObserver(([e]) => { on = e.isIntersecting; }).observe(canvas);
  let prev = performance.now();
  const loop = (now: number) => { const dt = Math.min(0.1, (now - prev) / 1000); prev = now; if (on) { t += dt; draw(); } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
