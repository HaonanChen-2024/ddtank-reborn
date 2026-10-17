import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { hash, patchSwf, preparedPixels } from '../../../scripts/workshop-bag-art.mjs';
import { decompressSwf, parseTags } from '../../../tools/i18n/abc-strings/lib.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(readFileSync(join(here,'zh-CN.json')));
const added=[71,77,80,96,99,103,105,10,12,140,141,171,173,176,178];
const originalPins=new Map([
  [69,'4969958c00d46c2d9c107c75d4bdcecfc923959dd2dcd559e3d3ccc1abb56c4a'],
  [62,'a0c229b74ad13637af59b8694a2f0cb9ab0bc4b0f9fb9e45a907199fd28525a5'],
  [65,'aee3ead3f97ea1e1172bf9471c7d6989a764ffda9bcce5a823bc95d12a9482cb'],
  [64,'8a667c1b07047919874fb44944c754eaae3d31dfa09e622a33dae33e8bd5e178'],
]);

test('all room caption PNGs retain their reviewed identity, dimensions and bounds',()=>{
  assert.equal(config.asset,'ui/vietnam/swf/room.swf');
  assert.deepEqual(config.bitmaps.slice(4).map(b=>b.id),added);
  assert.equal(new Set(config.bitmaps.map(b=>b.id)).size,19);
  assert.equal(config.bitmaps.reduce((n,b)=>n+b.regions.length,0),32);
  for(const b of config.bitmaps){
    const path=resolve(here,b.preparedImage.path);assert.ok(path.startsWith(here+sep));
    const png=readFileSync(path);
    assert.equal(hash(png),b.preparedImage.sha256);
    assert.deepEqual(png.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
    assert.equal(png.toString('ascii',12,16),'IHDR');
    assert.equal(png.readUInt32BE(16),b.width);assert.equal(png.readUInt32BE(20),b.height);
    assert.equal(b.tagCode,36);
    for(const r of b.regions){
      const[x,y,w,h]=r.box;assert.ok([x,y,w,h].every(Number.isInteger));
      assert.ok(x>=0&&y>=0&&w>0&&h>0&&x+w<=b.width&&y+h<=b.height);
      assert.match(r.text,/\p{Script=Han}/u);assert.doesNotMatch(r.text,/[A-Za-z\u00c0-\u024f\u1e00-\u1eff]/u);
    }
  }
});

test('existing four PNGs and both original animated button owners stay pinned',()=>{
  for(const[id,pin]of originalPins)assert.equal(config.bitmaps.find(b=>b.id===id).preparedImage.sha256,pin);
  for(const id of[171,173,176,178]){
    const b=config.bitmaps.find(b=>b.id===id),prep=id<176;
    assert.deepEqual(b.ownerSymbolClass,{id:prep?175:180,name:`room.view.roomView.${prep?'prep':'start'}BtnAsset`});
    assert.equal(b.regions[0].text,prep?'准备战斗':'开始游戏');
    assert.deepEqual([b.width,b.height],[130,148]);
  }
});

// Original game art is intentionally not published. Request the genuine local file
// explicitly; a fresh checkout still runs the two asset/config checks above.
const sourcePath=process.env.ROOM_ART_SOURCE;
test('genuine source rebuild keeps every non-target SWF tag and all original coordinates',{
  skip:!sourcePath||!existsSync(sourcePath)?'ROOM_ART_SOURCE genuine private SWF unavailable; not a runtime acceptance':false,
},()=>{
  const depRoot=process.env.WORKSHOP_NODE_DEPS??join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node');
  const{PNG}=createRequire(join(depRoot,'package.json'))('pngjs');
  const source=readFileSync(sourcePath);assert.equal(hash(source),config.sourceAssetSha256);
  const result=patchSwf(source,config,(image,b)=>preparedPixels(readFileSync(join(here,b.preparedImage.path)),b,PNG.sync.read));
  assert.equal(hash(result.out),config.expectedSwfSha256);assert.equal(result.totalTags,198);assert.equal(result.unchangedTags,179);
  const before=decompressSwf(source),after=decompressSwf(result.out),bt=parseTags(before.body),at=parseTags(after.body);
  assert.deepEqual(at.headerPrefix,bt.headerPrefix);assert.deepEqual(at.trailing,bt.trailing);
  const wanted=new Set(config.bitmaps.map(b=>b.id));
  for(let i=0;i<bt.tags.length;i++){
    const a=bt.tags[i],b=at.tags[i],id=a.code===36?before.body.readUInt16LE(a.bodyStart):-1;
    if(a.code!==36||!wanted.has(id))assert.deepEqual(b.raw,a.raw);
  }
});
