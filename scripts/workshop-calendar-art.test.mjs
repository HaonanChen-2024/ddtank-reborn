import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {patchCalendar,decodeJpeg3} from './workshop-calendar-art.mjs';
import {hash} from './workshop-bag-art.mjs';
import {decompressSwf,parseTags} from '../tools/i18n/abc-strings/lib.mjs';

const repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
const deps=createRequire(join(process.env.WORKSHOP_NODE_DEPS??join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node'),'package.json'));
const {GlobalFonts}=deps('@napi-rs/canvas');
const config=JSON.parse(readFileSync(join(repo,'research/i18n/bag-art/calendar.zh-CN.json')));
assert.ok(GlobalFonts.registerFromPath(join(process.env.WINDIR??'C:/Windows','Fonts',config.fontFile),config.fontFamily));
const base=readFileSync(join(repo,'apps/api/assets/flash',config.asset));
function tags(bytes){const d=decompressSwf(bytes);return{...d,tags:parseTags(d.body).tags};}
function bitmap(doc,id){return doc.tags.find(t=>[35,36].includes(t.code)&&doc.body.readUInt16LE(t.bodyStart)===id);}

test('real calendar captions preserve all non-target tags and all ActionScript',async()=>{
  const result=await patchCalendar(base,config),a=tags(base),b=tags(result.out),ids=new Set(config.bitmaps.map(e=>e.id));
  assert.equal(result.changed.length,16);assert.equal(a.tags.length,b.tags.length);
  for(let i=0;i<a.tags.length;i++){
    const t=a.tags[i];assert.equal(t.code,b.tags[i].code);
    if(![35,36].includes(t.code)||!ids.has(a.body.readUInt16LE(t.bodyStart)))assert.deepEqual(t.raw,b.tags[i].raw);
  }
});
test('PNG-in-JPEG3 caption retains exact RGBA outside its reviewed rectangle',async()=>{
  const entry=config.bitmaps.find(e=>e.id===24),result=await patchCalendar(base,{...config,bitmaps:[entry]}),a=tags(base),b=tags(result.out),ta=bitmap(a,24),tb=bitmap(b,24);
  const before=await decodeJpeg3(a.body.subarray(ta.bodyStart,ta.bodyEnd)),after=await decodeJpeg3(b.body.subarray(tb.bodyStart,tb.bodyEnd));
  assert.equal(before.codec,'png');assert.equal(after.codec,'png');const [x,y,w,h]=entry.regions[0].box;
  for(let yy=0;yy<entry.height;yy++)for(let xx=0;xx<entry.width;xx++)if(xx<x||xx>=x+w||yy<y||yy>=y+h){const p=(yy*entry.width+xx)*4;assert.deepEqual(before.rgba.subarray(p,p+4),after.rgba.subarray(p,p+4));}
});
test('shared claim-button translation preserves every other coreii tag including hidden controls',async()=>{
  const cfg=JSON.parse(readFileSync(join(repo,'research/i18n/bag-art/calendar-controls.zh-CN.json'))),input=readFileSync(join(repo,'apps/api/assets/flash',cfg.asset));
  const result=await patchCalendar(input,{...cfg,sourceBaseSha256:hash(input)}),a=tags(input),b=tags(result.out);
  assert.equal(result.changed.length,1);assert.equal(result.changed[0].id,20);
  for(let i=0;i<a.tags.length;i++){const t=a.tags[i];if(t.code!==36||a.body.readUInt16LE(t.bodyStart)!==20)assert.deepEqual(t.raw,b.tags[i].raw);}
  assert.deepEqual(bitmap(a,38).raw,bitmap(b,38).raw);
});
test('stale source and duplicate bitmap configuration are rejected',async()=>{
  await assert.rejects(patchCalendar(base,{...config,sourceBaseSha256:'0'.repeat(64)}),/source changed/);
  await assert.rejects(patchCalendar(base,{...config,bitmaps:[config.bitmaps[0],config.bitmaps[0]]}),/duplicate configured/);
});
test('JPEG3 class mismatch is rejected before replacement',async()=>{
  const e=config.bitmaps.find(e=>e.id===24);
  await assert.rejects(patchCalendar(base,{...config,bitmaps:[{...e,className:'wrong.CalendarClass'}]}),/bitmap class mismatch/);
});
