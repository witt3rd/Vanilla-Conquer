namespace CnCLean.Core

/-- Westwood Linear Congruential Generator PRNG (common/random.cpp) -/
structure WestwoodPRNG where
  seed : UInt32
  deriving Repr, DecidableEq, BEq, Inhabited

namespace WestwoodPRNG

def MULT : UInt32 := 0x41C64E6D
def ADD  : UInt32 := 0x00003039

/-- Advance PRNG by one step, returning (15-bit random value, next PRNG state) -/
def step (rng : WestwoodPRNG) : (UInt32 × WestwoodPRNG) :=
  let nextSeed : UInt32 := rng.seed * MULT + ADD
  let val : UInt32 := (nextSeed >>> 10) &&& 0x7FFF
  (val, { seed := nextSeed })

/-- Compute bitmask covering `magnitude` matching Westwood's Random_Pick -/
def computeMask (magnitude : UInt32) : UInt32 :=
  let rec loop (bit : Nat) : UInt32 :=
    match bit with
    | 0 => 1
    | b + 1 =>
      if (magnitude &&& (1 <<< UInt32.ofNat (b + 1))) != 0 then
        (1 <<< UInt32.ofNat (b + 2)) - 1
      else
        loop b
  loop 14

/-- Bounded ranged pick (fuel-bounded for total pure termination) -/
def ranged (rng : WestwoodPRNG) (minVal maxVal : Int) (fuel : Nat := 64) : (Int × WestwoodPRNG) :=
  if minVal == maxVal then
    (minVal, rng)
  else
    let lo := min minVal maxVal
    let hi := max minVal maxVal
    let magNat := (hi - lo).toNat
    let mag : UInt32 := UInt32.ofNat magNat
    let mask := computeMask mag
    let rec pickLoop (f : Nat) (curRng : WestwoodPRNG) : (Int × WestwoodPRNG) :=
      match f with
      | 0 => (lo, curRng)
      | f' + 1 =>
        let (raw, nextRng) := curRng.step
        let pick := raw &&& mask
        if pick <= mag then
          (lo + Int.ofNat pick.toNat, nextRng)
        else
          pickLoop f' nextRng
    pickLoop fuel rng

end WestwoodPRNG
end CnCLean.Core
