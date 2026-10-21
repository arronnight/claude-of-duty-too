#!/usr/bin/env python3
"""
Crop and magnify a region of a PNG, with no dependencies and no GPU.

  python3 tools/crop.py shots/x.png out.png --rect 500,400,450,140 --zoom 3

Exists because inspecting a specific defect ("is that bot untextured or just
small and brightly exposed?") needs pixels, and every other tool in this repo
that touches images drives headless Chromium. Chromium contends with the
performance harness for the GPU, and a profiling run that shares the GPU with a
screenshot tool produces numbers that are noise. This decodes PNG in pure
Python (zlib + the five PNG filter types) so it can run at any time, including
while a measurement is in flight.

Nearest-neighbour on the way up: this is a measuring instrument, and smoothing
would invent detail that is not in the frame.
"""
import argparse
import struct
import sys
import zlib


def read_png(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit(f'{path}: not a PNG')
    pos, idat, pal, trns = 8, bytearray(), None, None
    w = h = depth = ctype = None
    while pos < len(data):
        (ln,) = struct.unpack('>I', data[pos:pos + 4])
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, depth, ctype, _, _, interlace = struct.unpack('>IIBBBBB', body)
            if interlace:
                raise SystemExit('interlaced PNG not supported')
            if depth not in (8, 16):
                raise SystemExit(f'unsupported bit depth {depth}')
        elif typ == b'PLTE':
            pal = body
        elif typ == b'tRNS':
            trns = body
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
        pos += 12 + ln

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    bpp_bits = channels * depth
    stride = (w * bpp_bits + 7) // 8
    fbpp = max(1, bpp_bits // 8)

    raw = zlib.decompress(bytes(idat))
    out = bytearray(stride * h)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ft = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if ft == 1:
            for i in range(fbpp, stride):
                line[i] = (line[i] + line[i - fbpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - fbpp] if i >= fbpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - fbpp] if i >= fbpp else 0
                c = prev[i - fbpp] if i >= fbpp else 0
                b = prev[i]
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif ft != 0:
            raise SystemExit(f'bad filter type {ft}')
        out[y * stride:(y + 1) * stride] = line
        prev = line

    # Normalise everything to 8-bit RGB.
    step = depth // 8
    rgb = bytearray(w * h * 3)
    for y in range(h):
        base = y * stride
        for x in range(w):
            o = (y * w + x) * 3
            if ctype == 3:
                idx = out[base + x]
                rgb[o:o + 3] = pal[idx * 3:idx * 3 + 3]
            else:
                s = base + x * channels * step
                if ctype in (0, 4):
                    v = out[s]
                    rgb[o] = rgb[o + 1] = rgb[o + 2] = v
                else:
                    rgb[o] = out[s]
                    rgb[o + 1] = out[s + step]
                    rgb[o + 2] = out[s + 2 * step]
    return w, h, rgb


def write_png(path, w, h, rgb):
    out = bytearray()
    for y in range(h):
        out.append(0)
        out += rgb[y * w * 3:(y + 1) * w * 3]
    comp = zlib.compress(bytes(out), 6)

    def chunk(typ, body):
        return (struct.pack('>I', len(body)) + typ + body
                + struct.pack('>I', zlib.crc32(typ + body) & 0xFFFFFFFF))

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b'IDAT', comp))
        f.write(chunk(b'IEND', b''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--rect', required=True, help='x,y,w,h in source pixels')
    ap.add_argument('--zoom', type=int, default=1)
    a = ap.parse_args()

    x0, y0, cw, ch = (int(v) for v in a.rect.split(','))
    w, h, rgb = read_png(a.src)
    x0 = max(0, min(w - 1, x0)); y0 = max(0, min(h - 1, y0))
    cw = max(1, min(w - x0, cw)); ch = max(1, min(h - y0, ch))
    z = max(1, a.zoom)
    ow, oh = cw * z, ch * z

    out = bytearray(ow * oh * 3)
    for y in range(oh):
        sy = y0 + y // z
        for x in range(ow):
            sx = x0 + x // z
            s = (sy * w + sx) * 3
            d = (y * ow + x) * 3
            out[d:d + 3] = rgb[s:s + 3]
    write_png(a.dst, ow, oh, out)
    print(f'{a.src} [{x0},{y0} {cw}x{ch}] x{z} -> {a.dst} ({ow}x{oh})')


if __name__ == '__main__':
    main()
