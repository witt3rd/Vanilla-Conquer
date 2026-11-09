// AUTO-GENERATED FROM lean/CnCLean/FFI/Export.lean BY lean/scripts/extract_ffi.py
// DO NOT EDIT MANUALLY — regenerate via:
//   lake -d lean build && python3 lean/scripts/extract_ffi.py
#ifndef CNC_LEAN_FFI_H
#define CNC_LEAN_FFI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Trigonometry & Coordinate Math (tiberiandawn/coord.cpp)
uint8_t  cnc_lean_cos_lookup(uint8_t dir);
uint8_t  cnc_lean_sin_lookup(uint8_t dir);
uint16_t cnc_lean_calcx(uint8_t cos_val, uint16_t distance);
uint16_t cnc_lean_calcy(uint8_t sin_val, uint16_t distance);
uint16_t cnc_lean_move_point_x(uint16_t x, uint8_t dir, uint16_t distance);
uint16_t cnc_lean_move_point_y(uint16_t y, uint8_t dir, uint16_t distance);
uint32_t cnc_lean_coord_move(uint32_t start, uint8_t dir, uint16_t distance);
uint16_t cnc_lean_coord_cell(uint32_t coord);
uint16_t cnc_lean_coord_cell_64(uint32_t coord);
uint32_t cnc_lean_distance_coord(uint32_t coord1, uint32_t coord2);

// Non-Cryptographic Deterministic PRNG (common/random.cpp)
uint32_t cnc_lean_random_next_seed(uint32_t seed);
uint32_t cnc_lean_random_extract_val(uint32_t seed);
uint32_t cnc_lean_random_mask(uint32_t magnitude);

// 256-Step Facing Rotation Adjustment (tiberiandawn/facing.cpp)
uint8_t  cnc_lean_rotation_adjust(uint8_t current, uint8_t desired, uint8_t rate);

// Sub-Cell 5-Spot Infantry Occupancy Geometry (tiberiandawn/cell.cpp)
uint32_t cnc_lean_stopping_coord_abs(uint32_t spot_index);
uint32_t cnc_lean_spot_index(uint32_t coord);
uint32_t cnc_lean_resolve_free_spot_coord(
    uint32_t whole_coord,
    uint32_t spot_index,
    uint8_t  composite_mask,
    uint8_t  alt_idx);

#ifdef __cplusplus
}
#endif

#endif // CNC_LEAN_FFI_H
