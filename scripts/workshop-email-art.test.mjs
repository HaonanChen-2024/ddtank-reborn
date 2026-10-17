import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { decompressSwf, parseTags, compressSwf, buildTag } from '../tools/i18n/abc-strings/lib.mjs';
import { hash, decodeBitmap, encodeBitmap, jpegBitmapData, patchSwf, preparedPixels } from './workshop-bag-art.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),directory=join(repo,'research/i18n/bag-art');
const config=JSON.parse(readFileSync(join(directory,'email.zh-CN.json'))),source=readFileSync(join(repo,'apps/api/assets/flash',config.asset));
const hydrated=!source.subarray(0,80).toString().startsWith('version https://git-lfs.github.com/spec/v1');
const req=createRequire(join(process.env.WORKSHOP_NODE_DEPS??join(process.env.USERPROFILE??'','.cache/codex-runtimes/codex-primary-runtime/dependencies/node'),'package.json'));
const {PNG}=req('pngjs'),{createCanvas,loadImage}=req('@napi-rs/canvas');

test('email captions retain both original button states and the reviewed owners',()=>{
  assert.equal(config.asset,'ui/vietnam/swf/email.swf');
  assert.deepEqual(config.bitmaps.map(e=>e.id).sort((a,b)=>a-b),[5,6,8,9,10,11,13,14,24,25,31,36,40,44,45,54]);
  for(const [a,b,text] of [[36,40,'邮件列表'],[25,24,'未读邮件'],[9,8,'已发送'],[11,10,'全选'],[45,44,'删除'],[14,13,'领取附件']]){
    assert.equal(config.bitmaps.find(e=>e.id===a).regions[0].text,text);
    assert.equal(config.bitmaps.find(e=>e.id===b).regions[0].text,text);
  }
  assert.deepEqual(config.bitmaps.find(e=>e.id===6).regions.map(r=>r.text),['发件人','主题']);
  assert.match(config.expectedSwfSha256,/^[a-f0-9]{64}$/);
});

test('unread stamp changes the old ink alpha only inside its reviewed inner caption',{skip:!hydrated},()=>{
  const entry=config.bitmaps.find(e=>e.id===5),decoded=decompressSwf(source),parsed=parseTags(decoded.body),tag=parsed.tags.find(t=>t.code===36&&decoded.body.readUInt16LE(t.bodyStart)===5);
  assert.equal(entry.className,'asset.email.unReadImg');assert.equal(entry.regions[0].preserveAlpha,false);
  const image=decodeBitmap(decoded.body.subarray(tag.bodyStart,tag.bodyEnd)),png=readFileSync(join(directory,entry.preparedImage.path)),rgba=preparedPixels(png,entry,PNG.sync.read),replacement=buildTag(36,encodeBitmap(image,rgba));
  const expected=compressSwf(decoded.sig,decoded.version,Buffer.concat([parsed.headerPrefix,...parsed.tags.map(t=>t===tag?replacement:t.raw),parsed.trailing]));
  const result=patchSwf(source,{...config,bitmaps:[entry],expectedSwfSha256:hash(expected)},()=>rgba);
  assert.equal(result.changed[0].alphaChangedPixels,204);assert.equal(result.changed[0].outsideRegionsUnchanged,true);assert.equal(result.unchangedTags,parsed.tags.length-1);
  assert.throws(()=>patchSwf(source,{...config,bitmaps:[{...entry,regions:[{...entry.regions[0],preserveAlpha:true}]}],expectedSwfSha256:hash(expected)},()=>rgba),/protected alpha/);
});

test('reviewed add-friend JPEG preserves alpha, unrelated tags and pixels outside its caption',{skip:!hydrated},async()=>{
  assert.equal(hash(source),config.sourceAssetSha256);
  const entry=config.bitmaps.find(e=>e.id===54),decoded=decompressSwf(source),parsed=parseTags(decoded.body);
  const tag=parsed.tags.find(t=>t.code===35&&decoded.body.readUInt16LE(t.bodyStart)===54);
  assert.equal(hash(tag.raw),entry.sourceTagSha256);
  const body=decoded.body.subarray(tag.bodyStart,tag.bodyEnd),{encoded}=jpegBitmapData(body,35),im=await loadImage(encoded),canvas=createCanvas(im.width,im.height),ctx=canvas.getContext('2d');
  ctx.drawImage(im,0,0);const decodedJpeg={width:im.width,height:im.height,data:ctx.getImageData(0,0,im.width,im.height).data};
  const prepared=readFileSync(join(directory,entry.preparedImage.path)),rgba=preparedPixels(prepared,entry,PNG.sync.read);
  // Assemble the expected tag independently; all non-target tags remain byte-for-byte original.
  const prefix=Buffer.alloc(6);prefix.writeUInt16LE(54);prefix.writeUInt32LE(prepared.length,2);
  const replacement=buildTag(35,Buffer.concat([prefix,prepared,deflateSync(Buffer.alloc(0))]));
  const expected=compressSwf(decoded.sig,decoded.version,Buffer.concat([parsed.headerPrefix,...parsed.tags.map(t=>t===tag?replacement:t.raw),parsed.trailing]));
  const scoped={...config,bitmaps:[entry],expectedSwfSha256:hash(expected)},codec={...PNG.sync,readJPEG:()=>decodedJpeg};
  const result=patchSwf(source,scoped,()=>rgba,null,codec);
  assert.deepEqual(result.out,expected);assert.equal(result.changed[0].alphaChangedPixels,0);assert.equal(result.unchangedTags,parsed.tags.length-1);
  assert.equal(result.changed[0].outsideRegionsUnchanged,true);
  for(const overrides of [{id:53},{className:'asset.email.writingViewTitle'},{tagCode:21},{sourceTagSha256:'0'.repeat(64)}])
    assert.throws(()=>patchSwf(source,{...scoped,bitmaps:[{...entry,...overrides}]},()=>rgba,null,codec),/unsupported reviewed RoomList JPEG owner/);
  assert.throws(()=>patchSwf(source,{...scoped,asset:'ui/vietnam/swf/other.swf'},()=>rgba,null,codec),/unsupported reviewed RoomList JPEG owner/);
  assert.throws(()=>patchSwf(source,{...scoped,sourceAssetSha256:'0'.repeat(64)},()=>rgba,null,codec),/unknown reviewed JPEG SWF/);
  assert.throws(()=>patchSwf(source,{...scoped,expectedSwfSha256:undefined},()=>rgba,null,codec),/frozen output hash/);
  assert.throws(()=>patchSwf(source,scoped,()=>{const out=Buffer.from(rgba);out[0]^=1;return out;},null,codec),/unreviewed pixels/);
  assert.throws(()=>patchSwf(source,scoped,()=>{const out=Buffer.from(rgba);out[(10*entry.width+50)*4+3]--;return out;},null,codec),/protected alpha/);
});
