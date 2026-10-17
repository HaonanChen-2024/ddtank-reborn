// Pure caption renderer extracted from the pinned owner. No filesystem/process/network access.
import assert from 'node:assert/strict';
function inside(x, y, [left, top, width, height]) { return x >= left && y >= top && x < left + width && y < top + height; }
function inpaintCaption(image, rgba, box, seedRange) {
  const [left, top, width, height] = box, seed = new Set(), mask = new Set();
  const min = seedRange?.min ?? [185, 175, 120], max = seedRange?.max ?? [255, 255, 255];
  // Default reviewed buttons use pale glyphs; chat supplies its reviewed gold/black seed range.
  // Remove the glyph and its short dark outline,
  // while leaving the surrounding brick/grain pixels available for a local texture fill.
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    const p = (y * image.width + x) * 4;
    if (image.rgba[p + 3] >= 240 && min.every((v, c) => image.rgba[p + c] >= v && image.rgba[p + c] <= max[c])) seed.add(y * image.width + x);
  }
  for (const p of seed) {
    const x = p % image.width, y = Math.floor(p / image.width);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (inside(xx, yy, box) && image.rgba[(yy * image.width + xx) * 4 + 3] >= 240) mask.add(yy * image.width + xx);
    }
  }
  assert.ok(mask.size > 0, 'reviewed button caption has no pale glyphs');
  for (const p of mask) {
    const x = p % image.width, y = Math.floor(p / image.width), neighbours = [];
    // Narrow chat tabs have their gold frame immediately beside the glyphs; sample the reviewed
    // interior above/below them instead of smearing the frame into the black or gold button skin.
    if (seedRange) for (const step of [-1, 1]) {
      for (let yy = y + step; yy >= top && yy < top + height; yy += step) {
        const q = yy * image.width + x;
        if (!mask.has(q) && image.rgba[q * 4 + 3] >= 240) { neighbours.push({ p: q * 4, distance: Math.abs(yy - y) }); break; }
      }
    }
    else for (const step of [-1, 1]) {
      for (let xx = x + step; xx >= 0 && xx < image.width; xx += step) {
        const q = y * image.width + xx;
        if (!mask.has(q) && image.rgba[q * 4 + 3] >= 240) { neighbours.push({ p: q * 4, distance: Math.abs(xx - x) }); break; }
      }
    }
    if (!neighbours.length) for (const step of [-1, 1]) {
      for (let yy = y + step; yy >= 0 && yy < image.height; yy += step) {
        const q = yy * image.width + x;
        if (!mask.has(q) && image.rgba[q * 4 + 3] >= 240) { neighbours.push({ p: q * 4, distance: Math.abs(yy - y) }); break; }
      }
    }
    assert.ok(neighbours.length, 'caption texture cannot be reconstructed from surrounding pixels');
    const weight = neighbours.reduce((n, q) => n + 1 / q.distance, 0);
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(neighbours.reduce((n, q) => n + image.rgba[q.p + c] / q.distance, 0) / weight);
  }
}

export function renderBagCaption(image,entry,config,createCanvas,fontFits=[]) {
 let rgba=Buffer.from(image.rgba);
    for (const region of entry.regions) {
      const [x, y, w, h] = region.box;
      if (region.inpaint) inpaintCaption(image, rgba, region.box, region.inpaintSeed);
      else for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const p = ((y + yy) * image.width + x + xx) * 4;
        if (region.clearBoxes && !region.clearBoxes.some(box => inside(x + xx, y + yy, box))) continue;
        if (region.transparent) rgba.fill(0, p, p + 4);
        else { const [sx, sy, sw, sh] = region.sample, sp = ((sy + yy % sh) * image.width + sx + xx % sw) * 4; image.rgba.copy(rgba, p, sp, sp + 4); }
      }
      const scale = 3, canvas = createCanvas(w * scale, h * scale), ctx = canvas.getContext('2d');
      const lines = region.vertical ? [...region.text] : [region.text]; let size = region.fontSize;
      const stroke = region.strokeWidth ?? 0, outerStroke = region.outerStrokeWidth ?? 0, edge = Math.max(stroke, outerStroke);
      const textOffsetX = region.textOffsetX ?? 0, tx = (w / 2 + textOffsetX) * scale;
      while (size >= 7) { ctx.font = `bold ${size * scale}px "${config.fontFamily}"`; if (Math.max(...lines.map(line => ctx.measureText(line).width)) / scale + edge * 2 <= w - 2 - 2 * Math.abs(textOffsetX) && size * lines.length * 1.08 + edge * 2 <= h - 1) break; size -= .5; }
      assert.ok(size >= 7, 'Chinese caption cannot fit: ' + entry.id + ' ' + region.text);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      const lineHeight = size * 1.08, start = h / 2 - (lines.length - 1) * lineHeight / 2 + (region.textOffsetY ?? 0);
      lines.forEach((line, i) => { const ty = (start + i * lineHeight) * scale;
        if (region.outerStroke && outerStroke > 0) { ctx.strokeStyle = region.outerStroke; ctx.lineWidth = outerStroke * 2 * scale; ctx.strokeText(line, tx, ty); }
        if (region.stroke && stroke > 0) { ctx.strokeStyle = region.stroke; ctx.lineWidth = stroke * 2 * scale; ctx.strokeText(line, tx, ty); }
        if (region.fillBottom) { const gradient = ctx.createLinearGradient(0, 0, 0, h * scale); gradient.addColorStop(0, region.fill); gradient.addColorStop(1, region.fillBottom); ctx.fillStyle = gradient; }
        else ctx.fillStyle = region.fill;
        ctx.fillText(line, tx, ty);
      });
      const small = createCanvas(w, h), sc = small.getContext('2d'); sc.drawImage(canvas, 0, 0, w, h);
      const ink = sc.getImageData(0, 0, w, h).data;
      let left = w, top = h, right = -1, bottom = -1;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const q = (yy * w + xx) * 4, p = ((y + yy) * image.width + x + xx) * 4, a = ink[q + 3] / 255, ba = rgba[p + 3] / 255;
        if (a > 0) { left = Math.min(left, xx); top = Math.min(top, yy); right = Math.max(right, xx); bottom = Math.max(bottom, yy); }
        const outA = a + ba * (1 - a); if (outA === 0) continue;
        for (let c = 0; c < 3; c++) rgba[p + c] = Math.round((ink[q + c] * a + rgba[p + c] * ba * (1 - a)) / outA);
        rgba[p + 3] = region.preserveAlpha ? image.rgba[p + 3] : Math.round(outA * 255);
      }
      if (region.inkMargin !== undefined) assert.ok(right >= left && bottom >= top && left >= region.inkMargin && top >= region.inkMargin && right < w - region.inkMargin && bottom < h - region.inkMargin, 'Chinese caption ink touches reviewed boundary: ' + entry.id + ' ' + region.text);
      fontFits.push({ id: entry.id, text: region.text, fontSize: size, box: region.box, textOffsetX, textOffsetY: region.textOffsetY ?? 0,
        inkBounds: right < 0 ? null : [x + left, y + top, x + right, y + bottom] });
    }

 return rgba;
}
