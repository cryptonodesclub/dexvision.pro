import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { calm, pct, type Token } from './market';

/** A city lining the inside of a spinning habitat. Camera flies down the axis. */
const R = 62, L = 720;
const COL = { fog: '#05262a', sodium: '#ff9a2e', magenta: '#ff2e88', mint: '#8dffe6', yellow: '#ffe23d' };
const FOG = /* glsl */ `
  uniform vec3 fogC; uniform float scroll;
  float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
  vec3 haze(vec3 c,float z){float f=1.-exp(-pow(-z/330.,1.5));return mix(c,mix(fogC,vec3(1.,.5,.2)*.42,smoothstep(280.,700.,-z)),f);}
`;

export function colony(canvas: HTMLCanvasElement, box: HTMLElement, tokens: Token[], pick: (t: Token) => void) {
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }); }
  catch { box.dataset.failed = ''; return { refresh() {} }; }
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#02090a');
  const cam = new THREE.PerspectiveCamera(68, 1, 0.5, 1400); cam.position.set(0, -10, 0);
  const world = new THREE.Group(); scene.add(world);
  const U = { fogC: { value: new THREE.Color(COL.fog) }, scroll: { value: 0 }, time: { value: 0 } };

  /* towers */
  const N = 3000, g = new THREE.InstancedBufferGeometry();
  const b = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  g.index = b.index; g.attributes.position = b.attributes.position; g.attributes.normal = b.attributes.normal;
  const A = new Float32Array(N * 4), B = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const th = (Math.floor(Math.random() * 46) / 46) * Math.PI * 2, z = Math.floor(Math.random() * 80) * 9;
    const tall = Math.random() ** 3;
    A.set([th, z, 2.4 + Math.random() * 3.4, 2.4 + Math.random() * 4.4], i * 4);
    B.set([4 + tall * 33, Math.random(), Math.random(), 0], i * 4);
  }
  g.setAttribute('a', new THREE.InstancedBufferAttribute(A, 4)); g.setAttribute('b', new THREE.InstancedBufferAttribute(B, 4));
  g.instanceCount = N;
  const towers = new THREE.Mesh(g, new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */ `attribute vec4 a,b; uniform float scroll; varying vec3 vL,vN; varying vec4 vB; varying float vZ,vH; varying vec2 vW;
      void main(){ float y=position.y*b.x; float x=position.x*a.z; float z=-mod(a.y-scroll,${L}.)+position.z*a.w;
        vec2 up=vec2(-sin(a.x),cos(a.x)), tn=vec2(cos(a.x),sin(a.x));
        vec2 p=-up*(${R}.-y)+tn*x; vL=vec3(x,y,position.z*a.w); vN=normal; vB=b; vH=b.x; vW=a.zw;
        vec4 mv=viewMatrix*modelMatrix*vec4(p,z,1.); vZ=mv.z; gl_Position=projectionMatrix*mv; }`,
    fragmentShader: FOG + /* glsl */ `varying vec3 vL,vN; varying vec4 vB; varying float vZ,vH; varying vec2 vW; uniform float time;
      void main(){
        vec2 uv=abs(vN.x)>.5?vL.zy:vL.xy; vec2 cell=uv/vec2(.62,.86), id=floor(cell), f=fract(cell);
        float lit=step(.64+.2*vB.z,hash(id+vB.y*91.)); lit*=step(.14,f.x)*step(f.x,.84)*step(.22,f.y)*step(f.y,.78);
        vec3 tint=vB.y<.5?vec3(1.,.56,.18):vB.y<.74?vec3(.5,1.,.88):vB.y<.9?vec3(1.,.16,.5):vec3(1.,.88,.3);
        vec3 c=vec3(.012,.03,.032)+vec3(.0,.02,.022)*(vL.y/vH);
        float flick=.8+.2*step(.06,hash(id+floor(time*3.)));
        if(abs(vN.y)<.5) c+=tint*lit*(.4+1.1*hash(id.yx+3.))*flick;
        // neon edge on some towers, street glow at the foot
        float w=abs(vN.x)>.5?vW.y:vW.x; float edge=smoothstep(.12,.0,w*.5-abs(uv.x))*step(.8,vB.z);
        c+=tint*edge*1.7; c+=vec3(1.,.42,.12)*exp(-vL.y*.5)*.55; if(vN.y>.5)c+=tint*step(.9,vB.z)*.8;
        gl_FragColor=vec4(pow(haze(c,vZ),vec3(1.55))*1.5,1.); }`,
  }));
  towers.frustumCulled = false; world.add(towers);

  /* habitat floor: streets and traffic wrapped round the hull */
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(R, R, L, 96, 1, true).rotateX(Math.PI / 2).translate(0, 0, -L / 2), new THREE.ShaderMaterial({
    uniforms: U, side: THREE.BackSide,
    vertexShader: `varying vec3 vP; varying float vZ; void main(){vP=position;vec4 mv=modelViewMatrix*vec4(position,1.);vZ=mv.z;gl_Position=projectionMatrix*mv;}`,
    fragmentShader: FOG + /* glsl */ `varying vec3 vP; varying float vZ; uniform float time;
      void main(){ float th=atan(vP.y,vP.x)/6.2831853*46.; float z=(vP.z-scroll)/9.;
        vec2 f=abs(fract(vec2(th,z))-.5); float av=smoothstep(.07,.0,abs(f.x-.5)), st=smoothstep(.07,.0,abs(f.y-.5));
        float lane=floor(th+.5), dir=mod(lane,2.)*2.-1.; float car=step(.82,hash(vec2(lane,floor(z*4.+dir*time*3.))));
        vec3 c=vec3(.008,.02,.022)+vec3(1.,.45,.12)*(av*.28+st*.16);
        c+=(dir>0.?vec3(1.,.12,.3):vec3(.85,1.,.9))*car*av*1.9;
        gl_FragColor=vec4(pow(haze(c,vZ),vec3(1.6))*1.2,1.); }`,
  }));
  hull.frustumCulled = false; world.add(hull);

  /* open end: planet limb */
  const end = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), new THREE.ShaderMaterial({
    uniforms: U, vertexShader: `varying vec2 v; void main(){v=uv*2.-1.;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: FOG + /* glsl */ `varying vec2 v; uniform float time;
      void main(){ vec2 p=v*2.1; vec3 c=vec3(.01,.05,.06);
        c+=step(.994,hash(floor(p*70.)))*.9;
        vec2 q=p-vec2(.16,-.2); float r=length(q); float d=r-.62; float sun=clamp(dot(normalize(q),normalize(vec2(-.5,.85)))*.5+.5,0.,1.);
        float band=sin(q.y*26.+sin(q.x*9.)*1.2)*.5+.5;
        if(d<0.){ float nz=sqrt(1.-r*r/.3844); float li=clamp(dot(vec3(q/.62,nz),normalize(vec3(-.55,.8,.12))),0.,1.); c=mix(vec3(.02,.06,.06),mix(vec3(1.,.4,.12),vec3(1.,.74,.36),band),li*1.05);}
        c+=vec3(1.,.5,.2)*pow(sun,3.)*exp(-max(d,0.)*7.)*1.25*step(0.,d);
        // ring
        vec2 e=mat2(.94,-.34,.34,.94)*q; e.y*=4.4; float rr=length(e); float ring=smoothstep(.8,.84,rr)*smoothstep(1.22,1.16,rr)*(.55+.45*sin(rr*70.)); 
        if(!(d<0.&&e.y>0.)) c+=vec3(.55,1.,.88)*ring*.8;
        gl_FragColor=vec4(c,1.); }`,
  }));
  end.position.z = -L + 4; scene.add(end);

  /* air traffic */
  const T = 420, tg = new THREE.InstancedBufferGeometry(); tg.index = b.index; tg.attributes.position = b.attributes.position;
  const tA = new Float32Array(T * 4); const lanes = Array.from({ length: 12 }, () => [Math.random() * 6.28, 14 + Math.random() * 22]);
  for (let i = 0; i < T; i++) { const l = lanes[i % 12]; tA.set([l[0] + Math.random() * 0.03, l[1] + Math.random() * 1.2, Math.random() * L, (i % 2 ? 1 : -1) * (24 + (i % 12) * 3)], i * 4); }
  tg.setAttribute('a', new THREE.InstancedBufferAttribute(tA, 4)); tg.instanceCount = T;
  const cars = new THREE.Mesh(tg, new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: `attribute vec4 a; uniform float time,scroll; varying vec3 c; varying float vZ; void main(){ float z=-mod(a.z-scroll-a.w*time,${L}.);
      vec3 p=vec3(cos(a.x)*a.y,sin(a.x)*a.y,z)+position*vec3(.2,.16,4.2); c=a.w>0.?vec3(.8,1.,.92):vec3(1.,.14,.36); vec4 mv=modelViewMatrix*vec4(p,1.); vZ=mv.z; gl_Position=projectionMatrix*mv; }`,
    fragmentShader: FOG + `varying vec3 c; varying float vZ; void main(){gl_FragColor=vec4(haze(c*2.2,vZ),1.);}`,
  }));
  cars.frustumCulled = false; world.add(cars);

  /* neon signs, one per pair */
  const draw = (cv: HTMLCanvasElement, t: Token, i: number) => {
    const c = cv.getContext('2d')!, up = t.ch.h24 >= 0, col = [COL.mint, COL.yellow, COL.sodium][i % 3], cc = up ? COL.mint : COL.magenta;
    c.clearRect(0, 0, 512, 256); c.fillStyle = '#020c0ce8'; c.fillRect(8, 8, 496, 240);
    c.lineWidth = 7; c.strokeStyle = cc; c.strokeRect(14, 14, 484, 228); 
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = col;
    c.font = '118px "Tilt Neon"'; c.fillText(t.sym, 256, 98, 450);
    c.fillStyle = cc; c.font = '74px "Tilt Neon"'; c.fillText((up ? '▲ ' : '▼ ') + pct(t.ch.h24).slice(1), 256, 194, 450);
  };
  const signs = tokens.slice(0, 14).map((t, i) => {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 256;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(22, 11), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide }));
    // keep clear of the headline (lower left): right side, upper arc, far left
    const th = [0.15, 2.5, 0.75, -0.35, 2.0, 1.25, 2.85][i % 7], rad = 30 + (i % 3) * 5;
    m.position.set(Math.cos(th) * rad * 1.15, Math.sin(th) * rad * 0.8 - 4, 0); m.userData = { t, z: 60 + i * 34, i, cv, tex };
    world.add(m); draw(cv, t, i); return m;
  });

  const composer = new EffectComposer(renderer); composer.addPass(new RenderPass(scene, cam));
  const bloom = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.42, 0.5, 0.6); composer.addPass(bloom); composer.addPass(new OutputPass());
  let dpr = Math.min(devicePixelRatio, 1.5);
  const size = () => {
    const w = box.clientWidth, h = box.clientHeight;
    renderer.setPixelRatio(dpr); renderer.setSize(w, h, false); composer.setPixelRatio(dpr); composer.setSize(w, h);
    cam.aspect = w / h; cam.fov = w < 820 ? 82 : 68; cam.updateProjectionMatrix();
  };
  size(); new ResizeObserver(() => { size(); if (calm()) frame(0); }).observe(box);

  const ptr = new THREE.Vector2(), look = new THREE.Vector2(), ray = new THREE.Raycaster();
  const at = (e: PointerEvent | MouseEvent) => { const r = canvas.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
  const hit = (v: THREE.Vector2) => { ray.setFromCamera(v, cam); return ray.intersectObjects(signs)[0]?.object; };
  addEventListener('pointermove', (e) => { ptr.copy(at(e)); if (e.target === canvas) canvas.style.cursor = hit(ptr) ? 'pointer' : ''; });
  canvas.addEventListener('click', (e) => { const o = hit(at(e)); if (o) pick(o.userData.t); });

  let visible = true; new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(box);
  let s = 40;
  const frame = (dt: number) => {
    s += dt * 11; U.scroll.value = s; U.time.value += dt;
    look.lerp(ptr, 0.04);
    cam.position.x = look.x * 7; cam.position.y = -10 + look.y * 5; cam.lookAt(look.x * 22, 2 + look.y * 10, -200);
    world.rotation.z = Math.sin(U.time.value * 0.09) * 0.1 - look.x * 0.1;
    for (const m of signs) { const z = (((m.userData.z - s) % 476) + 476) % 476 + 34; m.position.z = -z; m.rotation.z = -world.rotation.z * 0.8; (m.material as THREE.MeshBasicMaterial).opacity = Math.min(1, (z - 34) / 22, (510 - z) / 130); }
    composer.render();
  };
  let prev = performance.now(), slow = 0;
  const loop = (now: number) => {
    const raw = (now - prev) / 1000; prev = now;
    if (visible && !document.hidden) { if (raw > 0.03 && raw < 0.5) slow++; else slow = Math.max(0, slow - 1); if (slow > 40 && dpr > 0.6) { dpr *= 0.82; slow = 0; size(); } frame(Math.min(raw, 0.1)); }
    requestAnimationFrame(loop);
  };
  document.fonts.load('118px "Tilt Neon"').then(() => { api.refresh(tokens); calm() ? frame(0) : requestAnimationFrame(loop); });
  const api = { refresh(ch: Token[]) { for (const m of signs) if (ch.includes(m.userData.t)) { draw(m.userData.cv, m.userData.t, m.userData.i); m.userData.tex.needsUpdate = true; } } };
  return api;
}
