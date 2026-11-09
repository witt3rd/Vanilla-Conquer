import Lean.Data.Json
import CnCLean.Core.Types
import CnCLean.Core.Random
import CnCLean.Sim.Unit
import CnCLean.Sim.Step

namespace CnCLean.Differential

open Lean
open CnCLean.Core
open CnCLean.Sim

/-- Parse a 2D point `{ "x": int, "y": int }` from JSON -/
def parsePoint2D (j : Json) : Except String Point2D := do
  let x ← (j.getObjVal? "x") >>= Json.getInt?
  let y ← (j.getObjVal? "y") >>= Json.getInt?
  return { x := x, y := y }

/-- Parse a `UnitState` record from JSON -/
def parseUnitState (j : Json) : Except String UnitState := do
  let id ← (j.getObjVal? "id") >>= Json.getNat?
  let unitType ← (j.getObjVal? "type") >>= Json.getStr?
  let coord ← (j.getObjVal? "coord") >>= parsePoint2D
  let cell ← (j.getObjVal? "cell") >>= parsePoint2D
  let facingNat ← (j.getObjVal? "facing") >>= Json.getNat?
  let desiredNat ← (j.getObjVal? "desiredFacing") >>= Json.getNat?
  let headTo ← (j.getObjVal? "headTo") >>= parsePoint2D
  let isDriving ← (j.getObjVal? "isDriving") >>= Json.getBool?
  let speedNat ← (j.getObjVal? "speed") >>= Json.getNat?
  let navCom ← (j.getObjVal? "navCom") >>= parsePoint2D
  let pathJson ← (j.getObjVal? "path") >>= Json.getArr?
  let mut pathList : List UInt8 := []
  for pElem in pathJson do
    let pNat ← pElem.getNat?
    pathList := pathList ++ [UInt8.ofNat pNat]
  return {
    id := id
    unitType := unitType
    coord := coord
    cell := cell
    facing := UInt8.ofNat facingNat
    desiredFacing := UInt8.ofNat desiredNat
    headTo := headTo
    isDriving := isDriving
    speed := UInt8.ofNat speedNat
    navCom := navCom
    path := pathList
  }

/-- Parse a single tick NDJSON line into `SimState` -/
def parseSimStateLine (line : String) : Except String SimState := do
  let j ← Json.parse line
  let tick ← (j.getObjVal? "tick") >>= Json.getNat?
  let seedNat ← (j.getObjVal? "seed") >>= Json.getNat?
  let unitsArr ← (j.getObjVal? "units") >>= Json.getArr?
  let actionsArr ← (j.getObjVal? "actions") >>= Json.getArr?
  let mut unitsList : List UnitState := []
  for uElem in unitsArr do
    let u ← parseUnitState uElem
    unitsList := unitsList ++ [u]
  let mut actionsList : List String := []
  for aElem in actionsArr do
    let aStr ← aElem.getStr?
    actionsList := actionsList ++ [aStr]
  return {
    tick := tick
    seed := UInt32.ofNat seedNat
    units := unitsList
    actions := actionsList
  }

/-- Verify a sequence of parsed `SimState` ticks against Lean's `stepTick` oracle -/
def verifyTraceSequence (states : List SimState) : Except String Nat := do
  match states with
  | [] => return 0
  | [_] => return 1
  | s0 :: rest =>
    let mut prev := s0
    let mut count : Nat := 1
    for curr in rest do
      let expected := stepTick prev curr.actions
      if curr.tick != expected.tick then
        throw s!"Tick mismatch at index {count}: expected tick {expected.tick}, got {curr.tick}"
      if curr.seed != expected.seed then
        throw s!"PRNG seed desync at tick {curr.tick}: expected {expected.seed}, got {curr.seed}"
      if curr.units != expected.units then
        throw s!"Unit state desync at tick {curr.tick}"
      prev := curr
      count := count + 1
    return count

end CnCLean.Differential
