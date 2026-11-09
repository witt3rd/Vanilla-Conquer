#version 450

layout(location = 0) in vec2 vUV;
layout(location = 0) out vec4 outColor;

layout(set = 0, binding = 0) uniform usampler2D uFbTex;
layout(set = 0, binding = 1, std140) uniform PaletteUBO {
    vec4 colors[256];
} uPalette;
layout(set = 0, binding = 2) uniform sampler2D uMenuTex;

layout(set = 0, binding = 3, std140) uniform UltraMenuUBO {
    // params0: x = time_sec, y = mouse_u, z = mouse_v, w = aspect_ratio
    vec4 params0;
    // params1: x = button_count, y = cursor_visible, z = mouse_down, w = intro_fade
    vec4 params1;
    // btn_rect[8]: x = u0, y = v0, z = u1, w = v1
    vec4 btn_rect[8];
    // btn_state[8]: x = hover_anim, y = selected, z = pressed, w = char_len
    vec4 btn_state[8];
    // btn_chars[16]: 2 uvec4s (32 ASCII chars) per button
    uvec4 btn_chars[16];
    // ver_chars[2]: up to 32 ASCII chars for VersionText
    uvec4 ver_chars[2];
    // ver_info: x = ver_len, y = copyright_len, z = click_flash, w = reserved
    vec4 ver_info;
} menu;

// Scene image occupies top 1536 rows of the 2752x1600 texture; bottom 64 rows are the HUD font atlas.
const float kTexW = 2752.0;
const float kTexH = 1600.0;
const float kSceneH = 1536.0;
const float kSceneVScale = kSceneH / kTexH; // 0.96

// Fast, high-quality hash & 2D noise for procedural fire, smoke, and sparks
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm4(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
    for (int i = 0; i < 4; ++i) {
        v += amp * noise2D(p);
        p = rot * p * 2.03 + vec2(17.1, 31.7);
        amp *= 0.5;
    }
    return v;
}

vec4 sampleScene(vec2 uv) {
    vec2 clamped = clamp(uv, vec2(0.0005), vec2(0.9995));
    return texture(uMenuTex, vec2(clamped.x, clamped.y * kSceneVScale));
}

// Extract packed ASCII byte from uvec4 pair (up to 32 chars)
uint extractChar(uvec4 c0, uvec4 c1, int idx) {
    if (idx < 0 || idx >= 32) return 32u;
    int wordIdx = idx >> 2;
    int byteShift = (idx & 3) * 8;
    uint word = 0u;
    if (wordIdx == 0) word = c0.x;
    else if (wordIdx == 1) word = c0.y;
    else if (wordIdx == 2) word = c0.z;
    else if (wordIdx == 3) word = c0.w;
    else if (wordIdx == 4) word = c1.x;
    else if (wordIdx == 5) word = c1.y;
    else if (wordIdx == 6) word = c1.z;
    else word = c1.w;
    return (word >> uint(byteShift)) & 0xFFu;
}

// Sample the 96-glyph (ASCII 32..127, 28x64 cell) font atlas in rows 1536..1600
// Returns vec2(core_alpha, glow_alpha). useMono=false -> NotoSans SemiCondensed, useMono=true -> JetBrainsMono
vec2 sampleGlyphAtlas(uint asciiCode, vec2 cellUV, bool useMono) {
    if (asciiCode <= 32u || asciiCode > 127u) return vec2(0.0);
    if (cellUV.x < 0.0 || cellUV.x > 1.0 || cellUV.y < 0.0 || cellUV.y > 1.0) return vec2(0.0);
    float idx = float(asciiCode - 32u);
    float u = (idx * 28.0 + clamp(cellUV.x, 0.04, 0.96) * 28.0) / kTexW;
    float v = (kSceneH + clamp(cellUV.y, 0.04, 0.96) * 64.0) / kTexH;
    vec4 s = texture(uMenuTex, vec2(u, v));
    return useMono ? s.ba : s.rg;
}

// Render a live nuclear viewport (Left or Right monitor) with toroidal vortex flow advection,
// internal plasma detonation waves, rising embers, heat distortion, and CRT scanlines.
vec3 renderNuclearViewport(vec2 uv, bool isLeft, float t, float blastPulse) {
    vec2 cloudCenter = isLeft ? vec2(0.148, 0.235) : vec2(0.865, 0.240);
    float stemX = isLeft ? 0.140 : 0.875;

    // Compute realisticmushroom-cloud velocity field:
    // 1. Upward buoyant surge in the stem & core
    // 2. Outward expansion at the top of the cap + toroidal downward curl at the outer rim
    vec2 rel = uv - cloudCenter;
    float distCenter = length(rel * vec2(2.4, 1.0));
    float stemWeight = exp(-pow((uv.x - stemX) * 14.0, 2.0)) * smoothstep(0.08, 0.55, uv.y) * smoothstep(0.66, 0.30, uv.y);
    float capWeight = smoothstep(0.45, 0.02, uv.y);

    // Toroidal vortex rotation in the mushroom cap
    float sideSign = (uv.x >= cloudCenter.x) ? 1.0 : -1.0;
    vec2 vortexVel = vec2(
        sideSign * (0.22 - uv.y) * 0.045 * capWeight,
        -0.042 * (stemWeight + 0.65 * capWeight * exp(-pow((uv.x - cloudCenter.x) * 8.0, 2.0)))
    );

    // Add multi-octave turbulent curl
    vec2 nCoord = uv * vec2(18.0, 12.0) + vec2(isLeft ? 0.0 : 7.3, t * 0.55);
    vec2 turb = vec2(
        fbm4(nCoord) - 0.5,
        fbm4(nCoord + vec2(13.7, 29.1)) - 0.5
    ) * 0.018;

    vec2 flow = vortexVel + turb;

    // Dual-phase seamless advection so the photorealistic mushroom cloud boils forever without stretching
    float cycleRate = 0.24;
    float p0 = fract(t * cycleRate + (isLeft ? 0.0 : 0.37));
    float p1 = fract(t * cycleRate + (isLeft ? 0.5 : 0.87));
    float blend = smoothstep(0.0, 1.0, abs(2.0 * p0 - 1.0));

    vec2 uv0 = uv - flow * (p0 - 0.35);
    vec2 uv1 = uv - flow * (p1 - 0.35);

    // Clamp advected UVs inside the respective viewport bounds
    if (isLeft) {
        uv0 = clamp(uv0, vec2(0.022, 0.005), vec2(0.282, 0.665));
        uv1 = clamp(uv1, vec2(0.022, 0.005), vec2(0.282, 0.665));
    } else {
        uv0 = clamp(uv0, vec2(0.716, 0.005), vec2(0.978, 0.670));
        uv1 = clamp(uv1, vec2(0.716, 0.005), vec2(0.978, 0.670));
    }

    vec3 col0 = sampleScene(uv0).rgb;
    vec3 col1 = sampleScene(uv1).rgb;
    vec3 baseCol = mix(col0, col1, blend);

    // Compute local fire temperature from redness/luminance of the mushroom cloud
    float fireTemp = clamp((baseCol.r * 1.15 + baseCol.g * 0.45 - baseCol.b * 0.8) * 0.9, 0.0, 1.5);

    // Animated internal plasma boils & rising shockwave core flashes
    float plasmaNoise = fbm4(uv * vec2(26.0, 18.0) - vec2(sideSign * t * 0.35, -t * 1.65));
    float coreWave = sin(uv.y * 14.0 + t * 3.8 - plasmaNoise * 3.5) * 0.5 + 0.5;
    float coreFlash = pow(fireTemp, 1.6) * (0.22 * plasmaNoise + 0.38 * blastPulse * coreWave);

    vec3 hotPlasma = vec3(1.0, 0.78, 0.35) * coreFlash + vec3(1.0, 0.38, 0.06) * (plasmaNoise - 0.42) * fireTemp * 0.45;
    vec3 col = baseCol + hotPlasma;

    // Expanding supersonic shockwave condensation ring in the viewport
    float shockPhase = fract(t * 0.32 + (isLeft ? 0.1 : 0.6));
    float shockRadius = shockPhase * 0.32;
    float shockRing = exp(-pow((distCenter - shockRadius) * 45.0, 2.0)) * (1.0 - shockPhase) * (1.0 - shockPhase);
    col += vec3(1.0, 0.72, 0.42) * shockRing * 0.32;

    // Live ballistic fire-debris & rising incandescent embers inside the viewport
    for (int k = 0; k < 8; ++k) {
        float fk = float(k) + (isLeft ? 1.0 : 19.0);
        float period = 2.4 + hash12(vec2(fk, 3.1)) * 1.8;
        float lt = fract((t + fk * 0.73) / period);
        vec2 launchPos = vec2(stemX + (hash12(vec2(fk, 7.7)) - 0.5) * 0.08, 0.56);
        vec2 vel = vec2((hash12(vec2(fk, 11.3)) - 0.5) * 0.22, -0.38 - hash12(vec2(fk, 5.9)) * 0.25);
        vec2 pos = launchPos + vel * lt + vec2(0.0, 0.22 * lt * lt);
        vec2 d = (uv - pos) * vec2(1.78, 1.0);
        float spark = exp(-dot(d, d) * 18000.0) * (1.0 - lt);
        col += vec3(1.0, 0.75, 0.32) * spark * 1.4;
    }

    // Military viewport CRT scanlines & dirty armored glass edge vignette
    float scanline = 0.93 + 0.07 * sin(uv.y * kSceneH * 3.14159265);
    col *= scanline;

    return max(col, vec3(0.0));
}

// Distance to a 2D line segment with velocity-aligned coordinates
float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
}

// Signed Distance Field for the hollow tactical arrow cursor matching CnC-Ultra-Menu.jpeg
float sdTacticalCursor(vec2 p) {
    // Cursor tip at (0, 0), pointing up-left like standard tactical arrow
    // Vertices in normalized cursor space (0..1 = 36px at 1536p)
    vec2 v0 = vec2(0.0, 0.0);
    vec2 v1 = vec2(0.08, 0.92);
    vec2 v2 = vec2(0.32, 0.68);
    vec2 v3 = vec2(0.54, 1.05);
    vec2 v4 = vec2(0.68, 0.96);
    vec2 v5 = vec2(0.46, 0.60);
    vec2 v6 = vec2(0.78, 0.56);

    vec2 poly[7] = vec2[7](v0, v1, v2, v3, v4, v5, v6);
    float d = dot(p - poly[0], p - poly[0]);
    float s = 1.0;
    for (int i = 0, j = 6; i < 7; j = i, i++) {
        vec2 e = poly[j] - poly[i];
        vec2 w = p - poly[i];
        vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
        d = min(d, dot(b, b));
        bvec3 cond = bvec3(p.y >= poly[i].y, p.y < poly[j].y, e.x * w.y > e.y * w.x);
        if (all(cond) || all(not(cond))) s *= -1.0;
    }
    return s * sqrt(d);
}

void main() {
    float t = menu.params0.x;
    vec2 mouseUV = menu.params0.yz;
    int btnCount = int(menu.params1.x + 0.5);
    bool showCursor = menu.params1.y > 0.5;
    float mouseDown = menu.params1.z;

    // Synchronized detonation intensity pulses for Left & Right viewports
    float blastL = pow(0.5 + 0.5 * sin(t * 1.45 + sin(t * 0.51) * 1.6), 2.8);
    float blastR = pow(0.5 + 0.5 * sin(t * 1.22 + 2.2 + sin(t * 0.43 + 1.1) * 1.6), 2.8);

    // Subtle cockpit shockwave rumble + mouse depth parallax
    vec2 shake = vec2(sin(t * 47.0), cos(t * 39.0)) * 0.00075 * pow(max(blastL, blastR), 2.2);
    vec2 parallax = (mouseUV - vec2(0.5)) * vec2(0.0065, 0.0045);

    vec2 uvConsole = clamp(vUV + shake + parallax * 0.15, vec2(0.0005), vec2(0.9995));
    vec4 baseSample = sampleScene(uvConsole);
    vec3 col = baseSample.rgb;
    float maskVal = baseSample.a;

    // Determine region: Left Viewport, Right Viewport, Center CRT Screen, or Armored Console/Logo
    bool inLeftZone = (uvConsole.x < 0.292 && uvConsole.y < 0.680);
    bool inRightZone = (uvConsole.x > 0.708 && uvConsole.y < 0.682);
    bool inCrtZone = (uvConsole.x >= 0.304 && uvConsole.x <= 0.694 && uvConsole.y >= 0.052 && uvConsole.y <= 0.592);

    if (inLeftZone && maskVal > 0.01) {
        vec2 uvView = clamp(vUV + shake - parallax * 0.35, vec2(0.001), vec2(0.999));
        vec3 blastCol = renderNuclearViewport(uvView, true, t, blastL);
        col = mix(col, blastCol, maskVal);
    } else if (inRightZone && maskVal > 0.01) {
        vec2 uvView = clamp(vUV + shake - parallax * 0.35, vec2(0.001), vec2(0.999));
        vec3 blastCol = renderNuclearViewport(uvView, false, t, blastR);
        col = mix(col, blastCol, maskVal);
    }

    // Compute multi-scale surface normal for the PBR armored steel console, bolts, cables, and 3D logo
    float metalMask = (inLeftZone || inRightZone || inCrtZone) ? (1.0 - maskVal) : maskVal;
    if (metalMask > 0.02) {
        vec2 texel = vec2(1.0 / kTexW, 1.0 / kSceneH);
        // Fine micro-grain normal (1.2px) + macro bevel normal (4.5px)
        float lR1 = dot(sampleScene(uvConsole + vec2(texel.x * 1.2, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
        float lL1 = dot(sampleScene(uvConsole - vec2(texel.x * 1.2, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
        float lD1 = dot(sampleScene(uvConsole + vec2(0.0, texel.y * 1.2)).rgb, vec3(0.299, 0.587, 0.114));
        float lU1 = dot(sampleScene(uvConsole - vec2(0.0, texel.y * 1.2)).rgb, vec3(0.299, 0.587, 0.114));

        float lR2 = dot(sampleScene(uvConsole + vec2(texel.x * 4.5, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
        float lL2 = dot(sampleScene(uvConsole - vec2(texel.x * 4.5, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
        float lD2 = dot(sampleScene(uvConsole + vec2(0.0, texel.y * 4.5)).rgb, vec3(0.299, 0.587, 0.114));
        float lU2 = dot(sampleScene(uvConsole - vec2(0.0, texel.y * 4.5)).rgb, vec3(0.299, 0.587, 0.114));

        float dx = (lR1 - lL1) * 2.2 + (lR2 - lL2) * 3.8;
        float dy = (lD1 - lU1) * 2.2 + (lD2 - lU2) * 3.8;
        vec3 N = normalize(vec3(-dx, -dy, 1.0));
        vec3 V = vec3(0.0, 0.0, 1.0);

        // Dynamic Light 1: Left Nuclear Blast Area Light
        vec3 posL = vec3(0.15, 0.30, 0.24);
        vec3 dirL = normalize(posL - vec3(uvConsole, 0.0));
        float distL = length(posL.xy - uvConsole);
        float attenL = 1.0 / (1.0 + 3.2 * distL * distL);
        vec3 H_L = normalize(dirL + V);
        float specL = pow(max(dot(N, H_L), 0.0), 28.0) * attenL * (0.45 + 1.15 * blastL);
        float diffL = max(dot(N, dirL) - 0.15, 0.0) * attenL * (0.20 + 0.55 * blastL);

        // Dynamic Light 2: Right Nuclear Blast Area Light
        vec3 posR = vec3(0.85, 0.30, 0.24);
        vec3 dirR = normalize(posR - vec3(uvConsole, 0.0));
        float distR = length(posR.xy - uvConsole);
        float attenR = 1.0 / (1.0 + 3.2 * distR * distR);
        vec3 H_R = normalize(dirR + V);
        float specR = pow(max(dot(N, H_R), 0.0), 28.0) * attenR * (0.45 + 1.15 * blastR);
        float diffR = max(dot(N, dirR) - 0.15, 0.0) * attenR * (0.20 + 0.55 * blastR);

        // Dynamic Light 3: Center CRT Phosphor Glow on Bezel & Wires
        vec3 posC = vec3(0.50, 0.34, 0.18);
        vec3 dirC = normalize(posC - vec3(uvConsole, 0.0));
        float distC = length((posC.xy - uvConsole) * vec2(1.4, 1.0));
        float attenC = exp(-distC * 4.5);
        vec3 H_C = normalize(dirC + V);
        float specC = pow(max(dot(N, H_C), 0.0), 24.0) * attenC * 0.45;

        // Dynamic Light 4: Interactive Tactical Cursor / Torch Light on Metal & 3D Logo
        vec3 posM = vec3(mouseUV, 0.14);
        vec3 dirM = normalize(posM - vec3(uvConsole, 0.0));
        float distM = length((posM.xy - uvConsole) * vec2(1.78, 1.0));
        float attenM = exp(-distM * 6.5);
        vec3 H_M = normalize(dirM + V);
        float specM = pow(max(dot(N, H_M), 0.0), 36.0) * attenM * 0.65;

        vec3 fireColorL = vec3(1.0, 0.48, 0.14);
        vec3 fireColorR = vec3(1.0, 0.44, 0.12);
        vec3 crtColor = vec3(0.25, 0.95, 0.48);
        vec3 cursorLight = vec3(0.60, 0.95, 0.72);

        vec3 pbrAdd = (fireColorL * (specL * 0.42 + diffL * 0.18) +
                       fireColorR * (specR * 0.42 + diffR * 0.18) +
                       crtColor * specC * 0.28 +
                       cursorLight * specM * 0.32) * metalMask;

        // Extra metallic rim-light sheen on the 3D COMMAND & CONQUER emblem (y=0.66..0.95)
        if (uvConsole.y > 0.65 && uvConsole.y < 0.95 && uvConsole.x > 0.18 && uvConsole.x < 0.82) {
            float sweepX = 0.5 + 0.38 * sin(t * 0.65);
            float sweep = exp(-pow((uvConsole.x - sweepX) * 5.5, 2.0));
            float bevelRim = clamp(length(vec2(dx, dy)) * 1.4, 0.0, 1.0);
            pbrAdd += vec3(1.0, 0.58, 0.22) * bevelRim * sweep * 0.18 * metalMask;
        }

        col += pbrAdd;
    }

    // Center CRT Terminal Phosphor Glass & Interactive Smoked-Glass Buttons
    if (inCrtZone && maskVal > 0.01) {
        float crtMask = maskVal;

        // Animated horizontal CRT static interference bands + rolling refresh wave
        float staticBand = fbm4(vec2(uvConsole.x * 3.0, uvConsole.y * 48.0 - t * 1.8));
        float refreshWave = exp(-pow((uvConsole.y - fract(t * 0.22) * 0.60 - 0.05) * 28.0, 2.0));
        float fineScan = 0.90 + 0.10 * sin(uvConsole.y * kSceneH * 3.14159265);

        vec3 crtCol = col * fineScan;
        crtCol += vec3(0.12, 0.38, 0.18) * (refreshWave * 0.09 + max(staticBand - 0.62, 0.0) * 0.16);

        // Render each interactive phosphor-glass button in native 4K
        for (int i = 0; i < 8; ++i) {
            if (i >= btnCount) break;
            vec4 r = menu.btn_rect[i];
            vec4 st = menu.btn_state[i];
            float hover = st.x;
            float selected = st.y;
            float pressed = st.z;
            int charLen = int(st.w + 0.5);

            // Tactile vertical offset when pressed
            vec2 buv = uvConsole - vec2(0.0, pressed * 0.0015);
            vec2 bCenter = 0.5 * (r.xy + r.zw);
            vec2 bHalf = 0.5 * (r.zw - r.xy);
            vec2 dBox = abs(buv - bCenter) - bHalf;
            float sdfBox = length(max(dBox, vec2(0.0))) + min(max(dBox.x, dBox.y), 0.0);

            float highlight = clamp(max(hover, selected * 0.55) + pressed * 0.6, 0.0, 1.2);

            // Outer phosphor bloom halo around button
            if (sdfBox < 0.025) {
                float outerGlow = exp(-max(sdfBox, 0.0) * 260.0) * (0.22 + 0.48 * highlight);
                crtCol += vec3(0.22, 0.85, 0.42) * outerGlow;
            }

            // Inside the smoked-glass button rectangle
            if (dBox.x <= 0.0 && dBox.y <= 0.0) {
                vec2 localUV = (buv - r.xy) / max(r.zw - r.xy, vec2(0.001));

                // Smoked phosphor glass fill with subtle left-side CRT static sheen (matching CnC-Ultra-Menu.jpeg)
                float leftSheen = exp(-localUV.x * 3.2) * (0.35 + 0.45 * highlight);
                float sweepPos = fract(t * 0.45 + float(i) * 0.17) * 1.6 - 0.3;
                float hoverSweep = exp(-pow((localUV.x - sweepPos) * 5.0, 2.0)) * hover * 0.35;
                float edgeGrad = smoothstep(0.0, 0.35, abs(localUV.y - 0.5) * 2.0);

                vec3 glassTint = mix(vec3(0.04, 0.09, 0.05), vec3(0.14, 0.32, 0.18), highlight * 0.65 + edgeGrad * 0.25);
                crtCol = mix(crtCol * 0.65, glassTint, 0.62);
                crtCol += vec3(0.42, 0.88, 0.55) * (leftSheen * 0.22 + hoverSweep);

                // Crisp top/bottom/side border rails + Reinforced L-shaped Corner Brackets
                float pxX = abs(dBox.x) * kTexW;
                float pxY = abs(dBox.y) * kSceneH;
                float distFromEnd = min(localUV.x, 1.0 - localUV.x) * (r.z - r.x) * kTexW;

                // Top & bottom thin border rails
                float rail = smoothstep(2.2, 0.8, pxY);
                // Side vertical bracket caps + inner vertical accent line at 18px from each end (like START NEW GAME)
                float endCap = smoothstep(2.6, 0.9, pxX);
                float cornerBracket = smoothstep(26.0, 0.0, distFromEnd) * smoothstep(3.2, 1.0, min(pxX, pxY));
                float innerTick = exp(-pow(distFromEnd - 18.0, 2.0) * 0.35) * (0.25 + 0.55 * highlight);

                float borderStrength = clamp(rail * 0.65 + endCap * 0.85 + cornerBracket * 0.95 + innerTick, 0.0, 1.4);
                vec3 borderCol = mix(vec3(0.45, 0.82, 0.54), vec3(0.82, 1.0, 0.88), highlight * 0.7 + cornerBracket * 0.3);
                crtCol += borderCol * borderStrength * (0.72 + 0.45 * highlight);

                // Render crisp native-4K button label from the TrueType HUD Font Atlas
                if (charLen > 0) {
                    float btnHeightPx = (r.w - r.y) * kSceneH;
                    float glyphH = btnHeightPx * 0.82;
                    float glyphW = glyphH * (21.5 / 64.0); // Semi-condensed character advance
                    float totalTextW = float(charLen) * glyphW;
                    float btnWidthPx = (r.z - r.x) * kTexW;

                    float localPxX = localUV.x * btnWidthPx;
                    float localPxY = localUV.y * btnHeightPx;
                    float startPxX = 0.5 * (btnWidthPx - totalTextW);
                    float startPxY = 0.5 * (btnHeightPx - glyphH);

                    if (localPxX >= startPxX && localPxX < startPxX + totalTextW &&
                        localPxY >= startPxY && localPxY < startPxY + glyphH) {
                        float relX = (localPxX - startPxX) / glyphW;
                        int charIdx = int(floor(relX));
                        float cellU = fract(relX);
                        float cellV = (localPxY - startPxY) / glyphH;
                        // Map narrower advance into the centered 28px atlas cell
                        float atlasU = 0.5 + (cellU - 0.5) * (21.5 / 28.0);

                        uint ch = extractChar(menu.btn_chars[i * 2], menu.btn_chars[i * 2 + 1], charIdx);
                        vec2 gSample = sampleGlyphAtlas(ch, vec2(atlasU, cellV), false);
                        float core = smoothstep(0.32, 0.68, gSample.x);
                        float glow = gSample.y;

                        vec3 txtCoreCol = mix(vec3(0.78, 0.96, 0.82), vec3(0.96, 1.0, 0.98), highlight * 0.8);
                        vec3 txtGlowCol = vec3(0.22, 0.88, 0.42) * (0.45 + 0.65 * highlight);
                        crtCol = mix(crtCol, txtCoreCol, core * 0.95) + txtGlowCol * glow * 0.55;
                    }
                }
            }
        }

        col = mix(col, crtCol, crtMask);
    }

    // Render the 3 live tactical VersionText telemetry strings (Left Viewport, Center Bezel, Right Viewport)
    int verLen = int(menu.ver_info.x + 0.5);
    if (verLen > 0) {
        // Right-aligned anchors matching CnC-Ultra-Menu.jpeg:
        // 0: Left viewport bottom-right (x_right = 0.258, y_center = 0.638, scale = 1.0)
        // 1: Center steel bezel bottom-right (x_right = 0.696, y_center = 0.640, scale = 1.28)
        // 2: Right viewport bottom-right (x_right = 0.943, y_center = 0.638, scale = 1.0)
        vec3 anchors[3] = vec3[3](
            vec3(0.258, 0.638, 34.0),
            vec3(0.696, 0.640, 42.0),
            vec3(0.943, 0.638, 34.0)
        );
        for (int a = 0; a < 3; ++a) {
            float gh = anchors[a].z;
            float gw = gh * (19.0 / 64.0);
            float totalW = float(verLen) * gw;
            float rightPxX = anchors[a].x * kTexW;
            float centerPxY = anchors[a].y * kSceneH;
            float curPxX = uvConsole.x * kTexW;
            float curPxY = uvConsole.y * kSceneH;
            float x0 = rightPxX - totalW;
            float y0 = centerPxY - 0.5 * gh;

            if (curPxX >= x0 && curPxX < rightPxX && curPxY >= y0 && curPxY < y0 + gh) {
                float relX = (curPxX - x0) / gw;
                int cIdx = int(floor(relX));
                float cellU = 0.5 + (fract(relX) - 0.5) * (19.0 / 28.0);
                float cellV = (curPxY - y0) / gh;
                uint ch = extractChar(menu.ver_chars[0], menu.ver_chars[1], cIdx);
                vec2 gs = sampleGlyphAtlas(ch, vec2(cellU, cellV), true);
                float core = smoothstep(0.35, 0.70, gs.x);
                float glow = gs.y;
                vec3 vCol = vec3(0.50, 0.84, 0.56);
                col = mix(col, vCol, core * 0.78) + vec3(0.18, 0.65, 0.30) * glow * 0.28;
            }
        }
    }

    // Foreground Layer 1: Live Drifting Volumetric Battlefield Smoke
    {
        vec2 uvSmoke = vUV + parallax * 0.45;
        // Billowing smoke rises and drifts rightward across the lower console & logo
        vec2 sCoord1 = uvSmoke * vec2(3.2, 2.4) + vec2(-t * 0.08, t * 0.05);
        vec2 sCoord2 = uvSmoke * vec2(6.5, 4.8) + vec2(-t * 0.14, t * 0.09);
        float smokeNoise = fbm4(sCoord1 + 0.45 * vec2(fbm4(sCoord2) - 0.5));

        // Concentrated in lower-left, bottom logo area, and lower-right edges
        float leftPlume = exp(-pow(uvSmoke.x * 2.3, 2.0)) * smoothstep(0.38, 0.95, uvSmoke.y);
        float bottomHaze = smoothstep(0.58, 0.98, uvSmoke.y) * 0.55;
        float smokeDensity = clamp((smokeNoise - 0.32) * (leftPlume * 0.65 + bottomHaze * 0.42), 0.0, 0.45);

        // Smoke is dynamically lit by the warm orange left/right nuclear blasts + subtle ambient soot
        vec3 smokeColor = mix(
            vec3(0.16, 0.12, 0.10),
            vec3(0.48, 0.25, 0.14) * (0.7 + 0.5 * blastL),
            exp(-uvSmoke.x * 2.5) * smoothstep(0.95, 0.45, uvSmoke.y)
        );
        col = mix(col, smokeColor, smokeDensity);
    }

    // Foreground Layer 2: Real-Time Physics-Driven Hot Orange Sparks & Embers with Motion-Blur Streaks
    {
        vec2 uvSpark = (vUV + parallax * 0.55) * vec2(1.78, 1.0);
        vec3 sparkAccum = vec3(0.0);

        for (int s = 0; s < 42; ++s) {
            float fs = float(s) + 1.0;
            float period = 1.8 + hash12(vec2(fs, 19.3)) * 2.2;
            float phase = (t + fs * 0.41) / period;
            float cycle = floor(phase);
            float lt = fract(phase);

            vec2 seed = vec2(fs + cycle * 13.0, fs * 3.7 + cycle * 7.0);
            vec2 r0 = hash22(seed);
            vec2 r1 = hash22(seed + vec2(41.2, 17.9));

            // Spawn sparks around the lower viewports, cable bundles, and logo edges
            vec2 p0 = vec2(r0.x * 1.78, 0.42 + r0.y * 0.56);
            vec2 v0 = vec2((r1.x - 0.46) * 0.52, -0.28 - r1.y * 0.42);
            vec2 accel = vec2(0.08 * sin(fs + t * 2.0), 0.38); // Turbulent wind + gravity

            vec2 posNow = p0 + v0 * lt + 0.5 * accel * lt * lt;
            // Velocity-stretched tail for realistic shutter motion blur
            float dtBlur = 0.045;
            float ltPrev = max(0.0, lt - dtBlur);
            vec2 posPrev = p0 + v0 * ltPrev + 0.5 * accel * ltPrev * ltPrev;

            // Bounding box early-out
            vec2 minP = min(posNow, posPrev) - vec2(0.025);
            vec2 maxP = max(posNow, posPrev) + vec2(0.025);
            if (uvSpark.x >= minP.x && uvSpark.x <= maxP.x && uvSpark.y >= minP.y && uvSpark.y <= maxP.y) {
                float dSeg = sdSegment(uvSpark, posPrev, posNow);
                float fade = sin(lt * 3.14159265);
                float flicker = 0.75 + 0.25 * sin(t * 35.0 + fs * 9.0);

                float core = exp(-dSeg * dSeg * 850000.0) * fade * flicker;
                float halo = exp(-dSeg * 320.0) * fade * flicker;

                sparkAccum += vec3(1.0, 0.92, 0.72) * core * 1.6 + vec3(1.0, 0.36, 0.06) * halo * 0.42;
            }
        }
        col += sparkAccum;
    }

    // Foreground Layer 3: Native-4K Glowing Phosphor Tactical Arrow Cursor
    if (showCursor) {
        vec2 cRel = (vUV - mouseUV) * vec2(kTexW, kSceneH) / 38.0;
        if (cRel.x >= -0.35 && cRel.x <= 1.15 && cRel.y >= -0.35 && cRel.y <= 1.35) {
            float dCur = sdTacticalCursor(cRel);
            float outline = smoothstep(0.065, 0.015, abs(dCur));
            float fill = smoothstep(0.02, -0.04, dCur);
            float glow = exp(-max(dCur, 0.0) * 8.5);

            vec3 curFill = mix(vec3(0.08, 0.24, 0.12), vec3(0.35, 0.85, 0.48), mouseDown * 0.6);
            vec3 curEdge = vec3(0.68, 1.0, 0.62);
            vec3 curHalo = vec3(0.22, 0.90, 0.42);

            col = mix(col, curFill, fill * 0.78);
            col = mix(col, curEdge, outline * 0.96);
            col += curHalo * glow * (0.42 + 0.35 * mouseDown);
        }
    }

    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
