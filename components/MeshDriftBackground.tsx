"use client";

/**
 * "Mesh drift" -- fullscreen animated WebGL backdrop, mounted once in the root
 * layout so every route gets an identical background.
 *
 * Plain WebGL1, no libraries. The scene is a single fullscreen *triangle*
 * rather than a quad: (-1,-1), (3,-1), (-1,3) covers the whole clip-space
 * square, so there is no diagonal seam. The fragment shader works off
 * gl_FragCoord and does not care how the surface was tessellated.
 *
 * WHY THE PALETTE IS LIGHT HERE, WHEN THE RECIPE SPECIFIED NEAR-BLACK
 * ---------------------------------------------------------------
 * This replica's <body> is opaque white with --lal-ink near-black. A canvas at
 * z-index -1 paints *over* the body background, so a #101010 -> #3A3A3A field
 * would put #251e20 text on a near-black field: not subtle, illegible. The home
 * hero is the one surface that is already dark (--lal-hero-from/to), which is
 * the only place in this design where the dark pair reads correctly.
 *
 * So PALETTE_LOW/HIGH below are the light equivalent, and the dark pair from
 * the recipe is kept beside them. To use the dark version -- on the hero, or
 * across the whole page if the body is ever re-skinned -- swap those two lines.
 * Nothing else in the file depends on the choice.
 */

import { useEffect, useRef } from "react";

const VERTEX_SHADER = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/**
 * The fragment shader, verbatim. Do not reflow the uniform block: the packed
 * layout is part of the contract, and the macros below are what let it keep a
 * readable u_* API inside a 15-vec4 WebGL1 budget.
 */
const FRAGMENT_SHADER = `
// "Mesh drift" — made with the 21st.dev Shader Builder
// Packed WebGL1 uniforms (the shader exposes readable u_* aliases as macros):
//   u_colors[8] (first 2 used)
//   vec3(0.063, 0.063, 0.063)
//   vec3(0.227, 0.227, 0.227)
//   u_scene = vec4(canvas width, canvas height, seconds * 0.86, 2.0)
//   u_shape = vec4(2.50, 0.59, 0.50, 0.00)
//   u_surface = vec4(2.40, 0.91, -0.10, 1.00)
//   u_finish = vec4(6.28, 0.00, 0.016, 0.16)
//   u_transform = vec4(1.0, 0.00, 0.03, 0.0)
//   u_space = vec4(0.00, 0.00, pointer x, pointer y)
//   u_cursor = vec4(presence, 4.0, 1.00, 0.35)

#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec3 u_colors[8];
// Seven packed vectors + eight colour vectors = 15 fragment uniform vectors,
// one below WebGL1's guaranteed minimum. Macros preserve the public u_* API.
uniform vec4 u_scene;      // resolution.xy, time, colour count
uniform vec4 u_shape;      // scale, intensity, paramA, warp
uniform vec4 u_surface;    // detail, contrast, brightness, saturation
uniform vec4 u_finish;     // hue, vignette, blur, grain
uniform vec4 u_transform;  // seed, rotation, drift, OKLab toggle
uniform vec4 u_space;      // offset.xy, pointer.xy
uniform vec4 u_cursor;

#define u_resolution u_scene.xy
#define u_time u_scene.z
#define u_colorCount u_scene.w
#define u_scale u_shape.x
#define u_intensity u_shape.y
#define u_paramA u_shape.z
#define u_warp u_shape.w
#define u_detail u_surface.x
#define u_contrast u_surface.y
#define u_brightness u_surface.z
#define u_saturation u_surface.w
#define u_hue u_finish.x
#define u_vignette u_finish.y
#define u_blur u_finish.z
#define u_grain u_finish.w
#ifdef GL_FRAGMENT_PRECISION_HIGH
#define u_seed u_transform.x
#else
// Keep hash inputs inside mediump's guaranteed ±2^14 range.
#define u_seed mod(u_transform.x, 31.0)
#endif
#define u_rotate u_transform.y
#define u_drift u_transform.z
#define u_oklab u_transform.w
#define u_offset u_space.xy
#define u_mouse u_space.zw
#define u_cursorPresence u_cursor.x
#define u_cursorEffect u_cursor.y
#define u_cursorStrength u_cursor.z
#define u_cursorRadius u_cursor.w

float hash21(vec2 p) {
#ifndef GL_FRAGMENT_PRECISION_HIGH
  p = mod(p, 31.0);
#endif
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

// Even, un-structured white noise for film grain (Dave Hoskins hash12). The
// multiply hash above is fine for value noise but shows a faint axis-aligned
// mesh at integer fragment coords, which reads as a net over flat areas.
float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
#ifndef GL_FRAGMENT_PRECISION_HIGH
  p = mod(p, 31.0);
#endif
  float n = sin(dot(p, vec2(41.0, 289.0)));
  return fract(vec2(15731.743, 7892.321) * n);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.0, 9.2);
    a *= 0.5;
  }
  return v;
}

// --- OKLab colour mixing (perceptual), gated by u_oklab -----------------------
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)),
    step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  // max() guards the sRGB branch: out-of-gamut OKLab interpolations can send a
  // channel negative, and pow(negative, …) is NaN which mix()/step() would
  // then propagate. The linear branch clips such channels to 0 downstream.
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    step(0.0031308, c));
}
vec3 linToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(max(l, 0.0), 1.0 / 3.0);
  m = pow(max(m, 0.0), 1.0 / 3.0);
  s = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 oklabToLin(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 mixColour(vec3 a, vec3 b, float t) {
  if (u_oklab > 0.5) {
    vec3 la = linToOklab(srgbToLinear(a));
    vec3 lb = linToOklab(srgbToLinear(b));
    return clamp(linearToSrgb(oklabToLin(mix(la, lb, t))), 0.0, 1.0);
  }
  return mix(a, b, t);
}

// Mix through the recipe colours; x is clamped to 0..1. WebGL1 forbids
// dynamic uniform indexing in fragment shaders, hence the constant loop.
vec3 palette(float x) {
  float n = max(u_colorCount - 1.0, 1.0);
  float f = clamp(x, 0.0, 1.0) * n;
  vec3 col = u_colors[0];
  for (int i = 0; i < 7; i++) {
    if (float(i) < n)
      col = mixColour(col, u_colors[i + 1],
        smoothstep(0.0, 1.0, clamp(f - float(i), 0.0, 1.0)));
  }
  return col;
}

vec3 hueRotate(vec3 col, float a) {
  const mat3 toYIQ = mat3(0.299, 0.596, 0.211,
                          0.587, -0.274, -0.523,
                          0.114, -0.322, 0.312);
  const mat3 toRGB = mat3(1.0, 1.0, 1.0,
                          0.956, -0.272, -1.106,
                          0.621, -0.647, 1.703);
  vec3 yiq = toYIQ * col;
  float ca = cos(a), sa = sin(a);
  yiq = vec3(yiq.x, yiq.y * ca - yiq.z * sa, yiq.y * sa + yiq.z * ca);
  return toRGB * yiq;
}

vec3 shade(vec2 uv, vec2 p, float t) {
  vec3 acc = u_colors[0] * 0.15;
  float total = 0.15;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= u_colorCount) break;
    float fi = float(i);
    vec2 c = vec2(
      sin(t * (0.21 + fi * 0.071) + fi * 2.4 + u_seed),
      cos(t * (0.17 + fi * 0.093) + fi * 1.7)) * (0.45 + u_intensity * 0.35);
    float w = exp(-dot(p - c, p - c) * 6.0);
    acc += u_colors[i] * w;
    total += w;
  }
  return acc / total;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 screenUv = uv;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
    / min(u_resolution.x, u_resolution.y);
  float cursorMask = 0.0;

  // Cursor modes 1–3 are local distortions. Push shifts the same screen-space
  // coordinates before field transforms, so Zoom/Rotate don't change its feel.
  if (u_cursorPresence > 0.001) {
    // u_mouse is normalized to -1..1 in canvas space. Convert it to the same
    // aspect-corrected screen space as p so effects stay under the cursor.
    vec2 cursor = (0.5 * u_mouse * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
    vec2 cursorDelta = p - cursor;
    if (u_cursorEffect < 0.5) {
      p += cursor * u_cursorPresence * u_cursorStrength * 0.55;
    } else {
      float cursorDistance = length(cursorDelta);
      vec2 cursorDirection = cursorDelta / max(cursorDistance, 0.0001);
      cursorMask = u_cursorPresence
        * (1.0 - smoothstep(0.0, u_cursorRadius, cursorDistance));
      if (u_cursorEffect < 1.5) {
        p -= cursorDirection * cursorMask * u_cursorStrength * 0.24;
      } else if (u_cursorEffect < 2.5) {
        float cursorAngle = cursorMask * u_cursorStrength * 2.2;
        float cc = cos(cursorAngle), cs = sin(cursorAngle);
        p = cursor + mat2(cc, -cs, cs, cc) * cursorDelta;
      } else if (u_cursorEffect < 3.5) {
        float ripple = sin(
          cursorDistance / max(u_cursorRadius, 0.001) * 18.0 - u_time * 5.0);
        p -= cursorDirection * ripple * cursorMask * u_cursorStrength * 0.07;
      }
    }
  }

  // Keep presets that read uv (rather than p) in the same warped space.
  uv = p * min(u_resolution.x, u_resolution.y) / u_resolution.xy + 0.5;
  p *= u_scale;
  // Field transform: rotate, pan, pointer push, slow drift.
  if (abs(u_rotate) > 0.0001) {
    float cr = cos(u_rotate), sr = sin(u_rotate);
    p = mat2(cr, -sr, sr, cr) * p;
  }
  p += u_offset;
  if (u_drift > 0.0001)
    p += u_drift * vec2(sin(u_time * 0.31), cos(u_time * 0.23));
  // Organic domain warp.
  if (u_warp > 0.0) {
    p += u_warp * (vec2(
      fbm(p * u_detail + u_seed),
      fbm(p * u_detail + vec2(5.2, 1.3))) - 0.5);
  }
  // Shade, with an optional soft 5-tap blur.
  vec3 col;
  if (u_blur > 0.0) {
    float e = u_blur;
    float pe = e * u_scale;
    vec2 uvE = vec2(e) * min(u_resolution.x, u_resolution.y) / u_resolution.xy;
    col  = shade(uv, p, u_time) * 0.36;
    col += shade(uv + vec2(uvE.x, 0.0), p + vec2(pe, 0.0), u_time) * 0.16;
    col += shade(uv - vec2(uvE.x, 0.0), p - vec2(pe, 0.0), u_time) * 0.16;
    col += shade(uv + vec2(0.0, uvE.y), p + vec2(0.0, pe), u_time) * 0.16;
    col += shade(uv - vec2(0.0, uvE.y), p - vec2(0.0, pe), u_time) * 0.16;
  } else {
    col = shade(uv, p, u_time);
  }
  // Post: contrast, saturation, hue, brightness, vignette, grain.
  if (abs(u_contrast - 1.0) > 0.0001)
    col = (col - 0.5) * u_contrast + 0.5;
  if (abs(u_saturation - 1.0) > 0.0001) {
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, u_saturation);
  }
  if (abs(u_hue) > 0.0001)
    col = hueRotate(col, u_hue);
  if (abs(u_brightness) > 0.0001)
    col += u_brightness;
  if (u_vignette > 0.0001) {
    float vd = length(screenUv - 0.5) * 1.41421356;
    col *= 1.0 - u_vignette * smoothstep(0.35, 1.0, vd);
  }
  if (u_cursorPresence > 0.001 && u_cursorEffect > 3.5)
    col += (vec3(0.18) + col * 0.12) * cursorMask * u_cursorStrength;
  if (u_grain > 0.0001)
    col += (grainHash(
      gl_FragCoord.xy + vec2(u_seed * 17.0, u_seed * 31.0)) - 0.5) * u_grain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/**
 * Scene parameters, kept as the packed vectors the shader's header documents.
 * Storing them packed rather than as twenty-odd named constants means the JS
 * and the GLSL cannot drift apart: one place owns the mapping.
 */
const SCENE = {
  /** seconds * this value is the shader's u_time */
  timeScale: 0.86,
  colourCount: 2,
  /** scale, intensity, paramA, warp */
  shape: [2.5, 0.59, 0.5, 0.0] as const,
  /** detail, contrast, brightness, saturation */
  surface: [2.4, 0.91, 0.0, 1.0] as const,
  /** hue (rad), vignette, blur, grain */
  finish: [6.28, 0.0, 0.016, 0.16] as const,
  /** seed, rotation, drift, OKLab toggle */
  transform: [1.0, 0.0, 0.03, 0.0] as const,
  /** offset.xy, pointer.xy */
  space: [0.0, 0.0, 0.0, 0.0] as const,
  /** presence, effect (4 = spotlight), strength, radius */
  cursor: [0.0, 4.0, 1.0, 0.35] as const,
};

/**
 * Written as floats, not hex strings: the shader takes a vec3 uniform, and a
 * CSS custom property cannot be handed to uniform3fv without being parsed back
 * out of getComputedStyle on every mount.
 *
 * The light pair in use. Contrast 0.91 lifts the floor slightly, so the darkest
 * rendered value lands a little under the nominal low colour.
 */
const PALETTE_LOW = [250 / 255, 250 / 255, 251 / 255] as const;
const PALETTE_HIGH = [196 / 255, 196 / 255, 204 / 255] as const;

/** The recipe's dark pair, kept for the hero / a future dark skin. */
const PALETTE_LOW_DARK = [16 / 255, 16 / 255, 16 / 255] as const;
const PALETTE_HIGH_DARK = [58 / 255, 58 / 255, 58 / 255] as const;
void PALETTE_LOW_DARK;
void PALETTE_HIGH_DARK;

/**
 * Fill all 8 colour slots. Only the first `colourCount` are read, but the array
 * must be declared 8 long, and the tail is padded with the high colour rather
 * than zeros so nothing in-gamut-adjacent is uploaded as black by accident.
 */
function buildColours(): Float32Array {
  const out = new Float32Array(8 * 3);
  for (let i = 0; i < 8; i++) {
    const c = i === 0 ? PALETTE_LOW : PALETTE_HIGH;
    out[i * 3 + 0] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  return out;
}

function compile(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log ?? "no log"}`);
  }
  return shader;
}

export function MeshDriftBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      // All fragment work on a fullscreen triangle: no edges to antialias and
      // no geometry to depth-test.
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // Not preserveDrawingBuffer: it costs a copy per frame and only matters
      // for toDataURL, which nothing here calls.
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    });

    if (!gl) {
      // No WebGL: leave the page's own white background alone rather than
      // flashing a black rectangle. The attribute keeps it inspectable.
      canvas.dataset.webgl = "unavailable";
      return;
    }

    let program: WebGLProgram;
    try {
      const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      if (!vs || !fs) throw new Error("shader allocation failed");
      const p = gl.createProgram();
      if (!p) throw new Error("program allocation failed");
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(`link failed: ${gl.getProgramInfoLog(p) ?? "no log"}`);
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      program = p;
    } catch (err) {
      canvas.dataset.webgl = "error";
      canvas.dataset.webglError = err instanceof Error ? err.message : String(err);
      return;
    }

    const glProgram = program;
    gl.useProgram(glProgram);

    // Fullscreen triangle. (-1,-1), (3,-1), (-1,3) covers clip space entirely.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(glProgram, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Cache locations up front. getUniformLocation returns null for a uniform the
    // compiler eliminated, and the matching uniform* call is then a documented
    // no-op, so nulls are safe here.
    const uColors = gl.getUniformLocation(glProgram, "u_colors[0]");
    const uScene = gl.getUniformLocation(glProgram, "u_scene");
    const uShape = gl.getUniformLocation(glProgram, "u_shape");
    const uSurface = gl.getUniformLocation(glProgram, "u_surface");
    const uFinish = gl.getUniformLocation(glProgram, "u_finish");
    const uTransform = gl.getUniformLocation(glProgram, "u_transform");
    const uSpace = gl.getUniformLocation(glProgram, "u_space");
    const uCursor = gl.getUniformLocation(glProgram, "u_cursor");

    gl.uniform3fv(uColors, buildColours());
    gl.uniform4fv(uShape, new Float32Array(SCENE.shape));
    gl.uniform4fv(uSurface, new Float32Array(SCENE.surface));
    gl.uniform4fv(uFinish, new Float32Array(SCENE.finish));
    gl.uniform4fv(uTransform, new Float32Array(SCENE.transform));
    gl.uniform4f(uSpace, SCENE.space[0], SCENE.space[1], 0, 0);
    gl.uniform4f(uCursor, 0, SCENE.cursor[1], SCENE.cursor[2], SCENE.cursor[3]);

    let width = 0;
    let height = 0;

    const resize = () => {
      // Cap DPR at 2. This shader is fragment-bound: 3x costs 2.25x of 2x for no
      // visible gain, because there are no fine edges to resolve.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(window.innerWidth * dpr));
      const h = Math.max(1, Math.round(window.innerHeight * dpr));
      if (w === width && h === height) return;
      width = canvas.width = w;
      height = canvas.height = h;
      gl.viewport(0, 0, width, height);
    };

    // Pointer normalised to -1..1 with Y flipped: the shader's cursor maths is
    // bottom-up (gl_FragCoord is), so a non-flipped Y would put the spotlight a
    // full screen height from the real pointer.
    let pointerX = 0;
    let pointerY = 0;
    let presence = 0;
    let pointerInside = false;

    /**
     * Elapsed seconds, accumulated only while the loop runs. A wall-clock start
     * timestamp would make the scene jump by however long the tab was hidden.
     */
    let elapsed = 0;
    let last = 0;
    let frame = 0;
    let running = false;

    const draw = (delta: number) => {
      // Presence eases rather than snapping, so the spotlight fades on enter
      // and exit instead of popping.
      const target = pointerInside ? 1 : 0;
      presence += (target - presence) * Math.min(1, delta * 6);
      elapsed += delta;

      gl.uniform4f(uScene, width, height, elapsed * SCENE.timeScale, SCENE.colourCount);
      gl.uniform4f(uSpace, SCENE.space[0], SCENE.space[1], pointerX, pointerY);
      gl.uniform4f(uCursor, presence, SCENE.cursor[1], SCENE.cursor[2], SCENE.cursor[3]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = (now: number) => {
      if (!running) return;
      // First frame after a resume has no previous timestamp; clamp rather than
      // letting a multi-second delta jump the animation.
      const delta = last === 0 ? 0 : Math.min((now - last) / 1000, 0.1);
      last = now;
      draw(delta);
      frame = requestAnimationFrame(loop);
    };

    const start = () => {
      if (running) return;
      running = true;
      last = 0;
      frame = requestAnimationFrame(loop);
    };

    const stop = () => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(frame);
    };

    /** One frame, for the still path: draw() eases presence by delta, and a
     *  delta of 0 would freeze it, so presence is set outright. */
    const renderStill = () => {
      presence = pointerInside ? 1 : 0;
      draw(0);
    };

    let stillMode = false;

    const onPointerMove = (event: PointerEvent) => {
      pointerX = (event.clientX / window.innerWidth) * 2 - 1;
      pointerY = 1 - (event.clientY / window.innerHeight) * 2;
      pointerInside = true;
      if (stillMode) renderStill();
    };
    const onPointerLeave = () => {
      pointerInside = false;
      if (stillMode) renderStill();
    };

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerleave", onPointerLeave);

    // A continuously animating fullscreen surface is exactly the kind of motion
    // that triggers vestibular discomfort, so honour the OS setting: draw one
    // frame and leave it. This replica has no in-app motion preference, so the
    // media query is the whole signal.
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    const sync = () => {
      stillMode = motionQuery.matches;
      resize();
      if (stillMode) {
        stop();
        renderStill();
      } else {
        start();
      }
    };

    const onVisibilityChange = () => {
      // Re-evaluate rather than toggling blindly, so a tab revealed mid-policy
      // change lands on the correct state.
      sync();
    };

    motionQuery.addEventListener("change", sync);
    document.addEventListener("visibilitychange", onVisibilityChange);
    sync();

    return () => {
      stop();
      motionQuery.removeEventListener("change", sync);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(glProgram);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      // Decorative: the whole page is already available to assistive tech, so an
      // unlabelled canvas would only add noise to the tree.
      aria-hidden="true"
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "block",
        // Behind page content. It paints inside the body's stacking context,
        // above the body's own background and below everything in flow.
        zIndex: -1,
        // Must never intercept input: the map, links and buttons above it all
        // depend on real pointer events reaching them.
        pointerEvents: "none",
      }}
    />
  );
}
