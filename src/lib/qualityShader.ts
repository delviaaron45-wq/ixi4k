/**
 * qualityShader — renderizador WebGL de la CADENA DE PROCESADO de ixi 4k.
 *
 * Reproduce en el navegador, píxel a píxel, los mismos pasos que FFmpeg
 * aplica en la exportación nativa (ver src-tauri/src/render.rs):
 *
 *   1. Reducción de ruido        (mix con media 3x3)          ← hqdn3d
 *   2. Exposición                (factor multiplicativo)      ← lutyuv
 *   3. Curva sombras/luces       (trozos 38/128/217)          ← lutyuv
 *   4. Ecuación: gamma + contraste + brillo + color           ← eq
 *   4b. Split toning del preset    (sombras/medios/luces)      ← colorbalance
 *   4c. Detalle doble pasada       (5×5 luma / 3×3 croma)      ← unsharp
 *   5. Claridad                  (contraste local radio ~6px) ← unsharp 13x13
 *   6. Nitidez adaptativa CAS    (amp por vecindario)         ← cas
 *   7. Fase 3: Möbius opcional + tope de luma 235/255         ← lutyuv
 *
 * Se usa tanto en la vista previa Before/After como en la exportación
 * WebCodecs (navegador/móvil), garantizando "antes vs después" real.
 */

import type { ShaderParams } from './qualityPipeline';

export interface QualityRenderer {
  readonly canvas: HTMLCanvasElement;
  /** Actualiza los parámetros de la cadena (recalcula uniforms). */
  setParams(params: ShaderParams): void;
  /** Dibuja un fotograma origen procesado en el canvas. */
  draw(source: TexImageSource): void;
  /** Redimensiona el canvas de salida. */
  resize(width: number, height: number): void;
  dispose(): void;
}

const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT = `
precision mediump float;

varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;

uniform float u_denoise;      // 0..0.6
uniform float u_exposure;     // 2^(e/100)
uniform float u_hasTone;      // 0 | 1
uniform float u_k1, u_b2, u_k2, u_b3, u_k3, u_b4, u_k4; // curva tonal
uniform float u_contrast;     // 0.8..1.5
uniform float u_saturation;   // 0.8..1.6
uniform float u_brightness;   // eq aditivo ±0.2
uniform float u_gamma;        // eq=gamma del preset (1 = sin gamma)
uniform vec3  u_cb_s;         // colorbalance del preset: sombras (R,G,B)
uniform vec3  u_cb_m;         // colorbalance del preset: medios
uniform vec3  u_cb_h;         // colorbalance del preset: luces
uniform float u_detail;       // unsharp doble pasada (luma)
uniform float u_detail_c;     // unsharp doble pasada (croma)
uniform float u_clarity;      // 0..0.35
uniform float u_cas;          // 0..0.70
uniform float u_zoom;         // 1 = sin firma · 1.015 = micro-zoom anti-duplicado
uniform float u_ae;           // 0 | 1 — Filtro AE «AE Edit» activo
uniform float u_mobius;       // 0 | 1 — mapa de tonos Möbius (Fase 3)

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float luma(vec3 c) { return dot(c, LUMA); }

// Curva tonal idéntica a lutyuv (dominio 0..255)
float tone(float y) {
  float yv = y * 255.0;
  float o;
  if (yv < 38.0)        { o = yv * u_k1; }
  else if (yv < 128.0)  { o = u_b2 + (yv - 38.0) * u_k2; }
  else if (yv < 217.0)  { o = u_b3 + (yv - 128.0) * u_k3; }
  else                  { o = u_b4 + (yv - 217.0) * u_k4; }
  return clamp(o, 0.0, 255.0) / 255.0;
}

// Curva S del Filtro AE «AE Edit» (idéntica al lutyuv de render.rs; 0..1):
// negros profundos conservando detalle, medios más oscuros, luces con punch.
float ae_curve(float v) {
  if (v < 0.1804) return 0.015 + v * 0.6929;
  if (v < 0.5020) return 0.14 + (v - 0.1804) * 1.0262;
  if (v < 0.8196) return 0.47 + (v - 0.5020) * 1.2278;
  return 0.86 + (v - 0.8196) * 0.7761;
}

void main() {
  vec2 t = u_texel;

  // 0) Firma anti-duplicado: muestrea el 98.5 % central (zoom 1.015),
  //    idéntico al scale=1.015 + crop de render.rs.
  vec2 uv = (v_uv - 0.5) / u_zoom + 0.5;

  // --- vecindario cercano (3x3, radio 1px): denoise + CAS ---
  vec3 c0 = texture2D(u_tex, uv + vec2(-t.x, -t.y)).rgb;
  vec3 c1 = texture2D(u_tex, uv + vec2( 0.0, -t.y)).rgb;
  vec3 c2 = texture2D(u_tex, uv + vec2( t.x, -t.y)).rgb;
  vec3 c3 = texture2D(u_tex, uv + vec2(-t.x,  0.0)).rgb;
  vec3 c4 = texture2D(u_tex, uv).rgb;
  vec3 c5 = texture2D(u_tex, uv + vec2( t.x,  0.0)).rgb;
  vec3 c6 = texture2D(u_tex, uv + vec2(-t.x,  t.y)).rgb;
  vec3 c7 = texture2D(u_tex, uv + vec2( 0.0,  t.y)).rgb;
  vec3 c8 = texture2D(u_tex, uv + vec2( t.x,  t.y)).rgb;

  vec3 avg3 = (c0 + c1 + c2 + c3 + c4 + c5 + c6 + c7 + c8) / 9.0;

  // min/max de luminancia en el vecindario (adaptividad CAS)
  float mn = luma(c0); float mx = luma(c0);
  float l;
  l = luma(c1); mn = min(mn, l); mx = max(mx, l);
  l = luma(c2); mn = min(mn, l); mx = max(mx, l);
  l = luma(c3); mn = min(mn, l); mx = max(mx, l);
  l = luma(c4); mn = min(mn, l); mx = max(mx, l);
  l = luma(c5); mn = min(mn, l); mx = max(mx, l);
  l = luma(c6); mn = min(mn, l); mx = max(mx, l);
  l = luma(c7); mn = min(mn, l); mx = max(mx, l);
  l = luma(c8); mn = min(mn, l); mx = max(mx, l);

  // --- vecindario amplio (radio ~6px): claridad ---
  vec2 r = t * 6.0;
  vec3 b0 = texture2D(u_tex, uv + vec2(-r.x, -r.y)).rgb;
  vec3 b1 = texture2D(u_tex, uv + vec2( 0.0, -r.y)).rgb;
  vec3 b2 = texture2D(u_tex, uv + vec2( r.x, -r.y)).rgb;
  vec3 b3 = texture2D(u_tex, uv + vec2(-r.x,  0.0)).rgb;
  vec3 b4 = c4;
  vec3 b5 = texture2D(u_tex, uv + vec2( r.x,  0.0)).rgb;
  vec3 b6 = texture2D(u_tex, uv + vec2(-r.x,  r.y)).rgb;
  vec3 b7 = texture2D(u_tex, uv + vec2( 0.0,  r.y)).rgb;
  vec3 b8 = texture2D(u_tex, uv + vec2( r.x,  r.y)).rgb;
  vec3 avgBig = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + b7 + b8) / 9.0;

  // 1) Reducción de ruido
  vec3 col = mix(c4, avg3, u_denoise);

  // 2) Exposición
  col *= u_exposure;

  // 3) Curva sombras/luces (sobre luminancia, como lutyuv)
  if (u_hasTone > 0.5) {
    float y = luma(col);
    if (y > 0.0001) {
      col *= tone(y) / y;
    }
  }

  // 4) Ecuación: gamma (eq) + contraste (pivote 0.5) + brillo + saturación
  if (abs(u_gamma - 1.0) > 0.001) {
    // Espejo de eq=gamma de FFmpeg: y' = (y)^(1/gamma) sobre la luminancia
    float gy = luma(col);
    if (gy > 0.0001) col *= pow(gy, 1.0 / u_gamma) / gy;
  }
  float Y = luma(col);
  float Y2 = (Y - 0.5) * u_contrast + 0.5 + u_brightness;
  if (Y > 0.0001) col *= Y2 / Y;
  col = mix(vec3(luma(col)), col, u_saturation);

  // 4b) colorbalance del preset (split toning sombras/medios/luces — espejo
  //     del paso 5b de render.rs). [0,0,0] = sin filtro → no-op.
  float cb_l = luma(col);
  float cb_sw = 1.0 - smoothstep(0.0, 0.40, cb_l);
  float cb_mw = max(0.0, 1.0 - abs(cb_l - 0.5) * 2.0);
  float cb_hw = smoothstep(0.55, 1.0, cb_l);
  col += u_cb_s * cb_sw + u_cb_m * cb_mw + u_cb_h * cb_hw;

  // 4c) Unsharp Mask de doble pasada del preset (espejo del paso 5c de
  //     render.rs). [0,0] = sin filtro → no-op.
  vec3 dsharp = col - avg3;
  col += u_detail * dsharp + u_detail_c * (dsharp - vec3(luma(dsharp)));

  // 5) Claridad (contraste local)
  col += u_clarity * (col - avgBig);

  // 6) Nitidez adaptativa CAS
  float amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 0.0001), 0.0, 1.0));
  col += u_cas * amp * (col - avg3);

  // --- AE Edit «Filtro AE»: mismos pasos reales que render.rs (paso 6b) ---
  if (u_ae > 0.5) {
    // 1) Curva S: contraste elevado, negros profundos CON detalle y
    //    grading cinematográfico oscuro
    float ly = luma(col);
    if (ly > 0.0001) col *= ae_curve(ly) / ly;

    // 2) Split toning (colorbalance): sombras frías azul/cian, medios y
    //    altas luces ligeramente cálidas (pieles naturales, sin saturar)
    float l1 = luma(col);
    float sw = 1.0 - smoothstep(0.0, 0.40, l1);
    float mw = max(0.0, 1.0 - abs(l1 - 0.5) * 2.0);
    float hw = smoothstep(0.55, 1.0, l1);
    col += vec3(-0.05, 0.02, 0.05) * sw
         + vec3(0.02, -0.01, -0.01) * mw
         + vec3(0.05, 0.01, -0.04) * hw;

    // 3) Detalle y nitidez mejorados de forma suave (unsharp 5×5 : 0.18)
    col += 0.18 * (col - avg3);

    // 4) Viñeta muy sutil (vignette a=0.22; esquinas ≈ −10 %)
    vec2 vc = v_uv - 0.5;
    vc.x *= u_texel.y / max(u_texel.x, 1e-6); // aspecto real del fotograma
    float r = length(vec2(vc.x, vc.y * 1.35));
    float vig = 1.0 - 0.10 * smoothstep(0.55, 1.05, r);
    col *= vig;

    // 4b) Subexposición «premium» (espejo de eq=brightness=-0.0200 tras la
    //    viñeta en render.rs): sin ella el export AE saldría más claro que
    //    la base (la curva S aclara en contenido brillante y el bloom suma).
    float e_l = luma(col);
    if (e_l > 0.0001) col *= max(e_l - 0.02, 0.0) / e_l;

    // 5) Bloom/glow cinematográfico en las luces: extracción (umbral 145/255,
    //    ganancia 1.6) + blur (2 anillos de 8 taps) + screen SOLO en luminancia
    //    (espejo de blend c0_mode=screen:c0_opacity=0.14 de render.rs).
    vec2 st = u_texel * (5.0 / max(u_zoom, 0.001));
    float glow = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853981;
      vec2 dir = vec2(cos(a), sin(a));
      vec3 s0 = texture2D(u_tex, uv + dir * st).rgb;
      vec3 s1 = texture2D(u_tex, uv + dir * st * 2.2).rgb;
      glow += max(0.0, luma(s0) - 0.5686) * 1.04   // 0.65 × 1.6
           + max(0.0, luma(s1) - 0.5686) * 0.56;   // 0.35 × 1.6
    }
    glow = (glow / 8.0) * vig;
    float yb = luma(col);
    float yn = yb + 0.14 * (glow * (1.0 - yb)); // screen con opacidad 0.14
    col *= yn / max(yb, 1e-4);
  }

  // 7) Fase 3 · control de luz: mapa de tonos Möbius (rodilla 214/255,
  //    span 41/255 — mismo trazado que el lutyuv de render.rs, en dominio
  //    normalizado) y tope de luminancia a 235/255 = 1.0 (blanco legal
  //    BT.709) para que ningún realce pueda quemar las altas luces.
  if (u_mobius > 0.5) {
    float my = luma(col);
    if (my > 0.839216) {
      float ny = 0.839216 + 0.160784 * (my - 0.839216) / ((my - 0.839216) + 0.160784);
      col += vec3(ny - my); // conserva el croma (desplaza los 3 canales igual)
    }
  }
  float cap_y = luma(col);
  if (cap_y > 0.921569) col += vec3(0.921569 - cap_y);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // eslint-disable-next-line no-console
    console.warn('[ixi4k] shader error:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/**
 * Crea el renderizador. Devuelve `null` si WebGL no está disponible
 * (el llamador debe usar el fallback CSS clásico).
 */
export function createQualityRenderer(
  canvas: HTMLCanvasElement,
  initial?: ShaderParams
): QualityRenderer | null {
  const gl = (canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
  }) || canvas.getContext('experimental-webgl', { alpha: false })) as WebGLRenderingContext | null;

  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  if (!vs || !fs) return null;

  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    // eslint-disable-next-line no-console
    console.warn('[ixi4k] link error:', gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  );
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  // Estado fijado UNA sola vez aquí (antes se repetía en cada draw):
  // unidad de textura 0 + volteo vertical de los fotogramas de vídeo.
  gl.activeTexture(gl.TEXTURE0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const U = {
    tex: gl.getUniformLocation(prog, 'u_tex'),
    texel: gl.getUniformLocation(prog, 'u_texel'),
    denoise: gl.getUniformLocation(prog, 'u_denoise'),
    exposure: gl.getUniformLocation(prog, 'u_exposure'),
    hasTone: gl.getUniformLocation(prog, 'u_hasTone'),
    k1: gl.getUniformLocation(prog, 'u_k1'),
    b2: gl.getUniformLocation(prog, 'u_b2'),
    k2: gl.getUniformLocation(prog, 'u_k2'),
    b3: gl.getUniformLocation(prog, 'u_b3'),
    k3: gl.getUniformLocation(prog, 'u_k3'),
    b4: gl.getUniformLocation(prog, 'u_b4'),
    k4: gl.getUniformLocation(prog, 'u_k4'),
    contrast: gl.getUniformLocation(prog, 'u_contrast'),
    saturation: gl.getUniformLocation(prog, 'u_saturation'),
    brightness: gl.getUniformLocation(prog, 'u_brightness'),
    gamma: gl.getUniformLocation(prog, 'u_gamma'),
    cbShadows: gl.getUniformLocation(prog, 'u_cb_s'),
    cbMids: gl.getUniformLocation(prog, 'u_cb_m'),
    cbHighlights: gl.getUniformLocation(prog, 'u_cb_h'),
    detail: gl.getUniformLocation(prog, 'u_detail'),
    detailC: gl.getUniformLocation(prog, 'u_detail_c'),
    clarity: gl.getUniformLocation(prog, 'u_clarity'),
    cas: gl.getUniformLocation(prog, 'u_cas'),
    zoom: gl.getUniformLocation(prog, 'u_zoom'),
    ae: gl.getUniformLocation(prog, 'u_ae'),
    mobius: gl.getUniformLocation(prog, 'u_mobius'),
  };

  let disposed = false;

  const applyParams = (p: ShaderParams) => {
    gl.uniform1f(U.denoise, p.denoise);
    gl.uniform1f(U.exposure, p.exposure);
    if (p.tone) {
      const { y15, y85 } = p.tone;
      const p15 = y15 * 255;
      const p85 = y85 * 255;
      gl.uniform1f(U.hasTone, 1);
      gl.uniform1f(U.k1, p15 / 38);
      gl.uniform1f(U.b2, p15);
      gl.uniform1f(U.k2, (127.5 - p15) / 90);
      gl.uniform1f(U.b3, 127.5);
      gl.uniform1f(U.k3, (p85 - 127.5) / 89);
      gl.uniform1f(U.b4, p85);
      gl.uniform1f(U.k4, (255 - p85) / 38);
    } else {
      gl.uniform1f(U.hasTone, 0);
    }
    gl.uniform1f(U.contrast, p.contrast);
    gl.uniform1f(U.saturation, p.saturation);
    gl.uniform1f(U.brightness, p.brightnessAdd);
    gl.uniform1f(U.gamma, p.gamma ?? 1);
    const zero: [number, number, number] = [0, 0, 0];
    const s = p.cbShadows ?? zero;
    const m = p.cbMids ?? zero;
    const h = p.cbHighlights ?? zero;
    gl.uniform3f(U.cbShadows, s[0], s[1], s[2]);
    gl.uniform3f(U.cbMids, m[0], m[1], m[2]);
    gl.uniform3f(U.cbHighlights, h[0], h[1], h[2]);
    gl.uniform1f(U.detail, p.detail ? p.detail[0] : 0);
    gl.uniform1f(U.detailC, p.detail ? p.detail[1] : 0);
    gl.uniform1f(U.clarity, p.clarity);
    gl.uniform1f(U.cas, p.cas);
    gl.uniform1f(U.zoom, p.zoom ?? 1);
    gl.uniform1f(U.ae, p.ae ?? 0);
    gl.uniform1f(U.mobius, p.mobius ?? 0);
  };

  if (initial) applyParams(initial);
  else {
    // identidad
    applyParams({
      denoise: 0,
      exposure: 1,
      tone: null,
      contrast: 1,
      saturation: 1,
      brightnessAdd: 0,
      clarity: 0,
      cas: 0,
    });
  }

  let lastW = canvas.width || 2;
  let lastH = canvas.height || 2;
  gl.viewport(0, 0, lastW, lastH);
  gl.uniform2f(U.texel, 1 / lastW, 1 / lastH);
  gl.uniform1i(U.tex, 0);

  return {
    canvas,
    setParams(p: ShaderParams) {
      if (disposed) return;
      // prog ya está bindeado desde createQualityRenderer; solo aplicamos uniforms
      applyParams(p);
    },
    resize(w: number, h: number) {
      if (disposed) return;
      const cw = Math.max(2, Math.round(w));
      const ch = Math.max(2, Math.round(h));
      if (cw === canvas.width && ch === canvas.height) return;
      canvas.width = cw;
      canvas.height = ch;
      lastW = cw;
      lastH = ch;
      gl.viewport(0, 0, cw, ch);
      gl.uniform2f(U.texel, 1 / cw, 1 / ch);
    },
    draw(source: TexImageSource) {
      if (disposed) return;
      // prog, textura y pixelStorei ya están configurados desde el setup inicial.
      // Solo subimos el nuevo fotograma y dibujamos — mínimo overhead por frame.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        gl.deleteTexture(tex);
        gl.deleteBuffer(buf);
        gl.deleteProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        const lose = gl.getExtension('WEBGL_lose_context');
        lose?.loseContext();
      } catch {
        /* noop */
      }
    },
  };
}
