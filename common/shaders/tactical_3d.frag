#version 450

layout(location = 0) in vec2 vUV;
layout(location = 0) out vec4 outColor;

layout(set = 0, binding = 0) uniform usampler2D uFrameIndex;
layout(set = 0, binding = 1) uniform PaletteUBO {
    vec4 colors[256];
} uPalette;
layout(set = 0, binding = 2) uniform sampler2D uMenuTex;
layout(set = 0, binding = 5) uniform sampler2D uPbrTex;

layout(set = 0, binding = 4) uniform Tactical3DUBO {
    vec4 view_params0;        // x=time, y=tac_u0, z=tac_v0, w=tac_u1
    vec4 view_params1;        // x=tac_v1, y=sub_cell_x, z=sub_cell_y, w=cells_wide
    vec4 view_params2;        // x=cells_high, y=origin_cell_x, z=origin_cell_y, w=theater
    vec4 view_params3;        // x=entity_count, y=light_count, z=player_house, w=palette_fade
    vec4 overlay_rects[4];    // [0]=rubber_band, [1]=dialog_rect, [2]=tooltip_rect, [3]=aux_ui
    vec4 hud_telemetry[2];    // [0]=(credits, power, drain, cur_units), [1]=(max_units, tiberium, sel_type, sel_hp)
    uvec4 hud_chars[4];       // [0..1]=selected unit name (32 chars), [2..3]=selected unit role (32 chars)
    uvec4 cell_grid[150];     // 30 x 20 cells = 600 uints
    vec4 ent_data0[128];      // x=wx, y=wy, z=alt, w=packed_type
    vec4 ent_data1[128];      // x=hull_yaw, y=turret_yaw, z=health_and_flags, w=footprint_and_aux
    vec4 light_pos_rad[32];   // x=wx, y=wy, z=wz, w=radius
    vec4 light_col_int[32];   // x=r, y=g, z=b, w=intensity
} uTac;

const float PI = 3.14159265359;

// ----------------------------------------------------------------------------
// Fast Hashes & Procedural Noise
// ----------------------------------------------------------------------------
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
    return mix(
        mix(hash12(i + vec2(0.0, 0.0)), hash12(i + vec2(1.0, 0.0)), u.x),
        mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
        u.y
    );
}

float fbm3(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
    for (int i = 0; i < 3; ++i) {
        v += a * noise2D(p);
        p = rot * p * 2.03 + vec2(17.1, 31.7);
        a *= 0.5;
    }
    return v;
}

float fbm4(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
    for (int i = 0; i < 4; ++i) {
        v += a * noise2D(p);
        p = rot * p * 2.02 + vec2(13.4, 29.1);
        a *= 0.5;
    }
    return v;
}

// ----------------------------------------------------------------------------
// Cell Grid Unpacking (30 x 20 Grid)
// ----------------------------------------------------------------------------
// Packed uint per cell:
//   bits 0..3   : LandType (0=Clear, 1=Road, 2=Water, 3=Rock, 4=Wall, 5=Tiberium, 6=Beach, 7=River)
//   bits 4..7   : OverlayKind (0=None, 1..12=Tiberium stage, 13=Wall, 14=Concrete, 15=Crate/Field)
//   bits 8..11  : SubKind (WallType 0..4 or SmudgeKind: 0=None, 1..5=Crater, 6=Scorch, 7=Bib)
//   bits 12..15 : SlopeAndBridgeFlags (0=Flat, 1..8=Cliff/Slope, 9=Bridge, 10=Falls, 11=Ford)
//   bits 16..17 : Visibility (0=Unmapped Shroud, 1=Mapped Fog edge, 2=Visible)
//   bits 18..19 : PlacementCursor (0=None, 1=Valid Green, 2=Blocked Red)
//   bits 20..27 : Icon/Variation seed
uint fetchCellRaw(ivec2 c) {
    ivec2 cc = clamp(c, ivec2(0), ivec2(29, 19));
    int idx = cc.y * 30 + cc.x;
    return uTac.cell_grid[idx >> 2][idx & 3];
}

bool isCellWater(uint raw) {
    uint land = raw & 15u;
    uint slope = (raw >> 12u) & 15u;
    return (land == 2u || land == 7u || slope == 10u) && (slope != 9u);
}

bool isCellBeach(uint raw) {
    uint land = raw & 15u;
    uint slope = (raw >> 12u) & 15u;
    return (land == 6u || slope == 11u);
}

bool isCellRoad(uint raw) {
    uint land = raw & 15u;
    uint slope = (raw >> 12u) & 15u;
    return (land == 1u || slope == 9u);
}

bool isCellRock(uint raw) {
    uint land = raw & 15u;
    uint slope = (raw >> 12u) & 15u;
    return (land == 3u || (slope >= 1u && slope <= 8u));
}

bool isCellWall(uint raw) {
    uint land = raw & 15u;
    uint ovl = (raw >> 4u) & 15u;
    return (land == 4u || ovl == 13u);
}

// Smooth bilinear field evaluators over the 30x20 cell grid
vec4 sampleTerrainFields(vec2 cellPos) {
    vec2 p = cellPos - vec2(0.5);
    ivec2 i0 = ivec2(floor(p));
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    uint c00 = fetchCellRaw(i0 + ivec2(0, 0));
    uint c10 = fetchCellRaw(i0 + ivec2(1, 0));
    uint c01 = fetchCellRaw(i0 + ivec2(0, 1));
    uint c11 = fetchCellRaw(i0 + ivec2(1, 1));

    // x = water, y = road, z = rock/cliff, w = visibility (0..1)
    vec4 v00 = vec4(isCellWater(c00) ? 1.0 : 0.0, isCellRoad(c00) ? 1.0 : 0.0, isCellRock(c00) ? 1.0 : 0.0, float((c00 >> 16u) & 3u) * 0.5);
    vec4 v10 = vec4(isCellWater(c10) ? 1.0 : 0.0, isCellRoad(c10) ? 1.0 : 0.0, isCellRock(c10) ? 1.0 : 0.0, float((c10 >> 16u) & 3u) * 0.5);
    vec4 v01 = vec4(isCellWater(c01) ? 1.0 : 0.0, isCellRoad(c01) ? 1.0 : 0.0, isCellRock(c01) ? 1.0 : 0.0, float((c01 >> 16u) & 3u) * 0.5);
    vec4 v11 = vec4(isCellWater(c11) ? 1.0 : 0.0, isCellRoad(c11) ? 1.0 : 0.0, isCellRock(c11) ? 1.0 : 0.0, float((c11 >> 16u) & 3u) * 0.5);

    return mix(mix(v00, v10, u.x), mix(v01, v11, u.x), u.y);
}

// ----------------------------------------------------------------------------
// 3D Terrain Heightfield (in Cell Units)
// ----------------------------------------------------------------------------
float evaluateTerrainHeight(vec2 worldCell, vec2 globalCell, out vec4 fieldsOut) {
    bool isShowcase = (uTac.hud_telemetry[0].x == 3200.0 && uTac.hud_telemetry[0].y == 2100.0);

    // Domain-warp coastal sampling using world-locked globalCell so terrain NEVER moves or warps when panning!
    vec2 qWarp = vec2(fbm3(globalCell * 0.36 + vec2(1.7, 9.2)), fbm3(globalCell * 0.36 + vec2(8.3, 2.8)));
    vec4 fExact = sampleTerrainFields(worldCell);
    vec2 coastWarp = (qWarp - 0.5) * (isShowcase ? vec2(1.65, 1.95) : vec2(0.85, 0.85));
    vec4 fNear = sampleTerrainFields(worldCell + coastWarp * 0.65);
    vec4 fBroad = 0.25 * (
        sampleTerrainFields(worldCell + coastWarp + vec2(-0.85, -0.75)) +
        sampleTerrainFields(worldCell + coastWarp + vec2( 0.85, -0.75)) +
        sampleTerrainFields(worldCell + coastWarp + vec2(-0.85,  0.75)) +
        sampleTerrainFields(worldCell + coastWarp + vec2( 0.85,  0.75))
    );
    fieldsOut = mix(fNear, fBroad, 0.55);

    float waterField = 0.0;
    float roadField  = 0.0;
    float valleyFlat = 0.0;
    float mtnEnvelope = 0.0;

    if (isShowcase) {
        vec2 penCell = worldCell;
        float eastCoastX = 12.8 + penCell.y * 0.28 + sin(penCell.y * 0.58 + 0.5) * 0.95 + (qWarp.x - 0.5) * 1.65;
        float southCoastY = 13.0 + (penCell.x - 12.5) * 0.20 + sin(penCell.x * 0.65) * 0.75 + (qWarp.y - 0.5) * 1.35;
        float coveDist = length((penCell - vec2(13.8, 13.8)) * vec2(0.45, 0.42));
        float coveWater = smoothstep(1.35, 0.42, coveDist) * smoothstep(10.8, 12.5, penCell.x);
        float pierLand = smoothstep(2.1, 0.7, length((penCell - vec2(14.8, 10.3)) * vec2(0.80, 0.95)));

        float eastOcean = smoothstep(eastCoastX - 1.3, eastCoastX + 1.8, penCell.x);
        float southOcean = smoothstep(southCoastY - 1.1, southCoastY + 1.6, penCell.y) * smoothstep(11.0, 13.2, penCell.x);
        waterField = clamp(max(eastOcean, max(southOcean, coveWater)) * (1.0 - pierLand * 0.82), 0.0, 1.0);

        vec2 pa = penCell - vec2(5.2, 4.2);
        vec2 ba = vec2(15.8, 10.8) - vec2(5.2, 4.2);
        float hRoad1 = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        float dRoad1 = length(pa - ba * hRoad1 + vec2(sin(penCell.y * 0.55) * 0.28, 0.0));

        vec2 pa2 = penCell - vec2(8.2, 8.8);
        vec2 ba2 = vec2(10.2, 14.8) - vec2(8.2, 8.8);
        float hRoad2 = clamp(dot(pa2, ba2) / dot(ba2, ba2), 0.0, 1.0);
        float dRoad2 = length(pa2 - ba2 * hRoad2 + vec2(sin(penCell.y * 0.75) * 0.22, 0.0));

        float synthRoad = max(smoothstep(1.45, 0.45, dRoad1), smoothstep(1.20, 0.38, dRoad2));
        synthRoad *= smoothstep(0.42, 0.08, waterField);
        roadField = max(smoothstep(0.32, 0.68, fNear.y) * (1.0 - waterField), synthRoad * 0.94);
        valleyFlat = max(smoothstep(3.4, 1.1, dRoad1), smoothstep(2.6, 0.9, dRoad2));

        float leftMtn   = smoothstep(6.8, 1.0, penCell.x + sin(penCell.y * 0.50) * 1.0) * smoothstep(14.5, 1.5, penCell.y);
        float northMtn  = smoothstep(4.8, 0.2, penCell.y - penCell.x * 0.08) * smoothstep(15.5, 1.5, penCell.x);
        float eastCliff = smoothstep(2.6, 0.4, abs(penCell.x - (eastCoastX - 1.6))) * smoothstep(9.8, 1.2, penCell.y);
        float southCrag = smoothstep(11.6, 2.0, penCell.x) * smoothstep(11.0, 14.8, penCell.y);
        mtnEnvelope = clamp(leftMtn * 0.92 + northMtn * 0.85 + eastCliff * 0.82 + southCrag * 0.72, 0.0, 1.0) * (1.0 - valleyFlat * 0.82);
    } else {
        // Live Gameplay Mode: 100% world-locked to the actual Tiberian Dawn map cells!
        // Smooth domain-warped shoreline (fNear/fBroad + qWarp) eliminates blocky tile steps while keeping dry land 100% dry!
        float wSmooth = mix(fNear.x, fBroad.x, 0.58);
        waterField  = smoothstep(0.24, 0.68, wSmooth + (qWarp.x - 0.5) * 0.18) * smoothstep(0.02, 0.42, max(fExact.x, fBroad.x * 0.85));
        roadField   = smoothstep(0.28, 0.68, mix(fExact.y, fNear.y, 0.45)) * (1.0 - waterField);
        float rSmooth = mix(fNear.z, fBroad.z, 0.58);
        mtnEnvelope = smoothstep(0.18, 0.75, rSmooth + (qWarp.y - 0.5) * 0.22) * (1.0 - waterField);
        valleyFlat  = clamp(1.0 - rSmooth * 1.15, 0.20, 1.0);
    }

    // Check cell flags for bridge / craters only
    ivec2 ci = ivec2(floor(worldCell));
    uint raw = fetchCellRaw(ci);
    uint ovl = (raw >> 4u) & 15u;
    uint sub = (raw >> 8u) & 15u;
    uint slope = (raw >> 12u) & 15u;

    // Sample 512x512 hardware Voronoi rock fracture texture (uPbrTex.r) at macro scale for rock/cliff mask
    vec4 pbrMacro  = texture(uPbrTex, globalCell * 0.028);
    vec4 pbrDetail = texture(uPbrTex, globalCell * 0.072 + vec2(0.37, 0.61));
    float voronoiRock = pbrMacro.r * 0.68 + pbrDetail.r * 0.32;

    // Smooth C-infinity domain-warped coastal mountain ridges using world-locked globalCell (no abs() derivative crease!)
    vec2 warpedPos = globalCell * 0.45 + (qWarp - 0.5) * 1.10;
    float rRaw1 = fbm3(warpedPos * 0.85) * 2.0 - 1.0;
    float rRaw2 = fbm3(warpedPos * 1.65 + vec2(4.2, 7.1)) * 2.0 - 1.0;
    float ridge1 = clamp(1.05 - sqrt(rRaw1 * rRaw1 + 0.045), 0.0, 1.0);
    float ridge2 = clamp(1.05 - sqrt(rRaw2 * rRaw2 + 0.045), 0.0, 1.0);
    float dryLand = smoothstep(0.05, 0.48, 1.0 - waterField);

    float cragMask = smoothstep(0.42, 0.82, ridge1 * 0.65 + ridge2 * 0.35) * dryLand * mtnEnvelope;

    // Coastal headland bluffs & sea-cliffs rising sharply along the rocky shoreline
    float coastEdge = smoothstep(0.02, 0.38, 1.0 - waterField) * smoothstep(0.92, 0.22, 1.0 - waterField);
    float headland = coastEdge * smoothstep(0.28, 0.72, ridge1 * 0.60 + voronoiRock * 0.40) * (1.0 - roadField * 0.85) * (isShowcase ? 1.0 : fExact.z);

    float mapRock = smoothstep(0.22, 0.72, fieldsOut.z + (qWarp.x - 0.5) * 0.35) * (0.50 + 0.50 * ridge1);
    float rockField = clamp(mapRock * (isShowcase ? 0.35 : 0.92) + cragMask * 0.75 + headland * 0.85 + mtnEnvelope * 0.95, 0.0, 1.0);

    // Smooth rolling micro-topography (keep high-frequency Voronoi in surface normal/albedo, not height displacement!)
    float microH = (fbm3(warpedPos * 1.4) - 0.5) * 0.045 * dryLand * (1.0 - roadField * 0.85);

    // Smooth 3D coastal mountains, crags & stepped cliff terraces
    float strata = ridge1 * 0.68 + ridge2 * 0.32;
    float terrace = smoothstep(0.15, 0.85, strata);
    float cliffH = rockField * (0.22 + 0.20 * terrace) + mtnEnvelope * (0.42 + 0.38 * ridge1);

    // Road crown
    float roadH = roadField * 0.018;

    float craterH = 0.0;
    if (ovl != 13u && sub >= 1u && sub <= 5u) {
        vec2 cc = fract(worldCell) - vec2(0.5);
        float r = length(cc) * 2.2;
        float sev = float(sub) * 0.2;
        float bowl = smoothstep(0.85, 0.0, r);
        float rim  = smoothstep(1.05, 0.75, r) * smoothstep(0.45, 0.75, r);
        craterH = (-0.11 * bowl + 0.035 * rim) * (0.5 + 0.5 * sev);
    }

    // Bridge deck over water
    if (slope == 9u) {
        waterField = 0.0;
        roadH = 0.16;
    }

    // Water surface sits below shoreline
    float waterH = -0.075 * waterField;

    fieldsOut.x = waterField;
    fieldsOut.y = roadField;
    fieldsOut.z = rockField;
    return microH + cliffH + roadH + craterH + waterH;
}

vec3 evaluateTerrainNormal(vec2 worldCell, vec2 globalCell) {
    float eps = 0.035;
    vec4 f0, fx, fy;
    float h0 = evaluateTerrainHeight(worldCell, globalCell, f0);
    float hx = evaluateTerrainHeight(worldCell + vec2(eps, 0.0), globalCell + vec2(eps, 0.0), fx);
    float hy = evaluateTerrainHeight(worldCell + vec2(0.0, eps), globalCell + vec2(0.0, eps), fy);
    return normalize(vec3(h0 - hx, h0 - hy, eps));
}

// ----------------------------------------------------------------------------
// 3D Signed Distance Primitives & Operations
// ----------------------------------------------------------------------------
float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdRoundBox(vec3 p, vec3 b, float r) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float sdCylinderZ(vec3 p, float r, float h) {
    vec2 d = abs(vec2(length(p.xy), p.z)) - vec2(r, h);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdCylinderY(vec3 p, float r, float h) {
    vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
    vec3 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    return length(pa - ba * h) - r;
}

float sdHexPrismZ(vec3 p, vec2 h) {
    const vec3 k = vec3(-0.8660254, 0.5, 0.57735);
    p = abs(p);
    p.xy -= 2.0 * min(dot(k.xy, p.xy), 0.0) * k.xy;
    vec2 d = vec2(
        length(p.xy - vec2(clamp(p.x, -k.z * h.x, k.z * h.x), h.x)) * sign(p.y - h.x),
        p.z - h.y
    );
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

vec2 rot2D(vec2 p, float a) {
    float c = cos(a), s = sin(a);
    return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

// ----------------------------------------------------------------------------
// House Faction PBR Trim Colors (Weathered Military Armor Palette)
// ----------------------------------------------------------------------------
vec3 getHouseTrimColor(int houseId) {
    if (houseId == 0) return vec3(0.31, 0.30, 0.24); // GDI Weathered NATO Olive-Drab / Field Khaki
    if (houseId == 1) return vec3(0.28, 0.23, 0.22); // Nod Weathered Charcoal-Crimson / Gunmetal
    if (houseId == 2) return vec3(0.32, 0.32, 0.30); // Neutral Weathered Field-Drab
    if (houseId == 3) return vec3(0.22, 0.30, 0.36); // Multi Naval Slate-Blue
    if (houseId == 4) return vec3(0.38, 0.31, 0.22); // Multi Ochre-Amber
    if (houseId == 5) return vec3(0.22, 0.32, 0.23); // Multi Tactical Olive
    return vec3(0.30, 0.32, 0.34);                   // Gunmetal Gray
}

// ----------------------------------------------------------------------------
// 3D Crystalline Tiberium & Wall Cell Geometry
// ----------------------------------------------------------------------------
// matId: 10 = Tiberium Crystal, 11 = Sandbag Wall, 12 = Cyclone Wall, 13 = Concrete Wall, 14 = Crate
float mapCellStructures(vec3 p, ivec2 ci, uint raw, out int matId, out vec3 localCoord) {
    matId = 0;
    localCoord = vec3(0.0);
    uint ovl = (raw >> 4u) & 15u;
    uint sub = (raw >> 8u) & 15u;
    uint land = raw & 15u;

    vec3 lp = vec3(p.xy - (vec2(ci) + vec2(0.5)), p.z);
    float d = 1e5;

    // 1. Glowing 3D Hexagonal Tiberium Crystal Cluster (stages 1..12)
    if ((ovl >= 1u && ovl <= 12u) || land == 5u) {
        int stage = (ovl >= 1u && ovl <= 12u) ? int(ovl) : 6;
        float density = float(stage) / 12.0;
        int numSpire = 3 + stage / 2;
        float seed = float((raw >> 20u) & 255u) + float(ci.x * 19 + ci.y * 37);

        for (int i = 0; i < 8; ++i) {
            if (i >= numSpire) break;
            float fi = float(i);
            vec2 rnd = hash22(vec2(seed, fi * 7.13));
            float ang = fi * 2.39996 + rnd.x * 0.8;
            float rad = (0.06 + 0.30 * sqrt((fi + 0.4) / float(numSpire))) * (0.65 + 0.35 * density);
            vec2 cOff = vec2(cos(ang), sin(ang)) * rad;

            vec3 cp = lp - vec3(cOff, 0.0);
            // Tilt crystal outward slightly from cluster center
            cp.xy -= cOff * (cp.z * 0.65);
            cp.xy = rot2D(cp.xy, ang);

            float hSpire = (0.11 + 0.22 * density * (1.0 - 0.35 * (fi / 8.0))) * (0.8 + 0.4 * rnd.y);
            float wSpire = (0.032 + 0.028 * density) * (1.0 - clamp(cp.z / max(hSpire * 1.35, 0.05), 0.0, 0.92));
            float dc = sdHexPrismZ(cp - vec3(0.0, 0.0, hSpire * 0.5), vec2(wSpire, hSpire * 0.5));
            if (dc < d) {
                d = dc;
                matId = 10;
                localCoord = cp;
            }
        }
    }

    // 2. Connected 3D Defensive Walls (Sandbag, Cyclone, Concrete/Brick, Barbwire, Wood)
    if (isCellWall(raw)) {
        bool nN = isCellWall(fetchCellRaw(ci + ivec2(0, -1)));
        bool nS = isCellWall(fetchCellRaw(ci + ivec2(0,  1)));
        bool nW = isCellWall(fetchCellRaw(ci + ivec2(-1, 0)));
        bool nE = isCellWall(fetchCellRaw(ci + ivec2( 1, 0)));

        float wallH = (sub == 2u) ? 0.26 : ((sub == 1u) ? 0.22 : 0.14);
        float wallThick = (sub == 2u) ? 0.14 : ((sub == 0u) ? 0.16 : 0.08);

        // Central pillar
        float dw = sdRoundBox(lp - vec3(0.0, 0.0, wallH * 0.5), vec3(wallThick * 1.15, wallThick * 1.15, wallH * 0.5), 0.015);
        if (nN) dw = min(dw, sdBox(lp - vec3(0.0, -0.25, wallH * 0.48), vec3(wallThick, 0.26, wallH * 0.48)));
        if (nS) dw = min(dw, sdBox(lp - vec3(0.0,  0.25, wallH * 0.48), vec3(wallThick, 0.26, wallH * 0.48)));
        if (nW) dw = min(dw, sdBox(lp - vec3(-0.25, 0.0, wallH * 0.48), vec3(0.26, wallThick, wallH * 0.48)));
        if (nE) dw = min(dw, sdBox(lp - vec3( 0.25, 0.0, wallH * 0.48), vec3(0.26, wallThick, wallH * 0.48)));

        if (dw < d) {
            d = dw;
            // Render coastal piers & defensive walls as weathered poured-concrete bastions (matId 13) or chainlink (12)
            matId = (sub == 1u || sub == 3u) ? 12 : 13;
            localCoord = lp;
        }
    }

    // 3. 3D Supply Crates (Steel / Wood)
    if (ovl == 15u) {
        float dc = sdRoundBox(lp - vec3(0.0, 0.0, 0.11), vec3(0.18, 0.18, 0.11), 0.015);
        if (dc < d) {
            d = dc;
            matId = 14;
            localCoord = lp;
        }
    }

    return d;
}

// ----------------------------------------------------------------------------
// 3D Articulated Entities (Vehicles, Buildings, Infantry, Aircraft, Trees, VFX)
// ----------------------------------------------------------------------------
// matId:
//   20 = Armored Track / Tire Rubber & Steel
//   21 = Vehicle Composite Hull Armor (House painted + weathered steel)
//   22 = Vehicle Turret & Gun Barrel Steel
//   23 = Glowing Tiberium Hopper / Obelisk Laser Crystal / Plasma Core
//   24 = Structure Concrete Foundation & Bastion Wall
//   25 = Structure Superstructure / Roof / Gantry Crane (House painted)
//   26 = Tree Bark Trunk
//   27 = 3D Botanical Foliage Canopy
//   28 = Outcrop Boulder Rock
//   29 = Infantry Soldier Armor
//   30 = Projectile / Rocket / Laser / Explosion Core
float evaluateSingleEntitySDF(
    vec3 p,
    vec4 d0,
    vec4 d1,
    float time,
    out int partMat,
    out vec3 partLocal
) {
    partMat = 21;
    partLocal = vec3(0.0);

    int packedType = int(floor(d0.w + 0.5));
    int cat = packedType & 7;
    int subType = (packedType >> 3) & 127;
    int flags = int(floor(d1.z));
    bool isFiring = (flags & 2) != 0;
    bool isConstructing = (flags & 16) != 0;
    bool isSpecial = (flags & 32) != 0;

    vec3 center = vec3(d0.xy, d0.z);
    vec3 rel = p - center;
    float entScale = (abs(d0.x) + abs(d0.y) > 0.01 && (cat == 0 || cat == 2)) ? 1.18 : 1.0;
    rel /= entScale;

    // ------------------------------------------------------------------------
    // CATEGORY 0: 3D ARTICULATED VEHICLES (Hulls + Treads/Wheels + Turrets)
    // ------------------------------------------------------------------------
    if (cat == 0) {
        // Rotate XY into vehicle hull frame (North = -Y in screen/map space)
        // PrimaryFacing 0 (North) -> yaw = 0 -> forward is -Y
        vec2 hxy = rot2D(rel.xy, -d1.x);
        vec3 hp = vec3(hxy, rel.z);

        // Turret frame
        vec2 txy = rot2D(rel.xy, -d1.y);
        float recoil = isFiring ? 0.055 : 0.0;
        vec3 tp = vec3(txy.x, txy.y + recoil, rel.z);

        float dHull = 1e5;
        float dTread = 1e5;
        float dTurret = 1e5;
        float dGlow = 1e5;

        if (subType == 0) {
            // UNIT_HTANK: GDI MAMMOTH TANK (Quad-track bogie pods, sloped glacis hull, twin 120mm cannons, Tusk pods)
            vec3 tpPod = vec3(abs(hp.x) - 0.30, abs(hp.y) - 0.21, hp.z - 0.082);
            dTread = sdRoundBox(tpPod, vec3(0.088, 0.185, 0.072), 0.012);

            // Sloped heavy glacis hull + reactive side skirts
            vec3 hullP = hp - vec3(0.0, 0.0, 0.148);
            hullP.z += 0.08 * max(0.0, -hullP.y - 0.18);
            dHull = sdRoundBox(hullP, vec3(0.26, 0.36, 0.078), 0.014);
            dHull = min(dHull, sdBox(vec3(abs(hp.x) - 0.29, hp.y, hp.z - 0.135), vec3(0.025, 0.34, 0.042)));

            // Angular Mammoth Turret + bustle rack + Twin 120mm Barrels with bore evacuators + Side Missile Pods
            vec3 turP = tp - vec3(0.0, 0.04, 0.265);
            turP.x *= 1.0 + 0.35 * max(0.0, -turP.y);
            dTurret = sdRoundBox(turP, vec3(0.195, 0.215, 0.068), 0.014);
            dTurret = min(dTurret, sdRoundBox(vec3(abs(tp.x) - 0.225, tp.y - 0.03, tp.z - 0.275), vec3(0.045, 0.135, 0.052), 0.010));
            vec3 barP = vec3(abs(tp.x) - 0.068, tp.y + 0.28, tp.z - 0.27);
            dTurret = min(dTurret, sdCylinderY(barP, 0.032, 0.24));
            dTurret = min(dTurret, sdCylinderY(barP - vec3(0.0, 0.04, 0.0), 0.044, 0.05));
        } else if (subType == 1) {
            // UNIT_MTANK: GDI M1A2 ABRAMS MAIN BATTLE TANK (Low sloped glacis, reactive side skirts, polygonal turret, 120mm gun)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.245, hp.y, hp.z - 0.072), vec3(0.075, 0.34, 0.065), 0.012);
            // Sloped wedge glacis + armored side skirts
            vec3 hullP = hp - vec3(0.0, 0.0, 0.132);
            hullP.z += 0.09 * max(0.0, -hullP.y - 0.14);
            dHull = sdRoundBox(hullP, vec3(0.225, 0.33, 0.066), 0.012);
            dHull = min(dHull, sdBox(vec3(abs(hp.x) - 0.255, hp.y, hp.z - 0.122), vec3(0.022, 0.31, 0.038)));
            // Polygonal M1A2 sloped cheek turret + rear bustle rack + commander cupola + 120mm cannon with bore evacuator
            vec3 turP = tp - vec3(0.0, 0.03, 0.225);
            turP.x *= 1.0 + 0.42 * max(0.0, -turP.y);
            dTurret = sdRoundBox(turP, vec3(0.175, 0.195, 0.058), 0.012);
            dTurret = min(dTurret, sdBox(tp - vec3(0.0, 0.20, 0.232), vec3(0.145, 0.055, 0.042)));
            dTurret = min(dTurret, sdCylinderZ(tp - vec3(0.065, 0.04, 0.285), 0.052, 0.022));
            dTurret = min(dTurret, sdCylinderY(tp - vec3(0.0, -0.26, 0.225), 0.028, 0.23));
            dTurret = min(dTurret, sdCylinderY(tp - vec3(0.0, -0.22, 0.225), 0.040, 0.05));
        } else if (subType == 2) {
            // UNIT_LTANK: LIGHT ARMORED TANK / BRADLEY IFV (Sloped wedge hull, reactive skirts, offset turret, autocannon)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.21, hp.y, hp.z - 0.068), vec3(0.068, 0.29, 0.060), 0.012);
            vec3 hullP = hp - vec3(0.0, 0.0, 0.122);
            hullP.z += 0.08 * max(0.0, -hullP.y - 0.12);
            dHull  = sdRoundBox(hullP, vec3(0.19, 0.28, 0.062), 0.012);
            vec3 turP = tp - vec3(0.0, 0.02, 0.205);
            turP.x *= 1.0 + 0.35 * max(0.0, -turP.y);
            dTurret = sdRoundBox(turP, vec3(0.14, 0.155, 0.054), 0.014);
            dTurret = min(dTurret, sdCylinderY(tp - vec3(0.0, -0.22, 0.205), 0.026, 0.19));
        } else if (subType == 3) {
            // UNIT_STANK: NOD STEALTH TANK (Angular F-117 faceted chassis + twin rocket bay)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.21, hp.y, hp.z - 0.062), vec3(0.060, 0.29, 0.055), 0.010);
            vec3 sp = hp - vec3(0.0, 0.0, 0.13);
            sp.x *= 1.0 + 0.55 * max(0.0, -sp.y);
            dHull = sdRoundBox(sp, vec3(0.195, 0.31, 0.070), 0.008);
            dTurret = sdBox(hp - vec3(0.0, 0.04, 0.215), vec3(0.135, 0.16, 0.052));
        } else if (subType == 4) {
            // UNIT_FTANK: NOD FLAME TANK (Twin rear pressurized fuel tanks + dual front flame nozzles)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.22, hp.y, hp.z - 0.070), vec3(0.070, 0.29, 0.064), 0.012);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.0, 0.125), vec3(0.195, 0.28, 0.066), 0.014);
            vec3 tankP = vec3(abs(hp.x) - 0.105, hp.y - 0.10, hp.z - 0.215);
            dTurret = sdCylinderY(tankP, 0.072, 0.135);
            vec3 nozP = vec3(abs(hp.x) - 0.085, hp.y + 0.24, hp.z - 0.165);
            dTurret = min(dTurret, sdCylinderY(nozP, 0.030, 0.125));
        } else if (subType == 10) {
            // UNIT_HARVESTER: HEAVY TIBERIUM HARVESTER (Armored hopper + glowing green crystals + front claw scoops)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.28, hp.y, hp.z - 0.085), vec3(0.085, 0.36, 0.076), 0.014);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.06, 0.175), vec3(0.26, 0.29, 0.105), 0.018);
            dHull  = min(dHull, sdRoundBox(hp - vec3(0.0, -0.19, 0.155), vec3(0.20, 0.14, 0.085), 0.016));
            float clawSwing = isSpecial ? sin(time * 9.0) * 0.045 : 0.0;
            vec3 clawP = vec3(abs(hp.x) - (0.14 + clawSwing), hp.y + 0.36, hp.z - 0.085);
            dTurret = sdRoundBox(clawP, vec3(0.058, 0.095, 0.052), 0.010);
            dGlow = sdRoundBox(hp - vec3(0.0, 0.09, 0.255), vec3(0.15, 0.16, 0.048), 0.010);
        } else if (subType == 13) {
            // UNIT_HOVER: AMPHIBIOUS LANDING CRAFT / LCAC (Elongated tapered hull + bow ramp + cargo bay + twin rear fans)
            vec3 skP = hp - vec3(0.0, 0.0, 0.048);
            skP.x *= 1.0 + 0.38 * max(0.0, -skP.y - 0.08);
            dTread = sdRoundBox(skP, vec3(0.24, 0.46, 0.045), 0.018);
            dHull  = sdRoundBox(skP - vec3(0.0, 0.02, 0.052), vec3(0.20, 0.41, 0.032), 0.012);
            // Armored side gunwales, bow ramp, deck cargo & rear twin fan shrouds
            dHull  = min(dHull, sdBox(vec3(abs(hp.x) - 0.19, hp.y + 0.02, hp.z - 0.135), vec3(0.032, 0.36, 0.042)));
            dHull  = min(dHull, sdRoundBox(hp - vec3(0.0, -0.06, 0.145), vec3(0.11, 0.16, 0.038), 0.010));
            dTurret = sdCylinderY(vec3(abs(hp.x) - 0.11, hp.y - 0.33, hp.z - 0.185), 0.068, 0.048);
            dTurret = min(dTurret, sdBox(hp - vec3(0.14, 0.12, 0.195), vec3(0.048, 0.085, 0.045)));
        } else if (subType == 14) {
            // UNIT_MHQ: MOBILE HEADQUARTERS (Armored command chassis + rotating 3D radar dish)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.23, hp.y, hp.z - 0.072), vec3(0.072, 0.31, 0.065), 0.014);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.0, 0.145), vec3(0.21, 0.29, 0.085), 0.016);
            vec3 dishP = hp - vec3(0.0, 0.04, 0.275);
            dishP.xy = rot2D(dishP.xy, time * 2.2);
            dTurret = sdRoundBox(dishP, vec3(0.18, 0.055, 0.095), 0.016);
        } else if (subType == 15) {
            // UNIT_GUNBOAT: GDI NAVAL MISSILE GUNBOAT (Raked warship hull, tiered bridge, mast, bow turret)
            vec3 bowP = hp - vec3(0.0, 0.0, 0.095);
            bowP.x *= 1.0 + 0.85 * max(0.0, -bowP.y - 0.08);
            dHull  = sdRoundBox(bowP, vec3(0.23, 0.46, 0.072), 0.016);
            // Tiered bridge superstructure + radar mast
            dHull  = min(dHull, sdBox(hp - vec3(0.0, 0.06, 0.185), vec3(0.15, 0.18, 0.058)));
            dHull  = min(dHull, sdBox(hp - vec3(0.0, 0.10, 0.265), vec3(0.09, 0.10, 0.045)));
            dTurret = sdCylinderZ(hp - vec3(0.0, 0.12, 0.34), 0.025, 0.065);
            // Rotating bow turret + naval cannon barrel
            dTurret = min(dTurret, sdRoundBox(tp - vec3(0.0, -0.20, 0.182), vec3(0.105, 0.115, 0.048), 0.012));
            dTurret = min(dTurret, sdCylinderY(tp - vec3(0.0, -0.35, 0.182), 0.026, 0.15));
        } else if (subType == 16) {
            // UNIT_MCV: HEAVY MOBILE CONSTRUCTION RIG (Tracked tractor chassis, forward cab, rear assembly gantry)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.28, hp.y, hp.z - 0.082), vec3(0.085, 0.38, 0.075), 0.014);
            // Forward armored cab + rear modular industrial housing
            dHull  = sdRoundBox(hp - vec3(0.0, -0.18, 0.165), vec3(0.25, 0.16, 0.092), 0.014);
            dHull  = min(dHull, sdRoundBox(hp - vec3(0.0, 0.10, 0.195), vec3(0.26, 0.24, 0.115), 0.016));
            // Structural gantry crane boom & side exhaust stacks
            dTurret = sdBox(hp - vec3(0.08, 0.02, 0.325), vec3(0.065, 0.28, 0.048));
            dTurret = min(dTurret, sdCylinderZ(vec3(abs(hp.x) - 0.24, hp.y + 0.04, hp.z - 0.24), 0.032, 0.12));
        } else if (subType == 7 || subType == 12) {
            // UNIT_MLRS / UNIT_MSAM: Tracked Chassis + Rotating Elevated Box Rocket Launcher Pod
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.23, hp.y, hp.z - 0.070), vec3(0.070, 0.31, 0.062), 0.015);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.0, 0.12), vec3(0.205, 0.29, 0.060), 0.018);
            vec3 podP = tp - vec3(0.0, 0.02, 0.235);
            podP.yz = rot2D(podP.yz, 0.26);
            dTurret = sdRoundBox(podP, vec3(0.17, 0.195, 0.088), 0.016);
        } else if (subType == 11) {
            // UNIT_ARTY: Self-Propelled Artillery Howitzer (Long elevated 155mm barrel)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.23, hp.y, hp.z - 0.070), vec3(0.070, 0.30, 0.062), 0.015);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.02, 0.125), vec3(0.205, 0.28, 0.065), 0.018);
            dTurret = sdRoundBox(hp - vec3(0.0, 0.07, 0.205), vec3(0.15, 0.15, 0.065), 0.018);
            vec3 barP = hp - vec3(0.0, -0.20, 0.265);
            barP.yz = rot2D(barP.yz, 0.34);
            dTurret = min(dTurret, sdCylinderY(barP, 0.036, 0.25));
        } else if (subType == 8 || subType == 9 || subType == 17) {
            // UNIT_JEEP (Humvee), UNIT_BUGGY, UNIT_BIKE: Fast Wheeled Recon Vehicles
            float wSpan = (subType == 17) ? 0.055 : 0.195;
            dTread = sdRoundBox(vec3(abs(hp.x) - wSpan, abs(hp.y) - 0.16, hp.z - 0.062), vec3(0.052, 0.075, 0.060), 0.018);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.0, 0.115), vec3(wSpan + 0.025, 0.25, 0.062), 0.018);
            dTurret = sdRoundBox(tp - vec3(0.0, 0.01, 0.185), vec3(0.075, 0.085, 0.042), 0.012);
            dTurret = min(dTurret, sdCylinderY(tp - vec3(0.0, -0.12, 0.195), 0.028, 0.14));
        } else {
            // UNIT_APC & Default Armored Tracked Carrier
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.23, hp.y, hp.z - 0.072), vec3(0.072, 0.30, 0.065), 0.015);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.0, 0.15), vec3(0.215, 0.29, 0.088), 0.022);
            dTurret = sdRoundBox(tp - vec3(0.0, -0.05, 0.245), vec3(0.105, 0.115, 0.045), 0.014);
            dTurret = min(dTurret, sdCylinderY(tp - vec3(0.0, -0.17, 0.245), 0.026, 0.12));
        }

        float dMin = dHull;
        partMat = 21;
        partLocal = hp;
        if (dTread < dMin) {
            dMin = dTread;
            partMat = 20;
            partLocal = hp;
        }
        if (dTurret < dMin) {
            dMin = dTurret;
            partMat = 22;
            partLocal = tp;
        }
        if (dGlow < dMin) {
            dMin = dGlow;
            partMat = 23;
            partLocal = hp;
        }
        return dMin;
    }

    // ------------------------------------------------------------------------
    // CATEGORY 1: 3D BASE STRUCTURES (Multi-Tiered Industrial Complexes, Tall Lattice Radio Towers,
    //             Sunken Concrete Pillbox Bunkers, & Massive Stepped Concrete Naval Pier)
    // ------------------------------------------------------------------------
    if (cat == 1) {
        int fw = max(1, int(floor(d1.w)) & 7);
        int fh = max(1, (int(floor(d1.w)) >> 3) & 7);
        vec2 halfSpan = vec2(float(fw), float(fh)) * 0.46;

        // No artificial square slabs under buildings; only use dPad for Naval Pier or low revetments
        float dPad   = 1e5;
        float dSuper = 1e5;
        float dMetal = 1e5;
        float dGlow  = 1e5;
        vec3  localOut = rel;

        if (subType == 22) {
            // MASSIVE STEPPED POURED-CONCRETE NAVAL PIER & SEAWALL BASTION (Lower-Right of CnC-Ultra-Game.jpg)
            vec2 pierP = rot2D(rel.xy, -0.52);
            vec3 pp = vec3(pierP, rel.z);
            localOut = pp;
            // Main heavy concrete deck & vertical ribbed caisson walls jutting into the surf
            float mainDeck = sdRoundBox(pp - vec3(-0.08, -0.05, 0.16), vec3(1.52, 0.84, 0.16), 0.018);
            // Stepped seawall bastions on seaward (front/right) end & recessed boat-slip landing platform
            float dCaisson1 = sdRoundBox(pp - vec3(1.18, 0.48, 0.19), vec3(0.42, 0.44, 0.19), 0.018);
            float dCaisson2 = sdRoundBox(pp - vec3(-0.92, 0.58, 0.17), vec3(0.46, 0.36, 0.17), 0.018);
            float dSlipStep = sdRoundBox(pp - vec3(0.18, 0.66, 0.09), vec3(0.62, 0.24, 0.09), 0.015);
            dPad = min(min(mainDeck, dSlipStep), min(dCaisson1, dCaisson2));
            // Perimeter low concrete seawall curb & mooring bollards
            float dCurb = max(
                sdBox(pp - vec3(-0.08, -0.05, 0.34), vec3(1.48, 0.80, 0.032)),
                -sdBox(pp - vec3(-0.08, -0.05, 0.35), vec3(1.36, 0.68, 0.05))
            );
            dPad = min(dPad, dCurb);

            // Forward octagonal coastal defense emplacement + rotating twin-gun turret on left-front of pier
            vec3 turBase = pp - vec3(-0.58, 0.18, 0.34);
            dSuper = sdCylinderZ(turBase, 0.38, 0.065);
            dSuper = min(dSuper, sdRoundBox(turBase - vec3(0.0, 0.0, 0.09), vec3(0.24, 0.24, 0.055), 0.015));
            dMetal = sdRoundBox(turBase - vec3(0.0, 0.0, 0.155), vec3(0.16, 0.18, 0.048), 0.012);
            dMetal = min(dMetal, sdBox(turBase - vec3(-0.22, 0.08, 0.16), vec3(0.20, 0.045, 0.024)));

            // Rear multi-tiered harbor control blockhouse & tall octagonal watchtower/lighthouse on right-rear
            dSuper = min(dSuper, sdRoundBox(pp - vec3(0.68, -0.20, 0.38), vec3(0.48, 0.36, 0.11), 0.016));
            dSuper = min(dSuper, sdRoundBox(pp - vec3(0.66, -0.22, 0.52), vec3(0.32, 0.24, 0.08), 0.014));
            dSuper = min(dSuper, sdRoundBox(pp - vec3(0.74, -0.26, 0.72), vec3(0.14, 0.14, 0.20), 0.014));
            // Cargo containers, ammo crates & dock crane boom on deck
            dMetal = min(dMetal, sdBox(pp - vec3(0.05, -0.28, 0.36), vec3(0.22, 0.12, 0.055)));
            dMetal = min(dMetal, sdCylinderZ(pp - vec3(0.74, -0.26, 0.98), 0.032, 0.14));
        } else if (subType == 1 || subType == 2 || subType == 5 || subType == 10) {
            // SUNKEN OCTAGONAL CONCRETE PILLBOX BUNKER (Central foreground of CnC-Ultra-Game.jpg, no square slab!)
            vec2 bxy = rot2D(rel.xy, 0.26);
            vec3 bp = vec3(bxy, rel.z);
            localOut = bp;
            float boxB = sdRoundBox(bp - vec3(0.0, 0.0, 0.15), vec3(0.56, 0.44, 0.15), 0.025);
            float octCut = (abs(bp.x) + abs(bp.y) - 0.78) * 0.7071;
            float mainBunker = max(boxB, octCut);
            // Carve wide dark recessed horizontal firing aperture in front/side walls + side blast bay
            float firingSlit = sdBox(bp - vec3(0.10, 0.36, 0.15), vec3(0.34, 0.18, 0.052));
            float sideBay = sdBox(bp - vec3(-0.40, 0.08, 0.12), vec3(0.20, 0.24, 0.08));
            dSuper = max(mainBunker, -min(firingSlit, sideBay));
            // Raised octagonal roof parapet lip & armored ventilation cupola
            float roofLip = max(
                sdRoundBox(bp - vec3(-0.04, -0.04, 0.31), vec3(0.42, 0.32, 0.035), 0.012),
                -sdBox(bp - vec3(-0.04, -0.04, 0.33), vec3(0.32, 0.22, 0.04))
            );
            dSuper = min(dSuper, roofLip);
            dMetal = sdRoundBox(bp - vec3(0.16, -0.12, 0.33), vec3(0.11, 0.11, 0.045), 0.01);
        } else {
            // SPRAWLING MULTI-TIERED INDUSTRIAL MILITARY BASE COMPOUND + TALL LATTICE STEEL RADIO TOWER
            vec2 cxy = rot2D(rel.xy, -0.22);
            vec3 cp = vec3(cxy, rel.z);
            localOut = cp;

            // Broken low perimeter blast-wall revetments & sandbag/concrete barriers (NOT a solid square pad!)
            float dWallOuter = max(
                sdBox(cp - vec3(0.0, 0.0, 0.065), vec3(halfSpan.x * 0.88, halfSpan.y * 0.82, 0.055)),
                -sdBox(cp - vec3(0.0, 0.0, 0.08), vec3(halfSpan.x * 0.78, halfSpan.y * 0.72, 0.09))
            );
            float gateCut = min(
                sdBox(cp - vec3(0.0, 0.0, 0.08), vec3(0.28, halfSpan.y * 1.1, 0.09)),
                sdBox(cp - vec3(0.0, 0.0, 0.08), vec3(halfSpan.x * 1.1, 0.26, 0.09))
            );
            dPad = max(dWallOuter, -gateCut);

            // Multi-building industrial cluster: Main ribbed hangar + side power hall + upper command block + aux shed
            float hall1 = sdRoundBox(cp - vec3(-0.18, 0.08, 0.19), vec3(halfSpan.x * 0.54, halfSpan.y * 0.46, 0.17), 0.016);
            float hall2 = sdRoundBox(cp - vec3(0.30, -0.14, 0.14), vec3(halfSpan.x * 0.42, halfSpan.y * 0.38, 0.13), 0.016);
            float hall3 = sdRoundBox(cp - vec3(-0.34, -0.26, 0.11), vec3(halfSpan.x * 0.32, halfSpan.y * 0.28, 0.10), 0.014);
            float tier2 = sdRoundBox(cp - vec3(-0.16, 0.04, 0.39), vec3(halfSpan.x * 0.36, halfSpan.y * 0.30, 0.09), 0.014);
            // Carve recessed dark hangar bays into front/side facades
            float doorCut = min(
                sdBox(cp - vec3(-0.16, halfSpan.y * 0.46, 0.11), vec3(0.24, 0.12, 0.08)),
                sdBox(cp - vec3(0.30, -0.14 + halfSpan.y * 0.38, 0.09), vec3(0.16, 0.10, 0.06))
            );
            dSuper = max(min(min(hall1, hall2), min(hall3, tier2)), -doorCut);

            // Twin cylindrical fuel/chemical silos, rooftop HVAC units & industrial piping
            float silo1 = sdCylinderZ(cp - vec3(0.38, 0.24, 0.18), 0.13, 0.16);
            float silo2 = sdCylinderZ(cp - vec3(0.14, 0.32, 0.15), 0.11, 0.13);
            dMetal = min(silo1, silo2);
            dMetal = min(dMetal, sdRoundBox(cp - vec3(0.26, -0.12, 0.29), vec3(0.15, 0.16, 0.05), 0.01));

            // Lipschitz-Continuous Tall 3D Open-Lattice Steel Communication / Radar Tower!
            vec3 towP = cp - vec3(-0.14, -0.04, 0.0);
            float hNorm = clamp((towP.z - 0.32) / 1.25, 0.0, 1.0);
            float towSpan = mix(0.15, 0.048, hNorm);
            // 4 tapered steel corner legs extending from z = 0.30 to z = 1.48
            vec3 legP = vec3(abs(towP.x) - towSpan, abs(towP.y) - towSpan, towP.z - 0.89);
            float dLegs = sdBox(legP, vec3(0.022, 0.022, 0.58));
            // 4 horizontal steel structural ring frames along the tower height
            float zRing = mod(clamp(towP.z, 0.38, 1.42) - 0.38, 0.24) - 0.12;
            float dRings = max(
                sdBox(vec3(towP.x, towP.y, zRing), vec3(towSpan + 0.024, towSpan + 0.024, 0.018)),
                -sdBox(vec3(towP.x, towP.y, zRing), vec3(max(0.01, towSpan - 0.020), max(0.01, towSpan - 0.020), 0.04))
            );
            dRings = max(dRings, abs(towP.z - 0.90) - 0.54);
            // Upper radar/comm platform, crossbar antenna booms, microwave drum dishes & tall whip mast
            float dPlat   = sdBox(towP - vec3(0.0, 0.0, 1.18), vec3(0.15, 0.15, 0.022));
            float dCross1 = sdBox(towP - vec3(0.0, 0.0, 1.36), vec3(0.24, 0.022, 0.020));
            float dDish   = sdCylinderY(towP - vec3(0.11, 0.07, 1.24), 0.065, 0.028);
            float dMast   = sdCylinderZ(towP - vec3(0.0, 0.0, 1.56), 0.016, 0.22);
            dMetal = min(dMetal, min(min(dLegs, dRings), min(min(dPlat, dCross1), min(dDish, dMast))));
        }

        // During construction, slice superstructure height by construction stage
        if (isConstructing) {
            float buildStage = clamp(d1.x, 0.15, 1.0);
            float maxZ = 0.75 * buildStage;
            dSuper = max(dSuper, rel.z - maxZ);
            dMetal = max(dMetal, rel.z - maxZ);
        }

        float dMin = dPad;
        partMat = 24;
        partLocal = localOut;
        if (dSuper < dMin) {
            dMin = dSuper;
            partMat = 25;
            partLocal = localOut;
        }
        if (dMetal < dMin) {
            dMin = dMetal;
            partMat = 22;
            partLocal = localOut;
        }
        if (dGlow < dMin) {
            dMin = dGlow;
            partMat = 23;
            partLocal = localOut;
        }
        return dMin;
    }

    // ------------------------------------------------------------------------
    // CATEGORY 2: 3D INFANTRY SQUAD SOLDIERS
    // ------------------------------------------------------------------------
    if (cat == 2) {
        vec2 ixy = rot2D(rel.xy, -d1.x);
        vec3 ip = vec3(ixy, rel.z);
        if (isSpecial) {
            // Prone infantry soldier hugged low to the ground
            float dProne = sdCapsule(ip, vec3(0.0, -0.09, 0.045), vec3(0.0, 0.11, 0.045), 0.062);
            float dHelm  = length(ip - vec3(0.0, -0.13, 0.068)) - 0.058;
            float dGun   = sdCylinderY(ip - vec3(0.045, -0.20, 0.055), 0.024, 0.095);
            float dMin = min(dProne, dHelm);
            partMat = 29;
            partLocal = ip;
            if (dGun < dMin) {
                dMin = dGun;
                partMat = 22;
            }
            return dMin;
        }
        // Standing / striding 3D armored soldier (boots, armored torso, shoulder pads, visored helmet, weapon)
        float dLegs = sdCapsule(vec3(abs(ip.x) - 0.042, ip.y, ip.z), vec3(0.0, 0.0, 0.02), vec3(0.0, 0.0, 0.11), 0.036);
        float dBody = sdRoundBox(ip - vec3(0.0, 0.0, 0.155), vec3(0.082, 0.058, 0.068), 0.022);
        float dPack = sdRoundBox(ip - vec3(0.0, 0.055, 0.165), vec3(0.058, 0.035, 0.055), 0.012);
        float dHelm = length(ip - vec3(0.0, -0.01, 0.255)) - 0.066;

        // Weapon & specialist gear by InfantryType (0=Minigun, 1=Grenade, 2=Bazooka, 3=Flamer, 4=Chem, 5=Engineer, 6=Rambo)
        float dGun = sdCylinderY(ip - vec3(0.062, -0.095, 0.165), 0.028, 0.115);
        if (subType == 2) {
            // INFANTRY_E3 Rocket Soldier: shoulder-mounted AT bazooka tube extending front & back
            dGun = sdCylinderY(ip - vec3(0.072, -0.03, 0.225), 0.036, 0.175);
        }

        float dMin = min(dBody, dHelm);
        partMat = 29;
        partLocal = ip;
        if (dLegs < dMin) {
            dMin = dLegs;
            partMat = 20;
        }
        if (dPack < dMin) {
            dMin = dPack;
            partMat = (subType == 3 || subType == 4) ? 23 : 22;
        }
        if (dGun < dMin) {
            dMin = dGun;
            partMat = 22;
        }
        return dMin;
    }

    // ------------------------------------------------------------------------
    // CATEGORY 3: 3D AIRCRAFT (Orca VTOL, Apache Helicopter, Chinook, A-10)
    // ------------------------------------------------------------------------
    if (cat == 3) {
        vec2 axy = rot2D(rel.xy, -d1.x);
        vec3 ap = vec3(axy, rel.z);
        // Fuselage + tail boom
        float dFuse = sdRoundBox(ap, vec3(0.16, 0.38, 0.095), 0.038);
        // Wings / VTOL Turbofan Nacelles
        float wSpan = (subType == 1 || subType == 3) ? 0.36 : 0.25;
        float dWing = sdRoundBox(vec3(abs(ap.x) - wSpan, ap.y + 0.04, ap.z), vec3(0.16, 0.12, 0.052), 0.018);
        // Spinning Rotor Disk (for helicopters/transports)
        float dRotor = 1e5;
        if (subType == 0) {
            // Chinook tandem twin rotors
            dRotor = min(
                sdCylinderZ(ap - vec3(0.0, -0.22, 0.12), 0.36, 0.014),
                sdCylinderZ(ap - vec3(0.0,  0.22, 0.13), 0.36, 0.014)
            );
        } else if (subType == 2) {
            // Apache main rotor disk
            dRotor = sdCylinderZ(ap - vec3(0.0, 0.0, 0.12), 0.44, 0.014);
        }
        float dMin = min(dFuse, dWing);
        partMat = 21;
        partLocal = ap;
        if (dRotor < dMin) {
            dMin = dRotor;
            partMat = 22;
            partLocal = ap;
        }
        return dMin;
    }

    // ------------------------------------------------------------------------
    // CATEGORY 4: 3D TREES, BLOSSOM TREES & OUTCROP ROCKS
    // ------------------------------------------------------------------------
    if (cat == 4) {
        float boughNoise = (noise2D(rel.xy * 12.0 + vec2(d0.x, d0.y) * 3.7) - 0.5) * 0.045;
        if (subType >= 25) {
            // Craggy Outcrop Boulder Formation
            float dRock = sdRoundBox(rel - vec3(0.0, 0.0, 0.14), vec3(0.26, 0.20, 0.14), 0.03) + boughNoise * 0.75;
            partMat = 28;
            partLocal = rel;
            return dRock;
        }
        // Rugged Coastal Rock Outcrop + Windswept Coniferous Pine / Scrub Cluster (CnC-Ultra-Game.jpg)
        vec2 wind = vec2(sin(time * 1.5 + d0.x * 0.9), cos(time * 1.2 + d0.y * 0.9)) * 0.015 * clamp(rel.z, 0.0, 1.0);
        vec3 tp = rel - vec3(wind, 0.0);
        float dTrunk = sdCapsule(tp, vec3(-0.04, 0.0, 0.0), vec3(-0.04, 0.0, 0.36), 0.038);
        // Subtle organic rounded boulder cluster at the base of the pines (no square boxes)
        float dRock1 = length((rel - vec3(0.12, 0.06, 0.05)) * vec3(1.1, 1.3, 1.6)) - 0.12 + boughNoise * 0.55;
        float dRock2 = length((rel - vec3(-0.14, 0.10, 0.04)) * vec3(1.3, 1.1, 1.7)) - 0.09 + boughNoise * 0.45;
        float dBaseRock = min(dRock1, dRock2);

        // Conical layered pine boughs (Lipschitz-continuous distance) with radial branch indentations
        vec3 cp = tp - vec3(-0.04, 0.0, 0.28);
        float ang = atan(cp.y, cp.x);
        float branchStar = sin(ang * 7.0 + cp.z * 16.0) * 0.025;
        float cone1 = max(length(cp.xy) - mix(0.24, 0.04, clamp((cp.z + 0.10) / 0.36, 0.0, 1.0)) + branchStar, abs(cp.z - 0.08) - 0.18);
        vec3 cp2 = tp - vec3(0.14, -0.08, 0.20);
        float cone2 = max(length(cp2.xy) - mix(0.18, 0.03, clamp((cp2.z + 0.08) / 0.28, 0.0, 1.0)) + branchStar * 0.8, abs(cp2.z - 0.06) - 0.14);
        float dCanopy = min(cone1, cone2) + boughNoise * 0.65;

        // Blossom Tree glowing Tiberium spore pods
        if (subType == 18 || subType == 19) {
            float dSpore = length(cp - vec3(0.0, 0.0, 0.16)) - 0.15;
            if (dSpore < dCanopy && dSpore < dTrunk) {
                partMat = 23;
                partLocal = cp;
                return dSpore;
            }
        }

        float dMin = dCanopy;
        partMat = 27;
        partLocal = cp;
        if (dBaseRock < dMin) {
            dMin = dBaseRock;
            partMat = 28;
            partLocal = rel;
        }
        if (dTrunk < dMin) {
            dMin = dTrunk;
            partMat = 26;
            partLocal = tp;
        }
        return dMin;
    }

    // ------------------------------------------------------------------------
    // CATEGORY 5 & 6: 3D PROJECTILES, MISSILES & VOLUMETRIC EXPLOSIONS/FIRE
    // ------------------------------------------------------------------------
    partMat = 30;
    partLocal = rel;
    if (cat == 5) {
        vec2 bxy = rot2D(rel.xy, -d1.x);
        vec3 bp = vec3(bxy, rel.z);
        return sdCapsule(bp, vec3(0.0, -0.10, 0.0), vec3(0.0, 0.10, 0.0), 0.045);
    }
    // Category 6: Volumetric Explosion / Fireball sphere
    float rad = clamp(d1.w, 0.14, 0.75);
    return length(rel - vec3(0.0, 0.0, rad * 0.45)) - rad;
}

// ----------------------------------------------------------------------------
// 4K Armored Metal, Hex Rivets, CRT Glass & Tactical Cursor Helpers for HUD/UI
// ----------------------------------------------------------------------------
float sdTacticalCursor(vec2 p) {
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

vec3 fetchFB(vec2 uv) {
    uint idx = texture(uFrameIndex, clamp(uv, vec2(0.0005), vec2(0.9995))).r & 0xFFu;
    return uPalette.colors[idx].rgb;
}

// Evaluates a 3D recessed socket + hexagonal bolt head at centerPx (in 640x400 coords)
void addHexRivet(vec2 px, vec2 centerPx, float radPx, inout vec2 normalXY, inout float aoMult) {
    vec2 d = px - centerPx;
    float r = length(d);
    if (r < radPx * 1.45) {
        // Outer recessed socket ring
        float socketRing = smoothstep(radPx * 1.40, radPx * 0.95, r) * smoothstep(radPx * 0.65, radPx * 0.95, r);
        aoMult *= (1.0 - 0.55 * socketRing);
        if (r < radPx * 0.88) {
            // Raised domed hex bolt head
            vec2 domeN = (d / max(radPx * 0.88, 1e-3)) * 1.35;
            normalXY += domeN;
            aoMult *= mix(0.88, 1.08, smoothstep(radPx * 0.88, 0.0, r));
        }
    }
}

// Shades a 4K anisotropic brushed gunmetal/titanium plate with multi-light PBR specular
vec3 shadeArmoredMetalPlate(
    vec2 px,
    vec2 macroNormalXY,
    vec3 baseMetalAlbedo,
    float roughness,
    float aoMult,
    vec2 mouseUV,
    float time
) {
    // Multi-scale anisotropic brushed steel micro-grooves + battle wear
    float brushH = noise2D(px * vec2(1.6, 14.0)) * 0.65 + noise2D(px * vec2(5.5, 42.0)) * 0.35;
    float brushV = noise2D(px * vec2(14.0, 1.6)) * 0.50;
    float patina = fbm3(px * 0.14);
    float scratch = smoothstep(0.76, 0.92, noise2D(px * vec2(0.85, 3.4) + vec2(patina * 2.0)));

    vec2 microGrad = vec2(
        (noise2D(px * vec2(3.5, 18.0) + vec2(0.15, 0.0)) - brushH) * 0.55,
        (noise2D(px * vec2(3.5, 18.0) + vec2(0.0, 0.15)) - brushH) * 1.25
    );

    vec3 N = normalize(vec3(-macroNormalXY.x - microGrad.x * 0.35, -macroNormalXY.y - microGrad.y * 0.35, 1.0));
    vec3 V = vec3(0.0, 0.0, 1.0);

    vec3 albedo = baseMetalAlbedo * (0.82 + 0.28 * brushH + 0.08 * brushV) * (0.86 + 0.26 * patina);
    albedo += vec3(0.14, 0.15, 0.16) * scratch * 0.45;

    float specPow = mix(48.0, 12.0, clamp(roughness, 0.05, 0.95));

    // Light 1: Overhead Warm Battlefield Key Light (Upper-Left)
    vec3 L1 = normalize(vec3(-0.38, -0.58, 0.72));
    vec3 H1 = normalize(L1 + V);
    float diff1 = max(dot(N, L1), 0.0);
    float spec1 = pow(max(dot(N, H1), 0.0), specPow);

    // Light 2: Warm Furnace / Explosion Bounce Light (Lower-Left)
    vec3 L2 = normalize(vec3(-0.45, 0.52, 0.72));
    vec3 H2 = normalize(L2 + V);
    float diff2 = max(dot(N, L2), 0.0);
    float spec2 = pow(max(dot(N, H2), 0.0), specPow * 0.75);

    // Light 3: Emerald EVA CRT Phosphor Rim Light
    vec3 L3 = normalize(vec3(0.28, -0.25, 0.92));
    vec3 H3 = normalize(L3 + V);
    float spec3 = pow(max(dot(N, H3), 0.0), specPow);

    // Light 4: Live Interactive Mouse Cursor Point Light
    vec2 uvNow = px / vec2(640.0, 400.0);
    vec3 posM = vec3(mouseUV, 0.14);
    vec3 dirM = normalize(posM - vec3(uvNow, 0.0));
    float distM = length((posM.xy - uvNow) * vec2(1.6, 1.0));
    float attenM = exp(-distM * 6.0);
    vec3 HM = normalize(dirM + V);
    float specM = pow(max(dot(N, HM), 0.0), 38.0) * attenM;
    float diffM = max(dot(N, dirM), 0.0) * attenM;

    // Subtle animated battlefield ember sweep across beveled edges
    float bevelMag = clamp(length(macroNormalXY), 0.0, 1.5);
    float emberPulse = 0.75 + 0.25 * sin(time * 1.7 + px.x * 0.02);

    vec3 col = albedo * (0.28 + 0.58 * diff1 + 0.24 * diff2);
    col += vec3(1.0, 0.78, 0.52) * spec1 * (0.38 + 0.25 * scratch);
    col += vec3(1.0, 0.46, 0.16) * spec2 * 0.24 * emberPulse;
    col += vec3(0.22, 0.95, 0.48) * spec3 * 0.16;
    col += vec3(0.55, 0.98, 0.68) * (specM * 0.48 + diffM * 0.14);
    col += vec3(0.95, 0.62, 0.26) * bevelMag * 0.12 * emberPulse;

    return clamp(col * aoMult, 0.0, 1.0);
}

// ----------------------------------------------------------------------------
// 4K Procedural 3x5 Bitmap Font, Vector Icons & 3D Unit Portrait Studio
// ----------------------------------------------------------------------------
int getGlyphMask3x5(int ch) {
    // Uppercase ASCII fold
    if (ch >= 97 && ch <= 122) ch -= 32;
    switch (ch) {
        case 48: return 31599; // '0'
        case 49: return 11415; // '1'
        case 50: return 29671; // '2'
        case 51: return 29647; // '3'
        case 52: return 23497; // '4'
        case 53: return 31183; // '5'
        case 54: return 31215; // '6'
        case 55: return 29266; // '7'
        case 56: return 31727; // '8'
        case 57: return 31695; // '9'
        case 65: return 11245; // 'A'
        case 66: return 27566; // 'B'
        case 67: return 31015; // 'C'
        case 68: return 27502; // 'D'
        case 69: return 31207; // 'E'
        case 70: return 31204; // 'F'
        case 71: return 31087; // 'G'
        case 72: return 23533; // 'H'
        case 73: return 29847; // 'I'
        case 74: return 4719;  // 'J'
        case 75: return 23469; // 'K'
        case 76: return 18727; // 'L'
        case 77: return 24557; // 'M'
        case 78: return 24429; // 'N'
        case 79: return 31599; // 'O'
        case 80: return 31716; // 'P'
        case 81: return 31611; // 'Q'
        case 82: return 31661; // 'R'
        case 83: return 31183; // 'S'
        case 84: return 29842; // 'T'
        case 85: return 23407; // 'U'
        case 86: return 23402; // 'V'
        case 87: return 23549; // 'W'
        case 88: return 23213; // 'X'
        case 89: return 23186; // 'Y'
        case 90: return 29351; // 'Z'
        case 58: return 1040;  // ':'
        case 37: return 21157; // '%'
        case 47: return 4772;  // '/'
        case 43: return 1488;  // '+'
        case 45: return 448;   // '-'
        case 46: return 2;     // '.'
        default: return 0;
    }
}

float sampleGlyph3x5(int ch, vec2 relPx, float scale) {
    vec2 g = relPx / scale;
    if (g.x < 0.0 || g.x >= 3.0 || g.y < 0.0 || g.y >= 5.0) return 0.0;
    int ix = clamp(int(floor(g.x)), 0, 2);
    int iy = clamp(int(floor(g.y)), 0, 4);
    int mask = getGlyphMask3x5(ch);
    int bitIdx = (4 - iy) * 3 + (2 - ix);
    return float((mask >> bitIdx) & 1);
}

int unpackHudChar(int bankOffset, int charIdx) {
    if (charIdx < 0 || charIdx >= 32) return 0;
    int wordIdx = charIdx >> 2;
    int byteIdx = charIdx & 3;
    uint w = uTac.hud_chars[bankOffset + (wordIdx >> 2)][wordIdx & 3];
    return int((w >> uint(byteIdx * 8)) & 255u);
}

float drawHudPackedStr(vec2 px, vec2 originPx, int bankOffset, int maxChars, float scale) {
    vec2 rel = px - originPx;
    float stepX = 4.0 * scale;
    if (rel.x < 0.0 || rel.y < 0.0 || rel.y >= 5.0 * scale) return 0.0;
    int idx = int(floor(rel.x / stepX));
    if (idx < 0 || idx >= maxChars) return 0.0;
    int ch = unpackHudChar(bankOffset, idx);
    if (ch <= 32) return 0.0;
    return sampleGlyph3x5(ch, vec2(rel.x - float(idx) * stepX, rel.y), scale);
}

// Left-aligned positive integer renderer (up to 6 digits, with optional leading '+' sign)
float drawHudNumber(vec2 px, vec2 originPx, int val, bool showPlus, float scale) {
    vec2 rel = px - originPx;
    float stepX = 4.0 * scale;
    if (rel.x < 0.0 || rel.y < 0.0 || rel.y >= 5.0 * scale) return 0.0;

    int v = max(0, val);
    int digits[7];
    int count = 0;
    if (v == 0) {
        digits[0] = 48;
        count = 1;
    } else {
        int tmp = v;
        int rev[6];
        int rc = 0;
        for (int i = 0; i < 6; ++i) {
            if (tmp <= 0) break;
            rev[rc++] = 48 + (tmp % 10);
            tmp /= 10;
        }
        if (showPlus) {
            digits[count++] = 43; // '+'
        }
        for (int i = rc - 1; i >= 0; --i) {
            digits[count++] = rev[i];
        }
    }

    int idx = int(floor(rel.x / stepX));
    if (idx < 0 || idx >= count) return 0.0;
    return sampleGlyph3x5(digits[idx], vec2(rel.x - float(idx) * stepX, rel.y), scale);
}

// Ray-marches a live 3D close-up studio portrait of the selected unit/structure for the Bottom-Left HUD Card
vec3 renderUnitPortrait3D(vec2 uvBox, int selPackedType, float time) {
    // Background: overcast misty mountain horizon + gritty battlefield ground matching CnC-Ultra-Game.jpg
    float cliffLine = 0.42 + 0.08 * sin(uvBox.x * 4.5 + 0.6) + 0.04 * sin(uvBox.x * 11.0);
    vec3 skyBg = mix(vec3(0.56, 0.59, 0.62), vec3(0.36, 0.39, 0.43), clamp(uvBox.y * 1.9, 0.0, 1.0));
    float cliffN = noise2D(uvBox * vec2(18.0, 28.0));
    vec3 cliffBg = mix(vec3(0.24, 0.25, 0.24), vec3(0.34, 0.34, 0.32), cliffN);
    vec3 bgCol = mix(skyBg, cliffBg, smoothstep(cliffLine - 0.05, cliffLine + 0.05, uvBox.y));

    int cat = selPackedType & 7;
    int subType = (selPackedType >> 3) & 127;
    int houseId = (selPackedType >> 10) & 7;

    // Studio camera setup looking at origin (0, 0, 0.14) at a dramatic 3/4 side-front angle (CnC-Ultra-Game.jpg)
    // Zoom = 0.96 so the ENTIRE M1A2 Abrams tank fits cleanly inside the frame from front barrel to rear hull
    float zoom = (cat == 1) ? 1.50 : ((cat == 2) ? 0.58 : 0.96);
    vec2 pScreen = (uvBox - vec2(0.52, 0.58)) * vec2(1.0, -1.0) * zoom;

    vec3 camForward = normalize(vec3(-0.46, -0.82, -0.34));
    vec3 camRight   = normalize(cross(camForward, vec3(0.0, 0.0, 1.0)));
    vec3 camUp      = cross(camRight, camForward);

    vec3 target = vec3(0.0, 0.0, (cat == 1) ? 0.22 : ((cat == 2) ? 0.14 : 0.14));
    vec3 ro = target - camForward * 1.50 + camRight * pScreen.x + camUp * pScreen.y;
    vec3 rd = camForward;

    // Facing North-East/Front-Left (yaw ~ 0.72 rad) points the front glacis & 120mm cannon toward bottom-left
    float yaw = 0.72 + sin(time * 0.35) * 0.03;
    float turYaw = yaw - 0.12 + sin(time * 0.65) * 0.05;
    vec4 d0 = vec4(0.0, 0.0, 0.0, float(selPackedType));
    vec4 d1 = vec4(yaw, turYaw, 0.99, float(2 | (2 << 3)));

    float t = 0.65;
    int hitMat = 0;
    vec3 hitLoc = vec3(0.0);
    vec3 hitP = vec3(0.0);
    for (int i = 0; i < 28; ++i) {
        vec3 p = ro + rd * t;
        // Ground plinth plane at z = 0
        float dGround = p.z;
        int mId;
        vec3 lCoord;
        float dEnt = evaluateSingleEntitySDF(p, d0, d1, time, mId, lCoord);
        float d = min(dEnt, dGround);
        if (d < 0.0035) {
            hitP = p;
            if (dEnt <= dGround) {
                hitMat = mId;
                hitLoc = lCoord;
            } else {
                hitMat = 99; // Studio road/rock plinth
            }
            break;
        }
        t += max(d * 0.85, 0.005);
        if (t > 2.5) break;
    }

    if (hitMat == 0) return bgCol;

    if (hitMat == 99) {
        float distR = length(hitP.xy);
        float shadow = smoothstep(0.12, 0.48, distR);
        float nG = noise2D(hitP.xy * 18.0);
        vec3 plinth = mix(vec3(0.20, 0.20, 0.19), vec3(0.30, 0.29, 0.27), nG) * (0.28 + 0.72 * shadow);
        return mix(plinth, bgCol, smoothstep(0.42, 0.86, distR));
    }

    float eps = 0.004;
    int dm;
    vec3 dl;
    float d00 = evaluateSingleEntitySDF(hitP, d0, d1, time, dm, dl);
    vec3 N = normalize(vec3(
        evaluateSingleEntitySDF(hitP + vec3(eps, 0.0, 0.0), d0, d1, time, dm, dl) - d00,
        evaluateSingleEntitySDF(hitP + vec3(0.0, eps, 0.0), d0, d1, time, dm, dl) - d00,
        evaluateSingleEntitySDF(hitP + vec3(0.0, 0.0, eps), d0, d1, time, dm, dl) - d00
    ));

    // Weathered grey-olive military steel for studio portrait (matching CnC-Ultra-Game.jpg)
    vec3 studioSteel = (houseId == 1) ? vec3(0.32, 0.26, 0.25) : vec3(0.36, 0.37, 0.34);
    float grit = noise2D(hitLoc.xy * 32.0 + hitLoc.z * 18.0);
    float seam = smoothstep(0.44, 0.49, abs(fract(hitLoc.y * 6.5) - 0.5));
    vec3 alb = studioSteel * (0.86 + 0.28 * grit) * (1.0 - 0.28 * seam);
    if (hitMat == 20) {
        // 6 distinct road-wheels, hubs & steel track grousers inside track pods
        float wheelSpacing = (fract((hitLoc.y + 0.32) * 9.2) - 0.5) / 9.2;
        float wheelR = length(vec2(wheelSpacing, hitLoc.z - 0.048));
        float isWheel = smoothstep(0.044, 0.033, wheelR);
        float isRim   = smoothstep(0.033, 0.025, wheelR) * (1.0 - smoothstep(0.022, 0.014, wheelR));
        float isHub   = smoothstep(0.014, 0.008, wheelR);
        float treadBar = step(0.45, fract((hitLoc.y + hitLoc.z) * 24.0));
        alb = mix(vec3(0.11, 0.12, 0.13), vec3(0.22, 0.23, 0.24), treadBar);
        alb = mix(alb, studioSteel * 0.78, isWheel);
        alb = mix(alb, studioSteel * 1.05, isRim);
        alb = mix(alb, vec3(0.07, 0.08, 0.09), isHub);
    }
    else if (hitMat == 22) alb = mix(studioSteel * 0.92, vec3(0.38, 0.40, 0.42), 0.35) * (0.88 + 0.24 * grit);
    else if (hitMat == 23) alb = vec3(0.18, 0.92, 0.38);
    else if (hitMat == 24) alb = vec3(0.36, 0.37, 0.38);

    vec3 Lkey = normalize(vec3(-0.52, -0.45, 0.72));
    vec3 Lrim = normalize(vec3(0.68, 0.42, 0.58));
    vec3 V = -rd;
    vec3 H = normalize(Lkey + V);

    float diff = max(dot(N, Lkey), 0.0);
    float rim  = max(dot(N, Lrim), 0.0);
    float spec = pow(max(dot(N, H), 0.0), 36.0);

    vec3 col = alb * (0.34 + 0.85 * diff + 0.32 * rim) + vec3(0.95, 0.96, 0.98) * spec * 0.46;
    if (hitMat == 23) col += vec3(0.12, 0.85, 0.32) * 0.65;
    return clamp(col, 0.0, 1.0);
}

// ----------------------------------------------------------------------------
// Main Native-4K 3D Tactical Battlefield & UI Compositor
// ----------------------------------------------------------------------------
void main() {
    float time = uTac.view_params0.x;
    vec4 tacRect = vec4(uTac.view_params0.y, uTac.view_params0.z, uTac.view_params0.w, uTac.view_params1.x);
    float fade = clamp(uTac.view_params3.w, 0.0, 1.0);

    // 1. Check if pixel is in Right Sidebar, Modal Dialog Box, or Tooltip Box
    // Extend 3D battlefield all the way to the top edge (vUV.y >= 0.0) and full right edge when sidebar is closed
    float tacRight = (tacRect.z > 0.95) ? 1.0 : tacRect.z;
    bool inTacViewport = (vUV.x >= tacRect.x && vUV.x < tacRight && vUV.y < tacRect.w);

    vec4 dlgRect = uTac.overlay_rects[1];
    bool inDialog = (dlgRect.z > dlgRect.x && vUV.x >= dlgRect.x && vUV.x <= dlgRect.z && vUV.y >= dlgRect.y && vUV.y <= dlgRect.w);

    vec4 tipRect = uTac.overlay_rects[2];
    bool inTooltip = (tipRect.z > tipRect.x && vUV.x >= tipRect.x && vUV.x <= tipRect.z && vUV.y >= tipRect.y && vUV.y <= tipRect.w);

    vec4 curRect = uTac.overlay_rects[3];
    vec2 mouseUV = clamp(curRect.xy, vec2(0.0), vec2(1.0));

    // Sample 8-bit software framebuffer for UI / HUD / Dialogs / Messages / Cursor
    uint palIdx = texture(uFrameIndex, vUV).r & 0xFFu;
    vec3 fbColor = uPalette.colors[palIdx].rgb;

    // Top rows of tactical view: check if multiplayer/system message text is drawn (packed in fract(view_params3.z))
    float msgV1 = fract(uTac.view_params3.z);
    bool inMsgText = (inTacViewport && msgV1 > 0.001 && vUV.y >= tacRect.y && vUV.y < msgV1 && palIdx != 0u && palIdx != 12u);

    if (!inTacViewport || inDialog || inTooltip || inMsgText) {
        vec2 px = vUV * vec2(640.0, 400.0);
        vec2 stepUV = vec2(1.0 / 640.0, 1.0 / 400.0);
        vec3 fbE = fetchFB(vUV + vec2( stepUV.x, 0.0));
        vec3 fbW = fetchFB(vUV + vec2(-stepUV.x, 0.0));
        vec3 fbS = fetchFB(vUV + vec2(0.0,  stepUV.y));
        vec3 fbN = fetchFB(vUV + vec2(0.0, -stepUV.y));

        float lum  = dot(fbColor, vec3(0.299, 0.587, 0.114));
        float lumE = dot(fbE, vec3(0.299, 0.587, 0.114));
        float lumW = dot(fbW, vec3(0.299, 0.587, 0.114));
        float lumS = dot(fbS, vec3(0.299, 0.587, 0.114));
        float lumN = dot(fbN, vec3(0.299, 0.587, 0.114));

        float greenDom = fbColor.g - max(fbColor.r, fbColor.b);
        float greenNeighbor = max(
            max(fbE.g - max(fbE.r, fbE.b), fbW.g - max(fbW.r, fbW.b)),
            max(fbS.g - max(fbS.r, fbS.b), fbN.g - max(fbN.r, fbN.b))
        );
        float chroma = max(fbColor.r, max(fbColor.g, fbColor.b)) - min(fbColor.r, min(fbColor.g, fbColor.b));
        bool isNeutralStone = (chroma < 0.095 && greenDom < 0.045 && lum > 0.035 && lum < 0.62);
        float crtScan = 0.92 + 0.08 * sin(vUV.y * 1600.0 * PI);

        // Extract 3D micro-bevel normal from legacy UI button/panel highlights & shadows
        vec2 fbGrad = vec2(lumE - lumW, lumS - lumN);
        vec3 uiCol = fbColor;

        // ====================================================================
        // A. IN-GAME MODAL COMMAND MENUS & DIALOGS (Options, Controls, Load/Save)
        // ====================================================================
        if (inDialog) {
            vec2 dMinPx = dlgRect.xy * vec2(640.0, 400.0);
            vec2 dMaxPx = dlgRect.zw * vec2(640.0, 400.0);
            vec2 dEdgePx = min(px - dMinPx, dMaxPx - px);
            float edgePx = min(dEdgePx.x, dEdgePx.y);

            vec2 plateN = fbGrad * 2.2;
            float ao = 1.0;

            // Outer 8-px heavy machined titanium armor bezel around the dialog
            if (edgePx < 8.5) {
                vec2 outDir = vec2(
                    (px.x - dMinPx.x < dMaxPx.x - px.x) ? -1.0 : 1.0,
                    (px.y - dMinPx.y < dMaxPx.y - px.y) ? -1.0 : 1.0
                );
                vec2 maskEdge = step(dEdgePx.xy, dEdgePx.yx);
                if (edgePx < 3.5) {
                    plateN = outDir * maskEdge * 1.45;
                } else if (edgePx > 5.5) {
                    plateN = -outDir * maskEdge * 1.25;
                }
                // Seam groove at edgePx == 7.5
                float groove = exp(-pow((edgePx - 7.5) * 2.2, 2.0));
                ao *= (1.0 - 0.65 * groove);
            }

            // Recessed header bar seam below dialog caption
            float headerY = dMinPx.y + 28.0;
            if (abs(px.y - headerY) < 1.8 && edgePx >= 8.0) {
                plateN.y += (px.y < headerY) ? 0.9 : -0.9;
                ao *= 0.62;
            }

            // 8 Corner + Mid-Rail Hex Bolts on the Dialog Armor Frame
            addHexRivet(px, dMinPx + vec2(5.0, 5.0), 2.4, plateN, ao);
            addHexRivet(px, vec2(dMaxPx.x - 5.0, dMinPx.y + 5.0), 2.4, plateN, ao);
            addHexRivet(px, vec2(dMinPx.x + 5.0, dMaxPx.y - 5.0), 2.4, plateN, ao);
            addHexRivet(px, dMaxPx - vec2(5.0, 5.0), 2.4, plateN, ao);
            if (dMaxPx.y - dMinPx.y > 120.0) {
                float midY = 0.5 * (dMinPx.y + dMaxPx.y);
                addHexRivet(px, vec2(dMinPx.x + 5.0, midY), 2.2, plateN, ao);
                addHexRivet(px, vec2(dMaxPx.x - 5.0, midY), 2.2, plateN, ao);
            }

            vec3 metalChassis = shadeArmoredMetalPlate(
                px, plateN, vec3(0.14, 0.16, 0.175), 0.34, ao, mouseUV, time
            );

            if (edgePx < 7.0) {
                // Outer machined titanium frame
                uiCol = metalChassis;
                // Glowing emerald inner seal line along edgePx == 6.8
                float sealGlow = exp(-pow((edgePx - 6.8) * 2.5, 2.0));
                uiCol += vec3(0.18, 0.88, 0.42) * sealGlow * 0.55;
            } else if (isNeutralStone) {
                // Convert 1995 BTEXTURE.SHP gray pebble fill into 4K brushed gunmetal armor & 3D beveled buttons
                float btnRelief = clamp((lum - 0.25) * 1.4, -0.25, 0.35);
                uiCol = metalChassis * (0.88 + 0.35 * btnRelief);
                // Add subtle phosphor bloom around neighboring green text/borders
                if (greenNeighbor > 0.06) {
                    uiCol += vec3(0.08, 0.42, 0.18) * greenNeighbor * 0.55;
                }
            } else if (lum <= 0.04) {
                // Recessed Listboxes, Savegame Slots & Slider Tracks -> Smoked Emerald CRT Glass
                float refresh = exp(-pow(( fract(vUV.y * 2.0 - time * 0.25) - 0.5) * 8.0, 2.0));
                uiCol = vec3(0.018, 0.058, 0.030) * crtScan + vec3(0.04, 0.16, 0.08) * refresh * 0.25;
                if (greenNeighbor > 0.05) {
                    uiCol += vec3(0.10, 0.48, 0.22) * greenNeighbor * 0.65;
                }
            } else if (greenDom >= 0.045) {
                // C&C Green Typography, Captions, Sliders & Button Borders -> Luminous 4K Emerald Phosphor
                uiCol = fbColor * crtScan * 1.28 + vec3(0.08, 0.38, 0.16) * greenDom;
            } else {
                // Gold/White Highlights, Filigree & Selected Text -> Polished Ion-Gold / Titanium
                uiCol = mix(metalChassis, fbColor * 1.18, 0.82) + vec3(0.12, 0.10, 0.06) * clamp(lum - 0.4, 0.0, 0.6);
            }
        }
        // ====================================================================
        // B. TOP EVA COMMAND TAB BAR (OPTIONS | CONDUIT | CREDITS | SIDEBAR)
        // ====================================================================
        else if (!inTacViewport && px.y < 16.5) {
            vec2 plateN = fbGrad * 1.8;
            float ao = 1.0;

            // 4 modular bays: [0..160) Options, [160..320) Conduit, [320..480) Credits, [480..640) Sidebar
            float bayX = mod(px.x, 160.0);
            float bayEdgeX = min(bayX, 160.0 - bayX);
            float bayEdgeY = min(px.y, 15.5 - px.y);
            float bayEdge = min(bayEdgeX, bayEdgeY);

            if (bayEdge < 2.2) {
                plateN.x += (bayX < 80.0) ? -1.1 : 1.1;
                plateN.y += (px.y < 8.0) ? -1.2 : 1.2;
                ao *= smoothstep(0.0, 1.5, bayEdge) * 0.5 + 0.5;
            }

            // Corner hex rivets on the 4 overhead modules
            float modOriginX = floor(px.x / 160.0) * 160.0;
            addHexRivet(px, vec2(modOriginX + 7.0, 7.5), 1.8, plateN, ao);
            addHexRivet(px, vec2(modOriginX + 153.0, 7.5), 1.8, plateN, ao);

            // Center Conduit [160..320) horizontal cooling ribs
            if (px.x >= 160.0 && px.x < 320.0 && bayEdge >= 2.2) {
                float rib = sin(px.y * 2.1);
                plateN.y += rib * 0.65;
                ao *= (0.78 + 0.22 * rib);
            }

            vec3 tabMetal = shadeArmoredMetalPlate(
                px, plateN, vec3(0.15, 0.17, 0.185), 0.32, ao, mouseUV, time
            );

            // Recessed Digital CRT Screen for Credits Counter [334..466, 2..13.5]
            bool inCreditsScreen = (px.x >= 334.0 && px.x <= 466.0 && px.y >= 2.0 && px.y <= 13.5);

            if (inCreditsScreen) {
                if (greenDom > 0.03 || lum > 0.25) {
                    // Glowing emerald/gold digital credit numerals
                    uiCol = fbColor * 1.32 + vec3(0.08, 0.42, 0.18) * max(greenDom, 0.15);
                } else {
                    // Recessed dark emerald CRT glass bay
                    uiCol = vec3(0.015, 0.052, 0.026) * crtScan;
                    if (greenNeighbor > 0.04) {
                        uiCol += vec3(0.08, 0.38, 0.16) * greenNeighbor * 0.65;
                    }
                }
            } else if (greenDom > 0.04 || (lum > 0.38 && !isNeutralStone)) {
                // OPTIONS / SIDEBAR glowing typography
                uiCol = fbColor * 1.25 + vec3(0.08, 0.36, 0.15) * max(greenDom, 0.1);
            } else {
                uiCol = tabMetal;
                if (greenNeighbor > 0.04) {
                    uiCol += vec3(0.08, 0.38, 0.16) * greenNeighbor * 0.5;
                }
            }
        }
        // ====================================================================
        // C. RIGHT TACTICAL MINIMAP & DARK-SLATE COMMAND DOCK (CnC-Ultra-Game.jpg)
        // ====================================================================
        else if (!inTacViewport && px.x >= 479.5) {
            vec2 plateN = fbGrad * 1.4;
            float ao = 1.0;

            // Sleek Dark Charcoal-Slate (#16191d) & Brushed Gunmetal Border (#383e44) palette
            vec3 slateBg     = vec3(0.086, 0.098, 0.114);
            vec3 slateSlot   = vec3(0.110, 0.125, 0.145);
            vec3 slateBorder = vec3(0.220, 0.245, 0.275);

            // Outer left metallic frame line along x = 480..481.5
            if (px.x < 481.8) {
                uiCol = slateBorder * 1.15;
            }
            // 1. TOP-RIGHT FRAMED TACTICAL MINIMAP (y in [0, 155))
            else if (px.y < 155.0) {
                bool inRadarScreen = (px.x >= 492.0 && px.x < 628.0 && px.y >= 17.0 && px.y < 149.0);
                vec2 rBox = max(vec2(492.0 - px.x, 17.0 - px.y), vec2(px.x - 628.0, px.y - 149.0));
                float dScreen = length(max(rBox, vec2(0.0)));

                if (inRadarScreen) {
                    vec2 rUV = (px - vec2(492.0, 17.0)) / vec2(136.0, 132.0);
                    float rEdge = min(min(rUV.x, 1.0 - rUV.x) * 136.0, min(rUV.y, 1.0 - rUV.y) * 132.0);
                    float innerShadow = smoothstep(0.0, 3.0, rEdge);

                    // Subtle tactical grid & coastal satellite map aesthetic
                    vec2 gridF = abs(fract(rUV * 6.0) - 0.5);
                    float reticle = smoothstep(0.47, 0.50, max(gridF.x, gridF.y)) * 0.07;
                    float mapTopo = fbm3(rUV * 7.5 + vec2(2.1, 4.7));
                    vec3 satCoast = mix(
                        vec3(0.035, 0.110, 0.165),
                        mix(vec3(0.18, 0.21, 0.15), vec3(0.28, 0.26, 0.22), smoothstep(0.45, 0.75, mapTopo)),
                        smoothstep(0.36, 0.52, mapTopo)
                    );

                    if (isNeutralStone || lum <= 0.035) {
                        uiCol = satCoast + vec3(0.12, 0.20, 0.24) * reticle;
                    } else {
                        uiCol = mix(satCoast, fbColor * 1.18, 0.85);
                    }
                    // Crisp white camera viewport rectangle indicator on minimap
                    vec2 vBox = abs(rUV - vec2(0.48, 0.52)) - vec2(0.18, 0.14);
                    float dCamBox = abs(max(vBox.x, vBox.y));
                    if (dCamBox < 0.012) {
                        uiCol = mix(uiCol, vec3(0.88, 0.92, 0.96), 0.75);
                    }
                    uiCol *= (0.65 + 0.35 * innerShadow);
                } else if (dScreen < 1.8) {
                    uiCol = slateBorder * 1.25;
                } else {
                    uiCol = shadeArmoredMetalPlate(px, plateN * 0.6, slateBg, 0.38, 0.92, mouseUV, time);
                    // Top-Right OPTIONS / MENU header caption in [y < 14]
                    if (px.y < 14.0 && (greenDom > 0.04 || (lum > 0.35 && !isNeutralStone))) {
                        uiCol = vec3(0.82, 0.86, 0.90);
                    }
                }
            }
            // 2. MIDDLE TACTICAL COMMAND STRIP (Repair, Sell, Map: y in [155, 180))
            else if (px.y < 180.0) {
                bool inBtn1 = (px.x >= 484.0 && px.x < 533.0 && px.y >= 158.0 && px.y < 177.0);
                bool inBtn2 = (px.x >= 537.0 && px.x < 586.0 && px.y >= 158.0 && px.y < 177.0);
                bool inBtn3 = (px.x >= 590.0 && px.x < 638.0 && px.y >= 158.0 && px.y < 177.0);

                if (inBtn1 || inBtn2 || inBtn3) {
                    float bx0 = inBtn1 ? 484.0 : (inBtn2 ? 537.0 : 590.0);
                    vec2 bMin = vec2(bx0, 158.0);
                    vec2 bMax = vec2(bx0 + 48.0, 177.0);
                    vec2 bEdge = min(px - bMin, bMax - px);
                    float edgeD = min(bEdge.x, bEdge.y);
                    if (edgeD < 1.3) {
                        uiCol = slateBorder * 1.2;
                    } else {
                        vec3 btnMetal = shadeArmoredMetalPlate(px, plateN * 0.5, slateSlot, 0.35, 0.95, mouseUV, time);
                        if (!isNeutralStone && lum > 0.08) {
                            uiCol = mix(btnMetal, vec3(0.78, 0.82, 0.86) * clamp(lum * 1.6, 0.3, 1.0), 0.78);
                        } else {
                            uiCol = btnMetal;
                        }
                    }
                } else {
                    uiCol = shadeArmoredMetalPlate(px, plateN * 0.4, slateBg * 0.85, 0.42, 0.88, mouseUV, time);
                }
            }
            // 3. LOWER COMMAND & PRODUCTION DOCK (y in [180, 400))
            else {
                // Left Tactical Power Bar (x in [480, 496))
                if (px.x < 496.0) {
                    bool inTube = (px.x >= 484.0 && px.x <= 492.0 && px.y >= 184.0 && px.y <= 395.0);
                    if (inTube) {
                        float cylNx = (px.x - 488.0) / 4.0;
                        float tick = step(0.35, fract(px.y * 0.25));
                        if (!isNeutralStone && (chroma > 0.12 || greenDom > 0.04) && lum > 0.10) {
                            uiCol = mix(vec3(0.18, 0.82, 0.36), fbColor * 1.25, 0.5) * (0.8 + 0.2 * tick) * (1.0 - 0.2 * cylNx * cylNx);
                        } else {
                            uiCol = slateBg * 0.75 + vec3(0.05, 0.08, 0.07) * tick;
                        }
                    } else {
                        uiCol = shadeArmoredMetalPlate(px, plateN * 0.4, slateBg, 0.38, 0.92, mouseUV, time);
                    }
                }
                // Production & Command Grid Bays (Column 0: [500..564), Column 1: [568..632))
                else {
                    bool inCol0 = (px.x >= 500.0 && px.x < 564.0);
                    bool inCol1 = (px.x >= 568.0 && px.x < 632.0);

                    if ((inCol0 || inCol1) && px.y >= 181.0 && px.y < 373.0) {
                        float colX0 = inCol0 ? 500.0 : 568.0;
                        float slotX = px.x - colX0;
                        float slotY = mod(px.y - 181.0, 48.0);
                        int rowIdx  = int(floor((px.y - 181.0) / 48.0));
                        int colIdx  = inCol0 ? 0 : 1;
                        float slotEdge = min(min(slotX, 64.0 - slotX), min(slotY, 48.0 - slotY));

                        if (slotEdge < 1.3) {
                            // Crisp thin metallic border matching CnC-Ultra-Game.jpg
                            uiCol = slateBorder * 1.18;
                        } else {
                            float neighborVar = abs(lumE - lumW) + abs(lumS - lumN);
                            if (isNeutralStone && neighborVar < 0.14) {
                                // Empty Command/Production Slot -> Sleek Dark-Slate Card with Crisp Vector Command Glyph
                                uiCol = shadeArmoredMetalPlate(px, vec2(0.0), slateSlot, 0.40, 0.92, mouseUV, time);
                                vec2 cUV = (vec2(slotX, slotY) - vec2(32.0, 24.0)) / 14.0;
                                float iconMask = 0.0;
                                int iconId = rowIdx * 2 + colIdx;
                                if (iconId == 0) {
                                    // Crossed Swords / Attack Move
                                    float d1 = abs(cUV.x - cUV.y);
                                    float d2 = abs(cUV.x + cUV.y);
                                    iconMask = smoothstep(0.14, 0.05, min(d1, d2)) * step(max(abs(cUV.x), abs(cUV.y)), 0.75);
                                } else if (iconId == 1) {
                                    // Shield / Defend Position
                                    float dS = length(cUV * vec2(1.1, 0.9)) - 0.65;
                                    iconMask = smoothstep(0.10, 0.02, abs(dS));
                                } else if (iconId == 2) {
                                    // Radar / Patrol Reticle
                                    float r = length(cUV);
                                    iconMask = smoothstep(0.09, 0.02, abs(r - 0.62)) + smoothstep(0.08, 0.02, min(abs(cUV.x), abs(cUV.y))) * step(r, 0.78);
                                } else if (iconId == 3) {
                                    // Wrench / Engineering
                                    float dBar = abs(cUV.x + cUV.y * 0.8);
                                    iconMask = smoothstep(0.16, 0.06, dBar) * step(length(cUV), 0.72);
                                } else {
                                    // Chevron / Tactical Formation
                                    float dC = abs(abs(cUV.x) * 0.85 + cUV.y - 0.15);
                                    iconMask = smoothstep(0.14, 0.04, dC) * step(abs(cUV.x), 0.68);
                                }
                                uiCol = mix(uiCol, vec3(0.46, 0.50, 0.55), clamp(iconMask, 0.0, 1.0) * 0.65);
                            } else {
                                // Active Unit / Building Cameo Icon in Dark-Slate Frame
                                float vignette = smoothstep(0.0, 5.0, slotEdge);
                                vec3 cameoCol = fbColor * (0.95 + 0.18 * vignette);
                                if (greenDom > 0.05) {
                                    cameoCol = vec3(0.88, 0.94, 0.90);
                                }
                                uiCol = clamp(cameoCol, 0.0, 1.0);
                            }
                        }
                    }
                    // Scroll Up / Down Rocker Buttons (y in [374, 399))
                    else if ((inCol0 || inCol1) && px.y >= 374.0 && px.y < 399.0) {
                        float colX0 = inCol0 ? 500.0 : 568.0;
                        float btnX = mod(px.x - colX0, 32.0);
                        float btnY = px.y - 374.0;
                        float bEdge = min(min(btnX, 32.0 - btnX), min(btnY, 25.0 - btnY));
                        if (bEdge < 1.3) {
                            uiCol = slateBorder * 1.18;
                        } else {
                            vec3 rockerMetal = shadeArmoredMetalPlate(px, plateN * 0.4, slateSlot, 0.36, 0.92, mouseUV, time);
                            if (!isNeutralStone && lum > 0.12) {
                                uiCol = mix(rockerMetal, vec3(0.75, 0.80, 0.85), 0.65);
                            } else {
                                uiCol = rockerMetal;
                            }
                        }
                    } else {
                        uiCol = shadeArmoredMetalPlate(px, vec2(0.0), slateBg, 0.40, 0.90, mouseUV, time);
                    }
                }
            }
        }
        // ====================================================================
        // D. TACTICAL TOOLTIPS & SYSTEM MESSAGES
        // ====================================================================
        else if (inTooltip) {
            vec2 tMinPx = tipRect.xy * vec2(640.0, 400.0);
            vec2 tMaxPx = tipRect.zw * vec2(640.0, 400.0);
            vec2 tEdge = min(px - tMinPx, tMaxPx - px);
            float edgePx = min(tEdge.x, tEdge.y);
            if (edgePx < 1.5) {
                uiCol = vec3(0.28, 0.92, 0.48);
            } else if (lum <= 0.08) {
                uiCol = vec3(0.02, 0.06, 0.032) * crtScan;
            } else {
                uiCol = fbColor * 1.22;
            }
        }

        // Composite Native-4K Glowing Phosphor Tactical Arrow Cursor on top of UI/Panels/Menus
        if (curRect.x > 0.0 || curRect.y > 0.0) {
            vec2 cRel = (vUV - mouseUV) * vec2(640.0, 400.0) / 15.0;
            if (cRel.x >= -0.35 && cRel.x <= 1.15 && cRel.y >= -0.35 && cRel.y <= 1.35) {
                float dCur = sdTacticalCursor(cRel);
                float outline = smoothstep(0.075, 0.015, abs(dCur));
                float fill = smoothstep(0.02, -0.04, dCur);
                float glow = exp(-max(dCur, 0.0) * 8.0);

                uiCol = mix(uiCol, vec3(0.08, 0.26, 0.13), fill * 0.82);
                uiCol = mix(uiCol, vec3(0.68, 1.0, 0.62), outline * 0.96);
                uiCol += vec3(0.22, 0.90, 0.42) * glow * 0.42;
            }
        }

        outColor = vec4(clamp(uiCol, 0.0, 1.0) * fade, 1.0);
        return;
    }

    // ------------------------------------------------------------------------
    // 2. Compute Exact World-Cell Coordinates in the 3D Tactical Viewport
    //    Supports Mode 0 (Default & 3D Orbital Zoom / 360-Spin / Arc-Tilt)
    //    and Mode 1 (Ground-Level First-Person Unit Possession)
    // ------------------------------------------------------------------------
    vec2 tacUV = (vUV - tacRect.xy) / max(tacRect.zw - tacRect.xy, vec2(1e-4));
    vec2 subCell = uTac.view_params1.yz;
    vec2 cellsSpan = vec2(uTac.view_params1.w, uTac.view_params2.x);
    vec2 originCell = uTac.view_params2.yz;
    int theater = int(floor(uTac.view_params2.w + 0.5));

    vec4 camParams = uTac.light_pos_rad[31]; // (camYaw, camPitch, camZoom, camMode)
    vec4 fpParams  = uTac.light_col_int[31]; // (fpEyeX, fpEyeY, fpEyeZ, fpEntIdx + fpWeaponKind * 0.1)
    float camYaw   = camParams.x;
    bool isFirstPerson = (camParams.w > 0.5);
    float camPitch = isFirstPerson ? clamp(camParams.y, -0.55, 0.65)
                                   : ((camParams.z > 0.05) ? clamp(camParams.y, 0.14, 1.52) : 0.98);
    float camZoom  = (camParams.z > 0.05) ? clamp(camParams.z, 0.25, 2.25) : 1.0;
    bool isCam3D   = isFirstPerson || (abs(camZoom - 1.0) > 0.005) || (abs(camYaw) > 0.005) || (abs(camPitch - 0.98) > 0.015);
    int fpEntIdx   = isFirstPerson ? int(floor(fpParams.w + 0.01)) : -1;
    int fpWeaponKind = isFirstPerson ? int(floor(fract(fpParams.w) * 10.0 + 0.5)) : 0;

    bool isShowcase = (uTac.hud_telemetry[0].x == 3200.0 && uTac.hud_telemetry[0].y == 2100.0);
    vec2 perspUV = isShowcase ? vec2(
        0.5 + (tacUV.x - 0.5) * mix(1.18, 0.92, vUV.y),
        pow(clamp(vUV.y, 0.0005, 1.0), 0.86)
    ) : tacUV;

    vec2 groundCellXY = subCell + perspUV * cellsSpan;
    vec3 V = normalize(vec3(-0.20, 0.78, 0.59));
    float orbitalHorizonMix = 0.0;

    if (isCam3D && !isFirstPerson) {
        // 3D Orbital Camera: Zoom + Vertical Arc Pitch Perspective Foreshortening + 360-Degree Yaw Spin
        float du = tacUV.x - 0.5;
        float dv = tacUV.y - 0.5;
        float tiltFactor = clamp((0.98 - camPitch) * 0.72, -0.32, 0.58);
        float denom = max(0.22, 1.0 + dv * tiltFactor);
        float perspX = (du * camZoom) / denom;
        float pitchScaleY = 1.0 / clamp(sin(camPitch) / 0.8305, 0.34, 1.25);
        float perspY = ((dv * camZoom) / denom) * pitchScaleY;
        vec2 worldSpan = vec2(perspX, perspY) * cellsSpan;
        float cYaw = cos(camYaw);
        float sYaw = sin(camYaw);
        vec2 rotSpan = vec2(worldSpan.x * cYaw - worldSpan.y * sYaw, worldSpan.x * sYaw + worldSpan.y * cYaw);
        groundCellXY = subCell + vec2(0.5) * cellsSpan + rotSpan;

        // Rotate & tilt 3D camera ray vector V along the orbital arc
        vec2 baseHoriz = normalize(vec2(-0.20, 0.78));
        vec2 rotHoriz = vec2(baseHoriz.x * cYaw - baseHoriz.y * sYaw, baseHoriz.x * sYaw + baseHoriz.y * cYaw);
        float elev = clamp(camPitch * 0.65, 0.22, 1.38);
        V = normalize(vec3(rotHoriz * cos(elev), sin(elev)));

        // When tilted to low ground-grazing angles, blend far upper horizon into the 3D sky dome
        if (camPitch < 0.48) {
            float horizonStart = clamp((0.48 - camPitch) * 0.75, 0.0, 0.28);
            orbitalHorizonMix = smoothstep(horizonStart, max(0.001, horizonStart - 0.14), tacUV.y);
        }
    }

    vec2 globalCellXY = originCell + groundCellXY;

    // First-Person Ground-Level Pinhole Camera Ray Construction & 3D Terrain Ray-March
    vec3 fpEye = vec3(0.0);
    vec3 fpRayDir = vec3(0.0, -1.0, 0.0);
    bool fpHitGround = true;
    float fpGroundT = 22.0;

    if (isFirstPerson) {
        vec4 fpTerrFields;
        float fpBaseGroundZ = evaluateTerrainHeight(fpParams.xy, originCell + fpParams.xy, fpTerrFields);
        fpEye = vec3(fpParams.xy, max(fpBaseGroundZ, 0.0) + max(fpParams.z, 0.22));
        vec3 fpFwd   = normalize(vec3(sin(camYaw) * cos(camPitch), -cos(camYaw) * cos(camPitch), sin(camPitch)));
        vec3 fpRight = vec3(cos(camYaw), sin(camYaw), 0.0);
        vec3 fpUp    = cross(fpFwd, fpRight);
        float fovScale = clamp(camZoom, 0.45, 1.45);
        vec2 ndc = vec2((tacUV.x - 0.5) * 1.55, (0.5 - tacUV.y) * 1.05) * fovScale;
        fpRayDir = normalize(fpFwd + fpRight * ndc.x + fpUp * ndc.y);
        V = -fpRayDir;

        fpHitGround = false;
        float t = 0.18;
        for (int s = 0; s < 48; ++s) {
            vec3 p = fpEye + fpRayDir * t;
            if (p.z > 2.65 && fpRayDir.z > 0.0) break;
            vec4 tf;
            float gridFade = smoothstep(0.0, 2.5, min(min(p.x, 29.0 - p.x), min(p.y, 19.0 - p.y)));
            float h = evaluateTerrainHeight(p.xy, originCell + p.xy, tf) * gridFade;
            float diff = p.z - h;
            if (diff < 0.008) {
                float tLo = max(0.18, t - max(0.05, t * 0.06));
                float tHi = t;
                for (int b = 0; b < 4; ++b) {
                    float tMid = 0.5 * (tLo + tHi);
                    vec3 pMid = fpEye + fpRayDir * tMid;
                    float hMid = evaluateTerrainHeight(pMid.xy, originCell + pMid.xy, tf);
                    if (pMid.z < hMid) tHi = tMid; else tLo = tMid;
                }
                fpGroundT = 0.5 * (tLo + tHi);
                fpHitGround = true;
                break;
            }
            t += max(diff * 0.55, 0.05 + t * 0.032);
            if (t > 22.0) break;
        }
        groundCellXY = fpEye.xy + fpRayDir.xy * (fpHitGround ? fpGroundT : 16.0);
        globalCellXY = originCell + groundCellXY;
    }

    vec3 L = normalize(vec3(-0.58, -0.42, 0.69)); // Warm directional sun from NW
    vec3 H = normalize(V + L);

    // ------------------------------------------------------------------------
    // 3. Ray-March 3D Terrain Relief (Heightfield Displacement + Cliffs + Craters)
    // ------------------------------------------------------------------------
    vec4 terrainFields;
    vec2 camStepXY = V.xy / max(V.z, 0.36);
    float hGround = evaluateTerrainHeight(groundCellXY, globalCellXY, terrainFields);
    vec2 displacedCellXY = groundCellXY;
    vec2 displacedGlobalXY = globalCellXY;
    if (!isFirstPerson && (isShowcase || isCam3D)) {
        // 5-step iterative terrain relief refinement along 3D perspective camera ray
        float reliefScale = isShowcase ? 0.92 : clamp((1.22 - camPitch) * 0.95, 0.15, 0.95);
        for (int rStep = 0; rStep < 5; ++rStep) {
            displacedCellXY = groundCellXY + camStepXY * (hGround * reliefScale);
            displacedGlobalXY = originCell + displacedCellXY;
            hGround = mix(hGround, evaluateTerrainHeight(displacedCellXY, displacedGlobalXY, terrainFields), 0.72);
        }
    }

    vec3 terrainPos = vec3(displacedCellXY, hGround);
    vec3 terrainN   = evaluateTerrainNormal(displacedCellXY, displacedGlobalXY);

    ivec2 cellIdx = ivec2(floor(displacedCellXY));
    uint cellRaw  = fetchCellRaw(cellIdx);
    uint cellLand = cellRaw & 15u;
    uint cellOvl  = (cellRaw >> 4u) & 15u;
    uint cellSub  = (cellRaw >> 8u) & 15u;
    uint cellSlope = (cellRaw >> 12u) & 15u;
    uint cellCursor = (cellRaw >> 18u) & 3u;

    // ------------------------------------------------------------------------
    // 4. Synthesize 4K PBR Terrain Albedo, Roughness & Normal Detail
    // ------------------------------------------------------------------------
    float waterMask = terrainFields.x;
    float roadMask  = terrainFields.y;
    float rockMask  = terrainFields.z;

    float nFine   = fbm4(displacedGlobalXY * 6.5);
    float nMicro  = noise2D(displacedGlobalXY * 24.0);
    float nPebble = noise2D(displacedGlobalXY * 48.0);
    // Sample 512x512 hardware Voronoi & PBR Material Atlas (binding = 5) at macro & meso scales
    // (uPbrTex has 16/32/64 Voronoi cells across [0,1], so 0.045 & 0.11 give crisp 3D rock facets & cobbles)
    vec4 pbrHi = texture(uPbrTex, displacedGlobalXY * 0.11);
    vec4 pbrLo = texture(uPbrTex, displacedGlobalXY * 0.038 + vec2(0.23, 0.71));
    nMicro  = mix(nMicro, pbrHi.r * 0.65 + pbrLo.r * 0.35, 0.72);
    nPebble = mix(nPebble, pbrHi.g * 0.60 + pbrLo.g * 0.40, 0.75);

    vec3 soilCol, grassCol, cliffCol, roadCol, beachCol;
    if (theater == 0) {
        // THEATER_DESERT: Weathered arid ochre sand, dry wadi hardpan, stratified sandstone crags
        float ripples = sin(displacedGlobalXY.x * 28.0 + displacedGlobalXY.y * 12.0 + nFine * 4.0) * 0.5 + 0.5;
        soilCol  = mix(vec3(0.46, 0.37, 0.25), vec3(0.58, 0.47, 0.33), nFine * 0.75 + ripples * 0.25);
        grassCol = mix(vec3(0.36, 0.33, 0.21), vec3(0.28, 0.32, 0.18), smoothstep(0.45, 0.75, nFine));
        cliffCol = mix(vec3(0.34, 0.26, 0.19), vec3(0.48, 0.38, 0.28), nMicro);
        roadCol  = mix(vec3(0.28, 0.24, 0.19), vec3(0.21, 0.18, 0.14), nMicro);
        beachCol = vec3(0.52, 0.44, 0.32);
    } else if (theater == 3) {
        // THEATER_WINTER: Gritty windblown snowdrifts, frozen tundra earth, dark slate coastal crags
        soilCol  = mix(vec3(0.64, 0.69, 0.74), vec3(0.84, 0.88, 0.92), nFine);
        grassCol = mix(vec3(0.46, 0.52, 0.58), vec3(0.74, 0.79, 0.85), smoothstep(0.3, 0.7, nFine));
        cliffCol = mix(vec3(0.20, 0.23, 0.26), vec3(0.36, 0.39, 0.43), nMicro);
        roadCol  = mix(vec3(0.22, 0.24, 0.27), vec3(0.16, 0.18, 0.20), nMicro);
        beachCol = vec3(0.46, 0.51, 0.56);
    } else {
        // THEATER_TEMPERATE / COASTAL (CnC-Ultra-Game.jpg):
        // Warm weathered coastal limestone/granite crags, dusty ochre-taupe dirt roads, and muted olive-sage scrubland
        soilCol  = mix(vec3(0.27, 0.23, 0.18), vec3(0.40, 0.34, 0.27), nFine * 0.65 + nPebble * 0.35);
        grassCol = mix(vec3(0.17, 0.21, 0.12), vec3(0.27, 0.31, 0.18), nFine * 0.65 + nMicro * 0.35);
        cliffCol = mix(vec3(0.25, 0.23, 0.21), vec3(0.48, 0.44, 0.39), nMicro);
        roadCol  = mix(vec3(0.29, 0.25, 0.20), vec3(0.41, 0.36, 0.29), nMicro * 0.6 + nFine * 0.4);
        beachCol = vec3(0.42, 0.38, 0.32);
    }

    float grassWeight = smoothstep(0.26, 0.68, fbm3(displacedGlobalXY * 1.4 + vec2(5.2, 9.1)));
    vec3 surfAlbedo = mix(soilCol, grassCol, grassWeight);
    float surfRough = mix(0.88, 0.80, grassWeight);
    float surfMetal = 0.02;

    // Organic coastal boulders, scree stones, and olive scrub bushes clustered near crags & grassy ridges
    if (waterMask < 0.12 && roadMask < 0.25 && (rockMask > 0.12 || grassWeight > 0.48)) {
        vec2 boulderGrid = displacedGlobalXY * 2.4 + (pbrLo.rg - 0.5) * 0.55;
        vec2 bId = floor(boulderGrid);
        vec2 bUv = fract(boulderGrid) - vec2(0.5);
        float bRand = hash12(bId);
        float thresh = (rockMask > 0.25) ? 0.78 : 0.90;
        if (bRand > thresh) {
            vec2 bOff = (vec2(hash12(bId + vec2(3.1, 1.7)), hash12(bId + vec2(7.4, 5.3))) - 0.5) * 0.38;
            float bRad = (0.14 + 0.14 * hash12(bId + vec2(11.2, 9.8))) * (0.75 + 0.45 * pbrHi.r);
            float bDist = length((bUv - bOff) * vec2(1.15, 0.90));
            if (bDist < bRad) {
                float bHeight = sqrt(max(0.0, 1.0 - (bDist / bRad) * (bDist / bRad)));
                vec3 bNormal = normalize(vec3((bUv - bOff) / bRad, bHeight * 1.15));
                terrainN = normalize(mix(terrainN, bNormal, 0.52));
                if (bRand > 0.88 && rockMask < 0.35) {
                    // Dark olive coastal scrub bush
                    surfAlbedo = mix(vec3(0.14, 0.19, 0.10), vec3(0.22, 0.28, 0.15), nMicro);
                    surfRough = 0.86;
                } else {
                    // Weathered coastal granite boulder
                    surfAlbedo = cliffCol * (0.82 + 0.30 * nPebble);
                    surfRough = 0.68;
                }
            }
        }
    }

    // Perturb terrain normal with 4K micro-detail & gravel scree
    terrainN = normalize(terrainN + vec3((nMicro - 0.5) * 0.28, (nPebble - 0.5) * 0.28, 0.0));

    // Apply Muddy Tank-Rutted Dirt Roads & Coastal Concrete Bridges
    if (roadMask > 0.01) {
        // Parallel heavy armor track ruts carved into damp mud/gravel roads
        float trackRut = pow(sin(displacedGlobalXY.x * 18.8 + displacedGlobalXY.y * 6.2) * 0.5 + 0.5, 3.0);
        float treadMark = step(0.45, fract((displacedGlobalXY.x + displacedGlobalXY.y) * 22.0));
        vec3 rCol = roadCol * (0.82 + 0.28 * nPebble) * (1.0 - 0.22 * trackRut * treadMark);
        float rRough = mix(0.68, 0.26, trackRut * 0.75); // Damp mud sheen in tank ruts
        if (cellSlope == 9u) {
            // 3D Poured-Concrete & Steel Girder Coastal Causeway / Bridge
            float girder = step(0.84, abs(fract(displacedGlobalXY.x) * 2.0 - 1.0));
            rCol = mix(vec3(0.28, 0.29, 0.31), vec3(0.42, 0.39, 0.32), girder * 0.5);
            surfMetal = mix(surfMetal, 0.42, roadMask);
            rRough = 0.48;
        }
        surfAlbedo = mix(surfAlbedo, rCol, roadMask);
        surfRough  = mix(surfRough, rRough, roadMask);
    }

    // Apply Poured-Concrete Coastal Seawalls, Bastions & Building Bibs
    if (cellOvl == 14u || (cellOvl != 13u && cellSub == 7u)) {
        vec2 gridF = abs(fract(displacedCellXY * 2.0) - 0.5);
        float seam = smoothstep(0.46, 0.50, max(gridF.x, gridF.y));
        vec3 concCol = mix(vec3(0.35, 0.36, 0.37), vec3(0.16, 0.17, 0.18), seam) * (0.88 + 0.24 * nMicro);
        surfAlbedo = mix(surfAlbedo, concCol, 0.88);
        surfRough  = 0.56;
    }

    // Apply Multi-Tiered Stratified Coastal Rock Cliffs & Scree Crevices (Voronoi-fractured granite/limestone, no contour rings)
    if (rockMask > 0.01) {
        float rockFacets = clamp(pbrHi.r * 0.58 + pbrLo.r * 0.42, 0.0, 1.0);
        float crevice = smoothstep(0.32, 0.08, rockFacets) * smoothstep(0.25, 0.70, nFine);
        vec3 rCliff = cliffCol * (0.72 + 0.46 * rockFacets) * (0.85 + 0.30 * nPebble);
        rCliff = mix(rCliff, vec3(0.11, 0.105, 0.10), crevice * 0.58);
        surfAlbedo = mix(surfAlbedo, rCliff, smoothstep(0.05, 0.55, rockMask));
        surfRough  = mix(surfRough, 0.72, rockMask);
    }

    // Apply Blast Craters & Carbon Scorch Marks
    if (cellOvl != 13u && cellSub >= 1u && cellSub <= 6u) {
        vec2 cc = fract(displacedCellXY) - vec2(0.5);
        float r = length(cc) * 2.1;
        float scorch = smoothstep(0.95, 0.15, r);
        surfAlbedo = mix(surfAlbedo, vec3(0.08, 0.07, 0.06), scorch * 0.82);
        surfRough  = mix(surfRough, 0.92, scorch);
        // Subtle hot embers inside deep blast craters
        if (cellSub >= 3u && cellSub <= 5u && r < 0.35) {
            float ember = smoothstep(0.35, 0.0, r) * (0.5 + 0.5 * sin(time * 4.0 + r * 12.0));
            surfAlbedo += vec3(0.85, 0.25, 0.04) * ember * 0.45;
        }
    }

    // Mutated ground beneath Tiberium crystals
    if ((cellOvl >= 1u && cellOvl <= 12u) || cellLand == 5u) {
        float tibStage = float(clamp(int(cellOvl), 1, 12)) / 12.0;
        vec3 tibGround = mix(vec3(0.14, 0.22, 0.12), vec3(0.12, 0.55, 0.22), nMicro * tibStage);
        surfAlbedo = mix(surfAlbedo, tibGround, 0.72 * tibStage);
    }

    // ------------------------------------------------------------------------
    // 5. Photorealistic Deep Ocean Swells & Multi-Layered Crashing Whitewater Surf
    // ------------------------------------------------------------------------
    float shoreBand = smoothstep(0.05, 0.45, waterMask) * smoothstep(0.85, 0.38, waterMask);
    if (shoreBand > 0.01 || isCellBeach(cellRaw)) {
        float wet = clamp(shoreBand * 1.7 + (isCellBeach(cellRaw) ? 0.55 : 0.0), 0.0, 1.0);
        surfAlbedo = mix(surfAlbedo, beachCol * 0.58, wet * 0.80);
        surfRough  = mix(surfRough, 0.18, wet);
    }

    vec3 waterEmissive = vec3(0.0);
    if (waterMask > 0.28) {
        float wDepth = smoothstep(0.32, 0.92, waterMask);
        vec2 flowDir = (cellSlope == 10u) ? vec2(0.0, -3.5) : vec2(0.65, 0.38);
        vec2 wp1 = displacedGlobalXY * 4.4 + flowDir * time * 0.82;
        vec2 wp2 = displacedGlobalXY * 10.2 - flowDir.yx * time * 1.18;

        float w1 = fbm3(wp1);
        float w2 = fbm3(wp2);
        float chop = noise2D(displacedGlobalXY * 26.0 + flowDir * time * 2.2);

        vec2 dWave = vec2(
            fbm3(wp1 + vec2(0.07, 0.0)) - w1,
            fbm3(wp1 + vec2(0.0, 0.07)) - w1
        ) * 3.6 + (vec2(chop) - 0.5) * 0.35;
        terrainN = normalize(vec3(-dWave.x, -dWave.y, 1.0));

        // Deep slate-navy ocean swells transitioning to coastal teal-slate (CnC-Ultra-Game.jpg)
        vec3 shallowWater = vec3(0.045, 0.165, 0.215);
        vec3 deepWater    = vec3(0.020, 0.068, 0.118);
        surfAlbedo = mix(shallowWater, deepWater, wDepth);
        surfRough  = 0.07;
        surfMetal  = 0.18;

        // Multi-layered crashing whitewater surf & lacy cellular Voronoi sea-foam (sampled from uPbrTex.b)
        float coastDist = 1.0 - waterMask;
        float breaker1 = sin(coastDist * 16.0 - time * 2.4 + w1 * 4.2) * 0.5 + 0.5;
        float breaker2 = sin(coastDist * 32.0 - time * 3.1 - w2 * 4.8) * 0.5 + 0.5;
        float breaker3 = sin(coastDist * 52.0 - time * 3.8 + (w1 - w2) * 5.5) * 0.5 + 0.5;
        float voronoiFoam1 = texture(uPbrTex, displacedGlobalXY * 0.068 + vec2(w1 * 0.04, -time * 0.015)).b;
        float voronoiFoam2 = texture(uPbrTex, displacedGlobalXY * 0.165 - vec2(time * 0.02, w2 * 0.04)).b;
        float laceFoam = clamp(voronoiFoam1 * 0.62 + voronoiFoam2 * 0.55, 0.0, 1.0);

        float surfZone  = smoothstep(0.96, 0.18, waterMask) * smoothstep(0.06, 0.26, waterMask);
        float innerSurf = smoothstep(0.58, 0.12, waterMask) * smoothstep(0.04, 0.18, waterMask);
        float mainCrest = smoothstep(0.42, 0.80, breaker1) * surfZone * (0.50 + 0.65 * laceFoam);
        float subCrest  = smoothstep(0.48, 0.84, breaker2) * surfZone * 0.88 * laceFoam;
        float shoreWash = smoothstep(0.45, 0.82, breaker3) * innerSurf * 0.92;
        float foamWeb   = (surfZone * 0.98 + innerSurf * 0.92) * pow(laceFoam, 1.25) * (0.48 + 0.52 * breaker1);
        float whitecap  = smoothstep(0.62, 0.88, w1 * 0.60 + w2 * 0.45) * laceFoam * smoothstep(0.30, 0.85, waterMask) * 0.58;

        // Rocky sea-stacks & jagged reef boulders poking through the surf zone
        float reefRock = smoothstep(0.66, 0.84, pbrLo.r * 0.65 + w1 * 0.35) * surfZone * smoothstep(0.62, 0.25, waterMask);

        float foamMask = clamp(max(max(mainCrest, subCrest), shoreWash) + foamWeb + whitecap, 0.0, 1.0) * (1.0 - reefRock);
        if (cellSlope == 10u || cellSlope == 11u) {
            foamMask = max(foamMask, smoothstep(0.32, 0.72, w1 + w2 * 0.65));
        }

        surfAlbedo = mix(surfAlbedo, cliffCol * 0.72, reefRock);
        surfAlbedo = mix(surfAlbedo, vec3(0.93, 0.96, 0.99), foamMask * 0.95);
        surfRough  = mix(surfRough, 0.52, max(foamMask, reefRock));

        // Moody coastal sky reflection & crisp specular sun glints on ocean swells
        vec3 R = reflect(-V, terrainN);
        vec3 skyCol = mix(vec3(0.14, 0.24, 0.34), vec3(0.44, 0.56, 0.68), clamp(R.z, 0.0, 1.0));
        float fresnel = pow(1.0 - max(dot(terrainN, V), 0.0), 4.0);
        waterEmissive = skyCol * (0.14 + 0.52 * fresnel) * (1.0 - foamMask * 0.78);
    }

    // ------------------------------------------------------------------------
    // 6. Top-Down / 3D Orbital / First-Person Camera Ray-March of 3D Cell Structures
    //    (Tiberium, Walls, Crates) & 3D Articulated Entities (Vehicles, Buildings, Infantry, Aircraft, Trees)
    // ------------------------------------------------------------------------
    vec3 camDir = isFirstPerson ? normalize(vec3(-0.20, 0.78, 0.59)) : V;
    int hitMat = 0;
    vec3 hitPos = terrainPos;
    vec3 hitNormal = terrainN;
    vec3 hitLocal = vec3(0.0);
    int hitHouse = 0;
    int hitSubType = 0;
    int hitFlags = 0;
    float hitHealth = 1.0;
    float bestCamU = 0.0;
    float fpBestT = fpGroundT;

    // A. Check 3D Tiberium Crystal Clusters, Connected Walls & Supply Crates in nearby cells
    ivec2 groundCellIdx = ivec2(floor(groundCellXY));
    if (!isFirstPerson) {
        for (int cy = -1; cy <= 1; ++cy) {
            for (int cx = -1; cx <= 1; ++cx) {
                if (!isCam3D && (cy < 0 || cx > 0)) continue;
                if (uTac.hud_telemetry[0].x == 3200.0 || roadMask > 0.10) continue;
                ivec2 testCell = groundCellIdx + ivec2(cx, cy);
                uint rawC = fetchCellRaw(testCell);
                uint ovlC = (rawC >> 4u) & 15u;
                uint landC = rawC & 15u;
                if (ovlC == 0u && landC != 4u && landC != 5u) continue;

                float u = 0.55;
                for (int s = 0; s < 16; ++s) {
                    if (u <= bestCamU) break;
                    vec3 p = vec3(groundCellXY + camDir.xy * u, camDir.z * u);
                    int mId;
                    vec3 lCoord;
                    float d = mapCellStructures(p, testCell, rawC, mId, lCoord);
                    if (d < 0.006) {
                        bestCamU = u;
                        hitMat = mId;
                        hitPos = terrainPos + camDir * u;
                        hitLocal = lCoord;
                        float eps = 0.006;
                        int dm;
                        vec3 dl;
                        hitNormal = normalize(vec3(
                            mapCellStructures(p + vec3(eps, 0.0, 0.0), testCell, rawC, dm, dl) - d,
                            mapCellStructures(p + vec3(0.0, eps, 0.0), testCell, rawC, dm, dl) - d,
                            mapCellStructures(p + vec3(0.0, 0.0, eps), testCell, rawC, dm, dl) - d
                        ));
                        break;
                    }
                    u -= max(d * 0.85, 0.006);
                }
            }
        }
    } else if (uTac.hud_telemetry[0].x != 3200.0) {
        // First-Person 3D ray-march of Walls, Tiberium & Supply Crates along fpRayDir
        float tW = 0.35;
        for (int s = 0; s < 28; ++s) {
            if (tW >= min(fpBestT, 12.0)) break;
            vec3 pWorld = fpEye + fpRayDir * tW;
            if (pWorld.z > 0.65 && fpRayDir.z > 0.0) break;
            ivec2 cIdx = ivec2(floor(pWorld.xy));
            uint rawC = fetchCellRaw(cIdx);
            uint ovlC = (rawC >> 4u) & 15u;
            uint landC = rawC & 15u;
            if (ovlC == 0u && landC != 4u && landC != 5u) {
                tW += 0.35;
                continue;
            }
            vec4 cTf;
            float cGroundZ = evaluateTerrainHeight(pWorld.xy, originCell + pWorld.xy, cTf);
            vec3 pCell = vec3(pWorld.xy, pWorld.z - cGroundZ);
            int mId;
            vec3 lCoord;
            float d = mapCellStructures(pCell, cIdx, rawC, mId, lCoord);
            if (d < 0.007) {
                fpBestT = tW;
                hitMat = mId;
                hitPos = pWorld;
                hitLocal = lCoord;
                float eps = 0.006;
                int dm;
                vec3 dl;
                hitNormal = normalize(vec3(
                    mapCellStructures(pCell + vec3(eps, 0.0, 0.0), cIdx, rawC, dm, dl) - d,
                    mapCellStructures(pCell + vec3(0.0, eps, 0.0), cIdx, rawC, dm, dl) - d,
                    mapCellStructures(pCell + vec3(0.0, 0.0, eps), cIdx, rawC, dm, dl) - d
                ));
                break;
            }
            tW += max(d * 0.80, 0.02);
        }
    }

    // B. Ray-March Active 3D Entities + Accumulate Ground Shadows, Volumetric Pyroclastic Smoke & Selection HUD
    int entCount = clamp(int(uTac.view_params3.x), 0, 128);
    float entityShadow = 0.0;
    vec4 hudOverlay = vec4(0.0);
    vec3 vfxAdditive = vec3(0.0);
    float vfxSmokeAlpha = 0.0;
    vec3 vfxSmokeColor = vec3(0.09, 0.10, 0.11);

    for (int i = 0; i < 128; ++i) {
        if (i >= entCount) break;
        if (isFirstPerson && i == fpEntIdx) continue;
        vec4 d0 = uTac.ent_data0[i];
        vec4 d1 = uTac.ent_data1[i];

        int packedType = int(floor(d0.w + 0.5));
        int cat = packedType & 7;
        int subType = (packedType >> 3) & 127;
        int houseId = (packedType >> 10) & 7;
        int flags = int(floor(d1.z));
        float health = clamp(fract(d1.z), 0.01, 0.999);

        // Determine culling radius in cells based on entity category (expanded for tall 3/4 towers & smoke plumes)
        float cullRad = 1.25;
        if (cat == 1) {
            int fw = max(1, int(floor(d1.w)) & 7);
            int fh = max(1, (int(floor(d1.w)) >> 3) & 7);
            cullRad = max(float(fw), float(fh)) * 0.82 + 1.45;
        } else if (cat == 3) {
            cullRad = 2.10;
        } else if (cat == 6) {
            cullRad = 6.20;
        } else if (cat == 4) {
            cullRad = 1.45;
        }

        if (isFirstPerson) {
            // First-Person 3D Pinhole Ray-Marching against 3D Entities, Projectiles & Volumetric Smoke/Fire
            float rayHorizLen = max(length(fpRayDir.xy), 0.12);
            vec2 rayHorizDir = fpRayDir.xy / rayHorizLen;
            float distAlong2D = dot(d0.xy - fpEye.xy, rayHorizDir);
            float tEnt = distAlong2D / rayHorizLen;
            if (tEnt < 0.14 || tEnt > 21.0) continue;
            vec3 pAtEnt = fpEye + fpRayDir * tEnt;
            float perp2D = length(pAtEnt.xy - d0.xy);
            if (perp2D > cullRad) continue;

            vec4 entTf;
            float entGroundZ = evaluateTerrainHeight(d0.xy, originCell + d0.xy, entTf);
            if (entTf.x > 0.35) entGroundZ = max(entGroundZ, 0.0);

            if (cat == 6 && tEnt < fpBestT + 1.2) {
                float rad = clamp(d1.w, 0.18, 1.15);
                float stage = clamp(d1.x, 0.0, 1.0);
                float relZ = pAtEnt.z - entGroundZ;
                if (relZ >= -0.05 && relZ < 3.6) {
                    float fDist3D = length(vec3((pAtEnt.xy - d0.xy) / (rad * 1.35), (relZ - 0.25) / (rad * 1.45)));
                    if (fDist3D < 1.35) {
                        float nF = fbm3(pAtEnt.xy * 4.5 - vec2(0.0, time * 3.4 + relZ * 3.0));
                        float fMask = smoothstep(1.25, 0.15, fDist3D - (nF - 0.5) * 0.55) * (1.0 - stage * 0.65);
                        vec3 fCol = mix(vec3(0.96, 0.22, 0.02), vec3(1.0, 0.86, 0.38), fMask);
                        vfxAdditive += fCol * fMask * 1.85;
                    }
                    // Rising 3D black pyroclastic smoke plume in first-person sky
                    float plumeW = rad * mix(0.65, 1.85, clamp(relZ / 3.2, 0.0, 1.0));
                    float smkDist = length(pAtEnt.xy - d0.xy + vec2(relZ * 0.22, 0.0));
                    if (relZ > 0.15 && smkDist < plumeW) {
                        float sn = fbm4(vec2(perp2D * 2.5, relZ * 1.8 - time * 0.55));
                        float smkA = smoothstep(plumeW, plumeW * 0.2, smkDist - (sn - 0.5) * 0.45) * smoothstep(3.5, 0.4, relZ);
                        if (smkA * 0.88 > vfxSmokeAlpha) {
                            vfxSmokeColor = mix(vec3(0.02, 0.025, 0.03), vec3(0.16, 0.18, 0.20), clamp(sn, 0.0, 1.0));
                            vfxSmokeAlpha = smkA * 0.88;
                        }
                    }
                }
                continue;
            }
            if (cat == 5 && tEnt < fpBestT) {
                float pZ = entGroundZ + max(d0.z, 0.18);
                float d3 = length(pAtEnt - vec3(d0.xy, pZ));
                if (d3 < 0.22) {
                    vfxAdditive += vec3(1.0, 0.82, 0.32) * exp(-d3 * 24.0) * 2.2;
                }
                continue;
            }
            if (cat <= 4 && tEnt - cullRad < fpBestT) {
                float tStart = max(0.16, tEnt - cullRad * 0.90);
                float tEnd   = min(fpBestT, tEnt + cullRad * 0.90);
                float tCur   = tStart;
                for (int s = 0; s < 32; ++s) {
                    if (tCur >= tEnd) break;
                    vec3 pWorld = fpEye + fpRayDir * tCur;
                    float infScale = (cat == 2) ? 1.65 : 1.0;
                    vec3 pSDF   = vec3(d0.xy + (pWorld.xy - d0.xy) * infScale, (pWorld.z - entGroundZ) * infScale);
                    int pMat;
                    vec3 pLoc;
                    float d = evaluateSingleEntitySDF(pSDF, d0, d1, time, pMat, pLoc) / infScale;
                    if (d < 0.0065) {
                        fpBestT   = tCur;
                        hitMat    = pMat;
                        hitPos    = pWorld;
                        hitLocal  = pLoc;
                        hitHouse  = houseId;
                        hitSubType = subType;
                        hitFlags  = flags;
                        hitHealth = health;
                        float eps = 0.006;
                        int dm;
                        vec3 dl;
                        hitNormal = normalize(vec3(
                            evaluateSingleEntitySDF(pSDF + vec3(eps, 0.0, 0.0), d0, d1, time, dm, dl) - d,
                            evaluateSingleEntitySDF(pSDF + vec3(0.0, eps, 0.0), d0, d1, time, dm, dl) - d,
                            evaluateSingleEntitySDF(pSDF + vec3(0.0, 0.0, eps), d0, d1, time, dm, dl) - d
                        ));
                        break;
                    }
                    tCur += max(d * 0.78, 0.006);
                }
            }
            continue;
        }

        // Fast 2D bounding-box rejection (shifted along 3/4 perspective camera vector for tall 3D projection)
        vec2 projCenter = d0.xy - camDir.xy * (d0.z * 0.95 + ((cat == 1) ? 0.85 : ((cat == 6) ? 1.85 : 0.25)));
        vec2 diffXY = groundCellXY - projCenter;
        if (max(abs(diffXY.x), abs(diffXY.y)) > cullRad) continue;

        // 1. Soft Directional Ground Shadow + Weathered Industrial Compound Yard Ground
        if (cat <= 4) {
            float shadowH = (cat == 3) ? max(d0.z, 0.65) : ((cat == 1) ? 0.55 : 0.22);
            vec2 shadowCenter = d0.xy - L.xy * (shadowH / max(L.z, 0.25));
            vec2 sDiff = groundCellXY - shadowCenter;
            vec2 sSpan = (cat == 1)
                ? vec2(max(1, int(floor(d1.w)) & 7), max(1, (int(floor(d1.w)) >> 3) & 7)) * 0.44
                : vec2(0.30, 0.34);
            float sDist = length(max(abs(sDiff) - sSpan * 0.65, 0.0)) / max(sSpan.x * 0.55, 0.15);
            entityShadow = max(entityShadow, smoothstep(1.0, 0.1, sDist) * ((cat == 3) ? 0.55 : 0.72));

            // Organic dark compacted gravel / scorched asphalt compound yard beneath base structures
            if (cat == 1 && subType != 22 && waterMask < 0.2) {
                vec2 yardDiff = groundCellXY - d0.xy;
                float yardDist = length(max(abs(yardDiff) - sSpan * 0.75, 0.0)) / max(sSpan.x * 0.65, 0.25);
                float yardMask = smoothstep(1.15, 0.15, yardDist);
                vec3 yardCol = mix(vec3(0.14, 0.13, 0.12), vec3(0.22, 0.21, 0.19), nMicro);
                if ((flags & 8) != 0) {
                    yardCol *= 0.45; // Heavy black soot/scorch around burning structures
                }
                surfAlbedo = mix(surfAlbedo, yardCol, yardMask * 0.82);
                surfRough  = mix(surfRough, 0.78, yardMask);
            }
        }

        // 1b. Amphibious Hovercraft / Naval Gunboat Churning Whitewater Wake Ring on Water
        if (waterMask > 0.25 && cat == 0 && (subType == 13 || subType == 15)) {
            vec2 wakeRel = groundCellXY - d0.xy;
            float wakeDist = length(wakeRel * vec2(1.05, 0.88));
            float wakeRing = smoothstep(0.95, 0.36, wakeDist) * smoothstep(0.14, 0.38, wakeDist);
            float wakeLace = texture(uPbrTex, groundCellXY * 0.12 - vec2(sin(d1.x), -cos(d1.x)) * time * 0.04).b;
            float wakeMask = clamp(wakeRing * (0.45 + 0.85 * wakeLace), 0.0, 0.95);
            surfAlbedo = mix(surfAlbedo, vec3(0.94, 0.97, 1.0), wakeMask);
            surfRough  = mix(surfRough, 0.45, wakeMask);
        }

        // 2. Stage 4: 3D Volumetric Pyroclastic Smoke, Fire, Munition Impacts & Tactical Flashes (cat == 6)
        if (cat == 6) {
            float stage = clamp(d1.x, 0.0, 1.0);
            float rad = clamp(d1.w, 0.14, 1.15);
            vec2 fireOrigin = d0.xy - vec2(0.0, 0.06);
            vec2 relFire = groundCellXY - fireOrigin;
            float distFire = length(relFire);

            if (subType == 66) {
                // ANIM_MOVE_FLASH: Crisp tactical emerald move-order confirmation ring on the ground
                float ringR = mix(0.08, 0.24, stage);
                float ring  = exp(-abs(distFire - ringR) * 42.0) * (1.0 - stage);
                float dotC  = exp(-distFire * 28.0) * (1.0 - stage);
                vfxAdditive += vec3(0.20, 1.0, 0.45) * (ring * 1.4 + dotC * 0.9);
                continue;
            }
            if (subType == 12 || subType == 13) {
                // ANIM_PIFF / ANIM_PIFFPIFF: Small-arms bullet impact spark & dust ricochet
                if (distFire < 0.28) {
                    float spark = exp(-distFire * 26.0) * (1.0 - stage * 0.85);
                    float dust  = smoothstep(0.22, 0.03, distFire) * (1.0 - stage) * 0.35;
                    vfxAdditive += vec3(1.0, 0.82, 0.38) * spark * 1.65;
                    vfxSmokeAlpha = max(vfxSmokeAlpha, dust);
                }
                continue;
            }
            if (subType == 34 || (subType >= 39 && subType <= 54)) {
                // ANIM_MUZZLE_FLASH / ANIM_SAM_* / ANIM_GUN_*: Compact directional weapon muzzle flash
                if (distFire < 0.32) {
                    float flash = exp(-distFire * 22.0) * (1.0 - stage * 0.80);
                    vfxAdditive += vec3(1.0, 0.78, 0.32) * flash * 1.75;
                }
                continue;
            }
            if (subType == 11 || subType == 35 || subType == 55) {
                // ANIM_SMOKE_PUFF / ANIM_SMOKE_M / ANIM_LZ_SMOKE: Soft expanding rocket/exhaust smoke puff (no fire)
                float puffR = mix(0.12, 0.28, stage);
                if (distFire < puffR * 1.35) {
                    float sn = texture(uPbrTex, relFire * 0.65 + vec2(stage * 0.3)).a;
                    float puff = smoothstep(puffR * 1.25, puffR * 0.15, distFire - (sn - 0.5) * 0.08) * (1.0 - stage * 0.85);
                    if (puff * 0.68 > vfxSmokeAlpha) {
                        vfxSmokeColor = vec3(0.24, 0.26, 0.28);
                        vfxSmokeAlpha = puff * 0.68;
                    }
                }
                continue;
            }
            if (subType == 56 || subType == 60) {
                // GDI Ion Cannon Orbital Particle Beam
                float beamW = abs(groundCellXY.x - d0.x);
                float beam = exp(-beamW * 14.0) * step(groundCellXY.y, d0.y + 0.25) * (1.0 - stage * 0.6);
                float core = smoothstep(1.1, 0.0, distFire / max(rad, 0.35));
                vfxAdditive += vec3(0.45, 0.82, 1.65) * (beam * 2.2 + core * 1.8);
                continue;
            }
            if ((subType >= 22 && subType <= 29) || subType == 72) {
                // ANIM_CHEM_*: Tiberium / Visceroid emerald chemical cloud
                if (distFire < rad * 1.25) {
                    float chem = smoothstep(rad * 1.15, 0.04, distFire) * (1.0 - stage * 0.75);
                    vfxAdditive += vec3(0.18, 0.95, 0.32) * chem * 1.35;
                }
                continue;
            }
            if (!isShowcase && (subType >= 0 && subType <= 10)) {
                // Live gameplay shell / artillery / grenade / napalm impact explosion (ANIM_FBALL1..ANIM_NAPALM3)
                float expR = rad * mix(0.45, 1.10, sqrt(stage));
                if (distFire < expR * 1.45) {
                    float nExp = fbm3(relFire * 5.5 - vec2(0.0, time * 2.8));
                    float fireball = smoothstep(expR * 1.05, expR * 0.10, distFire - (nExp - 0.5) * 0.16) * pow(1.0 - stage, 0.65);
                    float hotCore  = smoothstep(expR * 0.55, 0.0, distFire) * (1.0 - stage);
                    vec3 expCol = mix(vec3(0.96, 0.26, 0.03), vec3(1.0, 0.78, 0.24), fireball);
                    expCol = mix(expCol, vec3(1.0, 0.96, 0.80), hotCore);
                    vfxAdditive += expCol * (fireball * 1.65 + hotCore * 1.25);

                    float smkRing = smoothstep(expR * 1.35, expR * 0.25, distFire - (nExp - 0.5) * 0.22) * smoothstep(0.08, 0.45, stage) * (1.0 - stage * 0.75);
                    if (smkRing * 0.78 > vfxSmokeAlpha) {
                        vfxSmokeColor = mix(vec3(0.04, 0.045, 0.05), vec3(0.18, 0.19, 0.21), stage);
                        vfxSmokeAlpha = smkRing * 0.78;
                    }
                }
                continue;
            }

            // A. Roaring Licking Flame Tongues & Glowing Structural Embers at Base (CnC-Ultra-Game.jpg & Persistent Fires)
            vec2 upDir = normalize(vec2(-0.42, -0.91));
            vec2 rightDir = vec2(-upDir.y, upDir.x);
            float fAlong = dot(relFire, upDir);
            float fAcross = dot(relFire, rightDir);
            vec2 flameCoords = vec2(fAcross / (rad * 1.35), (fAlong - 0.18) / (rad * 1.55));
            float fDist = length(flameCoords);

            if (fDist < 1.55) {
                // Sample Voronoi & FBM at proper macro scale so flame tongues are coherent licking licks, NOT pixel noise!
                float fTurb1 = fbm4(relFire * 2.8 - upDir * time * 2.6);
                float fTurb2 = fbm3(relFire * 5.6 - upDir * time * 4.2 + vec2(1.7, 3.1));
                float vorF   = texture(uPbrTex, relFire * 0.085 - upDir * time * 0.08).b;
                float tongueMod = fTurb1 * 0.48 + fTurb2 * 0.32 + vorF * 0.20;

                float flameShape = smoothstep(1.18, 0.10, fDist - (tongueMod - 0.46) * 0.72);
                // Dark structural wreckage beams & soot gaps cutting across the roaring fire
                float steelRibs = smoothstep(0.18, 0.04, abs(sin(relFire.x * 11.0 + 0.4) * sin(relFire.y * 9.5))) * smoothstep(0.15, 0.85, fDist);
                float flameIntensity = flameShape * smoothstep(0.24, 0.76, tongueMod + (1.0 - fDist) * 0.48) * (1.0 - steelRibs * 0.65);
                float hotCore = smoothstep(0.58, 0.86, tongueMod + (1.0 - fDist) * 0.52) * flameShape * (1.0 - steelRibs * 0.45);

                vec3 flameCol = mix(vec3(0.95, 0.18, 0.01), vec3(1.0, 0.56, 0.06), smoothstep(0.10, 0.62, flameIntensity));
                flameCol = mix(flameCol, vec3(1.0, 0.94, 0.68), hotCore);
                vfxAdditive += flameCol * (flameIntensity * 1.45 + hotCore * 1.15);

                // Scattered glowing orange-amber debris embers around the burning compound perimeter
                float emberPatch = fbm4(relFire * 6.2 + vec2(2.3, 5.1)) * texture(uPbrTex, relFire * 0.14).g;
                float embers = smoothstep(0.38, 0.56, emberPatch) * smoothstep(1.50, 0.40, fDist);
                vfxAdditive += vec3(1.0, 0.42, 0.05) * embers * 1.25;
            }

            // B. Towering Diagonal 3D Pyroclastic Cauliflower Smoke Column rising up-left from the fire!
            // Built from 14 overlapping 3D spherical/ellipsoidal smoke billow puffs with true 3D surface normals
            vec2 plumeDir = normalize(vec2(-0.50, -0.866));
            vec2 plumeOrtho = vec2(-plumeDir.y, plumeDir.x);
            vec2 relPlume = groundCellXY - (fireOrigin + vec2(-0.18, -0.14));
            float alongPlume = dot(relPlume, plumeDir);
            float acrossPlume = dot(relPlume, plumeOrtho);

            if (alongPlume > -0.65 && alongPlume < 5.2 && abs(acrossPlume) < 2.6) {
                float billowMacro = texture(uPbrTex, relPlume * 0.048 - plumeDir * time * 0.025).a;
                float billowMeso  = texture(uPbrTex, relPlume * 0.115 - plumeDir * time * 0.045 + vec2(0.37, 0.19)).a;
                float fbmSmk      = fbm4(relPlume * 1.85 - plumeDir * time * 0.45);
                float lobeDisp    = (billowMacro * 0.48 + billowMeso * 0.32 + fbmSmk * 0.20) - 0.48;

                float bestPuffAlpha = 0.0;
                vec3  bestPuffNormal = vec3(0.0, 0.0, 1.0);
                float bestPuffH = 0.0;

                // Continuous organic pyroclastic plume spine + 14 overlapping cauliflower billow lobes
                for (int pk = 0; pk < 14; ++pk) {
                    float fi = float(pk) / 13.0;
                    float puffAlong = mix(0.02, 4.35, pow(fi, 0.90)) * clamp(rad / 0.85, 0.35, 1.15);
                    float sideAlt   = (mod(float(pk), 2.0) * 2.0 - 1.0) * (0.10 + 0.24 * fi);
                    float puffSway  = sin(fi * 9.5 - time * 0.65 + float(pk) * 1.1) * (0.12 + 0.28 * fi) + sideAlt;
                    float puffRad   = mix(0.62, 1.48, pow(fi, 0.62)) * rad;
                    vec2  puffCenter = plumeDir * puffAlong + plumeOrtho * puffSway;
                    vec2  dPuff = (relPlume - puffCenter) / puffRad;
                    // Displace spherical puff boundary with multi-scale cauliflower lobes
                    vec2  warpedDPuff = dPuff - normalize(dPuff + vec2(1e-4)) * lobeDisp * 0.68;
                    float r2 = dot(warpedDPuff, warpedDPuff);
                    if (r2 < 1.25) {
                        float pAlpha = smoothstep(1.22, 0.22, r2) * mix(0.97, 0.72, fi * fi);
                        if (pAlpha > bestPuffAlpha) {
                            bestPuffAlpha = pAlpha;
                            float nz = sqrt(max(0.05, 1.0 - min(r2, 0.95)));
                            // Perturb 3D puff normal with sub-lobe cauliflower bumps
                            vec2 subGrad = vec2(billowMeso - 0.5, fbmSmk - 0.5) * 0.85;
                            bestPuffNormal = normalize(vec3(warpedDPuff.x + subGrad.x, warpedDPuff.y + subGrad.y, nz));
                            bestPuffH = fi;
                        }
                    }
                }

                if (bestPuffAlpha > 0.01) {
                    // Shade 3D Pyroclastic Smoke Puff:
                    // 1. Deep velvety soot-black / charcoal core (vec3(0.014, 0.016, 0.019))
                    // 2. Cool overcast sky rim lighting from upper-left (-0.65, -0.55, 0.52)
                    // 3. Warm orange-amber fire underglow from lower-right (+0.50, +0.75, -0.35) near the base
                    vec3 skyLightDir  = normalize(vec3(-0.65, -0.55, 0.52));
                    vec3 fireLightDir = normalize(vec3( 0.52,  0.76, -0.25));
                    float skyDiff  = clamp(dot(bestPuffNormal, skyLightDir) * 0.5 + 0.5, 0.0, 1.0);
                    float fireDiff = clamp(dot(bestPuffNormal, fireLightDir), 0.0, 1.0) * exp(-bestPuffH * 2.6);

                    vec3 sootCore = vec3(0.014, 0.016, 0.019);
                    vec3 skyRim   = vec3(0.15, 0.17, 0.20);
                    vec3 smkCol   = mix(sootCore, skyRim, pow(skyDiff, 1.85) * 0.78);
                    smkCol += vec3(0.96, 0.34, 0.04) * pow(fireDiff, 1.35) * 0.85;

                    if (bestPuffAlpha > vfxSmokeAlpha) {
                        vfxSmokeColor = smkCol;
                        vfxSmokeAlpha = bestPuffAlpha;
                    }
                }
            }
            continue;
        }

        if (cat == 5) {
            // Projectile / Rocket / Obelisk Laser
            if (subType == 12) {
                // BULLET_LASER: Searing 3D Crimson Obelisk Laser Beam from (d1.x, d1.y) to (d0.x, d0.y)
                vec2 a = vec2(d1.x, d1.y - 0.36);
                vec2 b = vec2(d0.x, d0.y - 0.08);
                vec2 pa = groundCellXY - a, ba = b - a;
                float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
                float dist = length(pa - ba * h);
                float laserCore = exp(-dist * 42.0);
                float laserHalo = exp(-dist * 11.0);
                vfxAdditive += vec3(1.0, 0.85, 0.85) * laserCore * 2.2 + vec3(1.0, 0.08, 0.12) * laserHalo * 1.4;
                continue;
            }
            // Single crisp projectile head + compact contrail aligned with point light at d0.xy - vec2(0.0, d0.z * 0.15)
            vec2 bCenter = d0.xy - vec2(0.0, d0.z * 0.15);
            vec2 bDir = vec2(sin(d1.x), -cos(d1.x));
            vec2 relB = groundCellXY - bCenter;
            float along = dot(relB, -bDir);
            float perp  = length(relB - (-bDir) * clamp(along, 0.0, 0.38));
            if (perp < 0.14) {
                float head = exp(-length(relB) * 32.0);
                float trail = exp(-perp * 30.0) * smoothstep(0.38, 0.0, along) * step(0.0, along);
                vec3 pCol = (subType >= 4 && subType <= 7) ? vec3(1.0, 0.58, 0.18) : vec3(1.0, 0.85, 0.35);
                vfxAdditive += pCol * (head * 1.85 + trail * 0.95);
            }
            continue;
        }

        // 3. 3/4 Perspective Camera Sphere-Tracing for 3D Solid Entity (Vehicle, Structure, Infantry, Aircraft, Tree/Rock)
        // March from uMax (closest to camera, above entity/tower top) downward toward uMin (ground / base altitude)
        float uMax = (cat == 3) ? (d0.z * 1.45 + 0.55) : ((cat == 1) ? 2.65 : ((cat == 4) ? 1.15 : (d0.z * 1.35 + 0.62)));
        float uMin = max(bestCamU, (cat == 3) ? max(0.0, d0.z * 0.85 - 0.18) : 0.0);
        float u = uMax;
        for (int s = 0; s < 32; ++s) {
            if (u <= uMin) break;
            vec3 p = vec3(groundCellXY + camDir.xy * u, camDir.z * u);
            int pMat;
            vec3 pLoc;
            float d = evaluateSingleEntitySDF(p, d0, d1, time, pMat, pLoc);
            if (d < 0.006) {
                bestCamU = u;
                hitMat = pMat;
                hitPos = terrainPos + camDir * u;
                hitLocal = pLoc;
                hitHouse = houseId;
                hitSubType = subType;
                hitFlags = flags;
                hitHealth = health;

                float eps = 0.006;
                int dm;
                vec3 dl;
                hitNormal = normalize(vec3(
                    evaluateSingleEntitySDF(p + vec3(eps, 0.0, 0.0), d0, d1, time, dm, dl) - d,
                    evaluateSingleEntitySDF(p + vec3(0.0, eps, 0.0), d0, d1, time, dm, dl) - d,
                    evaluateSingleEntitySDF(p + vec3(0.0, 0.0, eps), d0, d1, time, dm, dl) - d
                ));
                break;
            }
            u -= max(d * 0.82, 0.005);
        }

        // 4. Secondary Smoke, Fire & Muzzle Flash for damaged / firing units
        if ((flags & 8) != 0) {
            vec2 smkOrigin = d0.xy - vec2(0.0, 0.16);
            vec2 sd = groundCellXY - smkOrigin;
            if (sd.y < 0.18 && sd.y > -1.35 && abs(sd.x) < 0.68) {
                float rise = clamp(-sd.y / 1.35, 0.0, 1.0);
                float sn = texture(uPbrTex, sd * 0.45 + vec2(0.0, time * 0.08)).a;
                float plumeWidth = 0.22 + rise * 0.36;
                float smkMask = smoothstep(plumeWidth, 0.04, abs(sd.x + rise * 0.25 + (sn - 0.5) * 0.32)) * pow(1.0 - rise, 0.58);
                float fireBase = smoothstep(0.28, 0.02, length(sd - vec2(0.0, -0.05)) - sn * 0.12);
                vfxAdditive += mix(vec3(0.98, 0.28, 0.03), vec3(1.0, 0.88, 0.42), fireBase) * fireBase * 1.55;
                vfxSmokeAlpha = max(vfxSmokeAlpha, clamp(smkMask * 0.82, 0.0, 0.86));
            }
        }
        if ((flags & 2) != 0) {
            vec2 muzDir = vec2(sin(d1.y), -cos(d1.y));
            vec2 muzPos = d0.xy + muzDir * 0.36 - vec2(0.0, 0.08);
            vec2 relM = groundCellXY - muzPos;
            float md = length(relM);
            if (md < 0.22) {
                vfxAdditive += vec3(1.0, 0.78, 0.30) * exp(-md * 28.0) * 1.65;
            }
            if (isShowcase) {
                // Showcase-only synthetic tracer streak (in live gameplay, actual BulletClass cat==5 projectiles render)
                float alongT = dot(relM, muzDir);
                float perpT  = length(relM - muzDir * clamp(alongT, 0.0, 1.85));
                if (alongT > 0.0 && alongT < 1.85 && perpT < 0.07) {
                    float pulseT = fract(alongT * 1.3 - time * 6.5);
                    float streak = exp(-perpT * 68.0) * smoothstep(0.05, 0.28, pulseT) * smoothstep(0.78, 0.32, pulseT);
                    vfxAdditive += vec3(1.0, 0.85, 0.42) * streak * 2.1;
                }
            }
        }

        // 5. Native-4K Tactical Selection Brackets & Health Bar (when IsSelected)
        if ((flags & 1) != 0) {
            vec2 selCenter = d0.xy - vec2(0.0, d0.z * 0.42 + ((cat == 1) ? 0.10 : 0.06));
            vec2 halfBox = (cat == 1)
                ? vec2(max(1, int(floor(d1.w)) & 7), max(1, (int(floor(d1.w)) >> 3) & 7)) * 0.48
                : ((cat == 2) ? vec2(0.24, 0.26) : vec2(0.42, 0.42));
            vec2 relSel = groundCellXY - selCenter;
            vec2 absSel = abs(relSel);

            // Corner selection brackets
            vec2 dEdge = abs(absSel - halfBox);
            bool onCornerX = (absSel.x > halfBox.x * 0.58 && absSel.x <= halfBox.x + 0.03 && dEdge.y < 0.028);
            bool onCornerY = (absSel.y > halfBox.y * 0.58 && absSel.y <= halfBox.y + 0.03 && dEdge.x < 0.028);
            if (onCornerX || onCornerY) {
                hudOverlay = vec4(0.95, 0.98, 1.0, 0.95);
            }

            // Crisp 4K Health Bar above selected unit/building
            vec2 barCenter = vec2(selCenter.x, selCenter.y - halfBox.y - 0.08);
            vec2 barHalf = vec2(halfBox.x * 0.85, 0.036);
            vec2 bRel = groundCellXY - barCenter;
            if (abs(bRel.x) <= barHalf.x && abs(bRel.y) <= barHalf.y) {
                float uBar = (bRel.x + barHalf.x) / (2.0 * barHalf.x);
                vec3 hCol = (health > 0.5)
                    ? mix(vec3(0.95, 0.82, 0.12), vec3(0.15, 0.92, 0.32), (health - 0.5) * 2.0)
                    : mix(vec3(0.92, 0.12, 0.10), vec3(0.95, 0.82, 0.12), health * 2.0);
                if (abs(bRel.x) > barHalf.x - 0.018 || abs(bRel.y) > barHalf.y - 0.012) {
                    hudOverlay = vec4(0.08, 0.10, 0.12, 0.95);
                } else if (uBar <= health) {
                    // Segmented LED health bar
                    float seg = step(0.18, fract(uBar * 12.0));
                    hudOverlay = vec4(hCol * (0.75 + 0.25 * seg), 0.95);
                } else {
                    hudOverlay = vec4(0.12, 0.14, 0.16, 0.85);
                }
            }
        }
    }

    // ------------------------------------------------------------------------
    // 7. Evaluate 3D Hit Material (if Ray Hit a 3D Crystal, Wall, Unit, Building, or Tree)
    // ------------------------------------------------------------------------
    vec3 N = terrainN;
    vec3 P = terrainPos;
    vec3 albedo = surfAlbedo;
    float roughness = surfRough;
    float metallic = surfMetal;
    vec3 emissive = waterEmissive;

    if (hitMat > 0) {
        N = hitNormal;
        P = hitPos;
        emissive = vec3(0.0);
        entityShadow = 0.0; // Top of 3D object isn't shadowed by its own ground footprint

        vec3 houseCol = getHouseTrimColor(hitHouse);
        float metalNoise = noise2D(hitLocal.xy * 24.0 + hitLocal.z * 12.0);

        if (hitMat == 10) {
            // 3D Faceted Emerald Tiberium Crystal
            albedo = vec3(0.08, 0.78, 0.28);
            roughness = 0.14;
            metallic = 0.25;
            float pulse = 0.75 + 0.25 * sin(time * 3.2 + P.x * 2.0 + P.y * 2.0);
            float rim = pow(1.0 - max(dot(N, V), 0.0), 2.2);
            emissive = vec3(0.08, 0.95, 0.35) * (0.42 + 0.65 * rim) * pulse;
        } else if (hitMat == 11) {
            // Sandbag Wall
            float bagSeam = sin(hitLocal.z * 55.0) * sin((hitLocal.x + hitLocal.y) * 28.0);
            albedo = vec3(0.64, 0.54, 0.36) * (0.85 + 0.25 * bagSeam);
            roughness = 0.88;
            metallic = 0.0;
        } else if (hitMat == 12) {
            // Cyclone / Razorwire Fence
            albedo = vec3(0.58, 0.62, 0.66);
            roughness = 0.35;
            metallic = 0.82;
        } else if (hitMat == 13 || hitMat == 24) {
            // Poured-Concrete Naval Pier, Seawall Caissons & Perimeter Revetment Walls (CnC-Ultra-Game.jpg)
            vec2 slabGrid = abs(fract(hitLocal.xy * 2.5) - 0.5);
            float slabSeam = smoothstep(0.45, 0.495, max(slabGrid.x, slabGrid.y));
            float vertRib  = sin(hitLocal.x * 22.0) * sin(hitLocal.y * 22.0);
            float wallButtress = smoothstep(0.28, 0.05, hitLocal.z) * (0.5 + 0.5 * vertRib);
            float wetBase  = smoothstep(0.11, 0.01, hitLocal.z);
            vec3 pierConc  = mix(vec3(0.24, 0.25, 0.26), vec3(0.35, 0.36, 0.37), metalNoise);
            pierConc = mix(pierConc, vec3(0.10, 0.11, 0.12), slabSeam * 0.72 + wallButtress * 0.38);
            pierConc = mix(pierConc, vec3(0.08, 0.09, 0.10), wetBase * 0.65);
            albedo = pierConc;
            roughness = mix(0.68, 0.22, wetBase);
            metallic = 0.12;
        } else if (hitMat == 14) {
            // Supply Crate
            albedo = vec3(0.55, 0.42, 0.24) * (0.85 + 0.3 * metalNoise);
            roughness = 0.55;
            metallic = 0.35;
        } else if (hitMat == 20) {
            // Armored Track / Road-Wheel Suspension Bogies & Steel Grousers
            float treadRib = step(0.45, fract((hitLocal.y + hitLocal.z) * 18.0));
            float wheelSpacing = (fract((hitLocal.y + 0.30) * 9.5) - 0.5) / 9.5;
            float wheelR = length(vec2(wheelSpacing, hitLocal.z - 0.048));
            float isWheel = smoothstep(0.042, 0.030, wheelR) * step(0.10, abs(hitLocal.x));
            albedo = mix(vec3(0.12, 0.13, 0.14), vec3(0.28, 0.30, 0.33), treadRib);
            albedo = mix(albedo, houseCol * 0.65, isWheel * 0.85);
            roughness = 0.56;
            metallic = 0.58;
        } else if (hitMat == 21) {
            // Vehicle Composite Hull Armor (House painted + weathered steel edges)
            float panel = smoothstep(0.42, 0.48, abs(fract(hitLocal.y * 5.0) - 0.5));
            albedo = mix(houseCol, vec3(0.24, 0.26, 0.28), panel * 0.45) * (0.88 + 0.24 * metalNoise);
            roughness = 0.34;
            metallic = 0.78;
            // Stealth Tank optical-camo shimmer
            if ((hitFlags & 4) != 0) {
                float shimmer = 0.5 + 0.5 * sin(time * 8.0 + P.x * 18.0 + P.y * 18.0);
                albedo = mix(surfAlbedo, vec3(0.35, 0.75, 0.95), 0.25 * shimmer);
                emissive = vec3(0.10, 0.35, 0.55) * shimmer * 0.35;
            }
        } else if (hitMat == 22) {
            // Turret, Gun Barrel, Open-Lattice Radio Tower & Industrial Steel
            float xBrace = 1.0;
            if (hitLocal.z > 0.35) {
                // Diagonal X-bracing steel truss pattern on tall communication towers
                float dX1 = abs(fract(hitLocal.z * 8.5 + (hitLocal.x + hitLocal.y) * 5.5) - 0.5);
                float dX2 = abs(fract(hitLocal.z * 8.5 - (hitLocal.x + hitLocal.y) * 5.5) - 0.5);
                xBrace = 0.55 + 0.55 * smoothstep(0.18, 0.04, min(dX1, dX2));
            }
            albedo = mix(houseCol * 0.82, vec3(0.26, 0.28, 0.31), 0.58) * (0.85 + 0.25 * metalNoise) * xBrace;
            roughness = 0.32;
            metallic = 0.82;
        } else if (hitMat == 23) {
            // Glowing Tiberium Hopper / Obelisk Ruby Crystal / Reactor Core
            bool isObelisk = (hitSubType == 3);
            vec3 glowCol = isObelisk ? vec3(1.0, 0.12, 0.18) : vec3(0.12, 0.96, 0.36);
            albedo = glowCol;
            roughness = 0.15;
            metallic = 0.5;
            emissive = glowCol * (1.25 + 0.45 * sin(time * 6.0));
        } else if (hitMat == 25) {
            // Structure Architectural Superstructure (Dark Weathered Industrial Concrete & Corrugated Steel + Firing Slits)
            float corrugation = 0.88 + 0.16 * sin((hitLocal.x + hitLocal.y) * 32.0);
            float panelSeam = smoothstep(0.44, 0.49, abs(fract(hitLocal.z * 7.5) - 0.5));
            float slitMask = step(0.72, fract((hitLocal.x + hitLocal.y) * 4.5)) * smoothstep(0.12, 0.15, hitLocal.z) * smoothstep(0.21, 0.18, hitLocal.z);
            vec3 indConcrete = mix(vec3(0.18, 0.19, 0.21), vec3(0.30, 0.31, 0.33), metalNoise) * corrugation;
            albedo = mix(indConcrete, houseCol * 0.72, 0.25) * (1.0 - 0.45 * panelSeam) * (1.0 - 0.75 * slitMask);
            if ((hitFlags & 8) != 0) {
                albedo *= 0.48; // Charred soot-blackened walls on burning compound structures
            }
            roughness = 0.62;
            metallic = 0.34;
            emissive = vec3(0.95, 0.62, 0.22) * slitMask * 0.18;
            if ((hitFlags & 16) != 0) {
                // Laser-scaffolding construction grid
                float scan = exp(-abs(hitLocal.z - 0.65 * clamp(uTac.view_params0.x, 0.0, 1.0)) * 24.0);
                emissive += vec3(0.20, 0.95, 0.45) * (0.35 + scan);
            }
        } else if (hitMat == 26) {
            // Tree Bark Trunk
            albedo = vec3(0.28, 0.19, 0.11) * (0.8 + 0.4 * metalNoise);
            roughness = 0.90;
            metallic = 0.0;
        } else if (hitMat == 27) {
            // 3D Weathered Coastal Pine & Scrub Foliage Canopy (with high-frequency branch/needle normal detail)
            float leafMicro = noise2D(P.xy * 42.0 + hitLocal.z * 28.0);
            float leafClump = fbm3(P.xy * 16.0);
            vec3 leafA = (theater == 3) ? vec3(0.68, 0.78, 0.86) : ((theater == 0) ? vec3(0.24, 0.30, 0.14) : vec3(0.09, 0.15, 0.07));
            vec3 leafB = (theater == 3) ? vec3(0.18, 0.30, 0.20) : ((theater == 0) ? vec3(0.38, 0.42, 0.18) : vec3(0.19, 0.27, 0.13));
            albedo = mix(leafA, leafB, smoothstep(-0.18, 0.22, hitLocal.z) * 0.55 + leafClump * 0.45) * (0.75 + 0.50 * leafMicro);
            N = normalize(N + vec3((leafMicro - 0.5) * 0.55, (leafClump - 0.5) * 0.55, 0.0));
            roughness = 0.86;
            metallic = 0.0;
        } else if (hitMat == 28) {
            // Outcrop Boulder Rock
            albedo = cliffCol * (0.82 + 0.35 * metalNoise);
            roughness = 0.74;
            metallic = 0.05;
        } else if (hitMat == 29) {
            // Infantry Combat Armor
            albedo = mix(houseCol, vec3(0.22, 0.24, 0.26), 0.35);
            roughness = 0.48;
            metallic = 0.45;
        }
    }

    // ------------------------------------------------------------------------
    // 8. Cook-Torrance GGX Directional Sun + Sky Ambient + 32 Dynamic Combat Lights
    // ------------------------------------------------------------------------
    float NdotL = max(dot(N, L), 0.0);
    float NdotV = max(dot(N, V), 0.001);
    float NdotH = max(dot(N, H), 0.0);
    float VdotH = max(dot(V, H), 0.0);

    float shadowVis = 1.0 - entityShadow;

    // GGX NDF & Fresnel
    float a2 = max(roughness * roughness * roughness * roughness, 0.002);
    float denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * denom * denom);
    vec3 F0 = mix(vec3(0.04), albedo, metallic);
    vec3 F  = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);
    vec3 kD = (vec3(1.0) - F) * (1.0 - metallic);

    vec3 sunColor = (theater == 3) ? vec3(1.05, 1.08, 1.15) : ((theater == 0) ? vec3(1.22, 1.08, 0.88) : vec3(1.15, 1.08, 0.95));
    vec3 skyAmb   = (theater == 3) ? vec3(0.28, 0.34, 0.44) : ((theater == 0) ? vec3(0.28, 0.24, 0.18) : vec3(0.22, 0.27, 0.32));

    vec3 directLight = (kD * albedo / PI + F * D * 0.25) * sunColor * NdotL * shadowVis;
    vec3 ambientLight = albedo * skyAmb * (0.55 + 0.45 * N.z);

    // Evaluate up to 31 Dynamic 3D Point Lights (Slot 31 is reserved for 3D Camera & First-Person State)
    int lightCount = clamp(int(uTac.view_params3.y), 0, 31);
    vec3 dynamicLight = vec3(0.0);
    for (int li = 0; li < 31; ++li) {
        if (li >= lightCount) break;
        vec4 lPosRad = uTac.light_pos_rad[li];
        vec4 lColInt = uTac.light_col_int[li];
        vec3 lVec = lPosRad.xyz - P;
        float dist = length(lVec);
        float rad = max(lPosRad.w, 0.1);
        if (dist < rad) {
            vec3 lDir = lVec / max(dist, 1e-4);
            float atten = pow(1.0 - dist / rad, 2.0) * lColInt.w;
            float nl = max(dot(N, lDir), 0.15);
            vec3 hL = normalize(V + lDir);
            float specL = pow(max(dot(N, hL), 0.0), mix(64.0, 8.0, roughness));
            dynamicLight += (albedo * nl + F0 * specL * 0.8) * lColInt.rgb * atten;
        }
    }

    // Local Tiberium ambient emerald bounce on nearby ground/units
    if ((cellOvl >= 1u && cellOvl <= 12u) || cellLand == 5u) {
        float tibStage = float(clamp(int(cellOvl), 1, 12)) / 12.0;
        dynamicLight += albedo * vec3(0.06, 0.65, 0.22) * tibStage * 0.35;
    }

    vec3 litColor = ambientLight + directLight + dynamicLight + emissive;

    // 3D Volumetric Overcast Coastal Sky Dome, Cumulus Clouds & Distant Mountain Silhouettes
    // Used in First-Person Mode (sky rays + distance fog) and Low-Angle 3D Orbital Tilt Mode
    if (isFirstPerson || orbitalHorizonMix > 0.001) {
        vec3 skyRay = isFirstPerson ? fpRayDir : normalize(vec3(sin(camYaw + (tacUV.x - 0.5) * 1.1), -cos(camYaw + (tacUV.x - 0.5) * 1.1), clamp((0.28 - tacUV.y) * 1.6, -0.1, 0.85)));
        float skyAz   = atan(skyRay.x, -skyRay.y);
        float skyElev = clamp(skyRay.z, -0.15, 1.0);
        vec3 zenithCol  = (theater == 0) ? vec3(0.24, 0.38, 0.56) : vec3(0.16, 0.24, 0.34);
        vec3 horizonCol = (theater == 0) ? vec3(0.68, 0.58, 0.46) : vec3(0.48, 0.53, 0.58);
        vec3 skyDome = mix(horizonCol, zenithCol, pow(clamp(skyElev * 1.6, 0.0, 1.0), 0.65));

        // Volumetric drifting coastal storm / cumulus clouds
        vec2 cloudUV = skyRay.xy / max(skyRay.z + 0.28, 0.12) * 1.6 + vec2(time * 0.018, -time * 0.012);
        float cNoise1 = fbm4(cloudUV * 1.8);
        float cNoise2 = fbm3(cloudUV * 4.2 + vec2(3.1, 1.7));
        float cloudMask = smoothstep(0.38, 0.76, cNoise1 * 0.68 + cNoise2 * 0.32) * smoothstep(-0.02, 0.14, skyElev);
        vec3 cloudLit = mix(vec3(0.28, 0.32, 0.37), vec3(0.76, 0.80, 0.84), smoothstep(0.35, 0.78, cNoise2));
        skyDome = mix(skyDome, cloudLit, cloudMask * 0.82);

        // Directional sun Mie scattering glow in sky
        float sunDot = clamp(dot(skyRay, L), 0.0, 1.0);
        skyDome += sunColor * (pow(sunDot, 12.0) * 0.32 + pow(sunDot, 64.0) * 0.55);

        // Distant jagged coastal mountain range silhouette along the horizon
        float mtnHeight = (fbm4(vec2(skyAz * 2.8 + 1.4, 2.3)) * 0.11 + fbm3(vec2(skyAz * 7.5, 5.1)) * 0.04) * 0.85;
        if (skyElev < mtnHeight && skyElev > -0.06) {
            float mtnShade = fbm3(vec2(skyAz * 14.0, skyElev * 28.0));
            vec3 mtnCol = mix(vec3(0.18, 0.21, 0.25), horizonCol * 0.88, clamp((mtnHeight - skyElev) * 6.0, 0.2, 0.85) + (mtnShade - 0.5) * 0.15);
            skyDome = mix(mtnCol, horizonCol, 0.45);
        }

        if (isFirstPerson) {
            if (!fpHitGround && hitMat == 0) {
                litColor = skyDome;
            } else {
                float hitDist = (hitMat > 0) ? fpBestT : fpGroundT;
                float fpFog = smoothstep(4.5, 21.5, hitDist);
                litColor = mix(litColor, skyDome, clamp(fpFog * 0.86, 0.0, 0.92));
            }
        } else {
            litColor = mix(litColor, skyDome, orbitalHorizonMix);
        }
    } else {
        // Photorealistic coastal atmospheric perspective & overcast horizon mist across upper screen (CnC-Ultra-Game.jpg)
        // Applied BEFORE foreground volumetric smoke & fire so the black smoke column rises vividly in front of the distant mist!
        float mistNoise = fbm3(globalCellXY * 0.72 + vec2(time * 0.08, -time * 0.04));
        float distFog = smoothstep(0.38, 0.0, vUV.y) * (0.24 + 0.44 * smoothstep(0.20, 0.0, vUV.y) + 0.14 * mistNoise);
        // Keep tall 3D communication towers & mountain ridges silhouetted clearly through the mist
        if ((hitMat > 0 && P.z > 0.32) || hGround > 0.28) {
            distFog *= 0.55;
        }
        litColor = mix(litColor, vec3(0.50, 0.54, 0.58), clamp(distFog, 0.0, 0.84));
    }

    // Composite roaring structure fire & overhanging 3D volumetric cauliflower smoke column in front of background mist!
    litColor += vfxAdditive * (1.0 - vfxSmokeAlpha * 0.58);
    if (vfxSmokeAlpha > 0.001) {
        litColor = mix(litColor, vfxSmokeColor, vfxSmokeAlpha);
    }

    // ------------------------------------------------------------------------
    // 8b. First-Person 3D Foreground Weapon / Tank Cannon Barrel & Gunner Optic HUD
    // ------------------------------------------------------------------------
    if (isFirstPerson) {
        // 1. 3D Foreground Main Battle Tank Cannon Barrel / Weapon extending from lower viewport into 3D space
        vec2 wUV = tacUV - vec2(0.5, 1.0); // Origin at bottom-center of viewport
        if (fpWeaponKind <= 1) {
            // 120mm Smoothbore Tank Cannon Barrel + Bore Evacuator + Mantlet Hood in lower-center/right
            vec2 bPos = vec2(wUV.x - 0.06 + wUV.y * 0.10, wUV.y); // Slight perspective convergence toward crosshair
            float barrelLen = -0.36; // Extends 36% up the screen toward the center reticle
            if (bPos.y > barrelLen && bPos.y <= 0.0) {
                float tB = clamp(-bPos.y / 0.36, 0.0, 1.0); // 0 at bottom mantlet, 1 at muzzle tip
                float halfW = mix(0.052, 0.016, pow(tB, 0.72));
                // Bore evacuator (fume extractor) bulge mid-barrel
                if (tB > 0.42 && tB < 0.68) {
                    halfW *= 1.32;
                } else if (tB > 0.90) {
                    halfW *= 1.18; // Muzzle reference sensor collar
                }
                if (abs(bPos.x) < halfW) {
                    float cylX = bPos.x / max(halfW, 1e-4);
                    float cylZ = sqrt(max(0.05, 1.0 - cylX * cylX));
                    vec3 bNorm = normalize(vec3(cylX * 0.85, -0.25, cylZ));
                    float bDiff = max(dot(bNorm, L), 0.15);
                    float bSpec = pow(max(dot(bNorm, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 28.0);
                    float flute = 0.90 + 0.10 * sin(tB * 65.0);
                    vec3 gunCol = mix(vec3(0.24, 0.22, 0.17), vec3(0.14, 0.15, 0.16), step(0.42, tB) * step(tB, 0.68));
                    vec3 shadedGun = gunCol * flute * (0.32 + 0.78 * bDiff) + vec3(0.85, 0.82, 0.74) * bSpec * 0.45;
                    litColor = shadedGun;
                }
            }
            // Armored Commander Cupola / Turret Glacis Deck along bottom edge
            float deckH = -0.055 + 0.025 * cos((tacUV.x - 0.5) * 5.0);
            if (wUV.y > deckH) {
                float edgeBevel = smoothstep(deckH, deckH + 0.012, wUV.y);
                litColor = mix(vec3(0.32, 0.30, 0.24), vec3(0.11, 0.12, 0.13), edgeBevel);
            }
        } else if (fpWeaponKind == 2) {
            // Infantry First-Person Assault Rifle in lower-right hand position
            vec2 rPos = tacUV - vec2(0.68, 1.0);
            float rAlong = -rPos.y;
            float rAcross = rPos.x + rAlong * 0.42;
            if (rAlong > 0.0 && rAlong < 0.34 && abs(rAcross) < mix(0.048, 0.014, rAlong / 0.34)) {
                float cylX = rAcross / mix(0.048, 0.014, rAlong / 0.34);
                vec3 rCol = vec3(0.13, 0.14, 0.15) * (0.55 + 0.45 * sqrt(max(0.0, 1.0 - cylX * cylX)));
                litColor = rCol;
            }
        }
    }

    // ------------------------------------------------------------------------
    // 9. 3D Holographic Building Placement Grid & Rubber-Band Selection Box
    // ------------------------------------------------------------------------
    if (cellCursor != 0u && !isFirstPerson) {
        vec2 cUV = fract(displacedCellXY);
        vec2 edgeD = min(cUV, 1.0 - cUV);
        float border = smoothstep(0.09, 0.02, min(edgeD.x, edgeD.y));
        float diag = step(0.5, fract((cUV.x + cUV.y) * 4.0 - time * 1.5));
        vec3 padCol = (cellCursor == 1u) ? vec3(0.12, 0.98, 0.38) : vec3(1.0, 0.14, 0.12);
        float padAlpha = 0.25 + 0.55 * border + 0.12 * diag;
        litColor = mix(litColor, padCol, clamp(padAlpha, 0.0, 0.85));
    }

    // Composite 4K Selection Brackets & Health Bars
    if (hudOverlay.a > 0.01) {
        litColor = mix(litColor, hudOverlay.rgb, hudOverlay.a);
    }

    // Composite 4K Glowing Rubber-Band Drag Selection Box
    vec4 bandRect = uTac.overlay_rects[0];
    if (bandRect.z > bandRect.x && bandRect.w > bandRect.y) {
        vec2 bMin = min(bandRect.xy, bandRect.zw);
        vec2 bMax = max(bandRect.xy, bandRect.zw);
        if (vUV.x >= bMin.x && vUV.x <= bMax.x && vUV.y >= bMin.y && vUV.y <= bMax.y) {
            vec2 dPx = min(vUV - bMin, bMax - vUV) * vec2(640.0, 400.0);
            float edge = min(dPx.x, dPx.y);
            if (edge < 1.6) {
                litColor = mix(litColor, vec3(0.85, 0.98, 1.0), 0.92);
            } else {
                litColor = mix(litColor, vec3(0.35, 0.82, 1.0), 0.10);
            }
        }
    }

    // ------------------------------------------------------------------------
    // 10. Atmospheric Reconnaissance Fog-of-War & ACES Filmic Tone Mapping
    // ------------------------------------------------------------------------
    float vis = terrainFields.w; // 0.0 = Unmapped Reconnaissance Fog, 1.0 = Fully Visible
    if (vis < 0.99 && !isFirstPerson) {
        // Instead of pitch-black void hiding the 3D coastal terrain, render unmapped cells as moody
        // twilight reconnaissance mist so 3D cliffs, roads & crashing surf remain visible across the screen
        float shroudNoise = fbm3(globalCellXY * 1.8 + vec2(time * 0.14, -time * 0.09));
        float shroudFactor = smoothstep(0.05, 0.85, vis + (shroudNoise - 0.5) * 0.22);
        vec3 reconFog = mix(litColor * 0.68, vec3(0.18, 0.22, 0.26) * (0.75 + 0.35 * shroudNoise), 0.28);
        litColor = mix(reconFog, litColor, shroudFactor);
    }

    // ACES Filmic Tone Mapping & Subtle Contrast Grading
    vec3 x = max(vec3(0.0), litColor);
    vec3 mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
    mapped = pow(clamp(mapped, 0.0, 1.0), vec3(0.92));

    // Cast subtle 3D contact shadow from Right Command Dock onto battlefield
    float sideShadow = (tacRect.z < 0.99) ? smoothstep(0.0, 6.5, (tacRect.z - vUV.x) * 640.0) : 1.0;
    mapped *= (0.55 + 0.45 * sideShadow);

    // ------------------------------------------------------------------------
    // 10b. Sleek Dark-Slate Corner Tactical HUD Cards & 3D Camera / 1st-Person Optic HUD
    // ------------------------------------------------------------------------
    vec2 px = vUV * vec2(640.0, 400.0);
    vec3 hudBg     = vec3(0.086, 0.098, 0.114);
    vec3 hudSlot   = vec3(0.118, 0.134, 0.154);
    vec3 hudBorder = vec3(0.225, 0.252, 0.282);

    if (isFirstPerson && dlgRect.z <= dlgRect.x) {
        // Illuminated Military Tank Gunner / Visor Optic Reticle in Viewport Center
        vec2 vpCenterPx = 0.5 * (tacRect.xy + tacRect.zw) * vec2(640.0, 400.0);
        vec2 cRel = px - vpCenterPx;
        float rDist = length(cRel);
        vec3 opticCol = (hitMat >= 20 && hitHouse == 1) ? vec3(1.0, 0.24, 0.18) : vec3(0.24, 0.96, 0.48);

        // Outer rangefinder ring + stadia mil-dots + center chevron
        float ringMask = smoothstep(0.95, 0.2, abs(rDist - 46.0)) * step(6.0, min(abs(cRel.x), abs(cRel.y)));
        float crossH   = smoothstep(0.75, 0.1, abs(cRel.y)) * step(8.0, abs(cRel.x)) * step(abs(cRel.x), 68.0);
        float crossV   = smoothstep(0.75, 0.1, abs(cRel.x)) * step(8.0, abs(cRel.y)) * step(abs(cRel.y), 52.0);
        float ticksH   = smoothstep(0.75, 0.1, abs(mod(abs(cRel.x) - 8.0, 12.0))) * step(abs(cRel.y), 3.2) * step(12.0, abs(cRel.x)) * step(abs(cRel.x), 64.0);
        float chev     = smoothstep(0.85, 0.15, abs(abs(cRel.x) * 0.85 - (cRel.y - 1.5))) * step(cRel.y, 6.5) * step(1.5, cRel.y);
        float reticleAlpha = clamp((ringMask * 0.55 + (crossH + crossV) * 0.65 + ticksH * 0.75 + chev * 0.95), 0.0, 1.0);
        mapped = mix(mapped, opticCol, reticleAlpha * 0.82);

        // Top-Center Azimuth Compass Tape & "1ST PERSON VIEW [V EXIT]" Status Pill
        vec2 pillMin = vec2(vpCenterPx.x - 86.0, 20.0);
        vec2 pillMax = vec2(vpCenterPx.x + 86.0, 42.0);
        if (px.x >= pillMin.x && px.x <= pillMax.x && px.y >= pillMin.y && px.y <= pillMax.y) {
            vec2 dIn = min(px - pillMin, pillMax - px);
            float edge = min(dIn.x, dIn.y);
            vec3 pCol = (edge < 1.1) ? opticCol * 0.85 : hudBg * 0.92;
            float tickX = mod(px.x - vpCenterPx.x + camYaw * 57.2958 * 1.5, 12.0);
            if (px.y > 35.5 && abs(tickX - 6.0) < 0.7) {
                pCol = opticCol * 0.75;
            }
            // "1ST PERSON VIEW [WASD/V]"
            int fpHdr[23] = int[23](49,83,84,32,80,69,82,83,79,78,32,86,73,69,87,32,91,87,65,83,68,47,86);
            vec2 tRel = px - vec2(pillMin.x + 12.0, pillMin.y + 4.5);
            if (tRel.x >= 0.0 && tRel.y >= 0.0 && tRel.y < 6.0) {
                int ci = int(floor(tRel.x / 6.4));
                if (ci >= 0 && ci < 23 && fpHdr[ci] != 32) {
                    float g = sampleGlyph3x5(fpHdr[ci], vec2(tRel.x - float(ci) * 6.4, tRel.y), 1.15);
                    pCol = mix(pCol, opticCol, g);
                }
            }
            mapped = mix(mapped, pCol, 0.88);
        }
    } else if (isCam3D && dlgRect.z <= dlgRect.x) {
        // Sleek Top-Center 3D Orbital Camera Telemetry Pill ("3D CAM [V:1ST-PERSON | HOME:RESET]")
        vec2 vpCenterPx = 0.5 * (tacRect.xy + tacRect.zw) * vec2(640.0, 400.0);
        vec2 pillMin = vec2(vpCenterPx.x - 74.0, 20.0);
        vec2 pillMax = vec2(vpCenterPx.x + 74.0, 34.0);
        if (px.x >= pillMin.x && px.x <= pillMax.x && px.y >= pillMin.y && px.y <= pillMax.y) {
            vec2 dIn = min(px - pillMin, pillMax - px);
            float edge = min(dIn.x, dIn.y);
            vec3 pCol = (edge < 1.1) ? hudBorder * 1.25 : hudBg * 0.90;
            int camHdr[20] = int[20](51,68,32,79,82,66,73,84,65,76,32,67,65,77,32,91,86,47,72,77);
            vec2 tRel = px - vec2(pillMin.x + 10.0, pillMin.y + 4.0);
            if (tRel.x >= 0.0 && tRel.y >= 0.0 && tRel.y < 6.0) {
                int ci = int(floor(tRel.x / 6.4));
                if (ci >= 0 && ci < 20 && camHdr[ci] != 32) {
                    float g = sampleGlyph3x5(camHdr[ci], vec2(tRel.x - float(ci) * 6.4, tRel.y), 1.10);
                    pCol = mix(pCol, vec3(0.38, 0.94, 0.54), g);
                }
            }
            mapped = mix(mapped, pCol, 0.86);
        }
    }

    if (dlgRect.z <= dlgRect.x) {
        // ====================================================================
        // CARD 1: TOP-LEFT FLOATING RESOURCE & TELEMETRY BAR (px in [4..228, 3..27])
        // ====================================================================
        if (px.x >= 2.0 && px.x <= 232.0 && px.y >= 1.0 && px.y <= 31.0) {
            vec2 bMin = vec2(4.0, 3.0);
            vec2 bMax = vec2(228.0, 27.0);
            vec2 dOut = max(bMin - px, px - bMax);
            float distOut = length(max(dOut, vec2(0.0)));
            if (distOut > 0.0) {
                mapped *= mix(0.45, 1.0, smoothstep(0.0, 4.0, distOut));
            } else {
                vec2 dIn = min(px - bMin, bMax - px);
                float edge = min(dIn.x, dIn.y);
                vec3 cardCol = (edge < 1.2) ? hudBorder * 1.18 : hudBg;

                // Module dividers at x = 62, 118, 174
                if (abs(px.x - 62.0) < 0.6 || abs(px.x - 118.0) < 0.6 || abs(px.x - 174.0) < 0.6) {
                    cardCol = hudBorder * 0.85;
                }

                int credits  = int(uTac.hud_telemetry[0].x + 0.5);
                int powerOut = int(uTac.hud_telemetry[0].y + 0.5);
                int powerDrn = int(uTac.hud_telemetry[0].z + 0.5);
                int curUnits = int(uTac.hud_telemetry[0].w + 0.5);
                int maxUnits = int(uTac.hud_telemetry[1].x + 0.5);
                int tiberium = int(uTac.hud_telemetry[1].y + 0.5);
                int netPower = max(0, powerOut - powerDrn);

                // 1. Stacked Silver/Steel Coins Icon at (12, 15) + Credits + "+510"
                float c1 = length((px - vec2(12.5, 17.5)) * vec2(1.0, 1.4)) - 4.2;
                float c2 = length((px - vec2(12.5, 14.0)) * vec2(1.0, 1.4)) - 4.2;
                float c3 = length((px - vec2(12.5, 10.5)) * vec2(1.0, 1.4)) - 4.2;
                if (min(c1, min(c2, c3)) < 0.0) {
                    cardCol = mix(vec3(0.54, 0.59, 0.65), vec3(0.84, 0.88, 0.92), smoothstep(0.0, -2.0, min(c1, min(c2, c3))));
                }
                float txtCred = drawHudNumber(px, vec2(20.0, 6.5), credits, false, 1.35);
                float txtCredRate = drawHudNumber(px, vec2(20.0, 16.5), 510, true, 1.05);
                cardCol = mix(cardCol, vec3(0.95, 0.97, 1.0), txtCred);
                cardCol = mix(cardCol, vec3(0.28, 0.88, 0.42), txtCredRate);

                // 2. Silver Lightning Bolt Icon at (70, 15) + Power + "+surplus"
                vec2 lp = px - vec2(70.5, 15.0);
                float bolt = step(abs(lp.y), 6.5) * step(abs(lp.x - lp.y * 0.25 + sign(lp.y) * 1.1), 1.8);
                cardCol = mix(cardCol, vec3(0.76, 0.82, 0.88), bolt);
                float txtPow = drawHudNumber(px, vec2(77.0, 6.5), powerOut, false, 1.35);
                float txtPowRate = drawHudNumber(px, vec2(77.0, 16.5), netPower, true, 1.05);
                cardCol = mix(cardCol, vec3(0.95, 0.97, 1.0), txtPow);
                cardCol = mix(cardCol, vec3(0.28, 0.88, 0.42), txtPowRate);

                // 3. 3-Person Squad Silhouette Icon at (125, 15) + Single-line Force Count "78/90"
                float headC = length(px - vec2(125.0, 10.5)) - 2.0;
                float bodyC = length((px - vec2(125.0, 16.8)) * vec2(1.0, 0.8)) - 3.1;
                float headL = length(px - vec2(121.2, 11.8)) - 1.6;
                float bodyL = length((px - vec2(121.2, 17.2)) * vec2(1.1, 0.85)) - 2.5;
                float headR = length(px - vec2(128.8, 11.8)) - 1.6;
                float bodyR = length((px - vec2(128.8, 17.2)) * vec2(1.1, 0.85)) - 2.5;
                if (min(min(headC, bodyC), min(min(headL, bodyL), min(headR, bodyR))) < 0.0) {
                    cardCol = vec3(0.72, 0.78, 0.84);
                }
                float txtForce = drawHudNumber(px, vec2(132.0, 10.5), curUnits, false, 1.30);
                float slashOff = (curUnits >= 10) ? 144.0 : 138.5;
                float txtSlash = sampleGlyph3x5(47, px - vec2(slashOff, 10.5), 1.30);
                float txtCap   = drawHudNumber(px, vec2(slashOff + 5.8, 10.5), maxUnits, false, 1.30);
                cardCol = mix(cardCol, vec3(0.95, 0.97, 1.0), max(txtForce, max(txtSlash, txtCap)));

                // 4. Emerald Teardrop / Bio-Tiberium Drop Icon at (182, 15) + Tiberium + "+15"
                vec2 dp = px - vec2(182.0, 15.5);
                float dropR = length(vec2(dp.x * 1.25, dp.y - max(0.0, -dp.y * 0.35))) - 4.4;
                if (dropR < 0.0) {
                    cardCol = mix(vec3(0.14, 0.68, 0.32), vec3(0.38, 0.96, 0.54), smoothstep(0.0, -2.5, dropR));
                }
                float txtTib = drawHudNumber(px, vec2(189.0, 6.5), tiberium, false, 1.35);
                float txtTibRate = drawHudNumber(px, vec2(189.0, 16.5), 15, true, 1.05);
                cardCol = mix(cardCol, vec3(0.95, 0.97, 1.0), txtTib);
                cardCol = mix(cardCol, vec3(0.28, 0.88, 0.42), txtTibRate);

                mapped = mix(mapped, cardCol, 0.92);
            }
        }

        // ====================================================================
        // CARD 2: TOP-RIGHT FLOATING "OBJECTIVES" CARD
        // Shifts neatly to the left of the Top-Right Framed Satellite Minimap
        // ====================================================================
        float objX0 = (tacRect.z > 0.95) ? 430.0 : 378.0;
        float objX1 = (tacRect.z > 0.95) ? 536.0 : 476.0;
        if (px.x >= objX0 - 2.0 && px.x <= objX1 + 2.0 && px.y >= 1.0 && px.y <= 59.0) {
            vec2 bMin = vec2(objX0, 3.0);
            vec2 bMax = vec2(objX1, 56.0);
            vec2 dOut = max(bMin - px, px - bMax);
            float distOut = length(max(dOut, vec2(0.0)));
            if (distOut > 0.0) {
                mapped *= mix(0.50, 1.0, smoothstep(0.0, 3.5, distOut));
            } else {
                vec2 dIn = min(px - bMin, bMax - px);
                float edge = min(dIn.x, dIn.y);
                vec3 cardCol = (edge < 1.1) ? hudBorder * 1.15 : hudBg;

                // Header "OBJECTIVES" (O=79,B=66,J=74,E=69,C=67,T=84,I=73,V=86,E=69,S=83)
                int objHdr[10] = int[10](79, 66, 74, 69, 67, 84, 73, 86, 69, 83);
                vec2 hRel = px - vec2(objX0 + 6.0, 7.5);
                if (hRel.x >= 0.0 && hRel.y >= 0.0 && hRel.y < 6.0) {
                    int ci = int(floor(hRel.x / 4.5));
                    if (ci >= 0 && ci < 10) {
                        float g = sampleGlyph3x5(objHdr[ci], vec2(hRel.x - float(ci) * 4.5, hRel.y), 1.1);
                        cardCol = mix(cardCol, vec3(0.92, 0.95, 0.98), g);
                    }
                }
                if (abs(px.y - 16.5) < 0.5 && px.x >= objX0 + 5.0 && px.x <= objX1 - 5.0) {
                    cardCol = hudBorder * 0.85;
                }

                // 3 Readable Tactical Objective Lines:
                // Row 0: "DESTROY ENEMY BASE"
                // Row 1: "SECURE BEACHHEAD"
                // Row 2: "PROTECT MCV CONVOY"
                int line0[18] = int[18](68,69,83,84,82,79,89,32,69,78,69,77,89,32,66,65,83,69);
                int line1[16] = int[16](83,69,67,85,82,69,32,66,69,65,67,72,72,69,65,68);
                int line2[18] = int[18](80,82,79,84,69,67,84,32,77,67,86,32,67,79,78,86,79,89);
                for (int r = 0; r < 3; ++r) {
                    float ry = 22.0 + float(r) * 11.0;
                    float dotD = length(px - vec2(objX0 + 7.5, ry + 2.2)) - 1.3;
                    if (dotD < 0.0) {
                        cardCol = (r == 0) ? vec3(0.28, 0.90, 0.44) : vec3(0.68, 0.74, 0.80);
                    }
                    vec2 tRel = px - vec2(objX0 + 12.0, ry);
                    if (tRel.x >= 0.0 && tRel.y >= 0.0 && tRel.y < 5.0) {
                        int ci = int(floor(tRel.x / 3.6));
                        int ch = 32;
                        if (r == 0 && ci >= 0 && ci < 18) ch = line0[ci];
                        else if (r == 1 && ci >= 0 && ci < 16) ch = line1[ci];
                        else if (r == 2 && ci >= 0 && ci < 18) ch = line2[ci];
                        if (ch != 32) {
                            float g = sampleGlyph3x5(ch, vec2(tRel.x - float(ci) * 3.6, tRel.y), 0.88);
                            cardCol = mix(cardCol, vec3(0.80, 0.84, 0.88), g);
                        }
                    }
                }

                mapped = mix(mapped, cardCol, 0.88);
            }
        }

        // ====================================================================
        // CARD 2B: TOP-RIGHT FRAMED SATELLITE MINIMAP (when C&C sidebar is closed)
        // Edge-to-edge coastal satellite terrain minimap matching CnC-Ultra-Game.jpg
        // ====================================================================
        if (tacRect.z > 0.95 && px.x >= 538.0 && px.x <= 638.0 && px.y >= 1.0 && px.y <= 98.0) {
            vec2 bMin = vec2(540.0, 3.0);
            vec2 bMax = vec2(636.0, 95.0);
            vec2 dOut = max(bMin - px, px - bMax);
            float distOut = length(max(dOut, vec2(0.0)));
            if (distOut > 0.0) {
                mapped *= mix(0.42, 1.0, smoothstep(0.0, 4.0, distOut));
            } else {
                vec2 dIn = min(px - bMin, bMax - px);
                float edge = min(dIn.x, dIn.y);
                vec3 cardCol = (edge < 1.3) ? hudBorder * 1.22 : hudBg;

                // Satellite Minimap Screen (px in [543..633, 6..92])
                if (px.x >= 543.0 && px.x <= 633.0 && px.y >= 6.0 && px.y <= 92.0) {
                    vec2 rUV = (px - vec2(543.0, 6.0)) / vec2(90.0, 86.0);
                    vec2 pEdge = min(px - vec2(543.0, 6.0), vec2(633.0, 92.0) - px);
                    if (min(pEdge.x, pEdge.y) < 1.0) {
                        cardCol = hudBorder * 1.15;
                    } else {
                        // Sculpt high-detail satellite coastal peninsula, inlets & islands matching CnC-Ultra-Game.jpg
                        float mTopo = fbm4(rUV * 7.5 + vec2(2.1, 4.3));
                        float mFine = fbm3(rUV * 16.0 + vec2(5.4, 1.2));
                        float mDetail = texture(uPbrTex, rUV * 0.45).r;
                        // Winding central fjord/channel + eastern coves + top-left inlet
                        float channelCenter = 0.42 + 0.14 * sin(rUV.y * 5.8 + 0.4) - (rUV.y - 0.5) * 0.24 + (mTopo - 0.5) * 0.18;
                        float riverDist = abs(rUV.x - channelCenter) - (0.055 + 0.045 * mFine);
                        float eastCoast = (0.78 + 0.10 * sin(rUV.y * 7.2 + mTopo * 2.5)) - rUV.x;
                        float nwInlet   = length((rUV - vec2(0.06, 0.24)) * vec2(1.4, 0.9)) - (0.18 + 0.06 * mTopo);
                        float seCove    = length((rUV - vec2(0.66, 0.90)) * vec2(1.1, 1.3)) - (0.19 + 0.05 * mTopo);
                        float landSDF   = min(min(riverDist, eastCoast), min(nwInlet, seCove));
                        bool isSatWater = (landSDF < 0.0);

                        vec3 satWater = mix(vec3(0.07, 0.11, 0.16), vec3(0.12, 0.17, 0.23), mTopo);
                        vec3 satGrass = mix(vec3(0.17, 0.24, 0.11), vec3(0.28, 0.36, 0.16), mFine);
                        vec3 satRock  = mix(vec3(0.22, 0.22, 0.21), vec3(0.35, 0.34, 0.32), mDetail);
                        vec3 satCol   = isSatWater ? satWater : mix(satRock, satGrass, smoothstep(0.32, 0.62, mTopo + mFine * 0.25));
                        // Crisp dark coastline contour & topographic ridge lines
                        if (abs(landSDF) < 0.014) satCol *= 0.38;
                        else if (!isSatWater && abs(fract(mTopo * 5.0) - 0.5) < 0.06) satCol *= 0.82;

                        // Live unit blips + tactical sector clusters on satellite minimap (Green GDI & Red Nod)
                        for (int ui = 0; ui < 48; ++ui) {
                            if (ui >= entCount) break;
                            vec4 ud0 = uTac.ent_data0[ui];
                            int uPack = int(floor(ud0.w + 0.5));
                            int uCat = uPack & 7;
                            int uHouse = (uPack >> 10) & 7;
                            if (uCat > 2) continue;
                            vec2 uUV = clamp(ud0.xy / vec2(24.0, 16.0), vec2(0.06), vec2(0.94));
                            if (length((rUV - uUV) * vec2(90.0, 86.0)) < 1.55) {
                                satCol = (uHouse == 1) ? vec3(0.94, 0.16, 0.12) : vec3(0.36, 0.90, 0.22);
                            }
                        }
                        // Strategic theatre blips across the wider peninsula (matching CnC-Ultra-Game.jpg minimap density)
                        vec2 blipGrid = rUV * vec2(26.0, 24.0);
                        vec2 bCell = floor(blipGrid);
                        vec2 bSub  = fract(blipGrid) - vec2(0.5);
                        float bHash = hash12(bCell + vec2(7.3, 2.9));
                        if (!isSatWater && bHash > 0.78 && length(bSub) < 0.34) {
                            bool isRedCluster = (length(rUV - vec2(0.72, 0.22)) < 0.18) || (length(rUV - vec2(0.18, 0.72)) < 0.18) || (bHash > 0.91);
                            satCol = isRedCluster ? vec3(0.94, 0.16, 0.12) : vec3(0.36, 0.90, 0.22);
                        }

                        // White camera viewport rectangle in lower-right quadrant (matching CnC-Ultra-Game.jpg)
                        vec2 vBox = abs(rUV - vec2(0.76, 0.67)) - vec2(0.16, 0.13);
                        if (abs(max(vBox.x, vBox.y)) < 0.012) {
                            satCol = vec3(0.94, 0.96, 0.98);
                        }
                        cardCol = satCol;
                    }
                }

                mapped = mix(mapped, cardCol, 0.96);
            }
        }

        // ====================================================================
        // CARD 3: BOTTOM-LEFT SELECTED UNIT INSPECTOR CARD (px in [4..164, 306..396])
        // ====================================================================
        if (px.x >= 2.0 && px.x <= 168.0 && px.y >= 303.0 && px.y <= 399.0) {
            vec2 bMin = vec2(4.0, 306.0);
            vec2 bMax = vec2(164.0, 396.0);
            vec2 dOut = max(bMin - px, px - bMax);
            float distOut = length(max(dOut, vec2(0.0)));
            if (distOut > 0.0) {
                mapped *= mix(0.42, 1.0, smoothstep(0.0, 4.0, distOut));
            } else {
                vec2 dIn = min(px - bMin, bMax - px);
                float edge = min(dIn.x, dIn.y);
                vec3 cardCol = (edge < 1.3) ? hudBorder * 1.22 : hudBg;

                int selPackedType = int(uTac.hud_telemetry[1].z + 0.5);
                float selHp = clamp(uTac.hud_telemetry[1].w, 0.01, 1.0);

                // A. Left 3D Studio Unit Portrait Box (px in [8..66, 310..368])
                if (px.x >= 8.0 && px.x <= 66.0 && px.y >= 310.0 && px.y <= 368.0) {
                    vec2 pEdge = min(px - vec2(8.0, 310.0), vec2(66.0, 368.0) - px);
                    if (min(pEdge.x, pEdge.y) < 1.1) {
                        cardCol = hudBorder * 1.15;
                    } else {
                        vec2 uvBox = (px - vec2(8.0, 310.0)) / 58.0;
                        cardCol = renderUnitPortrait3D(uvBox, selPackedType, time);
                    }
                }
                // B. Right Unit Telemetry Column (px in [70..160, 310..368])
                else if (px.x >= 70.0 && px.x <= 160.0 && px.y >= 310.0 && px.y <= 368.0) {
                    // Row 1: Live Selected Unit Name from uTac.hud_chars[0..1]
                    float nameMask = drawHudPackedStr(px, vec2(71.0, 312.0), 0, 18, 1.15);
                    cardCol = mix(cardCol, vec3(0.96, 0.98, 1.0), nameMask);

                    // Row 2: Live Role Subtitle from uTac.hud_chars[2..3]
                    float roleMask = drawHudPackedStr(px, vec2(71.0, 321.5), 2, 20, 0.95);
                    cardCol = mix(cardCol, vec3(0.62, 0.67, 0.72), roleMask);

                    // Row 3: "HEALTH:" + live percentage
                    int hpLbl[7] = int[7](72, 69, 65, 76, 84, 72, 58); // HEALTH:
                    vec2 hpRel = px - vec2(71.0, 333.0);
                    if (hpRel.x >= 0.0 && hpRel.y >= 0.0 && hpRel.y < 5.5) {
                        int ci = int(floor(hpRel.x / 4.0));
                        if (ci >= 0 && ci < 7) {
                            float g = sampleGlyph3x5(hpLbl[ci], vec2(hpRel.x - float(ci) * 4.0, hpRel.y), 1.0);
                            cardCol = mix(cardCol, vec3(0.78, 0.82, 0.86), g);
                        }
                    }
                    int hpPct = clamp(int(selHp * 100.0 + 0.5), 1, 100);
                    float pctMask = drawHudNumber(px, vec2(102.0, 333.0), hpPct, false, 1.0);
                    float pctSym  = sampleGlyph3x5(37, px - vec2(115.0, 333.0), 1.0);
                    cardCol = mix(cardCol, vec3(0.95, 0.98, 1.0), max(pctMask, pctSym));

                    // Row 4: Glowing Green Health Bar (px in [71..157, 342..348])
                    if (px.x >= 71.0 && px.x <= 157.0 && px.y >= 342.0 && px.y <= 348.0) {
                        float uBar = (px.x - 71.0) / 86.0;
                        vec2 hbEdge = min(px - vec2(71.0, 342.0), vec2(157.0, 348.0) - px);
                        if (min(hbEdge.x, hbEdge.y) < 0.9) {
                            cardCol = hudBorder;
                        } else if (uBar <= selHp) {
                            vec3 hCol = (selHp > 0.5)
                                ? mix(vec3(0.92, 0.78, 0.16), vec3(0.22, 0.86, 0.38), (selHp - 0.5) * 2.0)
                                : mix(vec3(0.90, 0.18, 0.14), vec3(0.92, 0.78, 0.16), selHp * 2.0);
                            cardCol = hCol * (0.85 + 0.15 * step(0.2, fract(uBar * 14.0)));
                        } else {
                            cardCol = vec3(0.05, 0.06, 0.07);
                        }
                    }

                    // Row 5: "VETERANCY: REGULAR"
                    int vetLbl[18] = int[18](86, 69, 84, 69, 82, 65, 78, 67, 89, 58, 32, 82, 69, 71, 85, 76, 65, 82);
                    vec2 vRel = px - vec2(71.0, 354.0);
                    if (vRel.x >= 0.0 && vRel.y >= 0.0 && vRel.y < 5.5) {
                        int ci = int(floor(vRel.x / 3.8));
                        if (ci >= 0 && ci < 18 && vetLbl[ci] != 32) {
                            float g = sampleGlyph3x5(vetLbl[ci], vec2(vRel.x - float(ci) * 3.8, vRel.y), 0.95);
                            vec3 vCol = (ci >= 11) ? vec3(0.88, 0.92, 0.96) : vec3(0.58, 0.63, 0.68);
                            cardCol = mix(cardCol, vCol, g);
                        }
                    }
                }
                // C. Bottom Row of 6 Tactical Subsystem Icon Squares (px in [8..158, 372..392], matching CnC-Ultra-Game.jpg)
                else if (px.x >= 8.0 && px.x < 158.0 && px.y >= 372.0 && px.y <= 392.0) {
                    float relX = px.x - 8.0;
                    int boxIdx = int(floor(relX / 25.0));
                    float boxX = relX - float(boxIdx) * 25.0;
                    float boxY = px.y - 372.0;
                    if (boxIdx >= 0 && boxIdx < 6 && boxX <= 23.0) {
                        float bEdge = min(min(boxX, 23.0 - boxX), min(boxY, 20.0 - boxY));
                        if (bEdge < 1.1) {
                            cardCol = hudBorder * 1.15;
                        } else {
                            cardCol = hudSlot;
                            vec2 ic = (vec2(boxX, boxY) - vec2(11.5, 10.0)) / 7.5;
                            float glyph = 0.0;
                            if (boxIdx == 0) {
                                // 3 Vertical Pointed Cannon Shells / Ammo Rounds side-by-side (|||)
                                float sx = mod(ic.x + 0.60, 0.40) - 0.20;
                                float in3 = step(abs(ic.x), 0.56);
                                float tipW = mix(0.11, 0.01, clamp((-ic.y - 0.15) / 0.55, 0.0, 1.0));
                                float shellD = max(abs(sx) - tipW, abs(ic.y) - 0.68);
                                float band = step(0.06, abs(ic.y - 0.22));
                                glyph = smoothstep(0.05, -0.02, shellD) * in3 * band;
                            } else if (boxIdx == 1) {
                                // Sloped Composite Armor Vest / Reactive Plate with shoulder straps & center bevel
                                float body = max(abs(ic.x) - (0.54 - max(0.0, -ic.y - 0.15) * 0.35), abs(ic.y) - 0.62);
                                float neck = length(ic - vec2(0.0, -0.62)) - 0.22;
                                float crease = step(0.05, abs(ic.x)) + step(0.05, abs(ic.y - 0.05));
                                glyph = smoothstep(0.06, -0.02, max(body, -neck)) * clamp(crease, 0.35, 1.0);
                            } else if (boxIdx == 2) {
                                // Tracked Caterpillar Suspension Loop with 3 road wheels inside
                                float loopOuter = length(vec2(max(abs(ic.x) - 0.42, 0.0), ic.y * 1.25)) - 0.42;
                                float loopRing = abs(loopOuter + 0.08) - 0.08;
                                float wx = mod(ic.x + 0.45, 0.30) - 0.15;
                                float wheels = length(vec2(wx, ic.y - 0.05)) - 0.10;
                                glyph = max(smoothstep(0.05, -0.01, loopRing), smoothstep(0.05, -0.01, wheels) * step(abs(ic.x), 0.44));
                            } else if (boxIdx == 3) {
                                // Side-Profile Tank Hull & Turret Silhouette
                                float hull = max(abs(ic.x + 0.05) - 0.58, abs(ic.y - 0.22) - 0.20);
                                float tur  = max(abs(ic.x + 0.08) - 0.32, abs(ic.y + 0.10) - 0.15);
                                float gun  = max(abs(ic.x - 0.38) - 0.32, abs(ic.y + 0.12) - 0.05);
                                glyph = smoothstep(0.06, -0.02, min(hull, min(tur, gun)));
                            } else if (boxIdx == 4) {
                                // Pintle-Mounted Heavy Machine Gun on Tripod Mount
                                float barrel = max(abs(ic.x - 0.05) - 0.62, abs(ic.y + 0.18) - 0.09);
                                float receiver = max(abs(ic.x + 0.15) - 0.28, abs(ic.y + 0.14) - 0.16);
                                float tripod = max(abs(abs(ic.x + 0.05) - (ic.y + 0.05) * 0.55) - 0.07, abs(ic.y - 0.25) - 0.28);
                                glyph = smoothstep(0.05, -0.02, min(min(barrel, receiver), tripod));
                            } else {
                                // Tank Commander Bust Silhouette with Helmet & Collar
                                float helm = length((ic - vec2(0.0, -0.26)) * vec2(1.0, 1.1)) - 0.27;
                                float shoulders = max(abs(ic.x) - (0.56 - (ic.y - 0.55) * 0.35), abs(ic.y - 0.38) - 0.26);
                                float collar = step(0.06, abs(abs(ic.x) - (ic.y - 0.12) * 0.65));
                                glyph = smoothstep(0.06, -0.02, min(helm, shoulders)) * clamp(collar + step(ic.y, 0.12), 0.25, 1.0);
                            }
                            cardCol = mix(cardCol, vec3(0.74, 0.79, 0.85), clamp(glyph, 0.0, 1.0));
                        }
                    }
                }

                mapped = mix(mapped, cardCol, 0.94);
            }
        }

        // ====================================================================
        // CARD 4: BOTTOM-RIGHT 5x2 DARK-SLATE TACTICAL COMMAND DOCK (px in [486..636, 336..396])
        // Renders the 5x2 command button grid from CnC-Ultra-Game.jpg when C&C sidebar is closed
        // ====================================================================
        if (tacRect.z > 0.95 && px.x >= 484.0 && px.x <= 638.0 && px.y >= 334.0 && px.y <= 398.0) {
            vec2 bMin = vec2(486.0, 336.0);
            vec2 bMax = vec2(636.0, 396.0);
            vec2 dOut = max(bMin - px, px - bMax);
            float distOut = length(max(dOut, vec2(0.0)));
            if (distOut > 0.0) {
                mapped *= mix(0.42, 1.0, smoothstep(0.0, 4.0, distOut));
            } else {
                vec2 dIn = min(px - bMin, bMax - px);
                float edge = min(dIn.x, dIn.y);
                vec3 cardCol = (edge < 1.2) ? hudBorder * 1.20 : hudBg;

                // 5 Columns x 2 Rows of Dark-Slate Tactical Command Buttons
                vec2 gRel = px - vec2(490.0, 340.0);
                if (gRel.x >= 0.0 && gRel.x < 142.0 && gRel.y >= 0.0 && gRel.y < 52.0) {
                    int colIdx = int(floor(gRel.x / 28.5));
                    int rowIdx = int(floor(gRel.y / 26.5));
                    float cellX = gRel.x - float(colIdx) * 28.5;
                    float cellY = gRel.y - float(rowIdx) * 26.5;
                    if (colIdx >= 0 && colIdx < 5 && rowIdx >= 0 && rowIdx < 2 && cellX <= 26.0 && cellY <= 24.0) {
                        float cEdge = min(min(cellX, 26.0 - cellX), min(cellY, 24.0 - cellY));
                        if (cEdge < 1.1) {
                            cardCol = hudBorder * 1.15;
                        } else {
                            cardCol = hudSlot;
                            vec2 ic = (vec2(cellX, cellY) - vec2(13.0, 12.0)) / 8.5;
                            int cmdId = rowIdx * 5 + colIdx;
                            float glyph = 0.0;
                            if (cmdId == 0) {
                                // Open 5-Finger Hand (Hold Position)
                                float palm = length((ic - vec2(0.02, 0.22)) * vec2(1.1, 1.2)) - 0.34;
                                float f1 = sdCapsule(vec3(ic, 0.0), vec3(-0.26, 0.08, 0.0), vec3(-0.34, -0.42, 0.0), 0.065);
                                float f2 = sdCapsule(vec3(ic, 0.0), vec3(-0.10, 0.02, 0.0), vec3(-0.12, -0.58, 0.0), 0.068);
                                float f3 = sdCapsule(vec3(ic, 0.0), vec3( 0.06, 0.02, 0.0), vec3( 0.08, -0.62, 0.0), 0.068);
                                float f4 = sdCapsule(vec3(ic, 0.0), vec3( 0.22, 0.08, 0.0), vec3( 0.28, -0.48, 0.0), 0.065);
                                float thumb = sdCapsule(vec3(ic, 0.0), vec3(-0.22, 0.26, 0.0), vec3(-0.52, 0.02, 0.0), 0.072);
                                glyph = smoothstep(0.05, -0.02, min(min(palm, thumb), min(min(f1, f2), min(f3, f4))));
                            } else if (cmdId == 1) {
                                // 4-Way Tactical Move Cross with Arrowheads at N, S, E, W tips
                                vec2 a = abs(ic);
                                float bars = min(max(a.x - 0.08, a.y - 0.56), max(a.y - 0.08, a.x - 0.56));
                                float tipY = max((a.x + (a.y - 0.42) * 0.85) - 0.28, abs(a.y - 0.58) - 0.16);
                                float tipX = max((a.y + (a.x - 0.42) * 0.85) - 0.28, abs(a.x - 0.58) - 0.16);
                                glyph = smoothstep(0.05, -0.02, min(bars, min(tipX, tipY)));
                            } else if (cmdId == 2) {
                                // Target Crosshair / Attack
                                float r = length(ic);
                                float ring = abs(r - 0.48) - 0.065;
                                float hairs = min(abs(ic.x), abs(ic.y)) - 0.05;
                                glyph = smoothstep(0.05, -0.02, min(ring, max(hairs, r - 0.72)));
                            } else if (cmdId == 3) {
                                // Heraldic Heater Shield with vertical half-fill (Guard / Defend)
                                float shY = ic.y + 0.05;
                                float shW = mix(0.50, 0.02, clamp((shY + 0.10) / 0.72, 0.0, 1.0));
                                float shD = max(abs(ic.x) - shW, abs(shY) - 0.58);
                                float outline = abs(shD) - 0.065;
                                float leftFill = max(shD + 0.08, ic.x);
                                glyph = smoothstep(0.05, -0.02, min(outline, leftFill));
                            } else if (cmdId == 4) {
                                // Open-End Wrench (Repair)
                                vec2 wr = rot2D(ic, 0.7854);
                                float shaft = max(abs(wr.x) - 0.11, abs(wr.y) - 0.48);
                                float head1 = max(length(wr - vec2(0.0, -0.50)) - 0.25, -(max(abs(wr.x) - 0.10, abs(wr.y + 0.60) - 0.16)));
                                float head2 = max(length(wr - vec2(0.0,  0.50)) - 0.22, -(max(abs(wr.x) - 0.09, abs(wr.y - 0.58) - 0.14)));
                                glyph = smoothstep(0.05, -0.02, min(shaft, min(head1, head2)));
                            } else if (cmdId == 5) {
                                // Crisp 5-Pointed Tactical Star
                                float ang = atan(ic.x, -ic.y);
                                float a5 = abs(mod(ang + 3.14159, 1.256637) - 0.628318);
                                float rStar = length(ic) * (cos(a5) + sin(a5) * 1.15);
                                glyph = smoothstep(0.62, 0.54, rStar);
                            } else if (cmdId == 6) {
                                // 8-Tooth Mechanical Gear with Hollow Center Bore
                                float r = length(ic);
                                float ang = atan(ic.y, ic.x);
                                float outerR = 0.48 + 0.10 * clamp(cos(ang * 8.0) * 2.5, -1.0, 1.0);
                                float gearD = max(r - outerR, 0.20 - r);
                                glyph = smoothstep(0.05, -0.02, gearD);
                            } else if (cmdId == 7) {
                                // Padlock with U-Shackle & Keyhole
                                float body = max(abs(ic.x) - 0.38, abs(ic.y - 0.20) - 0.28);
                                float keyhole = length(ic - vec2(0.0, 0.18)) - 0.08;
                                float shackle = max(abs(length(ic - vec2(0.0, -0.10)) - 0.23) - 0.065, ic.y + 0.08);
                                glyph = smoothstep(0.05, -0.02, min(max(body, -keyhole), shackle));
                            } else if (cmdId == 8) {
                                // Diagonal Expand Arrow + Crossbar
                                vec2 dr = rot2D(ic, -0.7854);
                                float mainShaft = max(abs(dr.y) - 0.065, abs(dr.x) - 0.58);
                                float crossBar  = max(abs(dr.x + 0.18) - 0.065, abs(dr.y) - 0.34);
                                float arrowTip  = max((abs(dr.y) + (dr.x - 0.38) * 0.85) - 0.24, abs(dr.x - 0.52) - 0.16);
                                glyph = smoothstep(0.05, -0.02, min(min(mainShaft, crossBar), arrowTip));
                            } else {
                                // Stop / Cancel Bold 'X'
                                float dX = min(abs(ic.x - ic.y), abs(ic.x + ic.y)) - 0.10;
                                glyph = smoothstep(0.05, -0.02, max(dX, max(abs(ic.x), abs(ic.y)) - 0.56));
                            }
                            cardCol = mix(cardCol, vec3(0.74, 0.80, 0.86), clamp(glyph, 0.0, 1.0));
                        }
                    }
                }

                mapped = mix(mapped, cardCol, 0.94);
            }
        }
    }

    if (dlgRect.z > dlgRect.x) {
        vec2 dCenter = 0.5 * (dlgRect.xy + dlgRect.zw) * vec2(640.0, 400.0);
        vec2 dHalf   = 0.5 * (dlgRect.zw - dlgRect.xy) * vec2(640.0, 400.0);
        vec2 dBox    = abs(vUV * vec2(640.0, 400.0) - dCenter) - dHalf;
        float dOutPx = length(max(dBox, vec2(0.0)));
        if (dOutPx > 0.0 && dOutPx < 22.0) {
            // Dim battlefield around active modal dialog + cast outer drop shadow & emerald rim glow
            mapped *= mix(0.28, 0.85, smoothstep(0.0, 22.0, dOutPx));
            mapped += vec3(0.14, 0.72, 0.35) * exp(-dOutPx * 0.35) * 0.32;
        } else {
            mapped *= 0.85;
        }
    }

    // ------------------------------------------------------------------------
    // 11. Composite Crisp 4K Tactical Mouse Cursor
    // ------------------------------------------------------------------------
    if (curRect.z > curRect.x && curRect.w > curRect.y && !isShowcase) {
        vec2 cPx = (vUV - curRect.xy) * vec2(640.0, 400.0);
        if (cPx.x >= -1.0 && cPx.x <= 14.0 && cPx.y >= -1.0 && cPx.y <= 16.0) {
            bool inOuter = (cPx.x >= -0.8 && cPx.y >= -0.8 && cPx.x <= cPx.y * 0.78 + 1.0 && (cPx.x + cPx.y * 0.62) <= 11.5);
            bool inInner = (cPx.x >= 0.4 && cPx.y >= 0.6 && cPx.x <= cPx.y * 0.72 && (cPx.x + cPx.y * 0.62) <= 9.8);
            if (inInner) {
                mapped = mix(vec3(0.92, 0.98, 1.0), vec3(0.35, 0.95, 0.58), clamp((cPx.x + cPx.y) / 14.0, 0.0, 1.0));
            } else if (inOuter) {
                mapped = vec3(0.04, 0.07, 0.09);
            }
        }
    }

    outColor = vec4(mapped * fade, 1.0);
}
