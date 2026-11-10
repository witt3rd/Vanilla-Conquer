# Vanilla-Conquer: Photorealistic 3D Vulkan Engine Roadmap

**North-Star Vision**: Push *Command & Conquer: Tiberian Dawn* 30+ years forward into a true photorealistic 3D RTS experience (matching `CnC-Ultra-Game.jpg`) through incremental, testable engineering stages—preserving deterministic 1995 gameplay while replacing the single-pass procedural SDF shader bottleneck with a modern multi-pass 3D Vulkan rendering and continuous movement pipeline.

---

## 1. Architectural Diagnosis: Why We Must Evolve Beyond Single-Pass SDF Ray-Marching

Our initial 3D tactical prototype rendered the entire battlefield inside a single fullscreen fragment shader (`common/shaders/tactical_3d.frag`). While that enabled rapid bring-up and live GPU frame-capture round-tripping, it hits four hard photorealism ceilings:

1. **Geometric Detail Ceiling**: Ray-marching 5–6 `sdRoundBox` / `sdCylinder` primitives per unit inside a 24-step fragment loop cannot reproduce the crisp hard-surface chamfers, reactive armor blocks, road-wheel bogies, smoke grenade launchers, pintle machine guns, radar trusswork, and compound military architecture of a 10,000+ triangle 3D mesh.
2. **Material & Texture Ceiling**: 4-octave procedural value noise (`noise2D` / `fbm3`) lacks the micro-surface fidelity of high-resolution PBR material maps (Albedo, Normal, Roughness, Height, Ambient Occlusion) blended via height-based splatmapping (`heightLerp`).
3. **Lighting, Depth & Shadow Ceiling**: Screen-space 2.5D ray-marching has no hardware depth buffer (`VK_FORMAT_D32_SFLOAT`), no true 3D perspective `View * Projection` matrix, and no directional shadow map pass—preventing real cast shadows from cliffs, trees, buildings, and gun barrels across the terrain and water.
4. **VFX & Movement Ceiling**: 2D radial noise overlays cannot match 3D self-shadowed pyroclastic smoke columns and churning wakes, and 15Hz cell-center grid snapping prevents smooth 60–144Hz terrain-following pitch/roll and any-angle steering.

---

## 2. Multi-Stage Incremental Architecture

1. **Stage 1: True 3D Perspective Camera, Vulkan Depth Buffer (`D32_SFLOAT`) & Tessellated 3D Coastal Terrain + Water Mesh Pipeline**
2. **Stage 2: `2048x2048` Directional Shadow Map Pass (PCF) & High-Res PBR Texture Array Splatmapping**
3. **Stage 3: Instanced High-Detail 3D Hard-Surface Meshes (Articulated Tanks, MCV, Hovercraft, Naval, Military Structures, Pines/Rocks)**
4. **Stage 4: 3D Volumetric Particle Emitters (Pyroclastic Smoke, Fire, Wakes, Track Decals) & Post-Processing (SSAO, Contact Shadows, ACES)**
5. **Stage 5: Hybrid Continuous 3D Movement on Discrete Navigation Grid (Terrain Pitch/Roll, 144Hz Kinematic Interpolation, String-Pulled Steering & RVO)**

---

## 3. Detailed Stage Breakdown

### Stage 1: True 3D Perspective Camera, Depth Buffer (`D32_SFLOAT`) & Tessellated 3D Terrain Mesh
- **Files**: `common/video_vulkan.cpp`, `common/video.h`, `common/shaders/terrain_3d.vert`, `common/shaders/terrain_3d.frag`
- **Deliverables**:
  1. Allocate a Vulkan hardware depth attachment (`VK_FORMAT_D32_SFLOAT`) matching the swapchain / offscreen render resolution.
  2. Introduce a true 3D RTS perspective camera (`View` and `Projection` matrices in `Tactical3DUBOData`) at a dramatic 3/4 oblique elevation angle with exact ray-plane/heightfield mouse picking so clicking units and cells remains 100% pixel-accurate.
  3. Generate a high-density 3D terrain vertex/index buffer ($256 \times 256$ tessellated mesh across the visible tactical footprint) displaced by multi-scale eroded coastal cliff strata, beachhead ramps, and blast craters.
  4. Render a separate 3D animated ocean wave mesh with depth-based water absorption, refracted seabed, and multi-layered breaking whitewater surf along the terrain shoreline intersection.

### Stage 2: Real Directional Shadow Mapping (`2048x2048` PCF) & High-Resolution PBR Material Splatmapping
- **Files**: `common/video_vulkan.cpp`, `common/shaders/shadow_depth.vert`, `common/shaders/terrain_3d.frag`
- **Deliverables**:
  1. Add a dedicated offscreen **Directional Sun Shadow Pass** (`2048x2048` `VK_FORMAT_D32_SFLOAT`) rendered from the sun's orthographic light-space matrix ($P_{\text{sun}} \cdot V_{\text{sun}}$) prior to the main color pass, using Percentage-Closer Filtering (PCF) + normal-offset bias.
  2. Synthesize and upload a high-resolution (`1024x1024` mipmapped) **PBR Tileable Texture Array** (`VK_IMAGE_VIEW_TYPE_2D_ARRAY`) at Vulkan startup containing Albedo, Normal, Roughness, and Height maps for:
     - Stratified coastal shale & fractured granite cliffs
     - Damp pebble-strewn earth & olive scrubland
     - Wet coastal sand & lacy sea-foam
     - Muddy tank-rutted dirt road & poured concrete bastions
  3. Blend terrain materials using height-modulated splatmapping (`heightLerp`) so rocks poke realistically through mud and sand rather than blurring together.

### Stage 3: Instanced High-Detail 3D Hard-Surface Meshes (Units, Structures & Foliage)
- **Files**: `common/meshes_3d.h`, `common/meshes_3d.cpp`, `common/video_vulkan.cpp`, `common/shaders/unit_mesh_3d.vert`, `common/shaders/unit_mesh_3d.frag`
- **Deliverables**:
  1. Build a procedural/parametric **High-Poly Hard-Surface 3D Mesh Builder** (plus optional `.obj`/`.gltf` asset override loader) stored in GPU vertex/index buffers (`VkBuffer`), with articulated sub-meshes per unit:
     - **M1A2 Abrams & Mammoth Tank**: Beveled composite glacis plates, armored side skirts, 6 individual road wheels + drive sprockets + track links per side, polygonal sloped turret, bustle rack, commander cupola, Pintle M2HB machine gun, smoke grenade launchers, and 120mm rifled cannon with bore evacuator.
     - **GDI MCV, Humvee, APC, MLRS, Harvester**: Detailed cab windshields, multi-axle off-road tires with tread blocks, radar/tow rigs, and articulated weapon mounts.
     - **LCAC Amphibious Hovercraft & Naval Gunboat**: Corrugated rubber cushion skirt, twin stern lift-fan shrouds, control bridge, deck cargo bay, and naval gun turrets.
     - **Military Base Compound Structures**: Reinforced concrete seawall bastions, octagonal guard bunkers with sandbag parapets, steel lattice communications/radar towers with rotating parabolic dishes, power plant cooling towers, and weapons factory hangars.
     - **Coastal Pine Trees, Scrub Bushes & Craggy Boulders**: Multi-tiered 3D bough geometry and faceted rock outcrops casting real shadow-map shadows.
  2. Render all 3D meshes in both the **Shadow Pass** and the **Main PBR Pass**, AND use the exact same high-poly 3D mesh for the **Bottom-Left Selected Unit Inspector Card** studio viewport.

### Stage 4: 3D Volumetric Particle Emitters, Water Wakes, Track Decals & Post-Processing
- **Files**: `tiberiandawn/display.cpp`, `common/shaders/particles_3d.vert`, `common/shaders/particles_3d.frag`, `common/shaders/hud_composite.frag`
- **Deliverables**:
  1. **3D Pyroclastic Smoke & Fire Columns**: Instanced 3D volumetric/billboarded particle emitters with normal-mapped puff lighting—self-shadowed by the sun at the top, lit warm orange from the blazing fire core at the base, and drifting northward in the coastal wind.
  2. **Persistent Tank-Track & Scorch Decals**: Project muddy track ruts behind moving vehicles and dark carbon blast craters under explosions.
  3. **Screen-Space Ambient Occlusion (SSAO) & Contact Shadows**: Deepen crevices under tank hulls, road wheels, cliff overhangs, and bunker foundations.
  4. **Sleek Dark-Slate HUD Compositor Pass**: Render the 4 floating dark-slate corner HUD panels (`Top-Left Telemetry`, `Top-Right OBJECTIVES + Live Satellite Minimap`, `Bottom-Left High-Poly 3D Unit Inspector`, `Bottom-Right 5x2 Tactical Command Dock`) + 4K cursor over the tone-mapped 3D scene.

### Stage 5: Hybrid Continuous 3D Movement on Discrete Navigation Structures
- **Files**: `tiberiandawn/drive.cpp`, `tiberiandawn/foot.cpp`, `tiberiandawn/display.cpp`
- **Deliverables**:
  1. **3D Terrain Pitch, Roll & Elevation Alignment**: Align each unit's $3\times3$ world transform matrix to the local 3D terrain height $z = h(x, y)$ and surface normal $\vec{N}(x, y)$ so tanks tilt up beachhead ramps and roll over ridges while turrets counter-rotate toward their targets.
  2. **60–144Hz Continuous Kinematic State Interpolation**: Smoothly integrate unit position, velocity, hull yaw, turret slew, and wheel/tread rotation across render frames so movement is fluid rather than stepping at 15Hz.
  3. **String-Pulled Any-Angle Steering & Local Separation**: Look ahead across `Path[]` cells using line-of-sight string-pulling and apply soft local avoidance so vehicle columns and infantry squads move along natural continuous paths.

---

## 4. Verification & Live Visual Round-Trip Protocol
At every stage:
1. Build with `nice -n 19 ionice -c 3 cmake --build build-vulkan --target VanillaTD -j4`.
2. Capture a live GPU frame via `CNC_AUTO_SCENARIO=1 CNC_AUTO_SHOWCASE=1 CNC_CAPTURE_FRAME=75 CNC_CAPTURE_PATH=/tmp/cnc_live.ppm CNC_CAPTURE_EXIT=1 ./build-vulkan/vanillatd`, convert to `/tmp/cnc_live.png`, and visually inspect against `/home/dt/Downloads/CnC-Ultra-Game.jpg`.
3. Run all 14/14 unit & e2e tests in both `build-vulkan` and `build` before committing.
