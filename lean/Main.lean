import CnCLean

open CnCLean.Core
open CnCLean.Sim
open CnCLean.Differential

def main (args : List String) : IO UInt32 := do
  let input ← match args with
    | path :: _ => IO.FS.readFile path
    | [] => do
      let stdin ← IO.getStdin
      stdin.readToEnd

  let lines := input.splitOn "\n" |>.filter (fun s => !s.isEmpty)
  let mut states : List SimState := []
  for line in lines do
    match parseSimStateLine line with
    | .ok st => states := states ++ [st]
    | .error err =>
      IO.eprintln s!"[ERROR] Malformed trace line: {err}"
      return 1

  match verifyTraceSequence states with
  | .ok count =>
    IO.println s!"[OK] Verified {count} deterministic simulation ticks with 0 desyncs."
    return 0
  | .error err =>
    IO.eprintln s!"[DESYNC] {err}"
    return 2
