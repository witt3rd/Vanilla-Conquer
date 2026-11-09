#!/usr/bin/env python3
"""
Generate the native-4K Ultra Menu clean console plate, PBR/aperture mask,
and high-DPI phosphor HUD font atlas in share/vanillatd/menu_ultra.rgba.
"""

import os
import struct
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont


def build_ultra_menu_asset(src_jpeg: str, out_rgba: str) -> None:
    im = Image.open(src_jpeg).convert("RGB")
    arr = np.array(im, dtype=np.float32)
    H, W, _ = arr.shape
    assert W == 2752 and H == 1536, f"Expected 2752x1536 source, got {W}x{H}"
    clean = arr.copy()

    # 1. Synthesize clean CRT glass interior (y=148..876, x=860..1872) from pure scanline strips
    strips = [
        arr[248:276, 860:1872],
        arr[362:392, 860:1872],
        arr[480:508, 860:1872],
        arr[598:626, 860:1872],
        arr[715:765, 860:1872],
    ]
    crt_strips = np.concatenate(strips, axis=0)
    strip_ys = np.array([262.0, 377.0, 494.0, 612.0, 740.0])
    strip_means = np.stack([s.mean(axis=0) for s in strips], axis=0)

    y0, y1 = 148, 876
    x0, x1 = 860, 1872
    bh = y1 - y0
    bw = x1 - x0

    rng = np.random.default_rng(7)
    patch = np.zeros((bh, bw, 3), dtype=np.float32)

    row_cursor = 0
    while row_cursor < bh:
        chunk = min(24, bh - row_cursor)
        start_r = int(rng.integers(0, crt_strips.shape[0] - chunk))
        if (start_r % 2) != ((y0 + row_cursor) % 2):
            start_r = max(0, start_r - 1)
        src_chunk = crt_strips[start_r : start_r + chunk] - crt_strips[
            start_r : start_r + chunk
        ].mean(axis=0, keepdims=True)
        patch[row_cursor : row_cursor + chunk] = src_chunk
        row_cursor += chunk

    ys_full = np.arange(y0, y1, dtype=np.float32)
    baseline = np.zeros((bh, bw, 3), dtype=np.float32)
    for c in range(3):
        for x_i in range(bw):
            baseline[:, x_i, c] = np.interp(ys_full, strip_ys, strip_means[:, x_i, c])

    synth_crt = (baseline + patch * 0.9).clip(0, 255)

    yy = np.arange(bh, dtype=np.float32)[:, None]
    xx = np.arange(bw, dtype=np.float32)[None, :]
    wy = np.minimum(yy / 10.0, (bh - 1 - yy) / 6.0).clip(0, 1)
    wx = np.minimum(xx / 14.0, (bw - 1 - xx) / 14.0).clip(0, 1)
    mask = (wy * wx)[:, :, None]

    clean[y0:y1, x0:x1] = (1.0 - mask) * clean[y0:y1, x0:x1] + mask * synth_crt

    # 2. Cleanly inpaint the 3 baked version strings so dynamic VersionText renders cleanly
    def inpaint_patch(vy0, vy1, vx0, vx1, sx0, sy0):
        vbh = vy1 - vy0
        vbw = vx1 - vx0
        yy_v = np.arange(vbh, dtype=np.float32)[:, None]
        xx_v = np.arange(vbw, dtype=np.float32)[None, :]
        fmask = (
            np.minimum(yy_v / 6.0, (vbh - 1 - yy_v) / 6.0).clip(0, 1)
            * np.minimum(xx_v / 16.0, (vbw - 1 - xx_v) / 16.0).clip(0, 1)
        )[:, :, None]
        src = clean[sy0 : sy0 + vbh, sx0 : sx0 + vbw].copy()
        ref_mean = clean[vy0 - 10 : vy0 - 2, vx0:vx1].mean(axis=0, keepdims=True)
        src_mean = src.mean(axis=0, keepdims=True)
        src = (src - src_mean) + ref_mean
        clean[vy0:vy1, vx0:vx1] = (1.0 - fmask) * clean[vy0:vy1, vx0:vx1] + fmask * src.clip(
            0, 255
        )

    inpaint_patch(958, 1004, 420, 742, 90, 958)
    inpaint_patch(955, 1010, 1510, 1952, 1040, 955)
    inpaint_patch(958, 1004, 2306, 2628, 1980, 958)

    # 3. Build Alpha Channel (Aperture & Metallic Specular Map)
    Y_grid, X_grid = np.mgrid[0:H, 0:W].astype(np.float32)
    alpha = np.zeros((H, W), dtype=np.float32)

    r, g, b = clean[:, :, 0], clean[:, :, 1], clean[:, :, 2]
    lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
    sat = (np.maximum(r, np.maximum(g, b)) - np.minimum(r, np.minimum(g, b))) / 255.0
    metallic = np.clip((lum - 0.08) * 1.4 * (1.0 - 0.5 * sat), 0.05, 0.95)
    logo_box = (Y_grid >= 1020) & (Y_grid <= 1465) & (X_grid >= 570) & (X_grid <= 2170)
    metallic[logo_box] = np.clip(metallic[logo_box] * 1.35 + 0.12, 0.1, 1.0)
    alpha[:, :] = metallic

    # Left Viewport Aperture
    lx0, lx1, ly0, ly1 = 56.0, 782.0, 0.0, 1028.0
    in_left_zone = (X_grid < 805) & (Y_grid < 1055)
    d_left = np.minimum(
        np.minimum(X_grid - lx0, lx1 - X_grid),
        np.minimum(Y_grid - ly0 + 20.0, ly1 - Y_grid),
    )
    d_left = np.minimum(d_left, (X_grid + Y_grid - 215.0) * 0.707)
    left_mask = np.clip(d_left / 18.0, 0.0, 1.0)
    alpha[in_left_zone] = left_mask[in_left_zone]

    # Right Viewport Aperture
    rx0, rx1, ry0, ry1 = 1964.0, 2694.0, 0.0, 1034.0
    in_right_zone = (X_grid > 1945) & (Y_grid < 1055)
    d_right = np.minimum(
        np.minimum(X_grid - rx0, rx1 - X_grid),
        np.minimum(Y_grid - ry0 + 20.0, ry1 - Y_grid),
    )
    d_right = np.minimum(d_right, ((W - X_grid) + Y_grid - 225.0) * 0.707)
    right_mask = np.clip(d_right / 18.0, 0.0, 1.0)
    alpha[in_right_zone] = right_mask[in_right_zone]

    # Center CRT Screen Aperture (with 4 corner chamfers + hanging rubber wire cutout)
    cx0, cx1, cy0, cy1 = 852.0, 1894.0, 88.0, 898.0
    in_crt_zone = (X_grid >= 830) & (X_grid <= 1920) & (Y_grid >= 70) & (Y_grid <= 920)
    d_crt = np.minimum(
        np.minimum(X_grid - cx0, cx1 - X_grid),
        np.minimum(Y_grid - cy0, cy1 - Y_grid),
    )
    chamfer = 94.0
    d_crt = np.minimum(d_crt, ((X_grid - cx0) + (Y_grid - cy0) - chamfer) * 0.707)
    d_crt = np.minimum(d_crt, ((cx1 - X_grid) + (Y_grid - cy0) - chamfer) * 0.707)
    d_crt = np.minimum(d_crt, ((X_grid - cx0) + (cy1 - Y_grid) - chamfer) * 0.707)
    d_crt = np.minimum(d_crt, ((cx1 - X_grid) + (cy1 - Y_grid) - chamfer) * 0.707)
    crt_mask = np.clip(d_crt / 10.0, 0.0, 1.0)

    wire_region = (Y_grid >= 84) & (Y_grid <= 145) & (X_grid >= 920) & (X_grid <= 1780)
    green_diff = g - r
    wire_weight = np.clip((3.0 - green_diff) / 8.0, 0.0, 1.0) * np.clip(
        (45.0 - g) / 25.0, 0.0, 1.0
    )
    crt_mask[wire_region] *= 1.0 - wire_weight[wire_region]
    alpha[in_crt_zone] = crt_mask[in_crt_zone]

    # 4. Build 64px HUD Font Atlas Strip at y=1536..1599 (96 ASCII chars 32..127, cell=28x64)
    atlas_h = 64
    total_h = H + atlas_h
    rgba = np.zeros((total_h, W, 4), dtype=np.uint8)
    rgba[0:H, :, 0:3] = clean.clip(0, 255).astype(np.uint8)
    rgba[0:H, :, 3] = (alpha * 255.0).clip(0, 255).astype(np.uint8)

    btn_font_path = "/usr/share/fonts/noto/NotoSans-SemiCondensedMedium.ttf"
    if not os.path.exists(btn_font_path):
        btn_font_path = "/usr/share/fonts/liberation/LiberationSans-Regular.ttf"
    mono_font_path = "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf"
    if not os.path.exists(mono_font_path):
        mono_font_path = btn_font_path

    btn_font = ImageFont.truetype(btn_font_path, 38)
    mono_font = ImageFont.truetype(mono_font_path, 32)

    btn_img = Image.new("L", (W, atlas_h), 0)
    mono_img = Image.new("L", (W, atlas_h), 0)
    draw_btn = ImageDraw.Draw(btn_img)
    draw_mono = ImageDraw.Draw(mono_img)

    cell_w = 28
    for idx in range(96):
        ch = chr(32 + idx)
        cx = idx * cell_w + cell_w // 2
        cy = atlas_h // 2
        draw_btn.text((cx, cy), ch, fill=255, font=btn_font, anchor="mm")
        draw_mono.text((cx, cy), ch, fill=255, font=mono_font, anchor="mm")

    btn_glow = btn_img.filter(ImageFilter.GaussianBlur(radius=3.2))
    mono_glow = mono_img.filter(ImageFilter.GaussianBlur(radius=2.8))

    rgba[H:total_h, :, 0] = np.array(btn_img, dtype=np.uint8)
    rgba[H:total_h, :, 1] = np.clip(np.array(btn_glow, dtype=np.float32) * 1.6, 0, 255).astype(
        np.uint8
    )
    rgba[H:total_h, :, 2] = np.array(mono_img, dtype=np.uint8)
    rgba[H:total_h, :, 3] = np.clip(np.array(mono_glow, dtype=np.float32) * 1.6, 0, 255).astype(
        np.uint8
    )

    os.makedirs(os.path.dirname(out_rgba), exist_ok=True)
    with open(out_rgba, "wb") as f:
        # Magic 'CCMU' (0x554D4343), Width (2752), Height (1600), SceneHeight (1536)
        f.write(struct.pack("<4I", 0x554D4343, W, total_h, H))
        f.write(rgba.tobytes())

    print(f"Generated {out_rgba} ({W}x{total_h}, scene={W}x{H})")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "/home/dt/Downloads/CnC-Ultra-Menu.jpeg"
    dst = (
        sys.argv[2]
        if len(sys.argv) > 2
        else "/home/dt/src/ext/Vanilla-Conquer/share/vanillatd/menu_ultra.rgba"
    )
    build_ultra_menu_asset(src, dst)
