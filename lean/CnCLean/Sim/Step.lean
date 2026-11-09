import CnCLean.Core.Types
import CnCLean.Core.Random
import CnCLean.Sim.Unit

namespace CnCLean.Sim

open CnCLean.Core

/-- Complete simulation state at a discrete tick -/
structure SimState where
  tick : Nat
  seed : UInt32
  units : List UnitState
  actions : List String
  deriving Repr, DecidableEq, BEq, Inhabited

/-- Advance a single unit by one atomic simulation tick -/
def stepUnit (u : UnitState) : UnitState :=
  let nextFacing := rotationAdjust u.facing u.desiredFacing 16
  if u.isDriving && nextFacing == u.desiredFacing then
    let dist : Int := u.speed.toNat
    let idx := nextFacing.toNat % 256
    let cosVal := COS_TABLE.getD idx 0
    let sinVal := SIN_TABLE.getD idx 0
    let nx := u.coord.x + calcx cosVal dist
    let ny := u.coord.y + calcy sinVal dist
    let ncx := Int.fdiv nx 256
    let ncy := Int.fdiv ny 256
    { u with
      coord := { x := nx, y := ny }
      cell := { x := ncx, y := ncy }
      facing := nextFacing }
  else
    { u with facing := nextFacing }

/-- Advance the global simulation state by one deterministic tick -/
def stepTick (s : SimState) (newActions : List String := []) : SimState :=
  let rng : WestwoodPRNG := { seed := s.seed }
  let (_, nextRng) := rng.step
  { tick := s.tick + 1
    seed := nextRng.seed
    units := s.units.map stepUnit
    actions := newActions }

end CnCLean.Sim
