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
    fieldsOut = sampleTerrainFields(worldCell);
    float warp = (fbm3(globalCell * 2.3) - 0.5) * 0.22;

    float waterField = smoothstep(0.32, 0.68, fieldsOut.x + warp * 0.65);
    float rockField  = smoothstep(0.28, 0.72, fieldsOut.z + warp * 0.55);
    float roadField  = smoothstep(0.35, 0.68, fieldsOut.y);

    // Base rolling micro-topography
    float microH = (fbm4(globalCell * 1.8) - 0.5) * 0.065;
    microH *= (1.0 - roadField * 0.85) * (1.0 - waterField);

    // Rock cliffs & escarpments rise 0.42 cell units (~10m) with stratified terraces
    float strata = fbm4(globalCell * 5.5);
    float cliffH = rockField * (0.34 + 0.14 * strata);

    // Road crown
    float roadH = roadField * 0.018;

    // Check cell smudge for blast craters
    ivec2 ci = ivec2(floor(worldCell));
    uint raw = fetchCellRaw(ci);
    uint ovl = (raw >> 4u) & 15u;
    uint sub = (raw >> 8u) & 15u;
    uint slope = (raw >> 12u) & 15u;

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
        roadH = 0.14;
    }

    // Water surface sits slightly below shoreline
    float waterH = -0.055 * waterField;

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
// House Faction PBR Trim Colors
// ----------------------------------------------------------------------------
vec3 getHouseTrimColor(int houseId) {
    if (houseId == 0) return vec3(0.92, 0.72, 0.22); // GDI Ion-Gold
    if (houseId == 1) return vec3(0.88, 0.14, 0.14); // Nod Laser-Crimson
    if (houseId == 2) return vec3(0.75, 0.73, 0.68); // Neutral Titanium-Tan
    if (houseId == 3) return vec3(0.22, 0.68, 0.85); // Multi Teal-Blue
    if (houseId == 4) return vec3(0.92, 0.45, 0.12); // Multi Amber-Orange
    if (houseId == 5) return vec3(0.20, 0.78, 0.32); // Multi Emerald
    return vec3(0.55, 0.58, 0.62);                   // Steel Gray
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
            matId = (sub == 0u) ? 11 : ((sub == 1u || sub == 3u) ? 12 : 13);
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
            // UNIT_HTANK: GDI MAMMOTH TANK (Quad-track pods, massive hull, twin 120mm cannons, side Tusk pods)
            vec3 tpPod = vec3(abs(hp.x) - 0.30, abs(hp.y) - 0.22, hp.z - 0.085);
            dTread = sdRoundBox(tpPod, vec3(0.09, 0.185, 0.075), 0.018);

            // Sloped heavy glacis hull
            vec3 hullP = hp - vec3(0.0, 0.0, 0.155);
            dHull = sdRoundBox(hullP, vec3(0.26, 0.36, 0.085), 0.024);

            // Wide Mammoth Turret + Twin 120mm Barrels + Side Missile Pods
            vec3 turP = tp - vec3(0.0, 0.04, 0.275);
            dTurret = sdRoundBox(turP, vec3(0.195, 0.215, 0.075), 0.024);
            // Side Tusk rocket pods
            dTurret = min(dTurret, sdRoundBox(vec3(abs(tp.x) - 0.225, tp.y - 0.03, tp.z - 0.285), vec3(0.045, 0.135, 0.055), 0.012));
            // Dual 120mm rifled barrels pointing forward (-Y)
            vec3 barP = vec3(abs(tp.x) - 0.068, tp.y + 0.27, tp.z - 0.28);
            dTurret = min(dTurret, sdCylinderY(barP, 0.036, 0.23));
        } else if (subType == 1) {
            // UNIT_MTANK: GDI MEDIUM TANK (M1A2-style wide sloped hull, reactive skirts, 120mm cannon)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.25, hp.y, hp.z - 0.075), vec3(0.078, 0.34, 0.068), 0.016);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.0, 0.135), vec3(0.225, 0.32, 0.072), 0.022);
            dTurret = sdRoundBox(tp - vec3(0.0, 0.02, 0.235), vec3(0.165, 0.185, 0.064), 0.022);
            dTurret = min(dTurret, sdCylinderY(tp - vec3(0.0, -0.25, 0.235), 0.034, 0.22));
        } else if (subType == 2) {
            // UNIT_LTANK: NOD LIGHT TANK (Compact wedge hull, rounded recon turret, 75mm gun)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.21, hp.y, hp.z - 0.068), vec3(0.068, 0.28, 0.060), 0.014);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.0, 0.12), vec3(0.185, 0.27, 0.064), 0.018);
            dTurret = sdRoundBox(tp - vec3(0.0, 0.01, 0.205), vec3(0.135, 0.15, 0.056), 0.024);
            dTurret = min(dTurret, sdCylinderY(tp - vec3(0.0, -0.21, 0.205), 0.030, 0.18));
        } else if (subType == 3) {
            // UNIT_STANK: NOD STEALTH TANK (Angular F-117 stealth chassis + twin rocket bay)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.21, hp.y, hp.z - 0.062), vec3(0.060, 0.29, 0.055), 0.012);
            vec3 sp = hp - vec3(0.0, 0.0, 0.13);
            sp.x *= 1.0 + 0.55 * max(0.0, -sp.y);
            dHull = sdRoundBox(sp, vec3(0.195, 0.31, 0.072), 0.010);
            dTurret = sdBox(hp - vec3(0.0, 0.04, 0.215), vec3(0.135, 0.16, 0.052));
        } else if (subType == 4) {
            // UNIT_FTANK: NOD FLAME TANK (Twin rear pressurized fuel tanks + dual front flame nozzles)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.22, hp.y, hp.z - 0.070), vec3(0.070, 0.29, 0.064), 0.015);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.0, 0.125), vec3(0.195, 0.28, 0.068), 0.018);
            // Twin rear cylindrical fuel tanks
            vec3 tankP = vec3(abs(hp.x) - 0.105, hp.y - 0.10, hp.z - 0.215);
            dTurret = sdCylinderY(tankP, 0.072, 0.135);
            // Dual forward flame projectors
            vec3 nozP = vec3(abs(hp.x) - 0.085, hp.y + 0.24, hp.z - 0.165);
            dTurret = min(dTurret, sdCylinderY(nozP, 0.032, 0.125));
        } else if (subType == 10) {
            // UNIT_HARVESTER: HEAVY TIBERIUM HARVESTER (Armored hopper + glowing green crystals + front claw scoops)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.28, hp.y, hp.z - 0.085), vec3(0.085, 0.36, 0.078), 0.018);
            // Rear containment hopper & sloped forward cab
            dHull  = sdRoundBox(hp - vec3(0.0, 0.06, 0.175), vec3(0.26, 0.29, 0.11), 0.024);
            dHull  = min(dHull, sdRoundBox(hp - vec3(0.0, -0.19, 0.155), vec3(0.20, 0.14, 0.088), 0.022));
            // Dual animated front harvesting claws
            float clawSwing = isSpecial ? sin(time * 9.0) * 0.045 : 0.0;
            vec3 clawP = vec3(abs(hp.x) - (0.14 + clawSwing), hp.y + 0.36, hp.z - 0.085);
            dTurret = sdRoundBox(clawP, vec3(0.058, 0.095, 0.052), 0.012);
            // Glowing Tiberium crystal core inside rear hopper grates
            dGlow = sdRoundBox(hp - vec3(0.0, 0.09, 0.255), vec3(0.165, 0.175, 0.055), 0.012);
        } else if (subType == 13) {
            // UNIT_HOVER: AMPHIBIOUS HOVERCRAFT LCAC (Wide rubber air-cushion skirt + vehicle deck + twin thrust fans)
            dTread = sdRoundBox(hp - vec3(0.0, 0.0, 0.055), vec3(0.42, 0.48, 0.052), 0.028);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.0, 0.115), vec3(0.35, 0.41, 0.035), 0.015);
            // Sidewalls & rear twin shrouded fan ducts
            dHull  = min(dHull, sdRoundBox(vec3(abs(hp.x) - 0.33, hp.y, hp.z - 0.17), vec3(0.045, 0.36, 0.055), 0.01));
            dTurret = sdCylinderY(vec3(abs(hp.x) - 0.18, hp.y - 0.34, hp.z - 0.22), 0.095, 0.055);
        } else if (subType == 14) {
            // UNIT_MHQ: MOBILE HEADQUARTERS (Armored command chassis + rotating 3D radar dish)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.23, hp.y, hp.z - 0.072), vec3(0.072, 0.31, 0.065), 0.015);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.0, 0.145), vec3(0.21, 0.29, 0.085), 0.02);
            vec3 dishP = hp - vec3(0.0, 0.04, 0.275);
            dishP.xy = rot2D(dishP.xy, time * 2.2);
            dTurret = sdRoundBox(dishP, vec3(0.18, 0.055, 0.095), 0.02);
        } else if (subType == 15) {
            // UNIT_GUNBOAT: GDI NAVAL MISSILE GUNBOAT (Sleek warship hull, bridge superstructure, bow turret)
            vec3 bowP = hp - vec3(0.0, 0.0, 0.095);
            bowP.x *= 1.0 + 0.75 * max(0.0, -bowP.y - 0.10);
            dHull  = sdRoundBox(bowP, vec3(0.24, 0.46, 0.075), 0.022);
            // Bridge cabin superstructure
            dHull  = min(dHull, sdRoundBox(hp - vec3(0.0, 0.06, 0.195), vec3(0.15, 0.18, 0.065), 0.018));
            // Rotating bow turret + twin naval cannon barrel
            dTurret = sdRoundBox(tp - vec3(0.0, -0.20, 0.185), vec3(0.11, 0.12, 0.052), 0.016);
            dTurret = min(dTurret, sdCylinderY(tp - vec3(0.0, -0.34, 0.185), 0.030, 0.14));
        } else if (subType == 16) {
            // UNIT_MCV: MOBILE CONSTRUCTION VEHICLE (Massive industrial rig + crane boom + beacon)
            dTread = sdRoundBox(vec3(abs(hp.x) - 0.29, hp.y, hp.z - 0.085), vec3(0.085, 0.38, 0.078), 0.018);
            dHull  = sdRoundBox(hp - vec3(0.0, 0.0, 0.185), vec3(0.27, 0.36, 0.115), 0.024);
            dTurret = sdRoundBox(hp - vec3(0.07, 0.02, 0.31), vec3(0.075, 0.27, 0.055), 0.014);
            dGlow  = length(hp - vec3(-0.12, -0.22, 0.31)) - 0.055;
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
            // STRUCT_GTOWER, STRUCT_ATOWER, STRUCT_TURRET, STRUCT_SAM: Defensive Emplacements
            dSuper = sdRoundBox(rel - vec3(0.0, 0.0, 0.16), vec3(halfSpan.x * 0.78, halfSpan.y * 0.78, 0.14), 0.02);
            vec2 txy = rot2D(rel.xy, -d1.y);
            vec3 tp = vec3(txy, rel.z - 0.32);
            dMetal = sdRoundBox(tp, vec3(0.18, 0.20, 0.09), 0.02);
            dMetal = min(dMetal, sdCylinderY(tp - vec3(0.0, -0.22, 0.0), 0.03, 0.18));
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
        if (subType >= 25) {
            // Outcrop Boulder Formation
            float dRock = length(rel * vec3(1.0, 1.15, 1.45) - vec3(0.0, 0.0, 0.14)) - 0.28;
            partMat = 28;
            partLocal = rel;
            return dRock;
        }
        // Swaying 3D Tree Trunk + Multi-Lobe Botanical Canopy
        vec2 wind = vec2(sin(time * 1.7 + d0.x * 0.9), cos(time * 1.3 + d0.y * 0.9)) * 0.025 * clamp(rel.z, 0.0, 1.0);
        vec3 tp = rel - vec3(wind, 0.0);
        float dTrunk = sdCapsule(tp, vec3(0.0, 0.0, 0.0), vec3(0.0, 0.0, 0.36), 0.065);

        vec3 cp = tp - vec3(0.0, 0.0, 0.46);
        float dCanopy = length(cp * vec3(1.0, 1.0, 1.25)) - 0.36;
        dCanopy = min(dCanopy, length((cp - vec3(0.16, 0.10, -0.06)) * vec3(1.1, 1.1, 1.3)) - 0.26);
        dCanopy = min(dCanopy, length((cp - vec3(-0.15, -0.08, -0.04)) * vec3(1.1, 1.1, 1.3)) - 0.25);
        dCanopy = min(dCanopy, length((cp - vec3(0.04, -0.16, 0.06)) * vec3(1.1, 1.1, 1.3)) - 0.24);

        // Blossom Tree glowing Tiberium spore pods
        if (subType == 18 || subType == 19) {
            float dSpore = length(cp - vec3(0.0, 0.0, 0.18)) - 0.16;
            if (dSpore < dCanopy && dSpore < dTrunk) {
                partMat = 23;
                partLocal = cp;
                return dSpore;
            }
        }

        if (dTrunk < dCanopy) {
            partMat = 26;
            partLocal = tp;
            return dTrunk;
        }
        partMat = 27;
        partLocal = cp;
        return dCanopy;
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
// Main Native-4K 3D Tactical Battlefield & UI Compositor
// ----------------------------------------------------------------------------
void main() {
    float time = uTac.view_params0.x;
    vec4 tacRect = vec4(uTac.view_params0.y, uTac.view_params0.z, uTac.view_params0.w, uTac.view_params1.x);
    float fade = clamp(uTac.view_params3.w, 0.0, 1.0);

    // 1. Check if pixel is in Top Tab Bar, Right Sidebar, Modal Dialog Box, or Tooltip Box
    bool inTacViewport = (vUV.x >= tacRect.x && vUV.x < tacRect.z && vUV.y >= tacRect.y && vUV.y < tacRect.w);

    vec4 dlgRect = uTac.overlay_rects[1];
    bool inDialog = (dlgRect.z > dlgRect.x && vUV.x >= dlgRect.x && vUV.x <= dlgRect.z && vUV.y >= dlgRect.y && vUV.y <= dlgRect.w);

    vec4 tipRect = uTac.overlay_rects[2];
    bool inTooltip = (tipRect.z > tipRect.x && vUV.x >= tipRect.x && vUV.x <= tipRect.z && vUV.y >= tipRect.y && vUV.y <= tipRect.w);

    // Sample 8-bit software framebuffer for UI / HUD / Dialogs / Messages / Cursor
    uint palIdx = texture(uFrameIndex, vUV).r & 0xFFu;
    vec3 fbColor = uPalette.colors[palIdx].rgb;

    // Top rows of tactical view: check if multiplayer/system message text is drawn (packed in fract(view_params3.z))
    float msgV1 = fract(uTac.view_params3.z);
    bool inMsgText = (inTacViewport && msgV1 > 0.001 && vUV.y < msgV1 && palIdx != 0u && palIdx != 12u);

    if (!inTacViewport || inDialog || inTooltip || inMsgText) {
        vec3 uiCol = fbColor;

        // Upgrade Top Tab Bar & Right Sidebar with subtle 4K metallic bevels & CRT radar sheen
        if (!inTacViewport) {
            float grain = (hash12(vUV * vec2(1920.0, 1080.0)) - 0.5) * 0.025;
            uiCol = clamp(uiCol + vec3(grain), 0.0, 1.0);
            // Bevel highlight along tactical viewport frame border
            float borderDistX = abs(vUV.x - tacRect.z) * 640.0;
            float borderDistY = abs(vUV.y - tacRect.y) * 400.0;
            if (borderDistX < 2.2 && vUV.y >= tacRect.y) {
                uiCol += vec3(0.18, 0.20, 0.22) * (1.0 - borderDistX / 2.2);
            }
            if (borderDistY < 1.8 && vUV.x < tacRect.z) {
                uiCol += vec3(0.16, 0.18, 0.20) * (1.0 - borderDistY / 1.8);
            }
        } else if (inDialog) {
            // Sleek 4K titanium-glass frame glow around modal in-game dialog
            vec2 dEdge = min(vUV - dlgRect.xy, dlgRect.zw - vUV) * vec2(640.0, 400.0);
            float edgePx = min(dEdge.x, dEdge.y);
            if (edgePx < 2.5) {
                uiCol = mix(vec3(0.25, 0.85, 0.45), uiCol, edgePx / 2.5);
            }
        }
        outColor = vec4(uiCol * fade, 1.0);
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

    // Oblique 3D Camera & Sun Directions (in cell coordinate space: +X East, +Y South, +Z Up)
    // Camera looks down from South-to-North at ~65 deg elevation so +Z projects upward (-Y on screen)
    vec3 V = normalize(vec3(0.0, 0.42, 0.907));
    vec3 L = normalize(vec3(-0.52, -0.46, 0.72)); // Warm directional sun from NW
    vec3 H = normalize(V + L);

    // ------------------------------------------------------------------------
    // 3. Ray-March 3D Terrain Relief (Heightfield Displacement + Cliffs + Craters)
    // ------------------------------------------------------------------------
    vec4 terrainFields;
    float hGround = evaluateTerrainHeight(groundCellXY, globalCellXY, terrainFields);
    // 2-step relief refinement along camera vector for tall cliffs
    vec2 displacedCellXY = groundCellXY + vec2(0.0, hGround * 0.42);
    vec2 displacedGlobalXY = originCell + displacedCellXY;
    hGround = evaluateTerrainHeight(displacedCellXY, displacedGlobalXY, terrainFields);

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
        // THEATER_DESERT: Golden ochre sand dunes, terracotta hardpan, red-sandstone cliffs
        float ripples = sin(displacedGlobalXY.x * 28.0 + displacedGlobalXY.y * 12.0 + nFine * 4.0) * 0.5 + 0.5;
        soilCol  = mix(vec3(0.68, 0.50, 0.30), vec3(0.82, 0.65, 0.42), nFine * 0.75 + ripples * 0.25);
        grassCol = mix(vec3(0.56, 0.46, 0.28), vec3(0.42, 0.48, 0.24), smoothstep(0.45, 0.75, nFine));
        cliffCol = mix(vec3(0.52, 0.34, 0.22), vec3(0.68, 0.46, 0.30), nMicro);
        roadCol  = mix(vec3(0.42, 0.35, 0.26), vec3(0.30, 0.26, 0.20), nMicro);
        beachCol = vec3(0.76, 0.62, 0.42);
    } else if (theater == 3) {
        // THEATER_WINTER: Crisp snowdrifts, icy blue frost, dark slate rock cliffs
        soilCol  = mix(vec3(0.78, 0.84, 0.90), vec3(0.92, 0.95, 0.98), nFine);
        grassCol = mix(vec3(0.62, 0.70, 0.78), vec3(0.85, 0.90, 0.96), smoothstep(0.3, 0.7, nFine));
        cliffCol = mix(vec3(0.28, 0.32, 0.36), vec3(0.45, 0.50, 0.56), nMicro);
        roadCol  = mix(vec3(0.32, 0.34, 0.38), vec3(0.22, 0.24, 0.27), nMicro);
        beachCol = vec3(0.60, 0.68, 0.75);
    } else {
        // THEATER_TEMPERATE / JUNGLE: Lush meadow grass, dark loam soil, granite cliffs, asphalt roads
        soilCol  = mix(vec3(0.34, 0.27, 0.18), vec3(0.45, 0.36, 0.24), nFine);
        grassCol = mix(vec3(0.20, 0.36, 0.14), vec3(0.32, 0.48, 0.19), nFine * 0.7 + nMicro * 0.3);
        cliffCol = mix(vec3(0.34, 0.33, 0.31), vec3(0.52, 0.50, 0.47), nMicro);
        roadCol  = mix(vec3(0.24, 0.24, 0.25), vec3(0.34, 0.33, 0.31), nMicro);
        beachCol = vec3(0.66, 0.58, 0.42);
    }

    float grassWeight = smoothstep(0.28, 0.68, fbm3(displacedGlobalXY * 1.4 + vec2(5.2, 9.1)));
    vec3 surfAlbedo = mix(soilCol, grassCol, grassWeight);
    float surfRough = mix(0.86, 0.78, grassWeight);
    float surfMetal = 0.02;

    // Perturb terrain normal with 4K micro-detail
    terrainN = normalize(terrainN + vec3((nMicro - 0.5) * 0.22, (nPebble - 0.5) * 0.22, 0.0));

    // Apply Road Network & Tire Tracks
    if (roadMask > 0.01) {
        vec3 rCol = roadCol * (0.88 + 0.24 * nPebble);
        if (cellSlope == 9u) {
            // 3D Bridge deck steel & concrete planks + side guardrails
            float girder = step(0.84, abs(fract(displacedCellXY.x) * 2.0 - 1.0));
            rCol = mix(vec3(0.32, 0.33, 0.35), vec3(0.55, 0.48, 0.22), girder * 0.5);
            surfMetal = mix(surfMetal, 0.45, roadMask);
        }
        surfAlbedo = mix(surfAlbedo, rCol, roadMask);
        surfRough  = mix(surfRough, 0.62, roadMask);
    }

    // Apply Concrete Pavement & Building Bibs
    if (cellOvl == 14u || (cellOvl != 13u && cellSub == 7u)) {
        vec2 gridF = abs(fract(displacedCellXY * 2.0) - 0.5);
        float seam = smoothstep(0.46, 0.50, max(gridF.x, gridF.y));
        vec3 concCol = mix(vec3(0.44, 0.45, 0.47), vec3(0.22, 0.23, 0.24), seam) * (0.9 + 0.2 * nMicro);
        surfAlbedo = mix(surfAlbedo, concCol, 0.85);
        surfRough  = 0.55;
    }

    // Apply Stratified Rock Cliffs
    if (rockMask > 0.01) {
        float strataLines = sin(hGround * 42.0 + nFine * 6.0) * 0.5 + 0.5;
        vec3 rCliff = cliffCol * (0.72 + 0.45 * strataLines) * (0.85 + 0.3 * nPebble);
        surfAlbedo = mix(surfAlbedo, rCliff, rockMask);
        surfRough  = mix(surfRough, 0.68, rockMask);
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
    // 5. Animated 3D Water, River Rapids & Shoreline Surf Foam
    // ------------------------------------------------------------------------
    float shoreBand = smoothstep(0.08, 0.48, waterMask) * smoothstep(0.82, 0.42, waterMask);
    if (shoreBand > 0.01 || isCellBeach(cellRaw)) {
        float wet = clamp(shoreBand * 1.6 + (isCellBeach(cellRaw) ? 0.45 : 0.0), 0.0, 1.0);
        surfAlbedo = mix(surfAlbedo, beachCol * 0.68, wet * 0.75);
        surfRough  = mix(surfRough, 0.22, wet);
    }

    vec3 waterEmissive = vec3(0.0);
    if (waterMask > 0.45) {
        float wDepth = smoothstep(0.45, 0.95, waterMask);
        vec2 flowDir = (cellSlope == 10u) ? vec2(0.0, -3.5) : vec2(0.7, 0.4);
        vec2 wp1 = displacedGlobalXY * 4.2 + flowDir * time * 0.85;
        vec2 wp2 = displacedGlobalXY * 9.5 - flowDir.yx * time * 1.15;

        float w1 = fbm3(wp1);
        float w2 = fbm3(wp2);
        float waveH = (w1 + w2 * 0.5) * 0.04;

        vec2 dWave = vec2(
            fbm3(wp1 + vec2(0.08, 0.0)) - w1,
            fbm3(wp1 + vec2(0.0, 0.08)) - w1
        ) * 3.2;
        terrainN = normalize(vec3(-dWave.x, -dWave.y, 1.0));

        vec3 shallowWater = vec3(0.06, 0.34, 0.36);
        vec3 deepWater    = vec3(0.02, 0.11, 0.22);
        surfAlbedo = mix(shallowWater, deepWater, wDepth);
        surfRough  = 0.08;
        surfMetal  = 0.15;

        // Animated shoreline lapping surf foam & waterfall rapids
        float foamWave = sin((1.0 - waterMask) * 28.0 - time * 3.8 + w1 * 5.0) * 0.5 + 0.5;
        float foamMask = smoothstep(0.72, 0.46, waterMask) * smoothstep(0.35, 0.85, foamWave);
        if (cellSlope == 10u || cellSlope == 11u) {
            foamMask = max(foamMask, smoothstep(0.35, 0.75, w1 + w2 * 0.6));
        }
        surfAlbedo = mix(surfAlbedo, vec3(0.88, 0.94, 0.98), clamp(foamMask * 0.85, 0.0, 1.0));
        surfRough  = mix(surfRough, 0.45, clamp(foamMask, 0.0, 1.0));

        // Sky reflection on water
        vec3 R = reflect(-V, terrainN);
        vec3 skyCol = mix(vec3(0.18, 0.32, 0.48), vec3(0.55, 0.72, 0.88), clamp(R.z, 0.0, 1.0));
        float fresnel = pow(1.0 - max(dot(terrainN, V), 0.0), 4.0);
        waterEmissive = skyCol * (0.15 + 0.55 * fresnel) * (1.0 - foamMask * 0.7);
    }

    // ------------------------------------------------------------------------
    // 6. Top-Down Oblique Camera Ray-March of 3D Cell Structures (Tiberium, Walls, Crates)
    //    & 3D Articulated Entities (Vehicles, Buildings, Infantry, Aircraft, Trees)
    //    Rays march FROM THE CAMERA (u = uMax, above the scene) DOWNWARD (-V) toward u = 0 (ground)
    // ------------------------------------------------------------------------
    vec3 camDir = vec3(0.0, 0.42, 0.907); // Unit vector from ground point toward camera (+Y South, +Z Up)
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
        ivec2 testCell = groundCellIdx + ivec2(0, cy);
        uint rawC = fetchCellRaw(testCell);
        uint ovlC = (rawC >> 4u) & 15u;
        uint landC = rawC & 15u;
        if (ovlC == 0u && landC != 4u && landC != 5u) continue;

        float u = 0.42;
        for (int s = 0; s < 18; ++s) {
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

    // B. Ray-March Active 3D Entities + Accumulate Ground Shadows & Selection HUD
    int entCount = clamp(int(uTac.view_params3.x), 0, 128);
    float entityShadow = 0.0;
    vec4 hudOverlay = vec4(0.0);
    vec3 vfxAdditive = vec3(0.0);

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
        float cullRad = 0.85;
        if (cat == 1) {
            int fw = max(1, int(floor(d1.w)) & 7);
            int fh = max(1, (int(floor(d1.w)) >> 3) & 7);
            cullRad = max(float(fw), float(fh)) * 0.72 + 0.55;
        } else if (cat == 3) {
            cullRad = 1.85;
        } else if (cat == 4 || cat == 6) {
            cullRad = 1.05;
        }

        // Fast 2D bounding-box rejection (shifted slightly North for tall 3D projection)
        vec2 projCenter = d0.xy - vec2(0.0, d0.z * 0.46 + ((cat == 1) ? 0.16 : 0.08));
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

        // 2. Volumetric Explosions, Flames, Smoke & Laser Beams (Categories 5 & 6)
        if (cat == 6) {
            float stage = clamp(d1.x, 0.0, 1.0);
            float rad = clamp(d1.w, 0.18, 0.85);
            vec2 expCenter = d0.xy - vec2(0.0, 0.12);
            float r = length(groundCellXY - expCenter) / rad;
            if (r < 1.35) {
                float fNoise = fbm3((groundCellXY - expCenter) * 8.0 - vec2(0.0, time * 4.5));
                float core = smoothstep(1.15, 0.0, r - fNoise * 0.35) * (1.0 - stage * 0.75);
                if (subType == 11 || subType == 35 || subType == 59) {
                    // Smoke plume
                    float smk = smoothstep(1.1, 0.1, r - fNoise * 0.4) * (1.0 - stage * 0.85);
                    vfxAdditive = mix(vfxAdditive, vec3(0.12, 0.13, 0.15), smk * 0.65);
                } else if (subType >= 22 && subType <= 29) {
                    // Chemical / Tiberium spray cloud
                    vfxAdditive += vec3(0.12, 0.95, 0.32) * core * 1.25;
                } else if (subType == 60) {
                    // GDI Ion Cannon Orbital Particle Beam!
                    float beamW = abs(groundCellXY.x - d0.x);
                    float beam = exp(-beamW * 14.0) * step(groundCellXY.y, d0.y + 0.25) * (1.0 - stage * 0.6);
                    vfxAdditive += vec3(0.45, 0.82, 1.65) * (beam * 2.2 + core * 1.8);
                } else {
                    // High-temperature fireball + expanding shockwave + dark smoke rim
                    vec3 fireCol = mix(vec3(1.0, 0.22, 0.02), vec3(1.0, 0.92, 0.55), smoothstep(0.65, 0.0, r));
                    vfxAdditive += fireCol * core * 1.65;
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

        // 4. Damage Smoke Plume & Muzzle Flash VFX for damaged / firing units
        if ((flags & 8) != 0) {
            vec2 smkOrigin = d0.xy - vec2(0.0, 0.18);
            vec2 sd = groundCellXY - smkOrigin;
            if (sd.y < 0.05 && sd.y > -0.55 && abs(sd.x) < 0.28) {
                float rise = clamp(-sd.y / 0.55, 0.0, 1.0);
                float sn = fbm3(sd * 9.0 + vec2(0.0, time * 2.8 + float(i)));
                float smkMask = smoothstep(0.22 + rise * 0.12, 0.0, abs(sd.x + (sn - 0.5) * 0.18)) * (1.0 - rise);
                vfxAdditive = mix(vfxAdditive, vec3(0.05, 0.05, 0.06), smkMask * 0.55);
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
            // Armored Track / Tire Rubber & Steel Grousers
            float treadRib = step(0.45, fract((hitLocal.y + hitLocal.z) * 18.0));
            albedo = mix(vec3(0.12, 0.13, 0.14), vec3(0.28, 0.30, 0.33), treadRib);
            roughness = 0.62;
            metallic = 0.55;
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
            // Structure Architectural Superstructure (House armor + illuminated windows/vents)
            vec2 winGrid = fract(vec2(hitLocal.x + hitLocal.y, hitLocal.z) * 7.5);
            float winMask = step(0.68, winGrid.x) * step(0.62, winGrid.y) * step(0.08, hitLocal.z);
            albedo = mix(vec3(0.36, 0.38, 0.42), houseCol, 0.62) * (0.86 + 0.26 * metalNoise);
            roughness = 0.40;
            metallic = 0.68;
            emissive = vec3(0.95, 0.78, 0.38) * winMask * 0.55;
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
            // 3D Botanical Foliage Canopy
            vec3 leafA = (theater == 3) ? vec3(0.75, 0.85, 0.92) : ((theater == 0) ? vec3(0.32, 0.42, 0.18) : vec3(0.14, 0.38, 0.11));
            vec3 leafB = (theater == 3) ? vec3(0.22, 0.38, 0.24) : ((theater == 0) ? vec3(0.48, 0.52, 0.22) : vec3(0.28, 0.56, 0.16));
            albedo = mix(leafA, leafB, smoothstep(-0.2, 0.25, hitLocal.z) * 0.7 + metalNoise * 0.3);
            roughness = 0.76;
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

    // Terrain self-shadowing from adjacent Rock Cliffs / Walls to the North-West
    uint nwRaw = fetchCellRaw(cellIdx + ivec2(-1, -1));
    float cliffShadow = (hitMat == 0 && (isCellRock(nwRaw) || isCellWall(nwRaw)) && !isCellRock(cellRaw))
        ? smoothstep(0.65, 0.15, fract(displacedCellXY.x) + fract(displacedCellXY.y)) * 0.55
        : 0.0;
    float shadowVis = (1.0 - max(entityShadow, cliffShadow));

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

    vec3 litColor = ambientLight + directLight + dynamicLight + emissive + vfxAdditive;

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
    // 10. Volumetric 3D Shroud & Fog-of-War + ACES Filmic Tone Mapping
    // ------------------------------------------------------------------------
    float vis = terrainFields.w; // 0.0 = Unmapped Shroud, 1.0 = Fully Visible
    if (vis < 0.99) {
        float shroudNoise = fbm3(globalCellXY * 2.2 + vec2(time * 0.18, -time * 0.12));
        float shroudFactor = smoothstep(0.12, 0.82, vis + (shroudNoise - 0.5) * 0.28);
        vec3 shroudCloud = vec3(0.015, 0.02, 0.028) * (0.6 + 0.8 * shroudNoise);
        litColor = mix(shroudCloud, litColor, shroudFactor);
    }

    // ACES Filmic Tone Mapping & Subtle Contrast Grading
    vec3 x = max(vec3(0.0), litColor);
    vec3 mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
    mapped = pow(clamp(mapped, 0.0, 1.0), vec3(0.92));

    // ------------------------------------------------------------------------
    // 11. Composite Live Tactical Mouse Cursor (MOUSE.SHP + 4K Contrast Rim)
    // ------------------------------------------------------------------------
    vec4 curRect = uTac.overlay_rects[3];
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
