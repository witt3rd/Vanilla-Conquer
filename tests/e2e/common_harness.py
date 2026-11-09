#!/usr/bin/env python3
"""
common_harness.py - End-to-End Test Harness & Math Oracles for Vanilla-Conquer

Provides:
- Mathematical oracles for Tiberian Dawn coordinates, facings, trig tables, 5-spot layout, and LCG PRNG.
- Video presentation geometry oracles (letterbox calculation and mouse inverse mapping).
- Differential NDJSON trace schema verification and bit-for-bit comparator.
- Toolchain, binary, and environment detection.
- Unified test reporting with progressive milestone awareness.
"""

import os
import sys
import json
import time
import shutil
import subprocess
from enum import Enum
from typing import Dict, List, Tuple, Any, Optional

# Constants matching Westwood original engine defines
MAP_CELL_MAX_X_BITS = 6
MAP_CELL_MAX_Y_BITS = 6
MAP_CELL_WIDTH = 1 << MAP_CELL_MAX_X_BITS   # 64
MAP_CELL_HEIGHT = 1 << MAP_CELL_MAX_Y_BITS  # 64
TOTAL_CELLS = MAP_CELL_WIDTH * MAP_CELL_HEIGHT  # 4096
LEPTONS_PER_CELL = 256
COORD_LEPTON_MASK = 0xFF
COORD_CELL_MASK = 0x3F

# 5 Stopping positions relative to cell upper-left (in leptons: X + (Y << 16))
# Westwood: StoppingCoordAbs in const.cpp
# 0: center (128, 128) -> 0x00800080
# 1: NW     (64, 64)   -> 0x00400040
# 2: NE     (192, 64)  -> 0x004000C0
# 3: SW     (64, 192)  -> 0x00C00040
# 4: SE     (192, 192) -> 0x00C000C0
STOPPING_COORD_ABS = [
    0x00800080,
    0x00400040,
    0x004000C0,
    0x00C00040,
    0x00C000C0,
]

# Adjacent cell index offsets: N, NE, E, SE, S, SW, W, NW
ADJACENT_CELL_OFFSETS = [-64, -63, 1, 65, 64, 63, -1, -65]

# Trig Lookup Tables from coord.cpp (amplitude 128)
COS_TABLE = [
    0x00, 0x03, 0x06, 0x09, 0x0c, 0x0f, 0x12, 0x15, 0x18, 0x1b, 0x1e, 0x21, 0x24, 0x27, 0x2a, 0x2d,
    0x30, 0x33, 0x36, 0x39, 0x3b, 0x3e, 0x41, 0x43, 0x46, 0x49, 0x4b, 0x4e, 0x50, 0x52, 0x55, 0x57,
    0x59, 0x5b, 0x5e, 0x60, 0x62, 0x64, 0x65, 0x67, 0x69, 0x6b, 0x6c, 0x6e, 0x6f, 0x71, 0x72, 0x74,
    0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7b, 0x7c, 0x7d, 0x7d, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e,

    0x7f, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7d, 0x7d, 0x7c, 0x7b, 0x7b, 0x7a, 0x79, 0x78, 0x77, 0x76,
    0x75, 0x74, 0x72, 0x71, 0x70, 0x6e, 0x6c, 0x6b, 0x69, 0x67, 0x66, 0x64, 0x62, 0x60, 0x5e, 0x5b,
    0x59, 0x57, 0x55, 0x52, 0x50, 0x4e, 0x4b, 0x49, 0x46, 0x43, 0x41, 0x3e, 0x3b, 0x39, 0x36, 0x33,
    0x30, 0x2d, 0x2a, 0x27, 0x24, 0x21, 0x1e, 0x1b, 0x18, 0x15, 0x12, 0x0f, 0x0c, 0x09, 0x06, 0x03,

    0x00, 0xfd, 0xfa, 0xf7, 0xf4, 0xf1, 0xee, 0xeb, 0xe8, 0xe5, 0xe2, 0xdf, 0xdc, 0xd9, 0xd6, 0xd3,
    0xd0, 0xcd, 0xca, 0xc7, 0xc5, 0xc2, 0xbf, 0xbd, 0xba, 0xb7, 0xb5, 0xb2, 0xb0, 0xae, 0xab, 0xa9,
    0xa7, 0xa5, 0xa2, 0xa0, 0x9e, 0x9c, 0x9a, 0x99, 0x97, 0x95, 0x94, 0x92, 0x91, 0x8f, 0x8e, 0x8c,
    0x8b, 0x8a, 0x89, 0x88, 0x87, 0x86, 0x85, 0x85, 0x84, 0x83, 0x83, 0x82, 0x82, 0x82, 0x82, 0x82,

    0x82, 0x82, 0x82, 0x82, 0x82, 0x82, 0x83, 0x83, 0x84, 0x85, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a,
    0x8b, 0x8c, 0x8e, 0x8f, 0x90, 0x92, 0x94, 0x95, 0x97, 0x99, 0x9a, 0x9c, 0x9e, 0xa0, 0xa2, 0xa5,
    0xa7, 0xa9, 0xab, 0xae, 0xb0, 0xb2, 0xb5, 0xb7, 0xba, 0xbd, 0xbf, 0xc2, 0xc5, 0xc7, 0xca, 0xcd,
    0xd0, 0xd3, 0xd6, 0xd9, 0xdc, 0xdf, 0xe2, 0xe5, 0xe8, 0xeb, 0xee, 0xf1, 0xf4, 0xf7, 0xfa, 0xfd,
]

SIN_TABLE = [
    0x7f, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7d, 0x7d, 0x7c, 0x7b, 0x7b, 0x7a, 0x79, 0x78, 0x77, 0x76,
    0x75, 0x74, 0x72, 0x71, 0x70, 0x6e, 0x6c, 0x6b, 0x69, 0x67, 0x66, 0x64, 0x62, 0x60, 0x5e, 0x5b,
    0x59, 0x57, 0x55, 0x52, 0x50, 0x4e, 0x4b, 0x49, 0x46, 0x43, 0x41, 0x3e, 0x3b, 0x39, 0x36, 0x33,
    0x30, 0x2d, 0x2a, 0x27, 0x24, 0x21, 0x1e, 0x1b, 0x18, 0x15, 0x12, 0x0f, 0x0c, 0x09, 0x06, 0x03,

    0x00, 0xfd, 0xfa, 0xf7, 0xf4, 0xf1, 0xee, 0xeb, 0xe8, 0xe5, 0xe2, 0xdf, 0xdc, 0xd9, 0xd6, 0xd3,
    0xd0, 0xcd, 0xca, 0xc7, 0xc5, 0xc2, 0xbf, 0xbd, 0xba, 0xb7, 0xb5, 0xb2, 0xb0, 0xae, 0xab, 0xa9,
    0xa7, 0xa5, 0xa2, 0xa0, 0x9e, 0x9c, 0x9a, 0x99, 0x97, 0x95, 0x94, 0x92, 0x91, 0x8f, 0x8e, 0x8c,
    0x8b, 0x8a, 0x89, 0x88, 0x87, 0x86, 0x85, 0x85, 0x84, 0x83, 0x83, 0x82, 0x82, 0x82, 0x82, 0x82,

    0x82, 0x82, 0x82, 0x82, 0x82, 0x82, 0x83, 0x83, 0x84, 0x85, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a,
    0x8b, 0x8c, 0x8e, 0x8f, 0x90, 0x92, 0x94, 0x95, 0x97, 0x99, 0x9a, 0x9c, 0x9e, 0xa0, 0xa2, 0xa5,
    0xa7, 0xa9, 0xab, 0xae, 0xb0, 0xb2, 0xb5, 0xb7, 0xba, 0xbd, 0xbf, 0xc2, 0xc5, 0xc7, 0xca, 0xcd,
    0xd0, 0xd3, 0xd6, 0xd9, 0xdc, 0xdf, 0xe2, 0xe5, 0xe8, 0xeb, 0xee, 0xf1, 0xf4, 0xf7, 0xfa, 0xfd,

    0x00, 0x03, 0x06, 0x09, 0x0c, 0x0f, 0x12, 0x15, 0x18, 0x1b, 0x1e, 0x21, 0x24, 0x27, 0x2a, 0x2d,
    0x30, 0x33, 0x36, 0x39, 0x3b, 0x3e, 0x41, 0x43, 0x46, 0x49, 0x4b, 0x4e, 0x50, 0x52, 0x55, 0x57,
    0x59, 0x5b, 0x5e, 0x60, 0x62, 0x64, 0x65, 0x67, 0x69, 0x6b, 0x6c, 0x6e, 0x6f, 0x71, 0x72, 0x74,
    0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7b, 0x7c, 0x7d, 0x7d, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e,
]


def to_signed_8(val: int) -> int:
    """Interpret byte as signed 8-bit integer (-128 to 127)."""
    val = val & 0xFF
    return val - 256 if val >= 128 else val


def calcx(param: int, distance: int) -> int:
    """Tiberian Dawn calcx displacement: (signed_param * distance) >> 7"""
    s_param = to_signed_8(param)
    return (s_param * distance) >> 7


def calcy(param: int, distance: int) -> int:
    """Tiberian Dawn calcy displacement: -((signed_param * distance) >> 7)"""
    s_param = to_signed_8(param)
    return -((s_param * distance) >> 7)


def coord_move(start_coord: int, dir_facing: int, distance: int) -> int:
    """Advance 32-bit packed COORDINATE by distance in direction dir_facing."""
    x = start_coord & 0xFFFF
    y = (start_coord >> 16) & 0xFFFF
    dir_byte = dir_facing & 0xFF
    x = (x + calcx(COS_TABLE[dir_byte], distance)) & 0xFFFF
    y = (y + calcy(SIN_TABLE[dir_byte], distance)) & 0xFFFF
    return (y << 16) | x


def coord_components(coord: int) -> Tuple[int, int, int, int]:
    """Unpack COORDINATE into (cell_x, cell_y, lepton_x, lepton_y)."""
    lx = coord & 0xFF
    cx = (coord >> 8) & 0x3F
    ly = (coord >> 16) & 0xFF
    cy = (coord >> 24) & 0x3F
    return (cx, cy, lx, ly)


def make_coord(cx: int, cy: int, lx: int, ly: int) -> int:
    """Pack cell and lepton components into 32-bit COORDINATE."""
    return ((ly & 0xFF) << 16) | ((cy & 0x3F) << 24) | (lx & 0xFF) | ((cx & 0x3F) << 8)


def cell_index(cx: int, cy: int) -> int:
    """Convert cell X and Y (0..63) to 1D index (0..4095)."""
    return (cx & 0x3F) + ((cy & 0x3F) << 6)


def cell_from_index(index: int) -> Tuple[int, int]:
    """Convert 1D cell index to (cell_x, cell_y)."""
    return (index & 0x3F, (index >> 6) & 0x3F)


def cell_coord(cell: int) -> int:
    """Return centered coordinate (128, 128 leptons) for given cell index."""
    cx, cy = cell_from_index(cell)
    return make_coord(cx, cy, 128, 128)


def dir_to_facing8(dir_val: int) -> int:
    """Convert 256-step DirType to 8-step FacingType: ((dir + 16) & 0xFF) >> 5"""
    return ((dir_val + 16) & 0xFF) >> 5


def facing8_to_dir(facing: int) -> int:
    """Convert 8-step FacingType to 256-step DirType: (facing & 7) << 5"""
    return (facing & 7) << 5


def facing_difference(desired: int, current: int) -> int:
    """Shortest signed angular difference in 256-circle: int8(desired - current)."""
    diff = (desired - current) & 0xFF
    return diff - 256 if diff >= 128 else diff


def rotation_adjust(current: int, desired: int, rate: int) -> int:
    """Adjust current facing toward desired facing by clamped rate."""
    rate = min(rate & 0x7F, 127)
    diff = facing_difference(desired, current)
    if abs(diff) <= rate:
        return desired & 0xFF
    if diff > 0:
        return (current + rate) & 0xFF
    else:
        return (current - rate) & 0xFF


class WestwoodPRNG:
    """Authoritative Westwood LCG PRNG (common/random.cpp)."""
    MULT = 0x41C64E6D
    ADD = 0x00003039

    def __init__(self, seed: int = 0):
        self.seed = seed & 0xFFFFFFFF

    def step(self) -> int:
        self.seed = (self.seed * self.MULT + self.ADD) & 0xFFFFFFFF
        return (self.seed >> 10) & 0x7FFF

    def ranged(self, min_val: int, max_val: int) -> int:
        if min_val == max_val:
            return min_val
        if min_val > max_val:
            min_val, max_val = max_val, min_val
        magnitude = max_val - min_val
        highbit = 14
        while (magnitude & (1 << highbit)) == 0 and highbit > 0:
            highbit -= 1
        mask = (1 << (highbit + 1)) - 1
        pick = magnitude + 1
        while pick > magnitude:
            pick = self.step() & mask
        return pick + min_val


def calculate_letterbox(win_w: int, win_h: int, game_w: int = 320, game_h: int = 200, keep_ar: bool = True) -> Tuple[int, int, int, int]:
    """Calculate (x, y, w, h) for letterbox/pillarbox viewport matching common/video_sdl2.cpp."""
    if win_w <= 0 or win_h <= 0:
        return (0, 0, 0, 0)
    if not keep_ar or game_w <= 0 or game_h <= 0:
        return (0, 0, win_w, win_h)

    ar = float(game_w) / float(game_h)
    dst_w = win_w
    dst_h = int(dst_w / ar)
    if dst_h > win_h:
        dst_h = win_h
        dst_w = int(dst_h * ar)

    dst_x = (win_w - dst_w) // 2
    dst_y = (win_h - dst_h) // 2
    return (dst_x, dst_y, dst_w, dst_h)


def invert_mouse_coords(win_x: int, win_y: int, render_rect: Tuple[int, int, int, int], game_w: int = 320, game_h: int = 200) -> Tuple[int, int, bool]:
    """Invert window mouse coordinates to software framebuffer coordinates matching common/video_sdl2.cpp."""
    rx, ry, rw, rh = render_rect
    in_bounds = (rx <= win_x < rx + rw) and (ry <= win_y < ry + rh)

    if rw > 0 and rh > 0:
        gx = int((win_x - rx) * game_w / rw)
        gy = int((win_y - ry) * game_h / rh)
    else:
        gx = 0
        gy = 0

    # Westwood clamp
    if gx >= game_w:
        gx = game_w - 1
    if gx < 0:
        gx = 0
    if gy >= game_h:
        gy = game_h - 1
    if gy < 0:
        gy = 0

    return (gx, gy, in_bounds)


class TestStatus(Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    SKIPPED = "SKIPPED"
    PENDING_MILESTONE = "PENDING_MILESTONE"


class TestCaseResult:
    def __init__(self, name: str, tier: int, milestone: str, status: TestStatus, duration_ms: float = 0.0, message: str = "", details: Optional[Dict[str, Any]] = None):
        self.name = name
        self.tier = tier
        self.milestone = milestone
        self.status = status
        self.duration_ms = duration_ms
        self.message = message
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "tier": self.tier,
            "milestone": self.milestone,
            "status": self.status.value,
            "duration_ms": round(self.duration_ms, 2),
            "message": self.message,
            "details": self.details,
        }


def find_repo_root() -> str:
    """Locate the root directory of Vanilla-Conquer."""
    candidate = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    if os.path.exists(os.path.join(candidate, "CMakeLists.txt")) and os.path.exists(os.path.join(candidate, "common")):
        return candidate
    return "/home/dt/src/ext/Vanilla-Conquer"


def run_command(cmd: List[str], cwd: Optional[str] = None, timeout: float = 30.0) -> Tuple[int, str, str]:
    """Execute subprocess safely with timeout."""
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
        )
        return (proc.returncode, proc.stdout, proc.stderr)
    except subprocess.TimeoutExpired:
        return (-1, "", f"Command timed out after {timeout} seconds")
    except Exception as e:
        return (-2, "", str(e))
