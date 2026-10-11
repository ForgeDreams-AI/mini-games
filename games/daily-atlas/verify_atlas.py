#!/usr/bin/env python3
"""Verify a restyled Daily Atlas country image against its original.
Accepts iff: (1) bbox-normalized silhouette IoU >= 0.80, and
(2) flat countries didn't gain invented mountains (flat-green collapse check).
Usage: verify_atlas.py <original.jpg> <new.jpg>  -> exit 0 accept / 1 reject."""
import sys
from PIL import Image

SIZE = 96
SHAPE_MIN = 0.80
WHITE_THRESH = 240

def load(p):
    return Image.open(p).convert('RGB')

def mask_of(im):
    w, h = im.size
    px = im.load()
    m = bytearray(w * h)
    for y in range(h):
        row = y * w
        for x in range(w):
            if max(px[x, y]) < WHITE_THRESH:
                m[row + x] = 1
    return m, w, h

def norm_crop(im):
    m, w, h = mask_of(im)
    pts = [(x, y) for y in range(h) for x in range(w) if m[y * w + x]]
    if not pts:
        return None
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    crop = im.crop((min(xs), min(ys), max(xs) + 1, max(ys) + 1))
    s = max(crop.size)
    sq = Image.new('RGB', (s, s), (255, 255, 255))
    sq.paste(crop, ((s - crop.size[0]) // 2, (s - crop.size[1]) // 2))
    return sq.resize((SIZE, SIZE), Image.LANCZOS)

def shape_iou(a, b):
    ca, cb = norm_crop(a), norm_crop(b)
    if ca is None or cb is None:
        return 0.0
    ma, _, _ = mask_of(ca); mb, _, _ = mask_of(cb)
    inter = sum(1 for x, y in zip(ma, mb) if x and y)
    union = sum(1 for x, y in zip(ma, mb) if x or y)
    return inter / union if union else 0.0

def flat_green_frac(im):
    m, w, h = mask_of(im)
    px = im.load()
    tot = fg = 0
    for y in range(h):
        row = y * w
        for x in range(w):
            if m[row + x]:
                tot += 1
                r, g, b = px[x, y]
                if g > r + 15 and g > b + 15 and (r + g + b) / 3 < 190:
                    fg += 1
    return fg / tot if tot else 0.0

def main():
    orig_p, new_p = sys.argv[1], sys.argv[2]
    o = load(orig_p); n = load(new_p)
    # downscale huge inputs for speed; keep aspect
    for im in (o, n):
        if max(im.size) > 800:
            im.thumbnail((800, 800), Image.LANCZOS)
    si = shape_iou(o, n)
    ofg = flat_green_frac(o); nfg = flat_green_frac(n)
    print(f'shapeIoU={si:.3f} origFlatGreen={ofg:.3f} newFlatGreen={nfg:.3f}')
    if si < SHAPE_MIN:
        print(f'REJECT: silhouette drift (IoU {si:.3f} < {SHAPE_MIN})')
        return 1
    if ofg >= 0.70 and nfg < 0.50:
        print(f'REJECT: invented mountains in flat country ({ofg:.2f} -> {nfg:.2f})')
        return 1
    print('ACCEPT')
    return 0

if __name__ == '__main__':
    sys.exit(main())
