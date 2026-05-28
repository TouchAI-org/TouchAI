// src/core/oklch.ts
var srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
var linearToSrgb = (c) => (c <= 31308e-7 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
var linearRgbToOklab = (r, g, b) => {
    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    const l_ = Math.cbrt(l);
    const m_ = Math.cbrt(m);
    const s_ = Math.cbrt(s);
    return [
        0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
    ];
};
var oklabToLinearRgb = (L, a, b) => {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
};
var rgbToOklch = (rgb) => {
    const [L, a, b] = linearRgbToOklab(
        srgbToLinear(rgb[0]),
        srgbToLinear(rgb[1]),
        srgbToLinear(rgb[2])
    );
    return { L, C: Math.sqrt(a * a + b * b), H: Math.atan2(b, a) };
};
var oklchToRgb = ({ L, C, H }) => {
    const a = C * Math.cos(H);
    const b = C * Math.sin(H);
    const [lr, lg, lb] = oklabToLinearRgb(L, a, b);
    const clamp01 = (x) => Math.max(0, Math.min(1, x));
    return [clamp01(linearToSrgb(lr)), clamp01(linearToSrgb(lg)), clamp01(linearToSrgb(lb))];
};
var hexToRgb = (hex) => {
    const n = parseInt(hex.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
var lerpHueShortest = (h1, h2, t) => {
    let diff = h2 - h1;
    if (diff > Math.PI) diff -= 2 * Math.PI;
    if (diff < -Math.PI) diff += 2 * Math.PI;
    return h1 + diff * t;
};
var lerpOklch = (a, b, t) => {
    const EPS = 1e-4;
    const ha = a.C < EPS ? b.H : a.H;
    const hb = b.C < EPS ? a.H : b.H;
    return {
        L: a.L + (b.L - a.L) * t,
        C: a.C + (b.C - a.C) * t,
        H: lerpHueShortest(ha, hb, t),
    };
};
function sampleChainRgb(anchors, samples) {
    if (anchors.length === 0) return [];
    if (anchors.length === 1) {
        const rgb = oklchToRgb(anchors[0]);
        return Array.from({ length: samples }, () => rgb);
    }
    const out = [];
    const K = anchors.length;
    for (let i = 0; i < samples; i++) {
        const t = i / (samples - 1);
        const seg = t * (K - 1);
        const segI = Math.min(K - 2, Math.floor(seg));
        const segT = seg - segI;
        out.push(oklchToRgb(lerpOklch(anchors[segI], anchors[segI + 1], segT)));
    }
    return out;
}

// src/core/palettes.ts
var ACCENTS = {
    red: '#FF3D7F',
    // Cherry      — hot coral-pink
    orange: '#FF7A1A',
    // Tangerine   — juicier orange
    yellow: '#FFD600',
    // Sunflower   — pure marigold
    green: '#C2FF3D',
    // Lime        — electric yellow-green
    mint: '#00FFA8',
    // Spearmint   — near-neon mint
    teal: '#00E5D6',
    // Lagoon      — pool turquoise
    cyan: '#1FC8FF',
    // Sky         — clean cerulean
    blue: '#2E70FF',
    // Cobalt      — electric blue
    indigo: '#7B4FFF',
    // Iris        — vibrant violet
    purple: '#D33CFF',
    // Orchid      — bright magenta
    pink: '#FF3DC0',
    // Hibiscus    — hot pink-magenta
    brown: '#D8A87B',
    // Latte       — warm peach neutral
};
var ACCENT_ORDER = [
    'red',
    'orange',
    'yellow',
    'green',
    'mint',
    'teal',
    'cyan',
    'blue',
    'indigo',
    'purple',
    'pink',
    'brown',
];
var ACCENT_OKLCH = Object.fromEntries(
    Object.entries(ACCENTS).map(([k, hex]) => [k, rgbToOklch(hexToRgb(hex))])
);
function solve3x3(M, v) {
    const det = (m) =>
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(M);
    if (Math.abs(D) < 1e-9) return null;
    const col = (i) => M.map((row, r) => row.map((x, c) => (c === i ? v[r] : x)));
    return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}
function fitCosinePaletteToSamples(samples) {
    const N = samples.length;
    const C = 0.5;
    const ts = samples.map((_, i) => i / (N - 1));
    const cosV = ts.map((t) => Math.cos(2 * Math.PI * C * t));
    const sinV = ts.map((t) => Math.sin(2 * Math.PI * C * t));
    const sCos = cosV.reduce((s, v) => s + v, 0);
    const sSin = sinV.reduce((s, v) => s + v, 0);
    const sCosCos = cosV.reduce((s, v) => s + v * v, 0);
    const sSinSin = sinV.reduce((s, v) => s + v * v, 0);
    const sCosSin = cosV.reduce((s, v, i) => s + v * sinV[i], 0);
    const M = [
        [N, sCos, sSin],
        [sCos, sCosCos, sCosSin],
        [sSin, sCosSin, sSinSin],
    ];
    const fitChannel = (ch) => {
        const ys = samples.map((c) => c[ch]);
        const sY = ys.reduce((s, y) => s + y, 0);
        const sYCos = ys.reduce((s, y, i) => s + y * cosV[i], 0);
        const sYSin = ys.reduce((s, y, i) => s + y * sinV[i], 0);
        const sol = solve3x3(M, [sY, sYCos, sYSin]);
        if (!sol) return { a: sY / N, b: 0, d: 0 };
        const [a, alpha, beta] = sol;
        const b = Math.sqrt(alpha * alpha + beta * beta);
        const d = (Math.atan2(-beta, alpha) / (2 * Math.PI) + 1) % 1;
        return { a, b, d };
    };
    const r = fitChannel(0);
    const g = fitChannel(1);
    const bl = fitChannel(2);
    return {
        a: [r.a, g.a, bl.a],
        b: [r.b, g.b, bl.b],
        c: [C, C, C],
        d: [r.d, g.d, bl.d],
    };
}
var accentPair = (hexA, hexB) => {
    const samples = sampleChainRgb([rgbToOklch(hexToRgb(hexA)), rgbToOklch(hexToRgb(hexB))], 17);
    samples[0] = hexToRgb(hexA);
    samples[samples.length - 1] = hexToRgb(hexB);
    return fitCosinePaletteToSamples(samples);
};
function accentChain(hexes) {
    if (hexes.length === 0) return accentPair(ACCENTS.indigo, ACCENTS.cyan);
    if (hexes.length === 1) {
        const v = hexToRgb(hexes[0]);
        return { a: v, b: [0, 0, 0], c: [1, 1, 1], d: [0, 0, 0] };
    }
    const anchors = hexes.map((h) => rgbToOklch(hexToRgb(h)));
    const samples = sampleChainRgb(anchors, 17);
    return fitCosinePaletteToSamples(samples);
}
var PALETTES = {
    prism: {
        a: [0.46, 0.88, 0.33],
        b: [0.6, 0.58, 0.74],
        c: [0.5, 0.5, 0.5],
        d: [0.54, 0.22, 0.84],
    },
    berry: {
        a: [0.92, 0.36, 0.56],
        b: [0.1, 0.14, 0.37],
        c: [0.5, 0.5, 0.5],
        d: [0.84, 0.11, 0.5],
    },
    lagoon: {
        a: [0.58, 0.64, 0.52],
        b: [0.64, 0.3, 0.5],
        c: [0.5, 0.5, 0.5],
        d: [0.37, 0.66, 0.89],
    },
    citrus: {
        a: [0.55, 0.61, 0.61],
        b: [0.54, 0.41, 0.63],
        c: [0.5, 0.5, 0.5],
        d: [0.66, 0.92, 0.23],
    },
    azure: { a: [0.13, 0.61, 1], b: [0.15, 0.14, 0], c: [0.5, 0.5, 0.5], d: [0.29, 0.98, 0.74] },
    ember: {
        a: [0.83, 0.61, 0.6],
        b: [0.2, 0.41, 0.62],
        c: [0.5, 0.5, 0.5],
        d: [0.73, 0.05, 0.36],
    },
};
function resolvePalette(p) {
    if (!p) return PALETTES.prism;
    if (typeof p === 'string') return PALETTES[p];
    return p;
}
function hueDistanceDeg(a, b) {
    const ha = (ACCENT_OKLCH[a].H * 180) / Math.PI;
    const hb = (ACCENT_OKLCH[b].H * 180) / Math.PI;
    return Math.abs(((hb - ha + 540) % 360) - 180);
}
function nextAccent(fromName, used, direction, minDeg, maxDeg) {
    const pool = ACCENT_ORDER.filter((n) => n !== 'brown' && !used.has(n) && n !== fromName);
    const startIdx = ACCENT_ORDER.indexOf(fromName);
    const ranked = pool
        .map((name) => {
            const idx = ACCENT_ORDER.indexOf(name);
            const ringStep =
                direction === 1
                    ? (idx - startIdx + ACCENT_ORDER.length) % ACCENT_ORDER.length
                    : (startIdx - idx + ACCENT_ORDER.length) % ACCENT_ORDER.length;
            const dHue = hueDistanceDeg(fromName, name);
            return { name, ringStep, dHue };
        })
        .filter((x) => x.dHue >= minDeg && x.dHue <= maxDeg)
        .sort((a, b) => a.ringStep - b.ringStep);
    if (ranked.length > 0) return ranked[0].name;
    return pool[0] ?? fromName;
}
function shuffleAccentPalette() {
    const r = Math.random();
    const N = r < 0.3 ? 2 : r < 0.7 ? 3 : r < 0.9 ? 4 : 5;
    const pool = ACCENT_ORDER.filter((n) => n !== 'brown');
    const start = pool[Math.floor(Math.random() * pool.length)];
    const direction = Math.random() < 0.5 ? 1 : -1;
    const analogous = Math.random() < 0.7;
    const [minDeg, maxDeg] = analogous ? [25, 65] : [70, 150];
    const used = /* @__PURE__ */ new Set([start]);
    const chain = [start];
    for (let i = 1; i < N; i++) {
        const prev = chain[chain.length - 1];
        const next = nextAccent(prev, used, direction, minDeg, maxDeg);
        chain.push(next);
        used.add(next);
    }
    const hexes = chain.map((n) => ACCENTS[n]);
    return accentChain(hexes);
}

// src/core/shader.ts
var VS = `
attribute vec2 a;
void main(){ gl_Position = vec4(a, 0.0, 1.0); }
`;
var FS = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform float uProgress;
uniform float uAlpha;
uniform float uBandTight;
uniform float uPosStart;
uniform float uPosEnd;
uniform float uHueShift;
uniform float uDirection; // 0 = horizontal, 1 = vertical
uniform float uWaveAmount;   // 0..2, multiplies edge wave displacement
uniform float uRippleAmount; // 0..2, multiplies vertical ripple intensity
uniform float uWaveSpeed;    // 0..3, multiplies all time-based motion
uniform float uBrightness;   // 0..1.5, scales the band's RGB before composite
uniform float uSwellAmount;  // 0..1, depth/iridescence intensity. 0 = flat band.
uniform vec3 uPalA;
uniform vec3 uPalB;
uniform vec3 uPalC;
uniform vec3 uPalD;

#define PI 3.14159265359

vec3 pal(in float t, in vec3 a, in vec3 b, in vec3 c, in vec3 d) {
  return a + b * cos(2.0 * PI * (c * t + d));
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float axis  = mix(uv.x, uv.y, uDirection);
  float cross = mix(uv.y, uv.x, uDirection);

  float pos = uPosStart + uProgress * (uPosEnd - uPosStart);

  float tw = uTime * uWaveSpeed;

  float waveX =
      sin(cross *  6.0 + tw * 1.3) * 0.020
    + sin(cross * 13.0 - tw * 0.9 + 1.4) * 0.012
    + sin(cross * 21.0 + tw * 1.7 + 2.6) * 0.006;
  waveX *= uWaveAmount;

  float d = (axis - pos) - waveX;
  float band = exp(-d * d * uBandTight);

  // Analytic slope of the band's pseudo-elevation map along the travel
  // axis only. We deliberately ignore the cross-axis chain-rule term
  // (\u2202waveX/\u2202cross) \u2014 letting the high-frequency edge wobble leak into
  // the normal made iridescence shimmer at the wave's frequency, which
  // read as "too wavy". Keeping the cross slope at zero gives a clean
  // left\u2192right hue sweep that matches the iOS name-drop feel.
  float dhDaxis = -2.0 * d * uBandTight * band;
  vec2 slope;
  slope.x = mix(dhDaxis, 0.0, uDirection);
  slope.y = mix(0.0, dhDaxis, uDirection);

  // Synthesised surface normal. The 0.18 gain controls perceived
  // height \u2014 higher = steeper flanks, more dramatic iridescent shift.
  vec3 N = normalize(vec3(-slope.x * 0.18, slope.y * 0.18, 1.0));

  float trail = clamp(0.5 - d * 1.3, 0.0, 1.0);
  trail = pow(trail, 2.5) * 0.30;

  float intensity = max(band * 0.95, trail);

  // Cover the full screen edge-to-edge so fixed UI (tabs, toggles) is hidden
  // during the sweep. A barely-perceptible 1.5% fade keeps the look soft
  // without exposing pixels at the viewport edges.
  float vfade = smoothstep(0.0, 0.015, cross) * smoothstep(1.0, 0.985, cross);

  // Hue rotates with the synthesised normal \u2014 the trick that reads as
  // iOS-name-drop iridescence \u2014 but on a deliberately gentle scale so
  // the foil shift looks calm, not strobing.
  float t = N.x * 0.45 + N.y * 0.30
          + axis * 1.4 + cross * 0.35
          + uHueShift + uTime * 0.04;
  vec3 col = pal(t, uPalA, uPalB, uPalC, uPalD);
  col *= uBrightness;

  // Fixed key light + camera looking down +z. View-independent because
  // there's no real camera; this gives a stable highlight that travels
  // across the crest as the band moves, instead of one that wobbles with
  // viewport size.
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L = normalize(vec3(0.35, 0.55, 0.9));
  vec3 H = normalize(L + V);
  float NdotH = clamp(dot(N, H), 0.0, 1.0);
  float NdotV = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = pow(1.0 - NdotV, 3.0);
  float spec    = pow(NdotH, 80.0);

  // Edge fade: as the band's traversal progress nears 0 or 1 (entering or
  // exiting the screen) the band reads at 20% alpha; at midpoint it's at
  // 100%. Softens the band's appearance/disappearance so it doesn't pop
  // into existence at full strength.
  float entryFade = mix(0.2, 1.0, 4.0 * uProgress * (1.0 - uProgress));

  // Body \u2014 palette colour where the band has presence. Premultiplied.
  float bodyA = intensity * vfade * uAlpha * entryFade;
  vec3  bodyPM = col * bodyA;

  // Highlights are emissive \u2014 they add light without occluding the page,
  // gated to the band's body so they only fire on the crest, not the wake.
  float highMask = band * vfade * uAlpha * entryFade * uSwellAmount;
  vec3  highEmit = (col * fresnel * 0.55 + vec3(spec) * 1.1) * highMask;
  float highA    = (fresnel * 0.4 + spec * 0.9) * highMask;

  gl_FragColor = vec4(bodyPM + highEmit, min(bodyA + highA, 1.0));
}
`;
var dirToUniforms = (d) => {
    switch (d) {
        case 'ltr':
            return { axis: 0, posStart: -0.2, posEnd: 1.2 };
        case 'rtl':
            return { axis: 0, posStart: 1.2, posEnd: -0.2 };
        case 'ttb':
            return { axis: 1, posStart: -0.2, posEnd: 1.2 };
        case 'btt':
            return { axis: 1, posStart: 1.2, posEnd: -0.2 };
    }
};
function createShader(opts = {}) {
    if (typeof window === 'undefined') return null;
    const canvas = opts.canvas ?? document.createElement('canvas');
    const gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
    });
    if (!gl) return null;
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('[glimm] shader compile error:', gl.getShaderInfoLog(s));
        }
        return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VS);
    const fs = compile(gl.FRAGMENT_SHADER, FS);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aLoc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(aLoc);
    gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
    const u = (n) => gl.getUniformLocation(prog, n);
    const uRes = u('uRes');
    const uTime = u('uTime');
    const uProgress = u('uProgress');
    const uAlpha = u('uAlpha');
    const uBandTight = u('uBandTight');
    const uPosStart = u('uPosStart');
    const uPosEnd = u('uPosEnd');
    const uHueShift = u('uHueShift');
    const uDirection = u('uDirection');
    const uWaveAmount = u('uWaveAmount');
    const uRippleAmount = u('uRippleAmount');
    const uWaveSpeed = u('uWaveSpeed');
    const uBrightness = u('uBrightness');
    const uSwellAmount = u('uSwellAmount');
    const uPalA = u('uPalA');
    const uPalB = u('uPalB');
    const uPalC = u('uPalC');
    const uPalD = u('uPalD');
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const state = {
        progress: 0,
        alpha: 0,
        palette: opts.palette ?? resolvePalette(void 0),
        bandTight: opts.bandTight ?? 14,
        direction: opts.direction ?? 'ltr',
        waveAmount: opts.waveAmount ?? 1,
        rippleAmount: opts.rippleAmount ?? 1,
        waveSpeed: opts.waveSpeed ?? 1,
        brightness: opts.brightness ?? 1,
        swellAmount: opts.swellAmount ?? 0.55,
    };
    const hueShift = Math.random() * 0.4;
    const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const r = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width * dpr));
        const h = Math.max(1, Math.round(r.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const start = performance.now();
    let raf = 0;
    const tick = () => {
        const t = (performance.now() - start) / 1e3;
        const dirU = dirToUniforms(state.direction);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(uRes, canvas.width, canvas.height);
        gl.uniform1f(uTime, t);
        gl.uniform1f(uProgress, state.progress);
        gl.uniform1f(uAlpha, state.alpha);
        gl.uniform1f(uBandTight, state.bandTight);
        gl.uniform1f(uPosStart, dirU.posStart);
        gl.uniform1f(uPosEnd, dirU.posEnd);
        gl.uniform1f(uDirection, dirU.axis);
        gl.uniform1f(uWaveAmount, state.waveAmount);
        gl.uniform1f(uRippleAmount, state.rippleAmount);
        gl.uniform1f(uWaveSpeed, state.waveSpeed);
        gl.uniform1f(uBrightness, state.brightness);
        gl.uniform1f(uSwellAmount, state.swellAmount);
        gl.uniform1f(uHueShift, hueShift);
        gl.uniform3f(uPalA, state.palette.a[0], state.palette.a[1], state.palette.a[2]);
        gl.uniform3f(uPalB, state.palette.b[0], state.palette.b[1], state.palette.b[2]);
        gl.uniform3f(uPalC, state.palette.c[0], state.palette.c[1], state.palette.c[2]);
        gl.uniform3f(uPalD, state.palette.d[0], state.palette.d[1], state.palette.d[2]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return {
        canvas,
        setProgress: (p) => {
            state.progress = p;
        },
        setAlpha: (a) => {
            state.alpha = a;
        },
        setPalette: (p) => {
            state.palette = p;
        },
        setBandTight: (b) => {
            state.bandTight = b;
        },
        setDirection: (d) => {
            state.direction = d;
        },
        setWaveAmount: (v) => {
            state.waveAmount = v;
        },
        setRippleAmount: (v) => {
            state.rippleAmount = v;
        },
        setWaveSpeed: (v) => {
            state.waveSpeed = v;
        },
        setBrightness: (v) => {
            state.brightness = v;
        },
        setSwellAmount: (v) => {
            state.swellAmount = v;
        },
        getProgress: () => state.progress,
        getAlpha: () => state.alpha,
        destroy: () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            gl.deleteProgram(prog);
            gl.deleteBuffer(buf);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
        },
    };
}

// src/core/shader-mesh.ts
var DEFAULT_IDEA_FLAGS = {
    asymmetricSwell: 0,
    secondaryCrest: 0,
    refraction: 0,
    chromaticDispersion: 0,
    noiseEdge: 0,
    cameraSweep: 0,
    bloom: 0,
    sparkles: 0,
    curlWake: 0,
};
var VS2 = `
attribute vec3 aPos;
attribute vec2 aUV;
uniform float uProgress;
uniform float uPosStart;
uniform float uPosEnd;
uniform float uBandTight;
uniform float uDirection;
uniform float uTime;
uniform float uWaveAmount;
uniform float uWaveSpeed;
uniform float uElevation;
uniform float uDistance;
uniform float uAspect;
uniform mat4  uProj;
// Idea blending amounts. 0 = base behaviour, 1 = idea fully applied.
uniform float uIdea1Asym;
uniform float uIdea2Secondary;
uniform float uIdea5Noise;
uniform float uIdea6Camera;
uniform float uIdea9Curl;
varying vec2  vUV;
varying float vZ;
varying float vD;
varying float vBand;

// 1-input hash (Inigo Quilez / Dave_Hoskins style). Cheap, no texture.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  float axis  = mix(aUV.x, aUV.y, uDirection);
  float cross = mix(aUV.y, aUV.x, uDirection);
  float pos   = uPosStart + uProgress * (uPosEnd - uPosStart);
  float tw    = uTime * uWaveSpeed;

  // Base sine-harmonic edge wave. Same recipe as the fullscreen shader.
  float waveSine =
      sin(cross *  6.0 + tw * 1.3) * 0.020
    + sin(cross * 13.0 - tw * 0.9 + 1.4) * 0.012
    + sin(cross * 21.0 + tw * 1.7 + 2.6) * 0.006;

  // Idea 5: replace the sine harmonics with hash noise so the crest
  // line stops feeling periodic. Sampled in (cross, time) so it
  // animates rather than freezing in place. Blended via uIdea5Noise.
  float waveNoise = (hash21(vec2(cross * 7.5, tw * 0.45)) - 0.5) * 0.05;
  float waveX = mix(waveSine, waveNoise, uIdea5Noise) * uWaveAmount;

  float d = (axis - pos) - waveX;

  // Idea 1: asymmetric swell \u2014 leading face steeper, trailing wake
  // gentler. step(0, d) picks the leading side (d > 0 means we're
  // ahead of the crest), so we apply a higher tightness there and a
  // lower one in the wake.
  float kLead  = uBandTight * mix(1.0, 1.7, uIdea1Asym);
  float kTrail = uBandTight * mix(1.0, 0.55, uIdea1Asym);
  float k = mix(kTrail, kLead, step(0.0, d));
  float band = exp(-d * d * k);

  // Idea 2: secondary crest \u2014 a smaller bump trailing the primary peak
  // at d \u2248 0.12. Adds to band so both the elevation and the FS-side
  // intensity get the doubled silhouette.
  float secondary = exp(-(d - 0.12) * (d - 0.12) * uBandTight * 2.5) * 0.4;
  band += secondary * uIdea2Secondary;
  band = clamp(band, 0.0, 1.4);

  vec3 p = aPos;
  // Stretch the plane horizontally by uAspect so it always fills the
  // viewport regardless of canvas aspect; vertical stays at [-1, 1].
  p.x *= uAspect;
  p.z = band * uElevation;

  // Idea 9: curl wake \u2014 vertices behind the crest are pulled back
  // along the travel axis, mimicking the sticker peel's "the material
  // folds over itself instead of hovering" trick. exp(d*4) decays the
  // pull as we move further into the wake. Only applies for d < 0.
  float wakeMask = exp(min(d, 0.0) * 4.0) * (1.0 - step(0.0, d));
  vec2 axisDirUV = vec2(mix(1.0, 0.0, uDirection), mix(0.0, 1.0, uDirection));
  p.xy -= axisDirUV * 0.35 * wakeMask * uIdea9Curl;

  // Idea 6: camera sweep \u2014 gentle dolly that pushes the crest forward
  // when the band is in the middle of its traversal. sin(progress*PI)
  // peaks at uProgress=0.5 and is zero at the ends, so the dolly is
  // synced to the band, not the clock.
  float dolly = sin(uProgress * 3.14159) * 0.55 * uIdea6Camera;

  vec3 viewP = vec3(p.x, p.y, -uDistance + p.z + dolly);
  vUV = aUV;
  vZ = viewP.z;
  vD = d;
  vBand = band;
  gl_Position = uProj * vec4(viewP, 1.0);
}
`;
var FS2 = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2  vUV;
varying float vZ;
varying float vD;
varying float vBand;
uniform vec2  uRes;
uniform float uTime;
uniform float uProgress;
uniform float uAlpha;
uniform float uDirection;
uniform float uHueShift;
uniform float uBrightness;
uniform float uSwellAmount;
uniform float uAspect;
uniform float uDistance;
uniform vec3  uPalA;
uniform vec3  uPalB;
uniform vec3  uPalC;
uniform vec3  uPalD;
// FS-side idea amounts (matches uIdeaN naming used in VS for clarity).
uniform float uIdea3Refraction;
uniform float uIdea4Chromatic;
uniform float uIdea7Bloom;
uniform float uIdea8Sparkles;
// HTML-in-canvas texture support \u2014 when uUseTexture > 0, the band's
// body samples from this texture (the live page rasterised via
// drawElementImage) instead of emitting pure palette colour. The
// page swells with the mesh's z-displacement plus an N.xy-driven UV
// offset (uRefractStrength) that lenses light at the rim.
uniform sampler2D uTex;
uniform float uUseTexture;
uniform float uRefractStrength;
// MARGIN value the JS-side projection uses \u2014 needed to remap plane UV
// (which spans the overdrawn plane) into viewport UV (the un-displaced
// screen position) for the texture sample. Otherwise the page texture
// reads zoomed-in by 1/MARGIN.
uniform float uTexMargin;

#define PI 3.14159265359

vec3 pal(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a + b * cos(2.0 * PI * (c * t + d));
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  // Real screen-space normal from vZ derivatives. The 90.0 gain is the
  // same one sticker-gl.ts uses; it balances tilt sensitivity vs.
  // per-pixel noise from finite-difference normals.
  vec3 N = normalize(vec3(-dFdx(vZ) * 90.0, dFdy(vZ) * 90.0, 1.0));

  // View-space surface point (matches sticker-gl.ts's camera setup).
  vec3 surfPos = vec3((vUV.x - 0.5) * 2.0 * uAspect,
                      (0.5 - vUV.y) * 2.0,
                      vZ);
  // Fixed key light, parked off-screen up-and-to-the-left.
  vec3 lightPos = vec3(-0.4, 0.6, -uDistance + 1.6);
  vec3 L = normalize(lightPos - surfPos);
  vec3 V = normalize(-surfPos);
  vec3 H = normalize(L + V);
  vec3 R = reflect(-L, N);

  float NdotH = clamp(dot(N, H), 0.0, 1.0);
  float NdotV = clamp(dot(N, V), 0.0, 1.0);

  // Trailing wake \u2014 same dark-side glow that the flat shader uses, so
  // the band still has something behind it instead of a hard cutoff.
  float trail = clamp(0.5 - vD * 1.3, 0.0, 1.0);
  trail = pow(trail, 2.5) * 0.30;
  float intensity = max(vBand * 0.95, trail);

  float axis = mix(vUV.x, vUV.y, uDirection);
  // Edge taper driven by *screen-space* coords, not plane UV. The mesh
  // overdraws the viewport (MARGIN < 1 on the JS side), so plane-UV
  // edges sit off-screen and a UV-based fade would be invisible.
  // Sampling gl_FragCoord keeps the fade tied to actual viewport edges.
  vec2 screenUV = gl_FragCoord.xy / uRes;
  float screenCross = mix(screenUV.y, screenUV.x, uDirection);
  float vfade = smoothstep(0.0, 0.015, screenCross) * smoothstep(1.0, 0.985, screenCross);

  // Iridescence \u2014 hue driven primarily by the reflection vector (which
  // rotates as the crest rises and falls), with a slow secondary drift
  // from axis + time. This is the bit that reads as iOS-name-drop foil.
  float hueT = R.x * 1.1 + R.y * 0.7
             + axis * 0.6
             + uHueShift + uTime * 0.04;

  // Idea 4: chromatic dispersion \u2014 sample the palette at three offset
  // hues and recombine per RGB channel. Reads as a prism split on
  // edges where the normal tilts hard.
  float disp = 0.08 * uIdea4Chromatic;
  vec3 colCenter = pal(hueT,        uPalA, uPalB, uPalC, uPalD);
  vec3 colR      = pal(hueT + disp, uPalA, uPalB, uPalC, uPalD);
  vec3 colB      = pal(hueT - disp, uPalA, uPalB, uPalC, uPalD);
  vec3 colSplit  = vec3(colR.r, colCenter.g, colB.b);
  vec3 col = mix(colCenter, colSplit, uIdea4Chromatic) * uBrightness;

  float fresnel = pow(1.0 - NdotV, 3.0);
  float spec    = pow(NdotH, 64.0);

  // Idea 7: bloom (fake) \u2014 adds a wider, softer halo around the tight
  // catch-light. Real bloom would need an FBO + blur; this is the
  // cheapest 1-pass approximation that still reads as glow.
  float bloomHalo = pow(NdotH, 8.0) * uIdea7Bloom * 0.85;

  float entryFade = mix(0.2, 1.0, 4.0 * uProgress * (1.0 - uProgress));

  // Idea 3: fake refraction \u2014 when the surface tilts hard (low N.z),
  // body alpha drops so the page behind shows through. Reads as a
  // lens bending light rather than a coloured stripe. Body alpha is
  // multiplied by N.z (mapped through uIdea3Refraction).
  float refractMask = mix(1.0, N.z, uIdea3Refraction * 0.85);

  float bodyA  = intensity * vfade * uAlpha * entryFade * refractMask;
  vec3  bodyPM = col * bodyA;

  // Texture mode: read the live page (rasterised via html-in-canvas)
  // at a UV that's been offset by the screen-space normal. The
  // mesh's z displacement already foreshortens the texture over the
  // crest; this extra refraction adds glass-lens lateral bend, which
  // is what reads as "the page is actually swelling" rather than just
  // being colour-tinted. Texture sample is opaque so we override the
  // body's premultiplied colour + alpha completely.
  if (uUseTexture > 0.5) {
    // Remap plane UV \u2192 viewport UV. The plane overdraws the viewport
    // by 1/uTexMargin so the visible region only spans the central
    // strip of vUV; rescale it to span [0, 1] of the texture.
    vec2 viewportUV = (vUV - 0.5) / uTexMargin + 0.5;
    // FLIP_Y=true is set at upload (matches THREE.CanvasTexture's
    // default). With that flip, GL texture-Y=0 corresponds to the
    // page TOP. Our mesh has vUV.y=0 at the viewport top, so we
    // sample at viewportUV directly with no further inversion.
    vec2 sampleUV = viewportUV + N.xy * uRefractStrength * vBand;
    vec3 page = texture2D(uTex, clamp(sampleUV, vec2(0.0), vec2(1.0))).rgb;
    // Body composite: page texture as base everywhere; iridescent
    // band colour ADDED on top, weighted by vBand. Mixing was
    // washing out the colour against the typical white page
    // background. Additive composition keeps the page legible
    // away from the band and lets the band read as a bright
    // overlay where it passes \u2014 like a glossy iridescent strip
    // sliding across the page.
    bodyA = vfade * uAlpha;
    vec3 bandOverlay = col * vBand * 1.6;
    bodyPM = (page + bandOverlay) * bodyA;
  }

  float highMask = vBand * vfade * uAlpha * entryFade * uSwellAmount;
  vec3  highEmit = (col * fresnel * 0.55 + vec3(spec) * 1.2 + col * bloomHalo) * highMask;
  float highA    = (fresnel * 0.4 + spec * 0.9 + bloomHalo * 0.7) * highMask;

  // Idea 8: wake sparkles \u2014 tile-quantised hash noise sampled at a
  // coarse grid so the twinkle is point-like, not a uniform mist.
  // Restricted to the wake region (where trail > 0) so the body of
  // the band stays clean.
  float sGrid = 140.0;
  float sSeed = hash21(floor(vUV * sGrid + floor(uTime * 14.0)));
  float sparkle = step(0.965, sSeed) * trail * uIdea8Sparkles;
  highEmit += vec3(sparkle * 1.6) * vfade * uAlpha;
  highA    += sparkle * 1.0 * vfade * uAlpha;

  gl_FragColor = vec4(bodyPM + highEmit, clamp(bodyA + highA, 0.0, 1.0));
}
`;
var dirToUniforms2 = (d) => {
    switch (d) {
        case 'ltr':
            return { axis: 0, posStart: -0.2, posEnd: 1.2 };
        case 'rtl':
            return { axis: 0, posStart: 1.2, posEnd: -0.2 };
        case 'ttb':
            return { axis: 1, posStart: -0.2, posEnd: 1.2 };
        case 'btt':
            return { axis: 1, posStart: 1.2, posEnd: -0.2 };
    }
};
function perspectiveProj(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    return new Float32Array([
        f / aspect,
        0,
        0,
        0,
        0,
        f,
        0,
        0,
        0,
        0,
        (far + near) / (near - far),
        -1,
        0,
        0,
        (2 * far * near) / (near - far),
        0,
    ]);
}
function createMeshShader(opts = {}) {
    if (typeof window === 'undefined') return null;
    const canvas = opts.canvas ?? document.createElement('canvas');
    const gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: true,
        premultipliedAlpha: true,
    });
    if (!gl) return null;
    if (!gl.getExtension('OES_standard_derivatives')) {
        console.warn(
            "[glimm] OES_standard_derivatives unavailable \u2014 mesh sweep will lack proper lighting; falling back is the caller's responsibility"
        );
        return null;
    }
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('[glimm] mesh shader compile error:', gl.getShaderInfoLog(s));
        }
        return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VS2);
    const fs = compile(gl.FRAGMENT_SHADER, FS2);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const COLS = opts.cols ?? 96;
    const ROWS = opts.rows ?? 56;
    let ASPECT = 1;
    const positions = [];
    const uvs = [];
    const indices = [];
    for (let j = 0; j <= ROWS; j++) {
        const v = j / ROWS;
        const y = (1 - v) * 2 - 1;
        for (let i = 0; i <= COLS; i++) {
            const u2 = i / COLS;
            const x = u2 * 2 - 1;
            positions.push(x, y, 0);
            uvs.push(u2, v);
        }
    }
    for (let j = 0; j < ROWS; j++) {
        for (let i = 0; i < COLS; i++) {
            const a = j * (COLS + 1) + i;
            const b = a + 1;
            const c = a + (COLS + 1);
            const d = c + 1;
            indices.push(a, b, c, b, d, c);
        }
    }
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    const uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
    const aUV = gl.getAttribLocation(prog, 'aUV');
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    const u = (n) => gl.getUniformLocation(prog, n);
    const uRes = u('uRes');
    const uProgress = u('uProgress');
    const uPosStart = u('uPosStart');
    const uPosEnd = u('uPosEnd');
    const uBandTight = u('uBandTight');
    const uDirection = u('uDirection');
    const uTime = u('uTime');
    const uAlpha = u('uAlpha');
    const uHueShift = u('uHueShift');
    const uWaveAmount = u('uWaveAmount');
    const uWaveSpeed = u('uWaveSpeed');
    const uElevation = u('uElevation');
    const uBrightness = u('uBrightness');
    const uSwellAmount = u('uSwellAmount');
    const uAspect = u('uAspect');
    const uDistance = u('uDistance');
    const uProj = u('uProj');
    const uPalA = u('uPalA');
    const uPalB = u('uPalB');
    const uPalC = u('uPalC');
    const uPalD = u('uPalD');
    const uIdea1Asym = u('uIdea1Asym');
    const uIdea2Secondary = u('uIdea2Secondary');
    const uIdea3Refraction = u('uIdea3Refraction');
    const uIdea4Chromatic = u('uIdea4Chromatic');
    const uIdea5Noise = u('uIdea5Noise');
    const uIdea6Camera = u('uIdea6Camera');
    const uIdea7Bloom = u('uIdea7Bloom');
    const uIdea8Sparkles = u('uIdea8Sparkles');
    const uIdea9Curl = u('uIdea9Curl');
    const uTex = u('uTex');
    const uUseTexture = u('uUseTexture');
    const uRefractStrength = u('uRefractStrength');
    const uTexMargin = u('uTexMargin');
    let tex = null;
    const ensureTexture = () => {
        if (tex) return tex;
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return tex;
    };
    const DISTANCE = 3.4;
    const MARGIN = 0.7;
    gl.uniform1f(uDistance, DISTANCE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const state = {
        progress: 0,
        alpha: 0,
        palette: opts.palette ?? resolvePalette(void 0),
        bandTight: opts.bandTight ?? 14,
        direction: opts.direction ?? 'ltr',
        waveAmount: opts.waveAmount ?? 1,
        rippleAmount: opts.rippleAmount ?? 1,
        waveSpeed: opts.waveSpeed ?? 1,
        brightness: opts.brightness ?? 1,
        swellAmount: opts.swellAmount ?? 0.9,
        elevation: opts.elevation ?? 0.18,
        ideas: { ...DEFAULT_IDEA_FLAGS, ...(opts.ideas ?? {}) },
        textureSource: null,
        useTexture: 0,
        refractStrength: 0.025,
    };
    const hueShift = Math.random() * 0.4;
    const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const r = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width * dpr));
        const h = Math.max(1, Math.round(r.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
        ASPECT = Math.max(0.01, w / Math.max(1, h));
        const fov = 2 * Math.atan(MARGIN / DISTANCE);
        const proj = perspectiveProj(fov, ASPECT, 0.1, 10);
        gl.useProgram(prog);
        gl.uniformMatrix4fv(uProj, false, proj);
        gl.uniform1f(uAspect, ASPECT);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const start = performance.now();
    let raf = 0;
    const tick = () => {
        const t = (performance.now() - start) / 1e3;
        const dirU = dirToUniforms2(state.direction);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(uRes, canvas.width, canvas.height);
        gl.uniform1f(uTime, t);
        gl.uniform1f(uProgress, state.progress);
        gl.uniform1f(uAlpha, state.alpha);
        gl.uniform1f(uBandTight, state.bandTight);
        gl.uniform1f(uPosStart, dirU.posStart);
        gl.uniform1f(uPosEnd, dirU.posEnd);
        gl.uniform1f(uDirection, dirU.axis);
        gl.uniform1f(uWaveAmount, state.waveAmount);
        gl.uniform1f(uWaveSpeed, state.waveSpeed);
        gl.uniform1f(uBrightness, state.brightness);
        gl.uniform1f(uSwellAmount, state.swellAmount);
        gl.uniform1f(uElevation, state.elevation);
        gl.uniform1f(uHueShift, hueShift);
        gl.uniform3f(uPalA, state.palette.a[0], state.palette.a[1], state.palette.a[2]);
        gl.uniform3f(uPalB, state.palette.b[0], state.palette.b[1], state.palette.b[2]);
        gl.uniform3f(uPalC, state.palette.c[0], state.palette.c[1], state.palette.c[2]);
        gl.uniform3f(uPalD, state.palette.d[0], state.palette.d[1], state.palette.d[2]);
        gl.uniform1f(uIdea1Asym, state.ideas.asymmetricSwell);
        gl.uniform1f(uIdea2Secondary, state.ideas.secondaryCrest);
        gl.uniform1f(uIdea3Refraction, state.ideas.refraction);
        gl.uniform1f(uIdea4Chromatic, state.ideas.chromaticDispersion);
        gl.uniform1f(uIdea5Noise, state.ideas.noiseEdge);
        gl.uniform1f(uIdea6Camera, state.ideas.cameraSweep);
        gl.uniform1f(uIdea7Bloom, state.ideas.bloom);
        gl.uniform1f(uIdea8Sparkles, state.ideas.sparkles);
        gl.uniform1f(uIdea9Curl, state.ideas.curlWake);
        if (state.useTexture > 0 && state.textureSource) {
            ensureTexture();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            try {
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.texImage2D(
                    gl.TEXTURE_2D,
                    0,
                    gl.RGBA,
                    gl.RGBA,
                    gl.UNSIGNED_BYTE,
                    state.textureSource
                );
            } catch {}
            gl.uniform1i(uTex, 0);
            gl.uniform1f(uUseTexture, 1);
        } else {
            gl.uniform1f(uUseTexture, 0);
        }
        gl.uniform1f(uRefractStrength, state.refractStrength);
        gl.uniform1f(uTexMargin, MARGIN);
        gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return {
        canvas,
        setProgress: (p) => {
            state.progress = p;
        },
        setAlpha: (a) => {
            state.alpha = a;
        },
        setPalette: (p) => {
            state.palette = p;
        },
        setBandTight: (b) => {
            state.bandTight = b;
        },
        setDirection: (d) => {
            state.direction = d;
        },
        setWaveAmount: (v) => {
            state.waveAmount = v;
        },
        setRippleAmount: (v) => {
            state.rippleAmount = v;
        },
        setWaveSpeed: (v) => {
            state.waveSpeed = v;
        },
        setBrightness: (v) => {
            state.brightness = v;
        },
        setSwellAmount: (v) => {
            state.swellAmount = v;
        },
        setElevation: (v) => {
            state.elevation = v;
        },
        setIdea: (key, value) => {
            state.ideas = { ...state.ideas, [key]: value };
        },
        setIdeas: (flags) => {
            state.ideas = { ...flags };
        },
        setTextureSource: (src) => {
            state.textureSource = src;
        },
        setUseTexture: (on) => {
            state.useTexture = on;
        },
        setRefractStrength: (v) => {
            state.refractStrength = v;
        },
        getProgress: () => state.progress,
        getAlpha: () => state.alpha,
        destroy: () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            gl.deleteProgram(prog);
            gl.deleteBuffer(posBuf);
            gl.deleteBuffer(uvBuf);
            gl.deleteBuffer(idxBuf);
            if (tex) gl.deleteTexture(tex);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
        },
    };
}

// src/core/shader-namedrop.ts
var VS3 = `
attribute vec3 aPos;
attribute vec2 aUV;
uniform float uProgress;
uniform vec2  uAnchor;
uniform float uBulgeRadius;
uniform float uElevation;
uniform float uAspect;
uniform float uDistance;
uniform float uTravelMode;
uniform mat4  uProj;
varying vec2  vUV;
varying float vZ;
varying float vBulge;

#define PI 3.14159265359

void main() {
  // Travel mode: anchor.x linearly traverses [-0.2, 1.2] as progress
  // goes 0\u21921 (matches the project's sweep posStart/posEnd convention).
  // Static mode: anchor stays at uAnchor.
  vec2 anchorPos = mix(uAnchor,
                       vec2(mix(-0.2, 1.2, uProgress), uAnchor.y),
                       uTravelMode);

  // Aspect-correct radial distance from anchor in UV space. Without
  // the aspect correction the bulge would render as a vertical ellipse
  // on wide viewports; this keeps it circular.
  vec2 d = (aUV - anchorPos) * vec2(uAspect, 1.0);
  float r = length(d);

  // Envelope:
  //   Static mode: sin(p\xB7\u03C0) grows to peak at progress=0.5 then
  //     deflates by progress=1.0 \u2014 the bulge swells in place.
  //   Travel mode: envelope stays at 1.0 \u2014 the bulge has constant
  //     amplitude as it traverses; it naturally fades in/out at the
  //     viewport edges as the anchor enters/leaves the screen.
  float envelope = mix(sin(uProgress * PI), 1.0, uTravelMode);

  // Radial profile \u2014 gaussian falloff inside the bulge. Effective
  // radius scales with envelope so the bulge visibly expands outward
  // as it grows, not just rises in place.
  float effR = max(uBulgeRadius * envelope, 0.001);
  float profile = exp(-(r * r) / (effR * effR));
  // Final bulge magnitude \u2014 combines envelope (overall height) with
  // radial profile (height at this vertex).
  float bulge = profile * envelope;

  vec3 p = aPos;
  // Stretch plane horizontally by aspect so it always fills the
  // viewport regardless of canvas dimensions.
  p.x *= uAspect;
  // Lift the vertex along +z toward the camera. The bulge centre
  // moves closest, edges stay flat. With perspective projection this
  // makes the centre's pixels expand outward, which reads as the
  // page surface "rising toward the screen" \u2014 the NameDrop feel.
  p.z = bulge * uElevation;

  vec3 viewP = vec3(p.x, p.y, -uDistance + p.z);
  vUV = aUV;
  vZ = viewP.z;
  vBulge = bulge;
  gl_Position = uProj * vec4(viewP, 1.0);
}
`;
var FS3 = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2  vUV;
varying float vZ;
varying float vBulge;
uniform vec2  uRes;
uniform float uTime;
uniform float uProgress;
uniform float uAlpha;
uniform float uHueShift;
uniform float uAspect;
uniform float uDistance;
uniform float uIridescence;
uniform float uRefractStrength;
uniform float uTexMargin;
uniform sampler2D uTex;
uniform float uUseTexture;
// Wipe support \u2014 when uHasSnapshot is on, uTexOld holds a frozen
// snapshot of the page as it was at sweep-start. The FS mixes
// between uTex (live, "after") and uTexOld ("before") based on
// whether the fragment's viewport X is left or right of the bulge
// anchor \u2014 producing a wipe that reveals the new page as the sweep
// crosses, instead of just showing the live page everywhere with a
// bulge on top.
uniform sampler2D uTexOld;
uniform float uHasSnapshot;
uniform vec3  uPalA;
uniform vec3  uPalB;
uniform vec3  uPalC;
uniform vec3  uPalD;

#define PI 3.14159265359

vec3 pal(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a + b * cos(2.0 * PI * (c * t + d));
}

void main() {
  // Real screen-space normal from z derivatives \u2014 same trick as the
  // mesh sweep and the sticker peel. The 90.0 gain matches sticker-
  // gl.ts; balances tilt sensitivity vs. per-pixel noise on the
  // bulge's flanks.
  vec3 N = normalize(vec3(-dFdx(vZ) * 90.0, dFdy(vZ) * 90.0, 1.0));

  // Plane-UV \u2192 viewport-UV remap (mesh overdraws viewport by
  // 1/uTexMargin so plane UV [0,1] covers more than just the visible
  // area; rescale to map the visible region to texture [0,1]).
  vec2 viewportUV = (vUV - 0.5) / uTexMargin + 0.5;

  // Refraction offset: sample the page at a UV shifted by the
  // surface normal. On flat plate, N.xy \u2248 0 so no shift. On bulge
  // flanks where N tilts hardest, the page lenses outward, which
  // reads as glass-like refraction at the bulge rim.
  vec2 sampleUV = viewportUV + N.xy * uRefractStrength * vBulge;
  // pageA tracks whether we have a real page texture to render.
  // When uUseTexture is 0 (host hasn't enabled it yet, or browser
  // lacks drawElementImage) we render the bulge with TRANSPARENT
  // background instead of opaque white \u2014 the source canvas's normal
  // DOM rendering shows through the GL canvas everywhere except the
  // raised bulge area. Without this guard the GL canvas paints
  // opaque white during the first 1-2 frames of every sweep (before
  // the host's pump catches up) and the page appears to flash white.
  vec3 page = vec3(0.0);
  float pageA = 0.0;
  if (uUseTexture > 0.5) {
    vec2 clampedUV = clamp(sampleUV, vec2(0.0), vec2(1.0));
    vec3 pageLive = texture2D(uTex, clampedUV).rgb;
    if (uHasSnapshot > 0.5) {
      // Wipe mode. Project the bulge's travel-mode anchor X (plane
      // UV) into viewport UV space (matching the remap above) so we
      // can compare it to viewportUV.x. The bulge centre is the
      // wipe boundary: fragments left of it have already been
      // "passed over" (show the live/new page), fragments right of
      // it haven't yet (show the snapshot/old page). A smoothstep
      // softens the boundary into a band the width of the bulge's
      // visible falloff.
      float anchorPlaneX = mix(-0.2, 1.2, uProgress);
      float anchorViewX = (anchorPlaneX - 0.5) / uTexMargin + 0.5;
      float wipeT = smoothstep(anchorViewX - 0.08, anchorViewX + 0.08, viewportUV.x);
      vec3 pageOld = texture2D(uTexOld, clampedUV).rgb;
      // wipeT = 0 left of bulge \u2192 live (new page)
      // wipeT = 1 right of bulge \u2192 snapshot (old page)
      page = mix(pageLive, pageOld, wipeT);
    } else {
      page = pageLive;
    }
    pageA = 1.0;
  }

  // View/light setup. Light parked off-screen up-and-to-the-left so
  // the bulge has a consistent specular catch on its left flank as
  // it expands.
  vec3 surfPos = vec3((vUV.x - 0.5) * 2.0 * uAspect,
                      (0.5 - vUV.y) * 2.0,
                      vZ);
  vec3 lightPos = vec3(-0.5, 0.7, -uDistance + 1.6);
  vec3 L = normalize(lightPos - surfPos);
  vec3 V = normalize(-surfPos);
  vec3 H = normalize(L + V);
  vec3 R = reflect(-L, N);

  float NdotH = clamp(dot(N, H), 0.0, 1.0);
  float NdotV = clamp(dot(N, V), 0.0, 1.0);

  // Screen-edge taper so the bulge can dissolve cleanly into the
  // viewport edges without exposing seams from the overdrawn plane.
  // Uses (1.0 - smoothstep(0.985, 1.0, x)) instead of the reversed-
  // arg smoothstep(1.0, 0.985, x): the latter is undefined behaviour
  // per the GLSL ES spec (edge0 must be < edge1) and some drivers
  // return 0 which would zero out vfade and make the shader invisible.
  vec2 screenUV = gl_FragCoord.xy / uRes;
  float vfade = smoothstep(0.0, 0.015, screenUV.x) * (1.0 - smoothstep(0.985, 1.0, screenUV.x))
              * smoothstep(0.0, 0.015, screenUV.y) * (1.0 - smoothstep(0.985, 1.0, screenUV.y));

  // Iridescent palette \u2014 hue driven primarily by the reflection
  // vector (rotates with normal tilt) plus a slow time/spatial
  // drift. This is what reads as NameDrop's foil shimmer.
  float hueT = R.x * 1.4 + R.y * 0.9
             + viewportUV.x * 0.3 + viewportUV.y * 0.2
             + uHueShift + uTime * 0.06;
  vec3 iri = pal(hueT, uPalA, uPalB, uPalC, uPalD);

  // Bulge surface highlights \u2014 Fresnel rim catches the bulge's
  // silhouette; tight specular gives a glass catch-light on the
  // crest. Both gated by vBulge so the flat plate stays clean.
  float fresnel = pow(1.0 - NdotV, 3.0) * vBulge;
  float spec    = pow(NdotH, 96.0) * vBulge;

  // Chromatic dispersion at the bulge edges \u2014 sample the palette
  // at three offset hues per RGB channel where the normal tilts
  // hard. Gives the rim a prismatic split, the NameDrop touch that
  // separates it from a generic radial gradient.
  float dispersion = (1.0 - NdotV) * vBulge * 0.06;
  vec3 iriR = pal(hueT + dispersion, uPalA, uPalB, uPalC, uPalD);
  vec3 iriB = pal(hueT - dispersion, uPalA, uPalB, uPalC, uPalD);
  vec3 iriSplit = vec3(iriR.r, iri.g, iriB.b);

  // Composite. Two modes:
  //   uUseTexture=1 (pageA=1): page covers viewport opaquely; bulge
  //     warps it visually + iridescent shimmer overlays the bulge.
  //   uUseTexture=0 (pageA=0): GL stays transparent except for the
  //     bulge area \u2014 the source canvas's normal DOM rendering shows
  //     through everywhere else.
  //
  // bodyA controls the GL canvas's opacity at this fragment. In
  // texture mode it's fully opaque (we *are* the page). Outside
  // texture mode it follows vBulge so flat areas read transparent.
  float bulgePresence = clamp(vBulge * 1.4, 0.0, 1.0);
  float bodyA = pageA + (1.0 - pageA) * bulgePresence;
  // bodyRgb is the page texture in texture mode; in fallback mode
  // it's just the iridescent palette colour weighted by vBulge so
  // the bulge area has *something* to show even with no texture.
  vec3 bodyRgb = page + (1.0 - pageA) * iri * vBulge;

  vec3 iriOverlay = iriSplit * vBulge * uIridescence * 0.55;
  vec3 highlights = iri * fresnel * 0.6 + vec3(spec) * 1.3;
  vec3 col = bodyRgb + iriOverlay + highlights * uIridescence;

  // Same reversed-arg avoidance as vfade above \u2014 entryFade ramps in
  // over progress 0..0.05, then out over 0.95..1.0.
  float entryFade = smoothstep(0.0, 0.05, uProgress) * (1.0 - smoothstep(0.95, 1.0, uProgress));
  float alpha = bodyA * vfade * uAlpha * entryFade;

  // Premultiplied alpha output (matches the project's blendFunc:
  // ONE, ONE_MINUS_SRC_ALPHA).
  gl_FragColor = vec4(col * alpha, alpha);
}
`;
function perspectiveProj2(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    return new Float32Array([
        f / aspect,
        0,
        0,
        0,
        0,
        f,
        0,
        0,
        0,
        0,
        (far + near) / (near - far),
        -1,
        0,
        0,
        (2 * far * near) / (near - far),
        0,
    ]);
}
function createNamedropShader(opts = {}) {
    if (typeof window === 'undefined') return null;
    const canvas = opts.canvas ?? document.createElement('canvas');
    const gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: true,
        premultipliedAlpha: true,
    });
    if (!gl) return null;
    if (!gl.getExtension('OES_standard_derivatives')) {
        console.warn(
            '[glimm/namedrop] OES_standard_derivatives unavailable \u2014 bulge lighting will be missing'
        );
        return null;
    }
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('[glimm/namedrop] shader compile error:', gl.getShaderInfoLog(s));
        }
        return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VS3);
    const fs = compile(gl.FRAGMENT_SHADER, FS3);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('[glimm/namedrop] program link error:', gl.getProgramInfoLog(prog));
        return null;
    }
    console.log('[glimm/namedrop] shader created, canvas:', canvas.width, 'x', canvas.height);
    const COLS = opts.cols ?? 96;
    const ROWS = opts.rows ?? 56;
    const positions = [];
    const uvs = [];
    const indices = [];
    for (let j = 0; j <= ROWS; j++) {
        const v = j / ROWS;
        const y = (1 - v) * 2 - 1;
        for (let i = 0; i <= COLS; i++) {
            const u2 = i / COLS;
            const x = u2 * 2 - 1;
            positions.push(x, y, 0);
            uvs.push(u2, v);
        }
    }
    for (let j = 0; j < ROWS; j++) {
        for (let i = 0; i < COLS; i++) {
            const a = j * (COLS + 1) + i;
            const b = a + 1;
            const c = a + (COLS + 1);
            const d = c + 1;
            indices.push(a, b, c, b, d, c);
        }
    }
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    const uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
    const aUV = gl.getAttribLocation(prog, 'aUV');
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    const u = (n) => gl.getUniformLocation(prog, n);
    const uRes = u('uRes');
    const uTime = u('uTime');
    const uProgress = u('uProgress');
    const uAlpha = u('uAlpha');
    const uHueShift = u('uHueShift');
    const uAspect = u('uAspect');
    const uDistance = u('uDistance');
    const uAnchor = u('uAnchor');
    const uBulgeRadius = u('uBulgeRadius');
    const uElevation = u('uElevation');
    const uIridescence = u('uIridescence');
    const uRefractStrength = u('uRefractStrength');
    const uTravelMode = u('uTravelMode');
    const uTexMargin = u('uTexMargin');
    const uTex = u('uTex');
    const uUseTexture = u('uUseTexture');
    const uTexOld = u('uTexOld');
    const uHasSnapshot = u('uHasSnapshot');
    const uProj = u('uProj');
    const uPalA = u('uPalA');
    const uPalB = u('uPalB');
    const uPalC = u('uPalC');
    const uPalD = u('uPalD');
    const DISTANCE = 3.4;
    const MARGIN = 0.7;
    let tex = null;
    const ensureTexture = () => {
        if (tex) return tex;
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return tex;
    };
    let texOld = null;
    const ensureTexOld = () => {
        if (texOld) return texOld;
        texOld = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texOld);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return texOld;
    };
    gl.uniform1f(uDistance, DISTANCE);
    gl.uniform1f(uTexMargin, MARGIN);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const state = {
        progress: 0,
        alpha: 0,
        palette: opts.palette ?? resolvePalette('prism'),
        anchor: opts.anchor ?? [0.5, 0.5],
        bulgeRadius: opts.bulgeRadius ?? 0.55,
        elevation: opts.elevation ?? 0.32,
        iridescence: opts.iridescence ?? 1,
        refractStrength: opts.refractStrength ?? 0.04,
        travelMode: opts.travelMode ?? 0,
        direction: opts.direction ?? 'ltr',
        bandTight: opts.bandTight ?? 14,
        waveAmount: 1,
        rippleAmount: 1,
        waveSpeed: 1,
        brightness: 1,
        swellAmount: 1,
        textureSource: null,
        useTexture: 0,
        snapshotSource: null,
    };
    const hueShift = Math.random() * 0.4;
    let ASPECT = 1;
    const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const r = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width * dpr));
        const h = Math.max(1, Math.round(r.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
        ASPECT = Math.max(0.01, w / Math.max(1, h));
        const fov = 2 * Math.atan(MARGIN / DISTANCE);
        const proj = perspectiveProj2(fov, ASPECT, 0.1, 10);
        gl.useProgram(prog);
        gl.uniformMatrix4fv(uProj, false, proj);
        gl.uniform1f(uAspect, ASPECT);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const start = performance.now();
    let raf = 0;
    let firstActiveFrameLogged = false;
    const tick = () => {
        const t = (performance.now() - start) / 1e3;
        if (!firstActiveFrameLogged && state.alpha > 1e-3) {
            firstActiveFrameLogged = true;
            console.log(
                '[glimm/namedrop] first active frame \u2014 alpha:',
                state.alpha.toFixed(3),
                'progress:',
                state.progress.toFixed(3),
                'useTexture:',
                state.useTexture,
                'textureSource:',
                state.textureSource ? 'set' : 'null'
            );
        }
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(uRes, canvas.width, canvas.height);
        gl.uniform1f(uTime, t);
        gl.uniform1f(uProgress, state.progress);
        gl.uniform1f(uAlpha, state.alpha);
        gl.uniform1f(uHueShift, hueShift);
        gl.uniform2f(uAnchor, state.anchor[0], state.anchor[1]);
        gl.uniform1f(uBulgeRadius, state.bulgeRadius);
        gl.uniform1f(uElevation, state.elevation);
        gl.uniform1f(uIridescence, state.iridescence);
        gl.uniform1f(uRefractStrength, state.refractStrength);
        gl.uniform1f(uTravelMode, state.travelMode);
        gl.uniform3f(uPalA, state.palette.a[0], state.palette.a[1], state.palette.a[2]);
        gl.uniform3f(uPalB, state.palette.b[0], state.palette.b[1], state.palette.b[2]);
        gl.uniform3f(uPalC, state.palette.c[0], state.palette.c[1], state.palette.c[2]);
        gl.uniform3f(uPalD, state.palette.d[0], state.palette.d[1], state.palette.d[2]);
        if (state.useTexture > 0 && state.textureSource) {
            ensureTexture();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            try {
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.texImage2D(
                    gl.TEXTURE_2D,
                    0,
                    gl.RGBA,
                    gl.RGBA,
                    gl.UNSIGNED_BYTE,
                    state.textureSource
                );
            } catch {}
            gl.uniform1i(uTex, 0);
            gl.uniform1f(uUseTexture, 1);
        } else {
            gl.uniform1f(uUseTexture, 0);
        }
        if (state.snapshotSource) {
            ensureTexOld();
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, texOld);
            try {
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.texImage2D(
                    gl.TEXTURE_2D,
                    0,
                    gl.RGBA,
                    gl.RGBA,
                    gl.UNSIGNED_BYTE,
                    state.snapshotSource
                );
            } catch {}
            gl.uniform1i(uTexOld, 1);
            gl.uniform1f(uHasSnapshot, 1);
        } else {
            gl.uniform1f(uHasSnapshot, 0);
        }
        gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return {
        canvas,
        setProgress: (p) => {
            state.progress = p;
        },
        setAlpha: (a) => {
            state.alpha = a;
        },
        setPalette: (p) => {
            state.palette = p;
        },
        setBandTight: (b) => {
            state.bandTight = b;
        },
        setDirection: (d) => {
            state.direction = d;
        },
        setWaveAmount: (v) => {
            state.waveAmount = v;
        },
        setRippleAmount: (v) => {
            state.rippleAmount = v;
        },
        setWaveSpeed: (v) => {
            state.waveSpeed = v;
        },
        setBrightness: (v) => {
            state.brightness = v;
        },
        setSwellAmount: (v) => {
            state.swellAmount = v;
        },
        setAnchor: (u2, v) => {
            state.anchor = [u2, v];
        },
        setBulgeRadius: (r) => {
            state.bulgeRadius = r;
        },
        setElevation: (z) => {
            state.elevation = z;
        },
        setIridescence: (i) => {
            state.iridescence = i;
        },
        setRefractStrength: (r) => {
            state.refractStrength = r;
        },
        setTravelMode: (on) => {
            state.travelMode = on;
        },
        setTextureSource: (src) => {
            state.textureSource = src;
        },
        setUseTexture: (on) => {
            state.useTexture = on;
        },
        setSnapshotSource: (src) => {
            state.snapshotSource = src;
        },
        getProgress: () => state.progress,
        getAlpha: () => state.alpha,
        destroy: () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            gl.deleteProgram(prog);
            gl.deleteBuffer(posBuf);
            gl.deleteBuffer(uvBuf);
            gl.deleteBuffer(idxBuf);
            if (tex) gl.deleteTexture(tex);
            if (texOld) gl.deleteTexture(texOld);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
        },
    };
}

// src/core/easings.ts
function cubicBezier(x1, y1, x2, y2) {
    const bezX = (t) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
    const bezY = (t) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
    const bezXd = (t) =>
        3 * (1 - 4 * t + 3 * t * t) * x1 + 3 * (2 * t - 3 * t * t) * x2 + 3 * t * t;
    return (x) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let t = x;
        for (let i = 0; i < 8; i++) {
            const dx = bezX(t) - x;
            if (Math.abs(dx) < 1e-6) break;
            const d = bezXd(t);
            if (Math.abs(d) < 1e-6) break;
            t -= dx / d;
        }
        return bezY(t);
    };
}
var EASINGS = {
    linear: (p) => p,
    easeOutQuart: (p) => 1 - Math.pow(1 - p, 4),
    easeOutCubic: (p) => 1 - Math.pow(1 - p, 3),
    easeInCubic: (p) => p * p * p,
    easeInOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    easeOutExpo: (p) => (p === 1 ? 1 : 1 - Math.pow(2, -10 * p)),
    easeInOutQuint: (p) => (p < 0.5 ? 16 * p * p * p * p * p : 1 - Math.pow(-2 * p + 2, 5) / 2),
    // cubic-bezier(1, 0, 0.35, 0.95) — holds at the start, then whips forward.
    snap: cubicBezier(1, 0, 0.35, 0.95),
    // cubic-bezier(0.25, 0.1, 0.25, 1) — CSS default `ease`. Smooth start, gentle finish.
    ease: cubicBezier(0.25, 0.1, 0.25, 1),
    // cubic-bezier(0.175, 0.885, 0.32, 1.1) — fast accel, overshoots past 1, settles.
    back: cubicBezier(0.175, 0.885, 0.32, 1.1),
};
var resolveEasing = (e) => {
    if (!e) return EASINGS.easeOutQuart;
    if (typeof e === 'function') return e;
    return EASINGS[e];
};

// src/core/sweep.ts
var easeOutQuart = (p) => 1 - Math.pow(1 - p, 4);
var easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
function playSweep(ctrl, opts = {}) {
    const sweepMs = opts.sweepMs ?? 1100;
    const outroMs = opts.outroMs ?? 700;
    const midpoint = opts.midpoint ?? 0.5;
    const easing = resolveEasing(opts.easing) ?? easeOutQuart;
    const peakAlpha = opts.peakAlpha ?? 1;
    if (opts.palette) ctrl.setPalette(resolvePalette(opts.palette));
    if (opts.bandTight !== void 0) ctrl.setBandTight(opts.bandTight);
    if (opts.direction) ctrl.setDirection(opts.direction);
    if (opts.waveAmount !== void 0) ctrl.setWaveAmount(opts.waveAmount);
    if (opts.rippleAmount !== void 0) ctrl.setRippleAmount(opts.rippleAmount);
    if (opts.waveSpeed !== void 0) ctrl.setWaveSpeed(opts.waveSpeed);
    if (opts.brightness !== void 0) ctrl.setBrightness(opts.brightness);
    if (opts.swellAmount !== void 0) ctrl.setSwellAmount(opts.swellAmount);
    let cancelled = false;
    let raf = 0;
    let resolveMidpoint;
    let resolveDone;
    const midpointP = new Promise((r) => {
        resolveMidpoint = r;
    });
    const doneP = new Promise((r) => {
        resolveDone = r;
    });
    (async () => {
        const currentProgress = ctrl.getProgress();
        const startProgress =
            currentProgress >= 0.999 ? 0 : Math.max(0, Math.min(1, currentProgress));
        ctrl.setAlpha(peakAlpha);
        ctrl.setProgress(startProgress);
        const remaining = 1 - startProgress;
        const phaseMs = Math.max(80, sweepMs * remaining);
        let midpointFired = false;
        const t0 = performance.now();
        await new Promise((resolve) => {
            const tick = () => {
                if (cancelled) {
                    resolve();
                    return;
                }
                const raw = Math.min(1, (performance.now() - t0) / phaseMs);
                const eased = easing(raw);
                const progress = startProgress + remaining * eased;
                ctrl.setProgress(progress);
                if (!midpointFired && progress >= midpoint) {
                    midpointFired = true;
                    Promise.resolve(opts.onMidpoint?.()).finally(resolveMidpoint);
                }
                if (raw < 1) raf = requestAnimationFrame(tick);
                else resolve();
            };
            raf = requestAnimationFrame(tick);
        });
        if (cancelled) return;
        if (!midpointFired) {
            Promise.resolve(opts.onMidpoint?.()).finally(resolveMidpoint);
        }
        await runRamp(
            outroMs,
            peakAlpha,
            0,
            easeInOutCubic,
            ctrl.setAlpha,
            () => cancelled,
            (id) => {
                raf = id;
            }
        );
        if (cancelled) return;
        ctrl.setProgress(0);
        opts.onComplete?.();
        resolveDone();
    })();
    return {
        midpoint: midpointP,
        done: doneP,
        cancel: () => {
            cancelled = true;
            cancelAnimationFrame(raf);
            resolveMidpoint();
            resolveDone();
        },
    };
}
function runRamp(durationMs, from, to, ease, setter, isCancelled, setRaf) {
    return new Promise((resolve) => {
        const t0 = performance.now();
        const tick = () => {
            if (isCancelled()) {
                resolve();
                return;
            }
            const raw = Math.min(1, (performance.now() - t0) / durationMs);
            setter(from + (to - from) * ease(raw));
            if (raw < 1) setRaf(requestAnimationFrame(tick));
            else resolve();
        };
        setRaf(requestAnimationFrame(tick));
    });
}

export {
    ACCENTS,
    ACCENT_ORDER,
    EASINGS,
    PALETTES,
    accentChain,
    accentPair,
    createMeshShader,
    createNamedropShader,
    createShader,
    cubicBezier,
    hexToRgb,
    oklchToRgb,
    playSweep,
    resolveEasing,
    resolvePalette,
    rgbToOklch,
    shuffleAccentPalette,
};
