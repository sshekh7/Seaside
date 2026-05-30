"use client"

import { useEffect, useRef } from "react"
import * as THREE from "three"

/**
 * Dense animated point-cloud terrain rendered with a custom GLSL shader.
 * Black & white "gradient descent / loss surface" aesthetic: complex ridged
 * topography that slowly morphs over time, lit from the upper-left.
 */
export function TerrainHero() {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x05060a)

    const camera = new THREE.PerspectiveCamera(
      42,
      mount.clientWidth / mount.clientHeight,
      0.1,
      1000
    )
    camera.position.set(-6, 24, 52)
    camera.lookAt(8, 6, -6)

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    mount.appendChild(renderer.domElement)

    // --- Geometry: a dense grid of points on the XZ plane ---
    const SEG = 480 // grid resolution -> (SEG+1)^2 points
    const SIZE = 80 // world size of the plane
    const geometry = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG)
    geometry.rotateX(-Math.PI / 2)

    const uniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uPointSize: { value: 1.7 },
      uHeight: { value: 9.0 },
      uLightDir: { value: new THREE.Vector3(-0.6, 0.8, 0.35).normalize() },
    }

    const material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: true,
      vertexShader: VERT,
      fragmentShader: FRAG,
    })

    const points = new THREE.Points(geometry, material)
    scene.add(points)

    // --- Resize handling ---
    const onResize = () => {
      if (!mount) return
      const w = mount.clientWidth
      const h = mount.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
      uniforms.uPixelRatio.value = renderer.getPixelRatio()
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    // --- Subtle parallax from pointer ---
    let targetX = 0
    let targetY = 0
    const onPointer = (e: PointerEvent) => {
      const r = mount.getBoundingClientRect()
      targetX = ((e.clientX - r.left) / r.width - 0.5) * 2
      targetY = ((e.clientY - r.top) / r.height - 0.5) * 2
    }
    mount.addEventListener("pointermove", onPointer)

    // --- Animation loop ---
    const clock = new THREE.Clock()
    let raf = 0
    let camAngle = 0
    const render = () => {
      const dt = clock.getDelta()
      uniforms.uTime.value += dt

      // slow orbit + pointer parallax
      camAngle += dt * 0.03
      const radius = 52
      const px = Math.sin(camAngle) * radius - 6 + targetX * 6
      const pz = Math.cos(camAngle) * radius
      camera.position.x += (px - camera.position.x) * 0.04
      camera.position.z += (pz - camera.position.z) * 0.04
      camera.position.y += (24 - targetY * 6 - camera.position.y) * 0.04
      camera.lookAt(8, 6, -6)

      renderer.render(scene, camera)
      raf = requestAnimationFrame(render)
    }
    render()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mount.removeEventListener("pointermove", onPointer)
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [])

  return <div ref={mountRef} className="absolute inset-0 h-full w-full" />
}

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

// Classic Ashima 3D simplex noise (Stefan Gustavson / Ashima Arts).
const NOISE_GLSL = /* glsl */ `
vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`

const VERT = /* glsl */ `
uniform float uTime;
uniform float uPixelRatio;
uniform float uPointSize;
uniform float uHeight;
uniform vec3 uLightDir;

varying float vHeight;
varying float vShade;
varying float vDist;

${NOISE_GLSL}

// Fractal ridged + domain-warped terrain. Returns height for a given xz.
float terrain(vec2 p, float t){
  // domain warp for swirling, complex structure
  vec2 q = vec2(
    snoise(vec3(p * 0.06, t * 0.05)),
    snoise(vec3(p * 0.06 + 31.4, t * 0.05))
  );
  vec2 w = p + q * 6.0;

  float h = 0.0;
  float amp = 0.5;
  float freq = 0.045;
  // fractal brownian motion with ridged octaves
  for (int i = 0; i < 6; i++) {
    float n = snoise(vec3(w * freq, t * 0.08 + float(i) * 1.7));
    n = 1.0 - abs(n);      // ridged
    n = n * n;             // sharpen ridges
    h += n * amp;
    amp *= 0.5;
    freq *= 2.02;
    w = w * 1.03 + 5.0;
  }
  // large rolling base so the whole surface drifts
  h += snoise(vec3(p * 0.018, t * 0.04)) * 0.5;
  return h;
}

void main(){
  vec3 pos = position;
  float t = uTime;

  float e = 0.35; // sample epsilon for normal estimation
  float h  = terrain(pos.xz, t);
  float hx = terrain(pos.xz + vec2(e, 0.0), t);
  float hz = terrain(pos.xz + vec2(0.0, e), t);

  pos.y = h * uHeight;

  // estimate normal from finite differences
  vec3 tangentX = vec3(e, (hx - h) * uHeight, 0.0);
  vec3 tangentZ = vec3(0.0, (hz - h) * uHeight, e);
  vec3 normal = normalize(cross(tangentZ, tangentX));

  float diffuse = clamp(dot(normal, uLightDir), 0.0, 1.0);
  vHeight = clamp(h, 0.0, 1.4);
  vShade = diffuse;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  vDist = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;

  // perspective-attenuated point size, clamped so near points stay fine
  float ps = uPointSize * uPixelRatio * (90.0 / vDist);
  gl_PointSize = clamp(ps, 1.0, 4.0 * uPixelRatio);
}
`

const FRAG = /* glsl */ `
precision highp float;

varying float vHeight;
varying float vShade;
varying float vDist;

void main(){
  // round, soft points
  vec2 uv = gl_PointCoord - 0.5;
  float r = dot(uv, uv);
  if (r > 0.25) discard;
  float alpha = smoothstep(0.25, 0.04, r);

  // grayscale: lit ridges blow out to white, valleys fall to near-black
  float base = vHeight * 0.55 + vShade * 0.75;
  base = pow(clamp(base, 0.0, 1.0), 1.25);
  float lum = mix(0.04, 1.0, base);

  // ridge sparkle on the brightest, most lit points
  lum += smoothstep(0.85, 1.0, vShade) * vHeight * 0.4;
  lum = clamp(lum, 0.0, 1.0);

  // fade into the dark distance for depth
  float fog = smoothstep(110.0, 28.0, vDist);
  lum *= mix(0.2, 1.0, fog);

  gl_FragColor = vec4(vec3(lum), alpha);
}
`
