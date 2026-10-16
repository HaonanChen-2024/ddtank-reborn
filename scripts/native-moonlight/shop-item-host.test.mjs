import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {scan,sha} from '../native-pair/build-library.mjs';
import {decode} from '../native-pair/audit-candidate.mjs';
import {verifyMoonlightShop,verifyShopHostMembers} from './audit-candidate.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),project=resolve(repo,'../..');
const source=readFileSync(resolve(repo,'scripts/native-moonlight/WorkshopNativeMoonlightBootstrap.as'),'utf8');
const host=scan(readFileSync(resolve(project,'runtime/client-overlay/2.png')));
const installed=resolve(project,'runtime/client-overlay/workshop-native/moonlight/WorkshopNativeMoonlightBootstrap.swf');
const bootstrap=scan(readFileSync(process.env.MOONLIGHT_CANDIDATE?resolve(process.env.MOONLIGHT_CANDIDATE,'flash/workshop-native/moonlight/WorkshopNativeMoonlightBootstrap.swf'):installed));

test('actual installed ShopItemInfo requires two integer identity arguments with no defaults',()=>{
  const contract=verifyShopHostMembers([{swf:host}]);
  assert.equal(contract.abcSha256,'f36ff2216315dc712660371a7a9e9833e0c511be0d30d6df566e0e75b98f7972');
  assert.deepEqual(contract.constructor,{method:1,parameters:['::int','::int'],optional:false});
});

test('ordinary Moonlight shop renders both projected products with actual required host identities',()=>{
  const result=verifyMoonlightShop(source,bootstrap);
  assert(result.cases.includes('real local recipe binds sealed host ShopItemInfo and original row fields'));
});

test('compiled candidate supplies both ShopItemInfo identities and preserves every other bootstrap method',{skip:!process.env.MOONLIGHT_CANDIDATE},()=>{
  const current=bootstrap.abcs[0],old=scan(readFileSync(installed)).abcs[0];
  const trait=current.p.methodTraits.find(t=>current.p.strings[current.p.names[t.name]?.name]==='renderShopRow');
  assert(trait);
  assert.deepEqual(decode(current.p.bodies.find(b=>b.method===trait.method).code).filter(op=>op.op===0x42).map(op=>op.args[0]),[2]);
  let unchanged=0;
  for(const body of old.p.bodies){
    if(body.method===trait.method)continue;
    assert.equal(sha(current.p.bodies.find(b=>b.method===body.method).code),sha(body.code),'untouched method '+body.method);unchanged++;
  }
  assert(unchanged>0);
});
