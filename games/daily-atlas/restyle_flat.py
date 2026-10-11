#!/usr/bin/env python3
"""Restyle leftover flat-country reliefs into the black-outline 3D terrain style.

For each input (the ORIGINAL flat relief, accurate silhouette):
  1. Extract the silhouette mask (non-white pixels). The mask is NEVER altered
     in shape -- only reframed (crop padding). Silhouette IoU vs original = 1.0.
  2. Reframe: crop to mask bbox + 4% padding so the country fills the frame.
  3. Render: white bg, soft drop shadow, green base (palette-matched to the
     restyled set), subtle seeded value-noise terrain texture (flat countries
     stay honest -- gentle rolling texture, no invented mountains), inner
     bevel shading for the raised-relief look, 2px black outline.
  4. Save JPEG q70 (matches the repo's recompress standard).

Usage: restyle_flat.py <in.jpg> <out.jpg>
"""
import sys
import hashlib
import numpy as np
from PIL import Image, ImageFilter

WHITE_T = 240
BASE_GREEN = np.array([102.0, 135.0, 88.0])     # median flat green of restyled set
OUTLINE_RGB = (22, 30, 20)
PAD_FRac = 0.04


def mask_of(a):
    return a.max(axis=2) < WHITE_T


def value_noise(h, w, cells, seed):
    rng = np.random.default_rng(seed)
    gh, gw = cells
    grid = rng.random((gh + 2, gw + 2)).astype(np.float32)
    ys = np.linspace(0, gh, h)[:, None]
    xs = np.linspace(0, gw, w)[None, :]
    y0 = ys.astype(int); x0 = xs.astype(int)
    fy = ys - y0; fx = xs - x0
    sy = fy * fy * (3 - 2 * fy); sx = fx * fx * (3 - 2 * fx)
    v00 = grid[y0, x0]; v10 = grid[y0, x0 + 1]
    v01 = grid[y0 + 1, x0]; v11 = grid[y0 + 1, x0 + 1]
    return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy


def edge_dist(mask, iters=8):
    """Approximate distance-to-edge (in px) via iterative max-filter."""
    d = np.zeros_like(mask, dtype=np.float32)
    cur = mask.copy()
    for i in range(1, iters + 1):
        m = Image.fromarray(cur)
        grown = np.asarray(m.filter(ImageFilter.MaxFilter(3)))
        ring = grown & ~cur
        d[ring] = i
        cur = grown
        if not (~cur).any():
            break
    d[mask & (d == 0)] = iters
    return d


def restyle(in_path, out_path):
    im = Image.open(in_path).convert('RGB')
    a = np.asarray(im).astype(np.float32)
    mask = mask_of(a)
    if not mask.any():
        raise ValueError('empty mask')

    # --- reframe to content bbox + padding ---
    ys, xs = np.where(mask)
    h0, w0 = mask.shape
    pad = int(max(h0, w0) * PAD_FRac) + 4
    x0, x1 = max(0, xs.min() - pad), min(w0, xs.max() + pad + 1)
    y0, y1 = max(0, ys.min() - pad), min(h0, ys.max() + pad + 1)
    a = a[y0:y1, x0:x1]
    mask = mask[y0:y1, x0:x1]
    H, W = mask.shape

    seed = int(hashlib.md5(in_path.encode()).hexdigest()[:8], 16)

    # --- terrain texture: gentle rolling noise, honest for flat countries ---
    n1 = value_noise(H, W, (max(2, H // 90), max(2, W // 90)), seed)
    n2 = value_noise(H, W, (max(4, H // 28), max(4, W // 28)), seed + 1)
    relief = (n1 - 0.5) * 22 + (n2 - 0.5) * 10          # +/- ~16 brightness
    tex = np.zeros((H, W, 3), np.float32)
    tex += BASE_GREEN[None, None, :]
    tex += relief[:, :, None] * np.array([0.9, 1.0, 0.85])[None, None, :]
    # faint warm variation in low spots like the restyled set's tan patches
    warm = np.clip((0.5 - n1) * 2, 0, 1)[:, :, None]
    tex = tex * (1 - warm * 0.12) + warm * 0.12 * np.array([150, 128, 95])

    # --- inner bevel: darken toward edge for raised-relief lift ---
    dist = edge_dist(mask, iters=8)
    bevel = np.clip(1 - dist / 8, 0, 1) ** 1.5          # 1 at edge -> 0 inside
    shade = 1 - bevel[:, :, None] * 0.28
    tex *= shade

    # --- compose: shadow, fill, outline ---
    canvas = np.full((H, W, 3), 255, np.float32)
    small = mask.sum() < 20000
    if not small:
        # soft drop shadow (skipped for small shapes: it would swamp the mask)
        sh = Image.fromarray((mask * 255).astype(np.uint8)).filter(
            ImageFilter.GaussianBlur(6))
        sha = (np.asarray(sh).astype(np.float32) / 255 * 70)
        dy, dx = 5, 4
        sh_canvas = np.zeros((H, W))
        sh_canvas[dy:, dx:] = sha[:H - dy, :W - dx]
        shadow_rgb = np.array([40, 40, 40], np.float32)
        canvas = canvas * (1 - sh_canvas[:, :, None] / 255) + \
            shadow_rgb * (sh_canvas[:, :, None] / 255)

    canvas[mask] = tex[mask]

    # black outline ring, drawn INSIDE the silhouette (mask minus eroded mask):
    # the outer edge stays exactly on the original boundary -> mask unchanged.
    m_img = Image.fromarray((mask * 255).astype(np.uint8))
    filt = 5 if mask.sum() > 20000 else 3
    eroded = np.asarray(m_img.filter(ImageFilter.MinFilter(filt))) > 0
    ring = mask & ~eroded
    canvas[ring] = OUTLINE_RGB

    out = Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8))
    out.save(out_path, 'JPEG', quality=70)
    print(f'wrote {out_path} ({W}x{H})')


if __name__ == '__main__':
    restyle(sys.argv[1], sys.argv[2])
