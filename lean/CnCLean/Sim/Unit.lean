import CnCLean.Core.Types
import CnCLean.Core.Random

namespace CnCLean.Sim

open CnCLean.Core

/-- 5 stopping sub-locations within a cell in leptons:
    0: Center (128, 128) -> 0x00800080
    1: NW     (64, 64)   -> 0x00400040
    2: NE     (192, 64)  -> 0x004000C0
    3: SW     (64, 192)  -> 0x00C00040
    4: SE     (192, 192) -> 0x00C000C0 -/
def STOPPING_COORD_ABS : Array Coordinate := #[
  0x00800080,
  0x00400040,
  0x004000C0,
  0x00C00040,
  0x00C000C0
]

/-- Adjacent cell index offsets (N, NE, E, SE, S, SW, W, NW) -/
def ADJACENT_CELL_OFFSETS : Array Int := #[
  -64, -63, 1, 65, 64, 63, -1, -65
]

/-- Count how many of the 5 infantry sub-cell spots (bits 0..4) are occupied -/
def occupiedSpotCount (spotMask : UInt8) : Nat :=
  let m := spotMask &&& 0x1F
  ((m >>> 0) &&& 1).toNat +
  ((m >>> 1) &&& 1).toNat +
  ((m >>> 2) &&& 1).toNat +
  ((m >>> 3) &&& 1).toNat +
  ((m >>> 4) &&& 1).toNat

/-- True if a specific spot index (0..4) is unoccupied in `spotMask` -/
def isSpotFree (spotMask : UInt8) (spotIdx : Nat) : Bool :=
  if spotIdx < 5 then
    (((spotMask &&& 0x1F) >>> UInt8.ofNat spotIdx) &&& 1) == 0
  else
    false

/-- True if any of the 5 sub-cell spots (0..4) is free -/
def hasFreeSpot (spotMask : UInt8) : Bool :=
  (spotMask &&& 0x1F) != 0x1F

/-- Westwood `Closest_Free_Spot` deterministic sub-cell spot selection -/
def closestFreeSpot (spotMask : UInt8) (preferredSpot : Nat) (tieBreakSeqIdx : Nat := 0) : Option Nat :=
  if isSpotFree spotMask preferredSpot then
    some preferredSpot
  else
    let seq : List Nat :=
      match tieBreakSeqIdx % 4 with
      | 0 => [1, 2, 3, 4]
      | 1 => [2, 3, 4, 1]
      | 2 => [3, 4, 1, 2]
      | _ => [4, 1, 2, 3]
    seq.find? (fun s => isSpotFree spotMask s)

/-- 2D coordinate pair (x, y) in leptons or cells for JSON trace compatibility -/
structure Point2D where
  x : Int
  y : Int
  deriving Repr, DecidableEq, BEq, Inhabited

/-- Single unit deterministic simulation state -/
structure UnitState where
  id : Nat
  unitType : String
  coord : Point2D
  cell : Point2D
  facing : UInt8
  desiredFacing : UInt8
  headTo : Point2D
  isDriving : Bool
  speed : UInt8
  navCom : Point2D
  path : List UInt8
  deriving Repr, DecidableEq, BEq, Inhabited

end CnCLean.Sim
