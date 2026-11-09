import Std.Tactic.BVDecide
import CnCLean.Core.Types
import CnCLean.Core.Random
import CnCLean.Sim.Unit
import CnCLean.Sim.Step
import CnCLean.FFI.Export

namespace CnCLean.Proofs

open CnCLean.Core
open CnCLean.Sim
open CnCLean.FFI

/-- Invariant 1: Coordinate Bounding
    Any 1D cell index constructed from `(cx, cy)` in the 64x64 cell grid is strictly bounded below 4096. -/
theorem coordinate_bounding (cx cy : Fin 64) :
    (cellIndex (UInt32.ofNat cx.val) (UInt32.ofNat cy.val)).toNat < 4096 := by
  revert cx cy
  decide

/-- Invariant 2: Cell-Lepton Packing Round-Trip
    Packing cell indices and lepton offsets via `makeCoord` and unpacking via `coordComponents`
    recovers the exact masked components for all 32-bit inputs. -/
theorem cell_lepton_roundtrip (cx cy lx ly : UInt32) :
    coordComponents (makeCoord cx cy lx ly) =
      (cx &&& (0x3F : UInt32), cy &&& (0x3F : UInt32), lx &&& (0xFF : UInt32), ly &&& (0xFF : UInt32)) := by
  simp [makeCoord, coordComponents]
  bv_decide

/-- Invariant 3: Facing 8-to-256-to-8 Round-Trip
    Converting any 8-way cardinal/ordinal facing (`0 .. 7`) to a 256-step `DirType` and back
    recovers the exact 8-way facing. -/
theorem facing_roundtrip (f : Fin 8) :
    dirToFacing8 (facing8ToDir (UInt8.ofNat f.val)) = UInt8.ofNat f.val := by
  revert f
  decide

/-- Invariant 4: Angular Monotonicity
    Adjusting `current` cardinal/ordinal facing toward `desired` facing never increases
    the shortest angular distance to `desired`. -/
theorem angular_monotonicity (current8 desired8 : Fin 8) :
    let curDir := facing8ToDir (UInt8.ofNat current8.val)
    let desDir := facing8ToDir (UInt8.ofNat desired8.val)
    angularDistance (rotationAdjust curDir desDir 16) desDir ≤ angularDistance curDir desDir ∧
    angularDistance (rotationAdjust curDir curDir 16) curDir = 0 := by
  revert current8 desired8
  decide

/-- Invariant 5: Sub-Cell 5-Spot Maximum Occupancy Limit
    Every 5-bit infantry sub-cell occupancy mask has at most 5 occupied spots (`occupiedSpotCount mask ≤ 5`),
    and a saturated cell (`0x1F`) reports zero free spots (`hasFreeSpot 0x1F = false`). -/
theorem max_occupancy_limit (spotMask : Fin 32) :
    occupiedSpotCount (UInt8.ofNat spotMask.val) ≤ 5 ∧ hasFreeSpot 0x1F = false := by
  revert spotMask
  decide

/-- Invariant 6: Atomic Step Transition Determinism
    Given identical simulation states and command actions, `stepTick` produces bit-for-bit
    identical successor simulation states. -/
theorem step_transition_determinism (s1 s2 : SimState) (a1 a2 : List String)
    (hs : s1 = s2) (ha : a1 = a2) :
    stepTick s1 a1 = stepTick s2 a2 := by
  subst hs ha
  rfl

/-- Invariant 7: FFI Exported Cell Extraction Equivalence
    The unboxed C-exported `cncLeanCoordCell` matches `cellIndex` on unpacked coordinate components
    for all 32-bit packed coordinates. -/
theorem ffi_coord_cell_equivalence (coord : UInt32) :
    let (cx, cy, _, _) := coordComponents coord
    (cncLeanCoordCell coord).toUInt32 = cellIndex cx cy := by
  simp [cncLeanCoordCell, coordComponents, cellIndex]
  bv_decide

end CnCLean.Proofs
