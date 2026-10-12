#!/usr/bin/env node
// Offline calendar caption candidate builder. No installation, HTTP, database, or browser operations.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateSync,deflateSync} from 'node:zlib';
import {ByteReader,decompressSwf,parseTags,buildTag,compressSwf} from '../tools/i18n/abc-strings/lib.mjs';
import {decodeBitmap,hash,patchSwf} from './workshop-bag-art.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const deps=createRequire(join(process.env.WORKSHOP_NODE_DEPS ?? join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node'),'package.json'));
const {PNG}=deps('pngjs'),{createCanvas,GlobalFonts,loadImage}=deps('@napi-rs/canvas');
function pointInPolygon(x,y,vertices) { let yes=false;for(let i=0,j=vertices.length-1;i<vertices.length;j=i++){const[a,b]=vertices[i],[c,d]=vertices[j];if((b>y)!==(d>y)&&x<(c-a)*(y-b)/(d-b)+a)yes=!yes;}return yes; }
function inside(x, y, [left, top, width, height]) { return x >= left && y >= top && x < left + width && y < top + height; }
function inpaintCaption(image, rgba, box, seedRange, radius = 2) {
  const [left, top, width, height] = box, seed = new Set(), mask = new Set();
  const min = seedRange?.min ?? [185, 175, 120], max = seedRange?.max ?? [255, 255, 255];
  // Reuse the reviewed bag-art caption mask; calendar supplies per-caption seed ranges.
  // Remove the glyph and its short dark outline,
  // while leaving the surrounding brick/grain pixels available for a local texture fill.
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    const p = (y * image.width + x) * 4;
    if (image.rgba[p + 3] >= 240 && min.every((v, c) => image.rgba[p + c] >= v && image.rgba[p + c] <= max[c])) seed.add(y * image.width + x);
  }
  for (const p of seed) {
    const x = p % image.width, y = Math.floor(p / image.width);
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx, yy = y + dy;
      if (inside(xx, yy, box) && image.rgba[(yy * image.width + xx) * 4 + 3] >= 240) mask.add(yy * image.width + xx);
    }
  }
  assert.ok(mask.size > 0, 'reviewed button caption has no pale glyphs');
  for (const p of mask) {
    const x = p % image.width, y = Math.floor(p / image.width), neighbours = [];
    // Explicit seeds use the reviewed interior above/below the caption to protect nearby frames.
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
  // Local harmonic fill removes directional streaks while retaining every unmasked skin pixel.
  for(let pass=0;pass<240;pass++) for(const q of mask) {
    const x=q%image.width,y=Math.floor(q/image.width),points=[];
    for(const [xx,yy] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) if(xx>=0&&yy>=0&&xx<image.width&&yy<image.height&&rgba[(yy*image.width+xx)*4+3]>=240) points.push((yy*image.width+xx)*4);
    if(points.length)for(let c=0;c<3;c++)rgba[q*4+c]=Math.round(points.reduce((v,p)=>v+rgba[p+c],0)/points.length);
  }
}

export function renderCaption(image,entry,config,fontFits=[]) {
    const rgba = Buffer.from(image.rgba);
    for (const region of entry.regions) {
      const [x, y, w, h] = region.box;
      if (region.inpaint) inpaintCaption(image, rgba, region.box, region.inpaintSeed, region.inpaintRadius ?? 2);
      else for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const p = ((y + yy) * image.width + x + xx) * 4;
        if (region.clearPolygon && !pointInPolygon(x + xx + .5, y + yy + .5, region.clearPolygon)) continue;
        if (region.flatFill) { for(let c=0;c<4;c++)rgba[p+c]=region.flatFill[c]; continue; }
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
      if(region.rotationDegrees) { ctx.translate(tx,start*scale);ctx.rotate(region.rotationDegrees*Math.PI/180);ctx.translate(-tx,-start*scale); }
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

export async function decodeJpeg3(bytes) {
  const id=bytes.readUInt16LE(0), size=bytes.readUInt32LE(2), encoded=bytes.subarray(6,6+size);
  const png=encoded.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  let image;
  if(png) { const p=PNG.sync.read(encoded);image={width:p.width,height:p.height,rgba:Buffer.from(p.data)}; }
  else { const im=await loadImage(encoded),canvas=createCanvas(im.width,im.height),ctx=canvas.getContext('2d');ctx.drawImage(im,0,0);image={width:im.width,height:im.height,rgba:Buffer.from(ctx.getImageData(0,0,im.width,im.height).data)}; }
  const alpha=bytes.length>6+size?inflateSync(bytes.subarray(6+size)):Buffer.alloc(0);
  assert.ok(alpha.length===0 || alpha.length===image.width*image.height,'unexpected JPEG3 alpha length');
  if(!png && alpha.length)for(let p=0;p<alpha.length;p++)image.rgba[p*4+3]=alpha[p];
  return {id,...image,raw:image.rgba,codec:png?'png':'jpeg'};
}
function encodeJpeg3(image,rgba) {
  const png=PNG.sync.write({width:image.width,height:image.height,data:rgba}),head=Buffer.alloc(6);head.writeUInt16LE(image.id);head.writeUInt32LE(png.length,2);
  return Buffer.concat([head,png,deflateSync(Buffer.alloc(0))]);
}
function symbolsOf(body,tags) {
  const result=new Map();for(const t of tags.filter(t=>t.code===76)){const r=new ByteReader(body.subarray(t.bodyStart,t.bodyEnd)),n=r.u16();for(let i=0;i<n;i++){const id=r.u16();result.set(id,r.cstring());}}return result;
}
export async function patchCalendar(bytes,config,fontFits=[]) {
  assert.equal(hash(bytes),config.sourceBaseSha256,'calendar source changed; preserved');
  assert.equal(new Set(config.bitmaps.map(e=>e.id)).size,config.bitmaps.length,'duplicate configured bitmap');
  assert.ok(config.bitmaps.every(e=>[35,36].includes(e.tagCode)),'unsupported calendar bitmap tag');
  const lossless=config.bitmaps.filter(e=>e.tagCode===36),result=patchSwf(bytes,{...config,bitmaps:lossless},(image,entry)=>renderCaption(image,entry,config,fontFits));
  const d=decompressSwf(result.out),parsed=parseTags(d.body),symbols=symbolsOf(d.body,parsed.tags),replacements=new Map(),jpegChanges=[];
  for(const e of config.bitmaps.filter(e=>e.tagCode===35)) {
    const matches=parsed.tags.filter(t=>t.code===35&&d.body.readUInt16LE(t.bodyStart)===e.id);assert.equal(matches.length,1);const t=matches[0];
    assert.equal(symbols.get(e.id),e.className,'bitmap class mismatch');assert.equal(hash(t.raw),e.tagSha256,'JPEG3 source tag changed');
    const before=await decodeJpeg3(d.body.subarray(t.bodyStart,t.bodyEnd));assert.equal(before.width,e.width);assert.equal(before.height,e.height);assert.equal(hash(before.raw),e.sourcePixelsSha256,'JPEG3 pixel source changed');
    for(const r of e.regions){assert.ok(r.box.every(Number.isInteger));const[x,y,w,h]=r.box;assert.ok(x>=0&&y>=0&&w>0&&h>0&&x+w<=e.width&&y+h<=e.height,'caption outside bitmap');assert.equal(Boolean(r.sample),!r.transparent);}
    const rgba=renderCaption(before,e,config,fontFits),encoded=encodeJpeg3(before,rgba),after=await decodeJpeg3(encoded);let changedPixels=0;
    for(let y=0;y<e.height;y++)for(let x=0;x<e.width;x++){const p=(y*e.width+x)*4;if(!after.rgba.subarray(p,p+4).equals(before.rgba.subarray(p,p+4))){assert.ok(e.regions.some(r=>inside(x,y,r.box)),'unreviewed JPEG3 pixel changed');assert.ok(e.regions.some(r=>inside(x,y,r.box)&&!r.preserveAlpha)||after.rgba[p+3]===before.rgba[p+3],'protected JPEG3 alpha changed');changedPixels++;}}
    assert.ok(changedPixels>0,'JPEG3 patch was a no-op');replacements.set(t,buildTag(35,encoded));jpegChanges.push({id:e.id,className:e.className,codecBefore:before.codec,codecAfter:'png',changedPixels,outsideRegionsUnchanged:true});
  }
  const out=compressSwf(d.sig,d.version,Buffer.concat([parsed.headerPrefix,...parsed.tags.map(t=>replacements.get(t)??t.raw),parsed.trailing]));
  const original=decompressSwf(bytes),a=parseTags(original.body),packed=decompressSwf(out),b=parseTags(packed.body);assert.equal(packed.error,null);assert.equal(out.readUInt32LE(4),packed.body.length+8);assert.equal(packed.sig,original.sig);assert.equal(packed.version,original.version);assert.deepEqual(a.headerPrefix,b.headerPrefix);assert.deepEqual(a.trailing,b.trailing);assert.equal(a.tags.length,b.tags.length);
  const changedIds=new Set(config.bitmaps.map(e=>e.id));let unchangedTags=0;
  for(let i=0;i<a.tags.length;i++){assert.equal(a.tags[i].code,b.tags[i].code);const t=a.tags[i];if(![35,36].includes(t.code)||!changedIds.has(original.body.readUInt16LE(t.bodyStart))){assert.deepEqual(t.raw,b.tags[i].raw);unchangedTags++;}}
  return {out,changed:[...result.changed,...jpegChanges],totalTags:a.tags.length,unchangedTags};
}
async function exportEntry(bytes,entry,path) {
  const d=decompressSwf(bytes),t=parseTags(d.body).tags.find(t=>t.code===entry.tagCode&&d.body.readUInt16LE(t.bodyStart)===entry.id),body=d.body.subarray(t.bodyStart,t.bodyEnd),im=t.code===36?decodeBitmap(body):await decodeJpeg3(body);
  writeFileSync(path,PNG.sync.write({width:im.width,height:im.height,data:im.rgba}));
}
export async function buildCandidates(output) {
  const allowed=resolve(repo,'../../runtime/material-exchange-20261013/calendar-ui'),outDir=resolve(output);assert.ok(outDir.startsWith(allowed+'\\')||outDir.startsWith(allowed+'/'),'output must be a fresh calendar-ui subdirectory');assert.ok(!existsSync(outDir),'candidate output already exists');mkdirSync(outDir,{recursive:true});
  const reports=[];
  for(const name of ['calendar','calendar-controls']) {
    const configFile=join(repo,'research/i18n/bag-art',name+'.zh-CN.json'),configBytes=readFileSync(configFile),config=JSON.parse(configBytes),asset=join(repo,'apps/api/assets/flash',config.asset),source=join(config.sourceBase==='overlay'?resolve(repo,'../../runtime/client-overlay'):resolve(repo,'apps/api/assets/flash'),config.asset),bytes=readFileSync(source);
    assert.equal(hash(readFileSync(asset)),config.sourceAssetSha256,'shipped calendar asset changed');assert.equal(hash(bytes),config.sourceBaseSha256,'source changed');
    const font=join(process.env.WINDIR??'C:/Windows','Fonts',config.fontFile);assert.ok(GlobalFonts.registerFromPath(font,config.fontFamily),'Chinese font unavailable');
    const dir=join(outDir,name);mkdirSync(dir);const fontFits=[],result=await patchCalendar(bytes,config,fontFits),candidate=join(dir,name==='calendar'?'calendar.swf':'coreii.swf');writeFileSync(candidate,result.out);writeFileSync(join(dir,'before.swf'),bytes);writeFileSync(join(dir,'config.json'),configBytes);
    const scale=2,rowHeight=135,columnWidth=900,sheet=createCanvas(columnWidth,config.bitmaps.length*rowHeight),ctx=sheet.getContext('2d');ctx.fillStyle='#b8b1a4';ctx.fillRect(0,0,sheet.width,sheet.height);ctx.font=`14px "${config.fontFamily}"`;
    for(let i=0;i<config.bitmaps.length;i++){const e=config.bitmaps[i],before=join(dir,e.id+'-before.png'),after=join(dir,e.id+'-after.png');await exportEntry(bytes,e,before);await exportEntry(result.out,e,after);ctx.fillStyle='#191919';ctx.fillText(`${e.id}: ${e.className}`,8,i*rowHeight+18);const bs=await loadImage(before),as=await loadImage(after),s=Math.min(scale,425/e.width,105/e.height);ctx.drawImage(bs,6,i*rowHeight+26,e.width*s,e.height*s);ctx.drawImage(as,456,i*rowHeight+26,e.width*s,e.height*s);
      for(const zoom of [1.5,4]){const c=createCanvas(Math.ceil(e.width*zoom),Math.ceil(e.height*zoom));c.getContext('2d').drawImage(as,0,0,c.width,c.height);writeFileSync(join(dir,e.id+`-after-${zoom}x.png`),c.toBuffer('image/png'));}}
    writeFileSync(join(dir,'comparison.png'),sheet.toBuffer('image/png'));
    assert.equal(hash(readFileSync(source)),config.sourceBaseSha256,'source mutated during build');assert.equal(hash(readFileSync(asset)),config.sourceAssetSha256,'asset mutated during build');
    const report={name,source,candidate,sourceSha256:hash(bytes),candidateSha256:hash(result.out),configSha256:hash(configBytes),changed:result.changed,totalTags:result.totalTags,unchangedTags:result.unchangedTags,fontFits,installed:false,runtimeAccepted:false,allUnselectedTagsByteIdentical:true,captionPixelsOutsideRegionsUnchanged:true};writeFileSync(join(dir,'evidence.json'),JSON.stringify(report,null,2));reports.push(report);
  }
  writeFileSync(join(outDir,'evidence.json'),JSON.stringify(reports,null,2));return reports;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv[2],'candidate','usage: workshop-calendar-art.mjs candidate [fresh-output-dir]');assert.ok(process.argv.length<=4);const out=process.argv[3]??resolve(repo,'../../runtime/material-exchange-20261013/calendar-ui','candidate-'+Date.now());const reports=await buildCandidates(out);console.log(JSON.stringify(reports.map(({name,candidate,candidateSha256,changed})=>({name,candidate,candidateSha256,bitmaps:changed.length}))));
}
