import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateSync} from 'node:zlib';
import {decompressSwf,parseTags} from '../tools/i18n/abc-strings/lib.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(readFileSync(join(repo,'research/i18n/bag-art/shop.zh-CN.json')));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const privateRoot=process.env.SHOP_ART_PRIVATE_ROOT??resolve(repo,'../../runtime/shop-pure-zh-20261016');
const available=['before.swf','shop-original.swf','candidate/shop.swf'].every(path=>existsSync(join(privateRoot,path)));
const ids=[1,2,4,5,6,7,8,9,10,11,13,16,17,18,19,20,21,22,23,24,26,29,31,33,36,37,38,39,44,45,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,99,100,101,102,104,105,106,109,110,111,112,115,116,120,121,122,123,124,125,127,128];

test('shop Chinese captions pin only the reviewed named bitmap owners',()=>{
  assert.equal(config.asset,'ui/vietnam/swf/shop.swf');
  assert.equal(config.kind,'original-chinese-bitmap-fit');
  assert.deepEqual(config.bitmaps.map(row=>row.id),ids);
  for(const row of config.bitmaps){
    assert.match(row.className,/^asset\.shop\./);assert.match(row.text,/[\u4e00-\u9fff]/);
    assert.ok(Number.isInteger(row.width)&&row.width>0&&Number.isInteger(row.height)&&row.height>0);
    for(const value of [row.sourceTagSha256,row.preparedImage.sha256,row.preparedImage.rgbaSha256,row.outputTagSha256])assert.match(value,/^[a-f0-9]{64}$/);
    assert.equal(row.preparedImage.path,'prepared/'+row.id+'.png');
  }
  assert.deepEqual(config.bitmaps.filter(row=>!row.reference).map(row=>row.id),[36,37]);
  assert.equal(config.sourceAssetSha256,'6e6539f62717d5813a63a15765e3b1c6ca1dcab266a08f2d397b606babb752e8');
  assert.equal(config.reference.sha256,'7989fd2e7b2cb78eab9a1ee40993a5bf37f98d88e1345a1d34cb3a564eea8b0e');
});

test('frozen shop output preserves every non-target tag including code, timelines and SymbolClass',{skip:!available},()=>{
  const before=readFileSync(join(privateRoot,'before.swf')),original=readFileSync(join(privateRoot,'shop-original.swf')),after=readFileSync(join(privateRoot,'candidate/shop.swf'));
  assert.equal(sha(before),config.sourceAssetSha256);assert.equal(sha(original),config.reference.sha256);assert.equal(sha(after),config.expectedSwfSha256);
  const a=decompressSwf(before),b=decompressSwf(after),x=parseTags(a.body),y=parseTags(b.body);assert.equal(a.error,null);assert.equal(b.error,null);
  assert.equal(a.sig,b.sig);assert.equal(a.version,b.version);assert.deepEqual(x.headerPrefix,y.headerPrefix);assert.deepEqual(x.trailing,y.trailing);assert.equal(x.tags.length,y.tags.length);
  const selected=new Map(config.bitmaps.map(row=>[row.id,row]));let changed=0,unchanged=0;
  for(let i=0;i<x.tags.length;i++){
    const old=x.tags[i],now=y.tags[i],id=[21,35,36].includes(old.code)?a.body.readUInt16LE(old.bodyStart):null,row=selected.get(id);
    assert.equal(now.code,old.code);
    if(!row){assert.deepEqual(now.raw,old.raw);unchanged++;continue;}
    assert.equal(sha(old.raw),row.sourceTagSha256);assert.equal(sha(now.raw),row.outputTagSha256);assert.notDeepEqual(now.raw,old.raw);changed++;
  }
  assert.equal(changed,99);assert.equal(unchanged,54);
});

test('prepared captions retain the existing bitmap allocations and exact PNG payloads',{skip:!available},()=>{
  const bytes=readFileSync(join(privateRoot,'candidate/shop.swf')),swf=decompressSwf(bytes),tags=parseTags(swf.body).tags;
  for(const row of config.bitmaps){
    const png=readFileSync(join(privateRoot,row.preparedImage.path));assert.equal(sha(png),row.preparedImage.sha256);
    assert.equal(png.readUInt32BE(16),row.width);assert.equal(png.readUInt32BE(20),row.height);
    const tag=tags.find(t=>t.code===row.tagCode&&swf.body.readUInt16LE(t.bodyStart)===row.id),body=swf.body.subarray(tag.bodyStart,tag.bodyEnd);
    if(tag.code===21)assert.deepEqual(body.subarray(2),png);
    else if(tag.code===35){const size=body.readUInt32LE(2);assert.deepEqual(body.subarray(6,6+size),png);assert.equal(inflateSync(body.subarray(6+size)).length,0);}
    else{assert.equal(body[2],5);assert.equal(body.readUInt16LE(3),row.width);assert.equal(body.readUInt16LE(5),row.height);assert.equal(inflateSync(body.subarray(7)).length,row.width*row.height*4);}
  }
});
