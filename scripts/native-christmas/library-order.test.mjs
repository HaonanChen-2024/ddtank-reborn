import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {basename,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import test,{after} from 'node:test';
import {scan,sha} from '../native-pair/build-library.mjs';
import {buildChristmasLibrary} from './build-library.mjs';
import {inspectChristmasAssets} from './extract-resources.mjs';
import {verifyLibraryLoadOrder} from './audit-candidate.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),project=resolve(repo,'../..');
const prior=resolve(project,'runtime/activity-moonlight-shop-20261015/native-unified-shop-candidate-a/christmas-component');
const oldBytes=readFileSync(resolve(prior,'flash/workshop-native/christmas/christmas-original-library.swf'));
assert.equal(sha(oldBytes),'d1feaeb84879396e65bb81d17b502c0c5fadf47e4ef35bde2b90e9287a338c9b');
const old=scan(oldBytes),temp=mkdtempSync(resolve(tmpdir(),'ddt-christmas-order-'));
after(()=>{const owned=realpathSync(temp);assert.equal(dirname(owned),realpathSync(tmpdir()));assert(basename(owned).startsWith('ddt-christmas-order-'));rmSync(owned,{recursive:true});});
const resource=inspectChristmasAssets({projectRoot:project});
const built=buildChristmasLibrary({projectRoot:project,out:temp,skinGlue:resolve(prior,'christmas-skins.glue.swf'),skins:resource.skins,styles:resource.styles});
const candidate=scan(readFileSync(resolve(temp,built.file)));
function preserved(lib){
 assert.deepEqual(lib.abcs.map(a=>a.name).sort(),old.abcs.map(a=>a.name).sort());
 for(const a of lib.abcs){const before=old.abcs.find(x=>x.name===a.name);assert.equal(sha(Buffer.concat([a.prefix,a.abc])),sha(Buffer.concat([before.prefix,before.abc])),a.name);}
 assert.deepEqual(lib.headerPrefix,old.headerPrefix);assert.deepEqual(lib.tags.filter(t=>t.code!==82).map(t=>t.raw),old.tags.filter(t=>t.code!==82).map(t=>t.raw));
}

test('gate rejects the frozen room-player subclass before its actual base class',()=>{
 assert.throws(()=>verifyLibraryLoadOrder(old),/ChristmasRoomPlayer must load after .*ChristmasRoomPlayerBase: ABC 21 before 22/);
});

test('actual builder emits every same-library parent before its child',()=>{
 const graph=verifyLibraryLoadOrder(candidate);assert.equal(graph.abcCount,29);assert.equal(graph.classCount,32);
 const player=graph.internalInheritanceEdges.find(e=>e.child.endsWith('::ChristmasRoomPlayer'));assert(player);
 assert.equal(player.parent,'workshop.christmas.original.player::ChristmasRoomPlayerBase');assert(player.parentAbc<player.childAbc);
});

test('reordering preserves all complete ABC payloads, non-ABC tags and movie header',()=>{preserved(candidate);});

test('fully compiled candidate preserves host code, art, styles and all scene resources',{skip:!process.env.CHRISTMAS_ORDER_CANDIDATE},()=>{
 const out=resolve(process.env.CHRISTMAS_ORDER_CANDIDATE),area=resolve(out,'flash/workshop-native/christmas');
 const full=scan(readFileSync(resolve(area,'christmas-original-library.swf')));preserved(full);verifyLibraryLoadOrder(full);
 const host=scan(readFileSync(resolve(area,'WorkshopNativeChristmasBootstrap.swf'))),before=scan(readFileSync(resolve(prior,'flash/workshop-native/christmas/WorkshopNativeChristmasBootstrap.swf')));
 assert.equal(host.sig,before.sig);assert.equal(host.version,before.version);assert.deepEqual(host.headerPrefix,before.headerPrefix);assert.deepEqual(host.tags.map(t=>t.code),before.tags.map(t=>t.code));
 for(const [i,tag]of host.tags.entries()){
  const oldTag=before.tags[i];assert.equal(tag.raw.length,oldTag.raw.length);
  // ProductInfo ends in the compiler's 64-bit build date; every other byte is fixed.
  const end=tag.raw.length-(tag.code===41?8:0);assert.equal(sha(tag.raw.subarray(0,end)),sha(oldTag.raw.subarray(0,end)),'host tag '+tag.code);
 }
 const manifest=JSON.parse(readFileSync(resolve(out,'manifest.json'),'utf8'));assert.equal(manifest.assets.length,14);
 for(const asset of manifest.assets){const local=asset.urlPath?asset.urlPath.slice(1):'flash/workshop-native/christmas/'+asset.file;assert.equal(sha(readFileSync(resolve(out,local))),sha(readFileSync(resolve(prior,local))),local);}
});
