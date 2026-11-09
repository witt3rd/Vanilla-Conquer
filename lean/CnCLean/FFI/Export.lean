namespace CnCLean.FFI

/-- Packed 64-bit chunks of the 256-entry Tiberian Dawn Cosine lookup table -/
def cosPack64 (q : UInt8) : UInt64 :=
  match q with
  | 0  => 0x15120f0c09060300
  | 1  => 0x2d2a2724211e1b18
  | 2  => 0x43413e3b39363330
  | 3  => 0x575552504e4b4946
  | 4  => 0x67656462605e5b59
  | 5  => 0x7472716f6e6c6b69
  | 6  => 0x7b7b7a7978777675
  | 7  => 0x7e7e7e7e7e7d7d7c
  | 8  => 0x7d7d7e7e7e7e7e7f
  | 9  => 0x767778797a7b7b7c
  | 10 => 0x6b6c6e7071727475
  | 11 => 0x5b5e606264666769
  | 12 => 0x494b4e5052555759
  | 13 => 0x3336393b3e414346
  | 14 => 0x1b1e2124272a2d30
  | 15 => 0x0306090c0f121518
  | 16 => 0xebeef1f4f7fafd00
  | 17 => 0xd3d6d9dcdfe2e5e8
  | 18 => 0xbdbfc2c5c7cacdd0
  | 19 => 0xa9abaeb0b2b5b7ba
  | 20 => 0x999a9c9ea0a2a5a7
  | 21 => 0x8c8e8f9192949597
  | 22 => 0x8585868788898a8b
  | 23 => 0x8282828282838384
  | 24 => 0x8383828282828282
  | 25 => 0x8a89888786858584
  | 26 => 0x959492908f8e8c8b
  | 27 => 0xa5a2a09e9c9a9997
  | 28 => 0xb7b5b2b0aeaba9a7
  | 29 => 0xcdcac7c5c2bfbdba
  | 30 => 0xe5e2dfdcd9d6d3d0
  | _  => 0xfdfaf7f4f1eeebe8

/-- Unboxed C-exported Cosine lookup for 256-way direction -/
@[export cnc_lean_cos_lookup]
def cncLeanCosLookup (dir : UInt8) : UInt8 :=
  let word := cosPack64 (dir >>> 3)
  let shift : UInt64 := (dir &&& 7).toUInt64 <<< 3
  ((word >>> shift) &&& 0xFF).toUInt8

/-- Unboxed C-exported Sine lookup for 256-way direction -/
@[export cnc_lean_sin_lookup]
def cncLeanSinLookup (dir : UInt8) : UInt8 :=
  cncLeanCosLookup (dir + 64)

/-- Unboxed signed-byte * distance >> 7 displacement (`calcx`) -/
@[export cnc_lean_calcx]
def cncLeanCalcx (param : UInt8) (distance : UInt16) : UInt16 :=
  let p32 : UInt32 := param.toUInt32
  let d32 : UInt32 := distance.toUInt32
  if (param &&& 0x80) == 0 then
    ((p32 * d32) >>> 7).toUInt16
  else
    let mag : UInt32 := ((256 : UInt32) - p32) * d32
    ((0 : UInt32) - ((mag + 127) >>> 7)).toUInt16

/-- Unboxed -((signed-byte * distance) >> 7) displacement (`calcy`) -/
@[export cnc_lean_calcy]
def cncLeanCalcy (param : UInt8) (distance : UInt16) : UInt16 :=
  (0 : UInt16) - cncLeanCalcx param distance

/-- Unboxed X coordinate movement (`Move_Point` X component) -/
@[export cnc_lean_move_point_x]
def cncLeanMovePointX (x : UInt16) (dir : UInt8) (distance : UInt16) : UInt16 :=
  x + cncLeanCalcx (cncLeanCosLookup dir) distance

/-- Unboxed Y coordinate movement (`Move_Point` Y component) -/
@[export cnc_lean_move_point_y]
def cncLeanMovePointY (y : UInt16) (dir : UInt8) (distance : UInt16) : UInt16 :=
  y + cncLeanCalcy (cncLeanSinLookup dir) distance

/-- Unboxed `Coord_Move(COORDINATE start, DirType dir, unsigned short distance)` -/
@[export cnc_lean_coord_move]
def cncLeanCoordMove (start : UInt32) (dir : UInt8) (distance : UInt16) : UInt32 :=
  let x : UInt16 := (start &&& 0xFFFF).toUInt16
  let y : UInt16 := ((start >>> 16) &&& 0xFFFF).toUInt16
  let nx : UInt32 := (cncLeanMovePointX x dir distance).toUInt32
  let ny : UInt32 := (cncLeanMovePointY y dir distance).toUInt32
  (ny <<< 16) ||| nx

/-- Unboxed `Coord_Cell(COORDINATE coord)` -/
@[export cnc_lean_coord_cell]
def cncLeanCoordCell (coord : UInt32) : UInt16 :=
  let cx : UInt32 := (coord >>> 8) &&& 0x3F
  let cy : UInt32 := (coord >>> 24) &&& 0x3F
  (cx ||| (cy <<< 6)).toUInt16

/-- Unboxed `Distance_Coord(COORDINATE coord1, COORDINATE coord2)` -/
@[export cnc_lean_distance_coord]
def cncLeanDistanceCoord (coord1 coord2 : UInt32) : UInt32 :=
  let y1 : UInt32 := (coord1 >>> 16) &&& 0xFFFF
  let y2 : UInt32 := (coord2 >>> 16) &&& 0xFFFF
  let x1 : UInt32 := coord1 &&& 0xFFFF
  let x2 : UInt32 := coord2 &&& 0xFFFF
  let dy : UInt32 := if y1 >= y2 then y1 - y2 else y2 - y1
  let dx : UInt32 := if x1 >= x2 then x1 - x2 else x2 - x1
  if dy > dx then
    dy + (dx >>> 1)
  else
    dx + (dy >>> 1)

/-- Unboxed Westwood LCG PRNG seed advance (`Seed = Seed * MULT + ADD`) -/
@[export cnc_lean_random_next_seed]
def cncLeanRandomNextSeed (seed : UInt32) : UInt32 :=
  seed * (0x41C64E6D : UInt32) + (0x00003039 : UInt32)

/-- Unboxed Westwood LCG PRNG 15-bit extraction (`(Seed >> 10) & 0x7FFF`) -/
@[export cnc_lean_random_extract_val]
def cncLeanRandomExtractVal (seed : UInt32) : UInt32 :=
  (seed >>> 10) &&& (0x7FFF : UInt32)

/-- Unboxed Westwood `RandomClass::operator()(minval, maxval)` bitmask computation -/
@[export cnc_lean_random_mask]
def cncLeanRandomMask (magnitude : UInt32) : UInt32 :=
  if (magnitude &&& (0x4000 : UInt32)) != 0 then 0x7FFF
  else if (magnitude &&& (0x2000 : UInt32)) != 0 then 0x3FFF
  else if (magnitude &&& (0x1000 : UInt32)) != 0 then 0x1FFF
  else if (magnitude &&& (0x0800 : UInt32)) != 0 then 0x0FFF
  else if (magnitude &&& (0x0400 : UInt32)) != 0 then 0x07FF
  else if (magnitude &&& (0x0200 : UInt32)) != 0 then 0x03FF
  else if (magnitude &&& (0x0100 : UInt32)) != 0 then 0x01FF
  else if (magnitude &&& (0x0080 : UInt32)) != 0 then 0x00FF
  else if (magnitude &&& (0x0040 : UInt32)) != 0 then 0x007F
  else if (magnitude &&& (0x0020 : UInt32)) != 0 then 0x003F
  else if (magnitude &&& (0x0010 : UInt32)) != 0 then 0x001F
  else if (magnitude &&& (0x0008 : UInt32)) != 0 then 0x000F
  else if (magnitude &&& (0x0004 : UInt32)) != 0 then 0x0007
  else if (magnitude &&& (0x0002 : UInt32)) != 0 then 0x0003
  else 0x0001

/-- Unboxed `FacingClass::Rotation_Adjust` new facing computation -/
@[export cnc_lean_rotation_adjust]
def cncLeanRotationAdjust (current desired rate : UInt8) : UInt8 :=
  let clampedRate : UInt8 := if rate > 127 then 127 else rate
  let diffByte : UInt8 := desired - current
  let isNeg : Bool := (diffByte &&& 0x80) != 0
  let absDiff : UInt8 := if isNeg then (0 : UInt8) - diffByte else diffByte
  if absDiff < clampedRate then
    desired
  else if isNeg then
    current - clampedRate
  else
    current + clampedRate

/-- Unboxed `StoppingCoordAbs[spot_index]` lookup (`0 .. 4`) -/
@[export cnc_lean_stopping_coord_abs]
def cncLeanStoppingCoordAbs (spotIndex : UInt32) : UInt32 :=
  match spotIndex with
  | 0 => 0x00800080
  | 1 => 0x00400040
  | 2 => 0x004000C0
  | 3 => 0x00C00040
  | 4 => 0x00C000C0
  | _ => 0x00800080

/-- Unboxed `CellClass::Spot_Index(COORDINATE coord)` (`0 .. 4`) -/
@[export cnc_lean_spot_index]
def cncLeanSpotIndex (coord : UInt32) : UInt32 :=
  let rel : UInt32 := coord &&& (0x00FF00FF : UInt32)
  if cncLeanDistanceCoord rel (0x00800080 : UInt32) < (60 : UInt32) then
    0
  else
    let rx : UInt32 := rel &&& 0xFFFF
    let ry : UInt32 := (rel >>> 16) &&& 0xFFFF
    let ix : UInt32 := if rx > 0x80 then 1 else 0
    let iy : UInt32 := if ry > 0x80 then 2 else 0
    (ix ||| iy) + 1

/-- Helper to check if `pos` (`0..4`) is free in `compositeMask` (`!(compositeMask & (1 << pos))`) -/
def isSpotFreeMask (compositeMask : UInt8) (pos : UInt32) : Bool :=
  ((compositeMask >>> pos.toUInt8) &&& 1) == 0

/-- Unboxed fallback spot scanner for `CellClass::Closest_Free_Spot` -/
@[export cnc_lean_resolve_free_spot_coord]
def cncLeanResolveFreeSpotCoord (wholeCoord : UInt32) (spotIndex : UInt32) (compositeMask : UInt8) (altIdx : UInt8) : UInt32 :=
  let (s0, s1, s2, s3) : (UInt32 × UInt32 × UInt32 × UInt32) :=
    if spotIndex == 0 then
      match altIdx &&& 3 with
      | 0 => (1, 2, 3, 4)
      | 1 => (2, 3, 4, 1)
      | 2 => (3, 4, 1, 2)
      | _ => (4, 1, 2, 3)
    else
      match spotIndex with
      | 1 => (0, 2, 3, 4)
      | 2 => (0, 1, 4, 3)
      | 3 => (0, 1, 4, 2)
      | _ => (0, 2, 3, 1)
  if isSpotFreeMask compositeMask s0 then
    wholeCoord + cncLeanStoppingCoordAbs s0
  else if isSpotFreeMask compositeMask s1 then
    wholeCoord + cncLeanStoppingCoordAbs s1
  else if isSpotFreeMask compositeMask s2 then
    wholeCoord + cncLeanStoppingCoordAbs s2
  else if isSpotFreeMask compositeMask s3 then
    wholeCoord + cncLeanStoppingCoordAbs s3
  else
    0

end CnCLean.FFI
