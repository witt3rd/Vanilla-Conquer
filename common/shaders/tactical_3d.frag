#version 450

layout(location = 0) in vec2 vUV;
layout(location = 0) out vec4 outColor;

layout(set = 0, binding = 0) uniform usampler2D uFrameIndex;
layout(set = 0, binding = 1) uniform PaletteUBO {
    vec4 colors[256];
} uPalette;
layout(set = 0, binding = 2) uniform sampler2D uMenuTex;

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
    // Domain-warp coastal sampling with multi-scale coves & headlands so straight 1995 tile rows become organic bays
    vec2 qWarp = vec2(fbm3(globalCell * 0.42 + vec2(1.7, 9.2)), fbm3(globalCell * 0.42 + vec2(8.3, 2.8)));
    vec2 coastWarp = (qWarp - 0.5) * vec2(1.45, 1.85);
    vec4 fNear = sampleTerrainFields(worldCell + coastWarp * 0.65);
    vec4 fBroad = 0.25 * (
        sampleTerrainFields(worldCell + coastWarp + vec2(-1.1, -0.9)) +
        sampleTerrainFields(worldCell + coastWarp + vec2( 1.1, -0.9)) +
        sampleTerrainFields(worldCell + coastWarp + vec2(-1.1,  0.9)) +
        sampleTerrainFields(worldCell + coastWarp + vec2( 1.1,  0.9))
    );
    vec4 fShoal = 0.25 * (
        sampleTerrainFields(worldCell + coastWarp + vec2(-2.2, -1.8)) +
        sampleTerrainFields(worldCell + coastWarp + vec2( 2.2, -1.8)) +
        sampleTerrainFields(worldCell + coastWarp + vec2( 0.0, -2.6)) +
        sampleTerrainFields(worldCell + coastWarp + vec2( 0.0,  2.2))
    );
    fieldsOut = mix(mix(fNear, fBroad, 0.50), fShoal, 0.36);

    float warp = (fbm3(globalCell * 1.9) - 0.5) * 0.22;
    // Wide 3-cell coastal surf & shoal transition from dry beach (0.0) to deep ocean (1.0)
    float waterField = smoothstep(0.05, 0.92, fieldsOut.x + warp * 0.48);

    // Synthesize a winding coastal military dirt road from the beachhead up through the rocky pass
    float passCenterX = 12.6 + 1.8 * sin(worldCell.y * 0.42 + 0.5) + (qWarp.x - 0.5) * 1.2;
    float passDist = abs(worldCell.x - passCenterX);
    float branchDist = abs(worldCell.y - (6.6 + 0.8 * sin(worldCell.x * 0.35))) * 1.15;
    float synthRoad = max(smoothstep(1.15, 0.38, passDist), smoothstep(0.95, 0.32, branchDist) * smoothstep(4.0, 8.0, worldCell.x) * smoothstep(22.0, 16.0, worldCell.x));
    synthRoad *= smoothstep(0.45, 0.10, waterField);
    float roadField = max(smoothstep(0.32, 0.68, fNear.y), synthRoad * 0.88);

    // Check cell flags for bridge / craters only
    ivec2 ci = ivec2(floor(worldCell));
    uint raw = fetchCellRaw(ci);
    uint ovl = (raw >> 4u) & 15u;
    uint sub = (raw >> 8u) & 15u;
    uint slope = (raw >> 12u) & 15u;

    // Domain-warped rotated fbm3 coastal crags & bluffs so coastal land has organic 3D topography
    vec2 warpedPos = globalCell * 0.65 + (qWarp - 0.5) * 1.35;
    float ridge1 = 1.0 - abs(fbm3(warpedPos * 1.15) * 2.0 - 1.0);
    float ridge2 = 1.0 - abs(fbm3(warpedPos * 2.45 + vec2(4.2, 7.1)) * 2.0 - 1.0);
    float dryLand = smoothstep(0.08, 0.55, 1.0 - waterField);
    float cragMask = smoothstep(0.54, 0.86, ridge1 * 0.68 + ridge2 * 0.32) * dryLand * (1.0 - roadField * 0.94);

    // Coastal headland bluffs rising smoothly along rocky shorelines
    float coastEdge = smoothstep(0.04, 0.45, 1.0 - waterField) * smoothstep(0.88, 0.28, 1.0 - waterField);
    float headland = coastEdge * smoothstep(0.42, 0.72, fbm3(warpedPos * 0.85)) * (1.0 - roadField);

    // Blend map rock field with organic geological ridges so 1995 tile rectangles never show as boxy gray patches
    float mapRock = smoothstep(0.25, 0.75, fieldsOut.z + (qWarp.x - 0.5) * 0.45) * (0.45 + 0.55 * ridge1);
    float rockField = clamp(mapRock * 0.65 + cragMask * 0.72 + headland * 0.65, 0.0, 1.0);

    // Base rolling micro-topography
    float microH = (fbm4(warpedPos * 2.2) - 0.5) * 0.075 * dryLand * (1.0 - roadField * 0.85);

    // Rock cliffs & coastal crags rise with stepped shale/limestone terraces
    float strata = fbm4(warpedPos * 4.6);
    float terrace = floor(strata * 3.5) * 0.16 + smoothstep(0.15, 0.85, fract(strata * 3.5)) * 0.26;
    float cliffH = rockField * (0.28 + 0.18 * terrace);

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
    float waterH = -0.065 * waterField;

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
    if (houseId == 0) return vec3(0.58, 0.51, 0.35); // GDI Weathered Desert-Olive / Sand-Gold
    if (houseId == 1) return vec3(0.52, 0.17, 0.16); // Nod Weathered Crimson / Urban Gunmetal
    if (houseId == 2) return vec3(0.46, 0.45, 0.41); // Neutral Weathered Field-Drab
    if (houseId == 3) return vec3(0.24, 0.46, 0.56); // Multi Naval Slate-Blue
    if (houseId == 4) return vec3(0.64, 0.38, 0.18); // Multi Ochre-Amber
    if (houseId == 5) return vec3(0.24, 0.48, 0.28); // Multi Tactical Olive
    return vec3(0.42, 0.45, 0.48);                   // Gunmetal Gray
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
            // UNIT_HOVER: AMPHIBIOUS HOVERCRAFT LCAC (Ribbed rubber air-cushion skirt + vehicle deck + twin thrust fans)
            dTread = sdRoundBox(hp - vec3(0.0, 0.0, 0.055), vec3(0.42, 0.48, 0.052), 0.022);
            dHull  = sdBox(hp - vec3(0.0, 0.0, 0.115), vec3(0.35, 0.41, 0.032));
            // Armored cargo sidewalls, starboard control cabin & rear twin shrouded fan ducts
            dHull  = min(dHull, sdBox(vec3(abs(hp.x) - 0.33, hp.y, hp.z - 0.17), vec3(0.042, 0.37, 0.052)));
            dHull  = min(dHull, sdBox(hp - vec3(0.26, -0.10, 0.24), vec3(0.065, 0.11, 0.055)));
            dTurret = sdCylinderY(vec3(abs(hp.x) - 0.18, hp.y - 0.35, hp.z - 0.22), 0.095, 0.055);
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
    // CATEGORY 1: 3D BASE STRUCTURES (Concrete Pad + Architectural Superstructure)
    // ------------------------------------------------------------------------
    if (cat == 1) {
        int fw = max(1, int(floor(d1.w)) & 7);
        int fh = max(1, (int(floor(d1.w)) >> 3) & 7);
        vec2 halfSpan = vec2(float(fw), float(fh)) * 0.46;

        // Concrete foundation pad
        float dPad = sdRoundBox(rel - vec3(0.0, 0.0, 0.035), vec3(halfSpan.x, halfSpan.y, 0.035), 0.015);
        float dSuper = 1e5;
        float dMetal = 1e5;
        float dGlow  = 1e5;

        if (subType == 3) {
            // STRUCT_OBELISK: Obelisk of Light (Tall curved obsidian/crimson monolith + glowing ruby crystal tip)
            float h = clamp(rel.z / 0.88, 0.0, 1.0);
            vec2 taper = vec2(0.24, 0.28) * (1.0 - 0.72 * pow(h, 0.85));
            vec3 op = rel - vec3(0.0, -0.10 * h * h, 0.44);
            dSuper = sdRoundBox(op, vec3(taper.x, taper.y, 0.42), 0.02);
            // Glowing ruby laser capacitor crystal at apex
            dGlow = length(rel - vec3(0.0, -0.11, 0.86)) - (isSpecial ? 0.105 : 0.078);
        } else if (subType == 12 || subType == 13) {
            // STRUCT_POWER / STRUCT_ADVANCED_POWER: Reactor Hall + Hyperboloid Cooling Towers
            dSuper = sdRoundBox(rel - vec3(-0.28, 0.12, 0.20), vec3(0.45, 0.42, 0.18), 0.025);
            // Cooling tower 1
            vec3 ct1 = rel - vec3(0.36, -0.18, 0.30);
            float r1 = 0.26 - 0.06 * sin(clamp(ct1.z / 0.30, -1.0, 1.0) * 1.57);
            dMetal = sdCylinderZ(ct1, r1, 0.28);
            // Turbine core glow inside cooling tower throat
            dGlow = sdCylinderZ(ct1 - vec3(0.0, 0.0, 0.18), 0.15, 0.04);
            if (subType == 13) {
                vec3 ct2 = rel - vec3(-0.28, -0.32, 0.32);
                float r2 = 0.24 - 0.05 * sin(clamp(ct2.z / 0.32, -1.0, 1.0) * 1.57);
                dMetal = min(dMetal, sdCylinderZ(ct2, r2, 0.30));
                dGlow = min(dGlow, sdCylinderZ(ct2 - vec3(0.0, 0.0, 0.20), 0.14, 0.04));
            }
        } else if (subType == 6) {
            // STRUCT_CONST: Construction Yard (Command hall + rotating industrial gantry crane)
            dSuper = sdRoundBox(rel - vec3(-0.32, -0.18, 0.24), vec3(0.65, 0.58, 0.22), 0.03);
            dMetal = sdRoundBox(rel - vec3(0.42, 0.28, 0.38), vec3(0.18, 0.18, 0.36), 0.02);
            // Crane boom arm
            vec3 boomP = rel - vec3(0.20, 0.28, 0.66);
            boomP.xy = rot2D(boomP.xy, sin(time * 0.45) * 0.35);
            dMetal = min(dMetal, sdBox(boomP, vec3(0.48, 0.07, 0.05)));
            dGlow  = sdBox(rel - vec3(-0.32, 0.25, 0.14), vec3(0.35, 0.22, 0.08));
        } else if (subType == 7) {
            // STRUCT_REFINERY: Tiberium Refinery (Processing silos + smokestacks + harvester bay)
            dSuper = sdRoundBox(rel - vec3(0.0, -0.25, 0.26), vec3(0.85, 0.45, 0.24), 0.03);
            dMetal = sdCylinderZ(rel - vec3(-0.55, -0.32, 0.44), 0.24, 0.42);
            dMetal = min(dMetal, sdCylinderZ(rel - vec3(0.55, -0.32, 0.44), 0.24, 0.42));
            // Harvester docking bay + glowing green crystal crusher
            dGlow  = sdBox(rel - vec3(0.0, 0.38, 0.10), vec3(0.38, 0.24, 0.06));
        } else if (subType == 0) {
            // STRUCT_WEAP: Weapons Factory (Arched hangar roof + vehicle assembly bay)
            vec3 wp = rel - vec3(0.0, -0.12, 0.24);
            dSuper = sdRoundBox(wp, vec3(0.85, 0.58, 0.22), 0.04);
            dMetal = sdCylinderY(rel - vec3(0.0, -0.12, 0.42), 0.62, 0.56);
            dGlow  = sdBox(rel - vec3(0.0, 0.46, 0.15), vec3(0.36, 0.06, 0.13));
        } else if (subType == 4 || subType == 21) {
            // STRUCT_RADAR / STRUCT_EYE: Bunker + Rotating Parabolic 3D Radar Dish
            dSuper = sdRoundBox(rel - vec3(0.0, 0.0, 0.19), vec3(halfSpan.x * 0.82, halfSpan.y * 0.82, 0.17), 0.025);
            vec3 dp = rel - vec3(0.0, -0.05, 0.46);
            dp.xy = rot2D(dp.xy, time * 1.15);
            dMetal = sdRoundBox(dp, vec3(0.36, 0.10, 0.18), 0.03);
        } else if (subType == 1 || subType == 2 || subType == 5 || subType == 10) {
            // STRUCT_GTOWER, STRUCT_ATOWER, STRUCT_TURRET, STRUCT_SAM: Reinforced Concrete Bunker + Twin-Barrel Turret
            float bunkerOct = sdCylinderZ(rel - vec3(0.0, 0.0, 0.11), 0.31 - 0.08 * clamp(rel.z / 0.22, 0.0, 1.0), 0.11);
            float struts = sdBox(vec3(abs(rel.x) - 0.17, abs(rel.y) - 0.17, rel.z - 0.16), vec3(0.04, 0.04, 0.14));
            dSuper = min(bunkerOct, struts);
            vec2 txy = rot2D(rel.xy, -d1.y);
            vec3 tp = vec3(txy, rel.z - 0.28);
            dMetal = sdRoundBox(tp, vec3(0.16, 0.19, 0.075), 0.02);
            dMetal = min(dMetal, sdCylinderY(vec3(abs(tp.x) - 0.055, tp.y + 0.22, tp.z), 0.024, 0.18));
        } else if (subType == 8) {
            // STRUCT_STORAGE: Tiberium Storage Silo (Cylindrical dome + green level gauge)
            dSuper = sdCylinderZ(rel - vec3(0.0, 0.0, 0.22), 0.36, 0.20);
            dGlow  = sdCylinderZ(rel - vec3(0.0, 0.0, 0.26), 0.22, 0.18);
        } else {
            // Barracks, Hand of Nod, Temple of Nod, Helipad, Airstrip, Repair Bay, Civilian Structures
            float bh = (subType == 19 || subType == 20) ? 0.46 : 0.26;
            dSuper = sdRoundBox(rel - vec3(0.0, 0.0, bh * 0.5), vec3(halfSpan.x * 0.84, halfSpan.y * 0.84, bh * 0.48), 0.025);
            dMetal = sdRoundBox(rel - vec3(0.0, -halfSpan.y * 0.25, bh * 0.82), vec3(halfSpan.x * 0.52, halfSpan.y * 0.42, bh * 0.22), 0.02);
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
        partLocal = rel;
        if (dSuper < dMin) {
            dMin = dSuper;
            partMat = 25;
            partLocal = rel;
        }
        if (dMetal < dMin) {
            dMin = dMetal;
            partMat = 22;
            partLocal = rel;
        }
        if (dGlow < dMin) {
            dMin = dGlow;
            partMat = 23;
            partLocal = rel;
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
        float boughNoise = (noise2D(rel.xy * 14.0 + vec2(d0.x, d0.y) * 3.7) - 0.5) * 0.065;
        if (subType >= 25) {
            // Craggy Outcrop Boulder Formation
            float dRock = sdRoundBox(rel - vec3(0.0, 0.0, 0.14), vec3(0.24, 0.20, 0.14), 0.04) + boughNoise * 0.85;
            partMat = 28;
            partLocal = rel;
            return dRock;
        }
        // Weathered Coastal Pine / Scrub Cluster + Basal Rock Outcrop (CnC-Ultra-Game.jpg)
        vec2 wind = vec2(sin(time * 1.5 + d0.x * 0.9), cos(time * 1.2 + d0.y * 0.9)) * 0.018 * clamp(rel.z, 0.0, 1.0);
        vec3 tp = rel - vec3(wind, 0.0);
        float dTrunk = sdCapsule(tp, vec3(0.0, 0.0, 0.0), vec3(0.0, 0.0, 0.34), 0.055);
        float dBaseRock = sdRoundBox(rel - vec3(0.14, 0.08, 0.07), vec3(0.16, 0.13, 0.07), 0.03) + boughNoise * 0.6;

        // Multi-tiered coniferous pine & coastal scrub boughs with organic foliage displacement
        vec3 cp = tp - vec3(0.0, 0.0, 0.36);
        float tier1 = length((cp - vec3(0.0, 0.0, -0.10)) * vec3(1.05, 1.05, 1.85)) - 0.34;
        float tier2 = length((cp - vec3(0.05, -0.04, 0.04)) * vec3(1.25, 1.25, 1.95)) - 0.27;
        float tier3 = length((cp - vec3(-0.04, 0.03, 0.16)) * vec3(1.55, 1.55, 2.05)) - 0.20;
        float bush  = length((cp - vec3(-0.18, 0.12, -0.16)) * vec3(1.20, 1.20, 1.75)) - 0.22;
        float dCanopy = min(min(tier1, tier2), min(tier3, bush)) + boughNoise;

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
    // Background: moody coastal cliff + twilight sky horizon matching CnC-Ultra-Game.jpg
    float cliffLine = 0.34 + 0.14 * sin(uvBox.x * 5.2 + 0.8) + 0.06 * sin(uvBox.x * 13.0);
    vec3 skyBg = mix(vec3(0.32, 0.38, 0.44), vec3(0.16, 0.20, 0.25), clamp(uvBox.y * 1.8, 0.0, 1.0));
    float cliffN = noise2D(uvBox * vec2(18.0, 28.0));
    vec3 cliffBg = mix(vec3(0.18, 0.17, 0.16), vec3(0.28, 0.26, 0.23), cliffN);
    vec3 bgCol = (uvBox.y < cliffLine) ? skyBg : cliffBg;

    int cat = selPackedType & 7;
    int subType = (selPackedType >> 3) & 127;
    int houseId = (selPackedType >> 10) & 7;

    // Studio camera setup looking at origin (0, 0, 0.14) at a dramatic 3/4 side-front angle (CnC-Ultra-Game.jpg)
    float zoom = (cat == 1) ? 1.50 : ((cat == 2) ? 0.55 : 0.72);
    vec2 pScreen = (uvBox - vec2(0.50, 0.58)) * vec2(1.0, -1.0) * zoom;

    vec3 camForward = normalize(vec3(-0.46, -0.80, -0.38));
    vec3 camRight   = normalize(cross(camForward, vec3(0.0, 0.0, 1.0)));
    vec3 camUp      = cross(camRight, camForward);

    vec3 target = vec3(0.0, 0.0, (cat == 1) ? 0.22 : ((cat == 2) ? 0.14 : 0.14));
    vec3 ro = target - camForward * 1.45 + camRight * pScreen.x + camUp * pScreen.y;
    vec3 rd = camForward;

    // Construct synthetic entity data for evaluateSingleEntitySDF at origin showing side-front 3/4 profile
    // Facing North-East/Front-Left (yaw ~ 0.72 rad) points the front glacis & 120mm cannon toward bottom-left!
    float yaw = 0.72 + sin(time * 0.45) * 0.05;
    float turYaw = yaw - 0.14 + sin(time * 0.85) * 0.08;
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
        if (t > 2.4) break;
    }

    if (hitMat == 0) return bgCol;

    if (hitMat == 99) {
        float distR = length(hitP.xy);
        float shadow = smoothstep(0.10, 0.44, distR);
        float nG = noise2D(hitP.xy * 18.0);
        vec3 plinth = mix(vec3(0.22, 0.20, 0.18), vec3(0.32, 0.29, 0.25), nG) * (0.38 + 0.62 * shadow);
        return mix(plinth, bgCol, smoothstep(0.45, 0.88, distR));
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

    vec3 houseCol = getHouseTrimColor(houseId);
    float grit = noise2D(hitLoc.xy * 28.0 + hitLoc.z * 16.0);
    vec3 alb = houseCol * (0.85 + 0.30 * grit);
    if (hitMat == 20) {
        // Road-wheels & steel track links inside track pods
        float wheelSpacing = (fract((hitLoc.y + 0.30) * 9.5) - 0.5) / 9.5;
        float wheelR = length(vec2(wheelSpacing, hitLoc.z - 0.048));
        float isWheel = smoothstep(0.042, 0.032, wheelR);
        float isHub   = smoothstep(0.016, 0.010, wheelR);
        alb = mix(vec3(0.14, 0.15, 0.16), houseCol * 0.68, isWheel);
        alb = mix(alb, vec3(0.08, 0.09, 0.10), isHub);
    }
    else if (hitMat == 22) alb = mix(houseCol * 0.82, vec3(0.32, 0.34, 0.36), 0.45) * (0.88 + 0.24 * grit);
    else if (hitMat == 23) alb = vec3(0.18, 0.92, 0.38);
    else if (hitMat == 24) alb = vec3(0.36, 0.37, 0.38);

    vec3 Lkey = normalize(vec3(-0.58, -0.48, 0.66));
    vec3 Lrim = normalize(vec3(0.65, 0.45, 0.60));
    vec3 V = -rd;
    vec3 H = normalize(Lkey + V);

    float diff = max(dot(N, Lkey), 0.0);
    float rim  = max(dot(N, Lrim), 0.0);
    float spec = pow(max(dot(N, H), 0.0), 32.0);

    vec3 col = alb * (0.30 + 0.82 * diff + 0.28 * rim) + vec3(0.98, 0.90, 0.78) * spec * 0.42;
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
    // Extend 3D battlefield all the way to the top edge (vUV.y >= 0.0) to match CnC-Ultra-Game.jpg
    bool inTacViewport = (vUV.x >= tacRect.x && vUV.x < tacRect.z && vUV.y < tacRect.w);

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
    // ------------------------------------------------------------------------
    vec2 tacUV = (vUV - tacRect.xy) / max(tacRect.zw - tacRect.xy, vec2(1e-4));
    vec2 subCell = uTac.view_params1.yz;
    vec2 cellsSpan = vec2(uTac.view_params1.w, uTac.view_params2.x);
    vec2 originCell = uTac.view_params2.yz;
    int theater = int(floor(uTac.view_params2.w + 0.5));

    // Ground plane (z = 0) intersection in local 30x20 grid space & global map cell space
    vec2 groundCellXY = subCell + tacUV * cellsSpan;
    vec2 globalCellXY = originCell + groundCellXY;

    // Oblique 3/4 Isometric Camera & Sun Directions (in cell coordinate space: +X East, +Y South, +Z Up)
    // Camera looks down from South-West to North-East at an oblique 3/4 RTS angle so 3D tank/cliff faces pop
    vec3 V = normalize(vec3(-0.24, 0.52, 0.82));
    vec3 L = normalize(vec3(-0.56, -0.44, 0.70)); // Warm directional sun from NW
    vec3 H = normalize(V + L);

    // ------------------------------------------------------------------------
    // 3. Ray-March 3D Terrain Relief (Heightfield Displacement + Cliffs + Craters)
    // ------------------------------------------------------------------------
    vec4 terrainFields;
    vec2 camStepXY = V.xy / max(V.z, 0.35);
    float hGround = evaluateTerrainHeight(groundCellXY, globalCellXY, terrainFields);
    // 4-step iterative terrain relief refinement along 3/4 oblique camera ray for dramatic coastal bluffs
    vec2 displacedCellXY = groundCellXY;
    vec2 displacedGlobalXY = globalCellXY;
    for (int rStep = 0; rStep < 4; ++rStep) {
        displacedCellXY = groundCellXY + camStepXY * (hGround * 0.85);
        displacedGlobalXY = originCell + displacedCellXY;
        hGround = mix(hGround, evaluateTerrainHeight(displacedCellXY, displacedGlobalXY, terrainFields), 0.75);
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

    float nFine   = fbm4(displacedGlobalXY * 9.5);
    float nMicro  = noise2D(displacedGlobalXY * 38.0);
    float nPebble = noise2D(displacedGlobalXY * 82.0);

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
        // Weathered olive-drab scrubland, gritty damp earth/loam, stratified shale/limestone coastal cliffs
        soilCol  = mix(vec3(0.23, 0.20, 0.16), vec3(0.34, 0.29, 0.22), nFine * 0.7 + nPebble * 0.3);
        grassCol = mix(vec3(0.16, 0.21, 0.12), vec3(0.25, 0.30, 0.17), nFine * 0.65 + nMicro * 0.35);
        cliffCol = mix(vec3(0.21, 0.20, 0.18), vec3(0.40, 0.38, 0.34), nMicro);
        roadCol  = mix(vec3(0.18, 0.16, 0.14), vec3(0.27, 0.25, 0.22), nMicro);
        beachCol = vec3(0.38, 0.35, 0.29);
    }

    float grassWeight = smoothstep(0.26, 0.68, fbm3(displacedGlobalXY * 1.4 + vec2(5.2, 9.1)));
    vec3 surfAlbedo = mix(soilCol, grassCol, grassWeight);
    float surfRough = mix(0.88, 0.80, grassWeight);
    float surfMetal = 0.02;

    // Scattered coastal boulders, scree stones, and dark olive scrub bushes across LAND_CLEAR
    if (waterMask < 0.12 && roadMask < 0.25) {
        vec2 boulderGrid = displacedGlobalXY * 3.2;
        vec2 bId = floor(boulderGrid);
        vec2 bUv = fract(boulderGrid) - vec2(0.5);
        float bRand = hash12(bId);
        if (bRand > 0.62) {
            vec2 bOff = (vec2(hash12(bId + vec2(3.1, 1.7)), hash12(bId + vec2(7.4, 5.3))) - 0.5) * 0.42;
            float bRad = 0.14 + 0.16 * hash12(bId + vec2(11.2, 9.8));
            float bDist = length((bUv - bOff) * vec2(1.15, 0.90));
            if (bDist < bRad) {
                float bHeight = sqrt(max(0.0, 1.0 - (bDist / bRad) * (bDist / bRad)));
                vec3 bNormal = normalize(vec3((bUv - bOff) / bRad, bHeight * 0.85));
                terrainN = normalize(mix(terrainN, bNormal, 0.72));
                if (bRand > 0.82) {
                    // Dark olive coastal scrub bush
                    surfAlbedo = mix(vec3(0.11, 0.16, 0.08), vec3(0.20, 0.26, 0.13), nMicro);
                    surfRough = 0.86;
                } else {
                    // Weathered coastal granite boulder
                    surfAlbedo = cliffCol * (0.78 + 0.35 * nPebble);
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
        float trackRut = pow(sin(displacedCellXY.x * 18.8 + displacedCellXY.y * 6.2) * 0.5 + 0.5, 3.0);
        float treadMark = step(0.45, fract((displacedCellXY.x + displacedCellXY.y) * 22.0));
        vec3 rCol = roadCol * (0.82 + 0.28 * nPebble) * (1.0 - 0.22 * trackRut * treadMark);
        float rRough = mix(0.68, 0.26, trackRut * 0.75); // Damp mud sheen in tank ruts
        if (cellSlope == 9u) {
            // 3D Poured-Concrete & Steel Girder Coastal Causeway / Bridge
            float girder = step(0.84, abs(fract(displacedCellXY.x) * 2.0 - 1.0));
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

    // Apply Multi-Tiered Stratified Coastal Rock Cliffs & Scree Crevices
    if (rockMask > 0.01) {
        float strataLines = sin(hGround * 48.0 + nFine * 7.5) * 0.5 + 0.5;
        float crevice = smoothstep(0.28, 0.05, strataLines);
        vec3 rCliff = cliffCol * (0.64 + 0.52 * strataLines) * (0.82 + 0.34 * nPebble);
        rCliff = mix(rCliff, vec3(0.10, 0.095, 0.09), crevice * 0.65);
        surfAlbedo = mix(surfAlbedo, rCliff, rockMask);
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

        // Multi-layered crashing whitewater surf & lacy cellular sea-foam along coastlines & crags
        float coastDist = 1.0 - waterMask;
        float breaker1 = sin(coastDist * 16.0 - time * 2.6 + w1 * 4.2) * 0.5 + 0.5;
        float breaker2 = sin(coastDist * 32.0 - time * 3.5 - w2 * 4.8) * 0.5 + 0.5;
        float laceCell = 1.0 - abs(fbm3(displacedGlobalXY * 6.8 + vec2(w1, w2) * 1.3) * 2.0 - 1.0);
        float laceFoam = pow(clamp(laceCell, 0.0, 1.0), 1.9);

        float surfZone  = smoothstep(0.88, 0.26, waterMask) * smoothstep(0.16, 0.34, waterMask);
        float mainCrest = smoothstep(0.54, 0.86, breaker1) * surfZone;
        float subCrest  = smoothstep(0.60, 0.90, breaker2) * surfZone * 0.78;
        float foamWeb   = surfZone * laceFoam * (0.48 + 0.52 * breaker1);
        float whitecap  = smoothstep(0.75, 0.92, w1 * 0.65 + w2 * 0.45) * smoothstep(0.45, 0.85, waterMask) * 0.30;

        float foamMask = clamp(max(mainCrest, subCrest) + foamWeb + whitecap, 0.0, 1.0);
        if (cellSlope == 10u || cellSlope == 11u) {
            foamMask = max(foamMask, smoothstep(0.32, 0.72, w1 + w2 * 0.65));
        }

        surfAlbedo = mix(surfAlbedo, vec3(0.90, 0.94, 0.97), foamMask * 0.92);
        surfRough  = mix(surfRough, 0.48, foamMask);

        // Moody coastal sky reflection & crisp specular sun glints on ocean swells
        vec3 R = reflect(-V, terrainN);
        vec3 skyCol = mix(vec3(0.14, 0.24, 0.34), vec3(0.44, 0.56, 0.68), clamp(R.z, 0.0, 1.0));
        float fresnel = pow(1.0 - max(dot(terrainN, V), 0.0), 4.0);
        waterEmissive = skyCol * (0.14 + 0.52 * fresnel) * (1.0 - foamMask * 0.78);
    }

    // ------------------------------------------------------------------------
    // 6. Top-Down Oblique Camera Ray-March of 3D Cell Structures (Tiberium, Walls, Crates)
    //    & 3D Articulated Entities (Vehicles, Buildings, Infantry, Aircraft, Trees)
    //    Rays march FROM THE CAMERA (u = uMax, above the scene) DOWNWARD (-V) toward u = 0 (ground)
    // ------------------------------------------------------------------------
    vec3 camDir = normalize(vec3(-0.24, 0.52, 0.82)); // 3/4 oblique camera ray (+Y South, -X West, +Z Up)
    int hitMat = 0;
    vec3 hitPos = terrainPos;
    vec3 hitNormal = terrainN;
    vec3 hitLocal = vec3(0.0);
    int hitHouse = 0;
    int hitSubType = 0;
    int hitFlags = 0;
    float hitHealth = 1.0;
    float bestCamU = 0.0;

    // A. Check 3D Tiberium Crystal Clusters, Connected Walls & Supply Crates in current/southern cell
    ivec2 groundCellIdx = ivec2(floor(groundCellXY));
    for (int cy = 0; cy <= 1; ++cy) {
        for (int cx = -1; cx <= 0; ++cx) {
            ivec2 testCell = groundCellIdx + ivec2(cx, cy);
            uint rawC = fetchCellRaw(testCell);
            uint ovlC = (rawC >> 4u) & 15u;
            uint landC = rawC & 15u;
            if (ovlC == 0u && landC != 4u && landC != 5u) continue;

            float u = 0.45;
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

    // B. Ray-March Active 3D Entities + Accumulate Ground Shadows, Volumetric Black Smoke & Selection HUD
    int entCount = clamp(int(uTac.view_params3.x), 0, 128);
    float entityShadow = 0.0;
    vec4 hudOverlay = vec4(0.0);
    vec3 vfxAdditive = vec3(0.0);
    float vfxSmokeAlpha = 0.0;

    for (int i = 0; i < 128; ++i) {
        if (i >= entCount) break;
        vec4 d0 = uTac.ent_data0[i];
        vec4 d1 = uTac.ent_data1[i];

        int packedType = int(floor(d0.w + 0.5));
        int cat = packedType & 7;
        int subType = (packedType >> 3) & 127;
        int houseId = (packedType >> 10) & 7;
        int flags = int(floor(d1.z));
        float health = clamp(fract(d1.z), 0.01, 0.999);

        // Determine culling radius in cells based on entity category
        float cullRad = 1.05;
        if (cat == 1) {
            int fw = max(1, int(floor(d1.w)) & 7);
            int fh = max(1, (int(floor(d1.w)) >> 3) & 7);
            cullRad = max(float(fw), float(fh)) * 0.72 + 0.70;
        } else if (cat == 3) {
            cullRad = 1.85;
        } else if (cat == 4 || cat == 6) {
            cullRad = 1.25;
        }

        // Fast 2D bounding-box rejection (shifted along 3/4 oblique camera vector for tall 3D projection)
        vec2 projCenter = d0.xy - camDir.xy * (d0.z * 0.85 + ((cat == 1) ? 0.35 : 0.18));
        vec2 diffXY = groundCellXY - projCenter;
        if (max(abs(diffXY.x), abs(diffXY.y)) > cullRad) continue;

        // 1. Soft Directional Ground Shadow from this 3D Entity
        float shadowH = (cat == 3) ? max(d0.z, 0.65) : ((cat == 1) ? 0.34 : 0.18);
        vec2 shadowCenter = d0.xy - L.xy * (shadowH / max(L.z, 0.25));
        vec2 sDiff = groundCellXY - shadowCenter;
        vec2 sSpan = (cat == 1)
            ? vec2(max(1, int(floor(d1.w)) & 7), max(1, (int(floor(d1.w)) >> 3) & 7)) * 0.46
            : vec2(0.32, 0.36);
        float sDist = length(max(abs(sDiff) - sSpan * 0.65, 0.0)) / max(sSpan.x * 0.55, 0.15);
        entityShadow = max(entityShadow, smoothstep(1.0, 0.1, sDist) * ((cat == 3) ? 0.55 : 0.72));

        // 1b. Amphibious Hovercraft / Naval Gunboat Whitewater Wake Ring on Water
        if (waterMask > 0.35 && cat == 0 && (subType == 13 || subType == 15)) {
            float wakeDist = length((groundCellXY - d0.xy) * vec2(1.1, 0.9));
            float wakeRing = smoothstep(0.68, 0.42, wakeDist) * smoothstep(0.22, 0.42, wakeDist);
            float wakeTurb = noise2D(groundCellXY * 24.0 - vec2(sin(d1.x), -cos(d1.x)) * time * 4.0);
            surfAlbedo = mix(surfAlbedo, vec3(0.92, 0.96, 0.99), clamp(wakeRing * wakeTurb * 1.35, 0.0, 0.92));
        }

        // 2. Volumetric Explosions, Blazing Fire Cores & Billowing Black Smoke Plumes (Categories 5 & 6)
        if (cat == 6) {
            float stage = clamp(d1.x, 0.0, 1.0);
            float rad = clamp(d1.w, 0.22, 0.95);
            vec2 expCenter = d0.xy - vec2(0.0, 0.12);
            vec2 relExp = groundCellXY - expCenter;
            float r = length(relExp) / rad;
            if (r < 1.55) {
                float fNoise = fbm4(relExp * 7.5 - vec2(0.0, time * 4.2));
                float core = smoothstep(1.15, 0.0, r - fNoise * 0.38) * (1.0 - stage * 0.72);
                if (subType == 11 || subType == 35 || subType == 59) {
                    // Dense billowing dark-charcoal smoke plume
                    float smk = smoothstep(1.25, 0.15, r - fNoise * 0.45) * (1.0 - stage * 0.75);
                    vfxSmokeAlpha = max(vfxSmokeAlpha, clamp(smk * 0.85, 0.0, 0.88));
                } else if (subType >= 22 && subType <= 29) {
                    // Chemical / Tiberium spray cloud
                    vfxAdditive += vec3(0.12, 0.95, 0.32) * core * 1.25;
                } else if (subType == 60) {
                    // GDI Ion Cannon Orbital Particle Beam!
                    float beamW = abs(groundCellXY.x - d0.x);
                    float beam = exp(-beamW * 14.0) * step(groundCellXY.y, d0.y + 0.25) * (1.0 - stage * 0.6);
                    vfxAdditive += vec3(0.45, 0.82, 1.65) * (beam * 2.2 + core * 1.8);
                } else {
                    // Blazing incandescent white-orange fireball core + billowing black smoke column above
                    vec3 fireCol = mix(vec3(0.98, 0.26, 0.03), vec3(1.0, 0.94, 0.62), smoothstep(0.68, 0.0, r));
                    vfxAdditive += fireCol * core * 1.85;
                    // Rising black smoke canopy around and north of the fireball
                    vec2 smkRel = (relExp + vec2(0.0, 0.22 * rad)) / (rad * 1.25);
                    float smkR = length(smkRel * vec2(1.1, 0.8));
                    float smkRing = smoothstep(1.2, 0.25, smkR - fNoise * 0.42) * smoothstep(0.12, 0.55, r + stage * 0.5);
                    vfxSmokeAlpha = max(vfxSmokeAlpha, clamp(smkRing * (0.45 + 0.45 * stage), 0.0, 0.88));
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
            // Tracer / Missile / Shell glow + contrail
            vec2 bCenter = d0.xy - vec2(0.0, d0.z * 0.42 + 0.08);
            vec2 bDir = vec2(sin(d1.x), -cos(d1.x));
            vec2 relB = groundCellXY - bCenter;
            float along = dot(relB, -bDir);
            float perp  = length(relB - (-bDir) * clamp(along, 0.0, 0.55));
            if (perp < 0.18) {
                float head = exp(-length(relB) * 28.0);
                float trail = exp(-perp * 26.0) * smoothstep(0.55, 0.0, along) * step(0.0, along);
                vec3 pCol = (subType >= 4 && subType <= 7) ? vec3(1.0, 0.58, 0.18) : vec3(1.0, 0.85, 0.35);
                vfxAdditive += pCol * (head * 2.0 + trail * 1.1);
            }
            continue;
        }

        // 3. Top-Down Camera Sphere-Tracing for 3D Solid Entity (Vehicle, Structure, Infantry, Aircraft, Tree/Rock)
        // March from uMax (closest to camera, above entity top) downward toward uMin (ground / base altitude)
        float uMax = (cat == 3) ? (d0.z * 1.15 + 0.42) : ((cat == 1) ? 1.05 : ((cat == 4) ? 0.88 : (d0.z * 1.1 + 0.46)));
        float uMin = max(bestCamU, (cat == 3) ? max(0.0, d0.z * 0.85 - 0.18) : 0.0);
        float u = uMax;
        for (int s = 0; s < 24; ++s) {
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
            u -= max(d * 0.88, 0.005);
        }

        // 4. Towering Volumetric Black Smoke Plume, Fire Base & Muzzle Flash VFX for damaged / firing units
        if ((flags & 8) != 0) {
            vec2 smkOrigin = d0.xy - vec2(0.0, 0.16);
            vec2 sd = groundCellXY - smkOrigin;
            if (sd.y < 0.08 && sd.y > -0.82 && abs(sd.x) < 0.42) {
                float rise = clamp(-sd.y / 0.82, 0.0, 1.0);
                float sn = fbm4(sd * 8.5 + vec2(sin(time * 0.8 + float(i)), time * 2.6 + float(i)));
                float plumeWidth = 0.16 + rise * 0.22;
                float smkMask = smoothstep(plumeWidth, 0.02, abs(sd.x - rise * 0.08 + (sn - 0.5) * 0.24)) * pow(1.0 - rise, 0.65);
                // Incandescent orange fire core at base of burning structure/tank
                float fireBase = smoothstep(0.22, 0.0, length(sd - vec2(0.0, -0.04)) - sn * 0.08);
                vfxAdditive += mix(vec3(0.98, 0.28, 0.03), vec3(1.0, 0.88, 0.42), fireBase) * fireBase * 1.45;
                vfxSmokeAlpha = max(vfxSmokeAlpha, clamp(smkMask * 0.84, 0.0, 0.88));
            }
        }
        if ((flags & 2) != 0) {
            vec2 muzDir = vec2(sin(d1.y), -cos(d1.y));
            vec2 muzPos = d0.xy + muzDir * 0.36 - vec2(0.0, 0.09);
            float md = length(groundCellXY - muzPos);
            if (md < 0.28) {
                vfxAdditive += vec3(1.0, 0.68, 0.22) * exp(-md * 18.0) * 1.8;
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
            // Concrete Fortress Wall / Building Foundation Pad
            albedo = vec3(0.46, 0.47, 0.49) * (0.88 + 0.24 * metalNoise);
            roughness = 0.65;
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
            // Turret, Gun Barrel, Radar Dish & Gantry Steel
            albedo = mix(houseCol * 0.82, vec3(0.32, 0.35, 0.38), 0.55) * (0.9 + 0.2 * metalNoise);
            roughness = 0.28;
            metallic = 0.88;
        } else if (hitMat == 23) {
            // Glowing Tiberium Hopper / Obelisk Ruby Crystal / Reactor Core
            bool isObelisk = (hitSubType == 3);
            vec3 glowCol = isObelisk ? vec3(1.0, 0.12, 0.18) : vec3(0.12, 0.96, 0.36);
            albedo = glowCol;
            roughness = 0.15;
            metallic = 0.5;
            emissive = glowCol * (1.25 + 0.45 * sin(time * 6.0));
        } else if (hitMat == 25) {
            // Structure Architectural Superstructure (Weathered Concrete Bunker + Faction Trim Stripe + Slit Vents)
            float stripeMask = smoothstep(0.15, 0.20, hitLocal.z) * smoothstep(0.26, 0.21, hitLocal.z);
            float slitMask = step(0.65, fract((hitLocal.x + hitLocal.y) * 5.0)) * smoothstep(0.14, 0.16, hitLocal.z) * smoothstep(0.20, 0.18, hitLocal.z);
            vec3 bunkerConcrete = vec3(0.32, 0.33, 0.34) * (0.84 + 0.30 * metalNoise);
            albedo = mix(bunkerConcrete, houseCol * 0.78, stripeMask * 0.55) * (1.0 - 0.65 * slitMask);
            roughness = 0.58;
            metallic = 0.32;
            emissive = vec3(0.95, 0.72, 0.32) * slitMask * 0.22;
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

    // Evaluate up to 32 Dynamic 3D Point Lights (Explosions, Muzzle Flashes, Lasers, Tiberium Glow)
    int lightCount = clamp(int(uTac.view_params3.y), 0, 32);
    vec3 dynamicLight = vec3(0.0);
    for (int li = 0; li < 32; ++li) {
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
    if (vfxSmokeAlpha > 0.001) {
        // Billowing dark charcoal smoke plume occludes battlefield beneath it
        litColor = mix(litColor, vec3(0.035, 0.040, 0.045), vfxSmokeAlpha);
    }
    litColor += vfxAdditive;

    // Subtle cool-slate coastal atmospheric mist drifting across upper horizon & cliff tops (CnC-Ultra-Game.jpg)
    float mistNoise = fbm3(globalCellXY * 0.85 + vec2(time * 0.12, -time * 0.06));
    float horizonMist = smoothstep(0.36, 0.0, vUV.y) * (0.14 + 0.16 * mistNoise);
    litColor = mix(litColor, vec3(0.42, 0.48, 0.54), horizonMist);

    // ------------------------------------------------------------------------
    // 9. 3D Holographic Building Placement Grid & Rubber-Band Selection Box
    // ------------------------------------------------------------------------
    if (cellCursor != 0u) {
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
    if (vis < 0.99) {
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
    // 10b. Sleek Dark-Slate Corner Tactical HUD Cards (CnC-Ultra-Game.jpg)
    // ------------------------------------------------------------------------
    vec2 px = vUV * vec2(640.0, 400.0);
    vec3 hudBg     = vec3(0.086, 0.098, 0.114);
    vec3 hudSlot   = vec3(0.118, 0.134, 0.154);
    vec3 hudBorder = vec3(0.225, 0.252, 0.282);

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

                // 3. Squad Silhouette Icon at (125, 15) + Single-line Force Count "12/50"
                float head1 = length(px - vec2(125.0, 11.0)) - 2.2;
                float body1 = length((px - vec2(125.0, 17.5)) * vec2(1.0, 0.75)) - 3.4;
                if (min(head1, body1) < 0.0) {
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
        // Ensures the top-right radar minimap is ALWAYS present like CnC-Ultra-Game.jpg
        // ====================================================================
        if (tacRect.z > 0.95 && px.x >= 538.0 && px.x <= 638.0 && px.y >= 1.0 && px.y <= 96.0) {
            vec2 bMin = vec2(540.0, 3.0);
            vec2 bMax = vec2(636.0, 93.0);
            vec2 dOut = max(bMin - px, px - bMax);
            float distOut = length(max(dOut, vec2(0.0)));
            if (distOut > 0.0) {
                mapped *= mix(0.42, 1.0, smoothstep(0.0, 4.0, distOut));
            } else {
                vec2 dIn = min(px - bMin, bMax - px);
                float edge = min(dIn.x, dIn.y);
                vec3 cardCol = (edge < 1.2) ? hudBorder * 1.22 : hudBg;

                // Top "OPTIONS   MENU" micro-caption bar inside minimap frame (y in [5..13])
                int optMenu[12] = int[12](79,80,84,73,79,78,83,32,77,69,78,85);
                vec2 mRel = px - vec2(562.0, 6.0);
                if (mRel.x >= 0.0 && mRel.y >= 0.0 && mRel.y < 5.0) {
                    int ci = int(floor(mRel.x / 3.8));
                    if (ci >= 0 && ci < 12 && optMenu[ci] != 32) {
                        float g = sampleGlyph3x5(optMenu[ci], vec2(mRel.x - float(ci) * 3.8, mRel.y), 0.9);
                        cardCol = mix(cardCol, vec3(0.78, 0.82, 0.86), g);
                    }
                }

                // Satellite Minimap Screen (px in [544..632, 14..89])
                if (px.x >= 544.0 && px.x <= 632.0 && px.y >= 14.0 && px.y <= 89.0) {
                    vec2 rUV = (px - vec2(544.0, 14.0)) / vec2(88.0, 75.0);
                    vec2 pEdge = min(px - vec2(544.0, 14.0), vec2(632.0, 89.0) - px);
                    if (min(pEdge.x, pEdge.y) < 1.0) {
                        cardCol = hudBorder * 1.15;
                    } else {
                        // Sample live cell_grid + coastal satellite topography
                        ivec2 mCell = ivec2(clamp(rUV * vec2(28.0, 22.0), vec2(0.0), vec2(27.0, 21.0)));
                        uint mRaw = fetchCellRaw(mCell);
                        bool mWater = isCellWater(mRaw);
                        bool mRock  = isCellRock(mRaw);
                        bool mRoad  = isCellRoad(mRaw);
                        float mTopo = fbm3(rUV * 8.0 + vec2(2.1, 4.7));
                        vec3 satCol = mWater
                            ? mix(vec3(0.03, 0.10, 0.16), vec3(0.06, 0.18, 0.24), mTopo)
                            : (mRock ? vec3(0.28, 0.26, 0.23) : (mRoad ? vec3(0.24, 0.21, 0.17) : mix(vec3(0.15, 0.19, 0.12), vec3(0.24, 0.27, 0.18), mTopo)));

                        // Live unit blips on satellite minimap
                        for (int ui = 0; ui < 48; ++ui) {
                            if (ui >= entCount) break;
                            vec4 ud0 = uTac.ent_data0[ui];
                            int uPack = int(floor(ud0.w + 0.5));
                            int uCat = uPack & 7;
                            int uHouse = (uPack >> 10) & 7;
                            if (uCat > 2) continue;
                            vec2 uUV = (ud0.xy - subCell) / max(cellsSpan, vec2(1.0));
                            if (length((rUV - uUV) * vec2(88.0, 75.0)) < 1.9) {
                                satCol = (uHouse == 0) ? vec3(0.95, 0.82, 0.22) : ((uHouse == 1) ? vec3(0.95, 0.18, 0.15) : vec3(0.25, 0.92, 0.38));
                            }
                        }

                        // White camera viewport rectangle
                        vec2 vBox = abs(rUV - vec2(0.50, 0.50)) - vec2(0.32, 0.28);
                        if (abs(max(vBox.x, vBox.y)) < 0.018) {
                            satCol = mix(satCol, vec3(0.92, 0.95, 0.98), 0.85);
                        }
                        cardCol = satCol;
                    }
                }

                mapped = mix(mapped, cardCol, 0.94);
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
                // C. Bottom Row of 6 Tactical Subsystem Icon Squares (px in [8..158, 372..392])
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
                                // Dual AP Shells
                                float s1 = length(vec2(abs(ic.x) - 0.32, ic.y * 0.65)) - 0.22;
                                glyph = smoothstep(0.08, -0.02, s1);
                            } else if (boxIdx == 1) {
                                // Composite Armor Plate
                                float dA = max(abs(ic.x) * 0.85 + abs(ic.y) * 0.5, abs(ic.y)) - 0.62;
                                glyph = smoothstep(0.08, -0.02, dA);
                            } else if (boxIdx == 2) {
                                // Tracked Suspension Drive
                                float dT = max(abs(ic.x) - 0.68, abs(ic.y) - 0.36);
                                glyph = smoothstep(0.10, 0.0, abs(dT));
                            } else if (boxIdx == 3) {
                                // Rotating Tank Turret
                                float dTur = length(ic + vec2(0.15, 0.0)) - 0.42;
                                float dGun = max(abs(ic.x - 0.35) - 0.42, abs(ic.y) - 0.10);
                                glyph = smoothstep(0.08, -0.02, min(dTur, dGun));
                            } else if (boxIdx == 4) {
                                // Heavy Rifled Cannon
                                float dB = max(abs(ic.x) - 0.72, abs(ic.y) - 0.14);
                                glyph = smoothstep(0.08, -0.02, dB);
                            } else {
                                // Crew / Commander Silhouette
                                float dH = length(ic - vec2(0.0, -0.28)) - 0.26;
                                float dS = length((ic - vec2(0.0, 0.42)) * vec2(0.8, 1.2)) - 0.42;
                                glyph = smoothstep(0.08, -0.02, min(dH, dS));
                            }
                            cardCol = mix(cardCol, vec3(0.68, 0.74, 0.80), clamp(glyph, 0.0, 1.0));
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
                                // Hand / Hold Position
                                float palm = max(abs(ic.x) - 0.38, abs(ic.y - 0.15) - 0.35);
                                float fingers = max(abs(ic.x) - 0.34, abs(ic.y + 0.25) - 0.28) + step(0.55, fract(ic.x * 5.0)) * 0.2;
                                glyph = smoothstep(0.08, -0.02, min(palm, fingers));
                            } else if (cmdId == 1) {
                                // 4-Way Tactical Move Cross
                                float crossD = min(max(abs(ic.x) - 0.12, abs(ic.y) - 0.68), max(abs(ic.y) - 0.12, abs(ic.x) - 0.68));
                                glyph = smoothstep(0.08, -0.02, crossD);
                            } else if (cmdId == 2) {
                                // Target Crosshair / Attack
                                float r = length(ic);
                                float ring = abs(r - 0.52) - 0.07;
                                float hairs = min(abs(ic.x), abs(ic.y)) - 0.05;
                                glyph = smoothstep(0.06, -0.02, min(ring, max(hairs, r - 0.72)));
                            } else if (cmdId == 3) {
                                // Shield / Guard Area
                                float sh = length(ic * vec2(1.15, 0.90)) - 0.58;
                                glyph = smoothstep(0.09, 0.0, abs(sh)) + smoothstep(0.08, -0.02, max(sh + 0.18, -ic.x));
                            } else if (cmdId == 4) {
                                // Wrench / Repair
                                float dBar = abs(ic.x + ic.y) - 0.14;
                                glyph = smoothstep(0.08, -0.02, max(dBar, length(ic) - 0.65));
                            } else if (cmdId == 5) {
                                // Star / Special Ability
                                float ang = atan(ic.y, ic.x);
                                float r = length(ic) * (1.0 + 0.35 * cos(ang * 5.0));
                                glyph = smoothstep(0.55, 0.42, r);
                            } else if (cmdId == 6) {
                                // Gear / Settings
                                float r = length(ic);
                                float ang = atan(ic.y, ic.x);
                                float cog = abs(r - 0.45 + 0.08 * cos(ang * 8.0)) - 0.11;
                                glyph = smoothstep(0.06, -0.02, cog);
                            } else if (cmdId == 7) {
                                // Padlock / Lock Stance
                                float body = max(abs(ic.x) - 0.38, abs(ic.y - 0.18) - 0.28);
                                float shackle = max(abs(length(ic - vec2(0.0, -0.15)) - 0.24) - 0.06, ic.y + 0.12);
                                glyph = smoothstep(0.07, -0.02, min(body, shackle));
                            } else if (cmdId == 8) {
                                // Diagonal Expand / Scatter
                                float d1 = abs(ic.x - ic.y) - 0.09;
                                glyph = smoothstep(0.07, -0.02, max(d1, max(abs(ic.x), abs(ic.y)) - 0.62));
                            } else {
                                // Stop / Cancel 'X'
                                float dX = min(abs(ic.x - ic.y), abs(ic.x + ic.y)) - 0.11;
                                glyph = smoothstep(0.07, -0.02, max(dX, max(abs(ic.x), abs(ic.y)) - 0.58));
                            }
                            cardCol = mix(cardCol, vec3(0.72, 0.78, 0.84), clamp(glyph, 0.0, 1.0));
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
    // 11. Composite Live Tactical Mouse Cursor (MOUSE.SHP + 4K Contrast Rim)
    // ------------------------------------------------------------------------
    if (curRect.z > curRect.x && curRect.w > curRect.y) {
        if (vUV.x >= curRect.x && vUV.x < curRect.z && vUV.y >= curRect.y && vUV.y < curRect.w) {
            if (palIdx != 0u) {
                mapped = fbColor;
            } else {
                // High-contrast 4K dark drop-shadow rim around cursor sprite so it pops over any 3D surface
                vec2 texel = 1.0 / vec2(textureSize(uFrameIndex, 0));
                uint nE = texture(uFrameIndex, vUV + vec2( texel.x, 0.0)).r & 0xFFu;
                uint nW = texture(uFrameIndex, vUV + vec2(-texel.x, 0.0)).r & 0xFFu;
                uint nS = texture(uFrameIndex, vUV + vec2(0.0,  texel.y)).r & 0xFFu;
                uint nN = texture(uFrameIndex, vUV + vec2(0.0, -texel.y)).r & 0xFFu;
                if (nE != 0u || nW != 0u || nS != 0u || nN != 0u) {
                    mapped = mix(mapped, vec3(0.02, 0.06, 0.03), 0.82);
                }
            }
        }
    } else if (curRect.x > 0.0 && curRect.y > 0.0) {
        // Procedural 4K Phosphor Tactical Arrow fallback if software cursor bitmap is not yet set
        vec2 cRel = (vUV - curRect.xy) * vec2(640.0, 400.0) / 16.0;
        if (cRel.x >= -0.2 && cRel.x <= 1.1 && cRel.y >= -0.2 && cRel.y <= 1.2) {
            bool inArrow = (cRel.x >= 0.0 && cRel.y >= 0.0 && cRel.x <= cRel.y * 0.72 && (cRel.x + cRel.y * 0.65) <= 0.85);
            if (inArrow) {
                mapped = vec3(0.55, 1.0, 0.65);
            }
        }
    }

    outColor = vec4(mapped * fade, 1.0);
}
