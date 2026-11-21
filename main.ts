// Flying Toaster — procedural catalogue photograph of an impossible gadget.
// Renders a 1024x1024 PNG entirely in code (no image assets, no network).
// Node 22 stdlib only: node:fs, node:zlib, node:path, node:url.
// Deterministic: every coordinate is a fixed constant; no Date, no random.
import * as fs from "node:fs";
import * as zlib from "node:zlib";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const W = 1024;
const H = 1024;
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR || "/output";
const OUT_PATH = path.join(OUT_DIR, "entry.png");

// ---------------------------------------------------------------------------
// Framebuffer: RGB, 8 bit per channel.
// ---------------------------------------------------------------------------
const fb = new Uint8Array(W * H * 3);

type RGB = [number, number, number];

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(c1: RGB, c2: RGB, t: number): RGB {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

// Source-over blend of one pixel. a is 0..1.
function blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || x >= W || y < 0 || y >= H || a <= 0) return;
  const i = (y * W + x) * 3;
  if (a >= 1) {
    fb[i] = r;
    fb[i + 1] = g;
    fb[i + 2] = b;
    return;
  }
  const ia = 1 - a;
  fb[i] = clamp255(Math.round(r * a + fb[i] * ia));
  fb[i + 1] = clamp255(Math.round(g * a + fb[i + 1] * ia));
  fb[i + 2] = clamp255(Math.round(b * a + fb[i + 2] * ia));
}

function fillRect(
  x0: number, y0: number, x1: number, y1: number,
  r: number, g: number, b: number, a: number,
): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) blend(x, y, r, g, b, a);
  }
}

// Vertical linear gradient over a rectangle.
function vGradRect(
  x0: number, y0: number, x1: number, y1: number,
  top: RGB, bottom: RGB, a: number,
): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    const t = (y - y0) / Math.max(1, y1 - y0);
    const c = lerpColor(top, bottom, t);
    for (let x = xa; x <= xb; x++) blend(x, y, c[0], c[1], c[2], a);
  }
}

// Generic region painter: paints every pixel in the box where inside(x, y).
function paintRegion(
  x0: number, y0: number, x1: number, y1: number,
  inside: (x: number, y: number) => boolean,
  r: number, g: number, b: number, a: number,
): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      if (inside(x, y)) blend(x, y, r, g, b, a);
    }
  }
}

// Test whether (x, y) lies inside a rounded rect (local coords, origin top-left).
function inRoundedRect(
  x: number, y: number, w: number, h: number, rad: number,
): boolean {
  if (x < 0 || x >= w || y < 0 || y >= h) return false;
  const cx = x < rad ? rad : x > w - rad ? w - rad : x;
  const cy = y < rad ? rad : y > h - rad ? h - rad : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function fillRoundedRect(
  x0: number, y0: number, x1: number, y1: number, rad: number,
  r: number, g: number, b: number, a: number,
): void {
  const w = x1 - x0;
  const h = y1 - y0;
  paintRegion(x0, y0, x1, y1, (x, y) => inRoundedRect(x - x0, y - y0, w, h, rad), r, g, b, a);
}

// Rounded rect filled with a vertical gradient.
function vGradRoundedRect(
  x0: number, y0: number, x1: number, y1: number, rad: number,
  top: RGB, bottom: RGB, a: number,
): void {
  const w = x1 - x0;
  const h = y1 - y0;
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    const t = (y - y0) / Math.max(1, y1 - y0);
    const c = lerpColor(top, bottom, t);
    for (let x = xa; x <= xb; x++) {
      if (inRoundedRect(x - x0, y - y0, w, h, rad)) blend(x, y, c[0], c[1], c[2], a);
    }
  }
}

// Rotated ellipse (angle in degrees, clockwise positive). Optional per-pixel
// shading via shade(u, v): u,v are normalised local coords in [-1, 1].
function fillRotatedEllipse(
  cx: number, cy: number, rx: number, ry: number, angleDeg: number,
  r: number, g: number, b: number, a: number,
  shade?: (u: number, v: number) => RGB,
): void {
  const ang = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const rad = Math.max(rx, ry) + 2;
  const xa = Math.floor(cx - rad);
  const xb = Math.ceil(cx + rad);
  const ya = Math.floor(cy - rad);
  const yb = Math.ceil(cy + rad);
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const dx = x - cx;
      const dy = y - cy;
      // Rotate point back into the ellipse's local frame.
      const u = (dx * cos + dy * sin) / rx;
      const v = (-dx * sin + dy * cos) / ry;
      if (u * u + v * v <= 1) {
        if (shade) {
          const c = shade(u, v);
          blend(x, y, c[0], c[1], c[2], a);
        } else {
          blend(x, y, r, g, b, a);
        }
      }
    }
  }
}

// Rotated rounded rect, centred at (cx, cy), rotated angleDeg clockwise.
function fillRotatedRoundedRect(
  cx: number, cy: number, w: number, h: number, rad: number, angleDeg: number,
  r: number, g: number, b: number, a: number,
): void {
  const ang = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const radBox = Math.max(w, h) / 2 + 2;
  paintRegion(
    cx - radBox, cy - radBox, cx + radBox, cy + radBox,
    (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const lx = dx * cos + dy * sin + w / 2;
      const ly = -dx * sin + dy * cos + h / 2;
      return inRoundedRect(lx, ly, w, h, rad);
    },
    r, g, b, a,
  );
}

// Soft elliptical shadow: black, alpha falls from maxAlpha at centre to 0.
function softEllipseShadow(
  cx: number, cy: number, rx: number, ry: number, maxAlpha: number,
): void {
  const xa = Math.floor(cx - rx);
  const xb = Math.ceil(cx + rx);
  const ya = Math.floor(cy - ry);
  const yb = Math.ceil(cy + ry);
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const u = (x - cx) / rx;
      const v = (y - cy) / ry;
      const t = 1 - u * u - v * v;
      if (t > 0) blend(x, y, 20, 18, 16, maxAlpha * t);
    }
  }
}

// Radial spotlight: warm white, alpha falls from maxAlpha at centre to 0.
function spotlight(cx: number, cy: number, radius: number, maxAlpha: number): void {
  const xa = Math.floor(cx - radius);
  const xb = Math.ceil(cx + radius);
  const ya = Math.floor(cy - radius);
  const yb = Math.ceil(cy + radius);
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const dx = (x - cx) / radius;
      const dy = (y - cy) / radius;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        const t = 1 - d2;
        blend(x, y, 255, 253, 246, maxAlpha * t);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal 5x7 bitmap font (A-Z subset used by the badge + hyphen).
// ---------------------------------------------------------------------------
const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
};

function drawText(
  text: string, x0: number, y0: number, scale: number,
  r: number, g: number, b: number, a: number,
): void {
  let cx = x0;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] === "1") {
            fillRect(
              cx + col * scale, y0 + row * scale,
              cx + col * scale + scale - 1, y0 + row * scale + scale - 1,
              r, g, b, a,
            );
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

// ---------------------------------------------------------------------------
// PNG encoder: 8-bit RGB, filter 1 (Sub) per scanline, zlib level 9.
// ---------------------------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw scanlines with filter byte 1 (Sub) at the head of each row.
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + W * 3);
    raw[rowStart] = 1;
    const fbRow = y * W * 3;
    for (let x = 0; x < W; x++) {
      const i = fbRow + x * 3;
      const o = rowStart + 1 + x * 3;
      const leftR = x === 0 ? 0 : fb[i - 3];
      const leftG = x === 0 ? 0 : fb[i - 2];
      const leftB = x === 0 ? 0 : fb[i - 1];
      raw[o] = (fb[i] - leftR) & 0xff;
      raw[o + 1] = (fb[i + 1] - leftG) & 0xff;
      raw[o + 2] = (fb[i + 2] - leftB) & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Scene. Draw order: background -> shadow -> wings -> body -> toast -> lever
// -> butter dish -> brand badge.
// ---------------------------------------------------------------------------
function drawScene(): void {
  // 1. Background: soft warm vertical gradient + spotlight behind product.
  vGradRect(0, 0, W - 1, H - 1, [244, 242, 238], [255, 255, 255], 1);
  spotlight(512, 530, 430, 0.55);

  // 2. Ground shadow: the toaster hovers just above the surface.
  softEllipseShadow(512, 768, 265, 34, 0.16);

  // 3. Wings (behind the body). Each wing: 3 overlapping feathers, light
  //    grey-white with a soft grey outline, swept slightly upward.
  const featherFill: RGB = [238, 240, 243];
  const featherEdge: RGB = [196, 200, 207];
  const featherShade = (u: number, _v: number): RGB =>
    lerpColor([228, 231, 235], [246, 247, 249], (u + 1) / 2);
  const leftFeathers: Array<[number, number, number, number, number]> = [
    // cx, cy, rx, ry, angle
    [212, 428, 132, 26, -35],
    [250, 470, 122, 27, -30],
    [286, 508, 112, 27, -25],
  ];
  const rightFeathers: Array<[number, number, number, number, number]> = [
    [812, 428, 132, 26, 35],
    [774, 470, 122, 27, 30],
    [738, 508, 112, 27, 25],
  ];
  for (const [cx, cy, rx, ry, ang] of [...leftFeathers, ...rightFeathers]) {
    // Soft grey outline: a slightly larger ellipse drawn first, now at full
    // opacity so the pale feathers read better against the studio backdrop.
    fillRotatedEllipse(cx, cy, rx + 3, ry + 3, ang, featherEdge[0], featherEdge[1], featherEdge[2], 1.0);
    fillRotatedEllipse(cx, cy, rx, ry, ang, featherFill[0], featherFill[1], featherFill[2], 1, featherShade);
  }
  // Fairings where the wings meet the body.
  fillRoundedRect(258, 496, 318, 552, 18, 226, 214, 190, 1);
  fillRoundedRect(706, 496, 766, 552, 18, 226, 214, 190, 1);

  // 4. Toaster body: cream/stainless rounded rect, outline, top highlight,
  //    darker base strip, two dark slots on the top face.
  fillRoundedRect(246, 376, 774, 684, 52, 184, 168, 136, 1); // outline
  vGradRoundedRect(250, 380, 770, 680, 48, [247, 241, 227], [230, 217, 189], 1);
  // Bright highlight stripe along the top edge.
  fillRoundedRect(268, 388, 752, 404, 8, 255, 252, 244, 0.55);
  // Subtle darker base strip at the bottom.
  fillRoundedRect(252, 652, 768, 678, 20, 196, 180, 148, 0.5);
  // Slots.
  fillRoundedRect(338, 398, 472, 428, 10, 58, 49, 40, 1);
  fillRoundedRect(552, 398, 686, 428, 10, 58, 49, 40, 1);
  // Slot inner shading (a thin darker line at the bottom of each slot).
  fillRoundedRect(344, 420, 466, 426, 3, 30, 25, 20, 0.8);
  fillRoundedRect(558, 420, 680, 426, 3, 30, 25, 20, 0.8);

  // 5. Toast slice, tilted ~20 degrees, popping out of the right slot.
  //    Crust (slightly larger, behind), then golden body, then highlight.
  fillRotatedRoundedRect(618, 352, 118, 158, 26, 20, 181, 122, 40, 1);
  fillRotatedRoundedRect(618, 352, 104, 146, 22, 20, 234, 181, 79, 1);
  // Soft highlight on the toast's upper face.
  fillRotatedRoundedRect(600, 312, 66, 34, 12, 20, 246, 207, 125, 0.7);

  // 6. Lever on the right side of the body + round knob.
  fillRoundedRect(768, 536, 800, 560, 10, 138, 122, 94, 1);
  fillRotatedEllipse(806, 548, 12, 12, 0, 107, 91, 64, 1);
  fillRotatedEllipse(802, 544, 4, 4, 0, 214, 198, 166, 0.9);

  // 7. One accessory ONLY: small white butter dish, bottom-right, with a
  //    yellow pat of butter and its own tiny soft shadow.
  softEllipseShadow(780, 876, 88, 12, 0.10);
  fillRoundedRect(700, 832, 860, 872, 12, 255, 255, 255, 1);
  fillRotatedEllipse(780, 834, 80, 18, 0, 216, 212, 204, 1); // dish rim edge
  fillRotatedEllipse(780, 832, 76, 15, 0, 255, 255, 255, 1); // dish top
  // Butter pat with a glossy highlight dot.
  fillRoundedRect(744, 800, 816, 830, 8, 255, 217, 77, 1);
  fillRoundedRect(744, 800, 816, 810, 8, 255, 230, 130, 0.6);
  fillRotatedEllipse(762, 812, 7, 4, 0, 255, 255, 255, 0.85);

  // 8. Brand badge: tiny rounded-rect badge on the body front, "AIR-TOAST".
  const label = "AIR-TOAST";
  const scale = 2;
  const textW = (label.length * 6 - 1) * scale;
  const badgeW = textW + 20;
  const badgeH = 34;
  const bx0 = 512 - badgeW / 2;
  const by0 = 606;
  fillRoundedRect(bx0, by0, bx0 + badgeW, by0 + badgeH, 12, 233, 222, 198, 1);
  drawText(label, bx0 + 10, by0 + 10, scale, 90, 74, 51, 1);
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
function main(): void {
  // Anchor paths to this file's directory (never process.cwd()).
  void fileURLToPath(import.meta.url);
  drawScene();
  const png = encodePNG();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, png);
  console.log("wrote " + OUT_PATH + " (" + png.length + " bytes, " + W + "x" + H + ")");
}

main();
