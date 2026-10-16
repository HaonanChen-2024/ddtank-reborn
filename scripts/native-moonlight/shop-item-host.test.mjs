import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {scan,sha,q} from '../native-pair/build-library.mjs';
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
  assert(result.cases.includes('Morn dataSource maps row properties before the render handler without null info'));
});

test('actual Morn binds dataSource before rendering and original shop info cannot receive null',()=>{
  const shared=scan(readFileSync(resolve(project,'runtime/client-overlay/workshop-native/shared/native-shared-library.swf')));
  const list=shared.abcs.find(a=>a.name==='morn/core/components/List');
  const listTrait=list.p.methodTraits.find(t=>list.p.strings[list.p.names[t.name]?.name]==='renderItem');
  const render=decode(list.p.bodies.find(b=>b.method===listTrait.method).code);
  const binding=render.find(op=>op.op===0x61&&q(list.p,op.args[0])==='::dataSource');
  const handler=render.find(op=>op.op===0x46&&q(list.p,op.args[0])==='::executeWith');
  assert.equal(listTrait.method,53);assert.equal(binding.offset,50);assert.equal(handler.offset,127);
  assert(binding.offset<handler.offset,'cell.dataSource must bind before renderHandler');
  const box=shared.abcs.find(a=>a.name==='morn/core/components/Box');
  const boxTrait=box.p.methodTraits.find(t=>(t.kind&15)===3&&box.p.strings[box.p.names[t.name]?.name]==='dataSource');
  const mapping=decode(box.p.bodies.find(b=>b.method===boxTrait.method).code);
  assert.equal(boxTrait.method,9);
  assert(mapping.some(op=>op.op===0x46&&q(box.p,op.args[0]).endsWith('::hasOwnProperty')));
  assert(mapping.some(op=>op.op===0x61&&op.offset===114),'Box maps a supplied property through its setter');
  const library=scan(readFileSync(resolve(project,'runtime/client-overlay/workshop-native/moonlight/moonlight-original-library.swf')));
  const row=library.abcs.find(a=>a.name==='activity/moonlightbox/view/MoonlightShopItem');
  const setter=row.p.methodTraits.find(t=>(t.kind&15)===3&&row.p.strings[row.p.names[t.name]?.name]==='info');
  const info=decode(row.p.bodies.find(b=>b.method===setter.method).code);
  const template=info.find(op=>op.op===0x66&&q(row.p,op.args[0])==='::TemplateID');
  assert.equal(setter.method,3);assert.equal(template.offset,33);
  assert(!info.some(op=>op.offset<template.offset&&op.op>=0x0c&&op.op<=0x1b),'original setter has no null branch before TemplateID');
});

test('compiled candidate omits early null info and preserves other method logic and resource bytes',{skip:!process.env.MOONLIGHT_CANDIDATE},()=>{
  const current=bootstrap.abcs[0],old=scan(readFileSync(process.env.MOONLIGHT_BASELINE||installed)).abcs[0];
  const trait=current.p.methodTraits.find(t=>current.p.strings[current.p.names[t.name]?.name]==='renderShopRow');
  assert(trait);
  assert.deepEqual(decode(current.p.bodies.find(b=>b.method===trait.method).code).filter(op=>op.op===0x42).map(op=>op.args[0]),[2]);
  const rows=current.p.methodTraits.find(t=>current.p.strings[current.p.names[t.name]?.name]==='localShopRows');
  assert(rows);
  const before=old.p.bodies.find(b=>b.method===rows.method),after=current.p.bodies.find(b=>b.method===rows.method);
  assert.deepEqual(decode(before.code).filter(op=>op.op===0x55).map(op=>op.args[0]),[8]);
  assert.deepEqual(decode(after.code).filter(op=>op.op===0x55).map(op=>op.args[0]),[7]);
  assert(!decode(after.code).some(op=>op.op===0x2c&&current.p.strings[op.args[0]]==='info'));
  // Removing the early info key relocates one later class-name string constant.
  const oldRender=decode(old.p.bodies.find(b=>b.method===trait.method).code),newRender=decode(current.p.bodies.find(b=>b.method===trait.method).code);
  assert.equal(newRender.length,oldRender.length);let relocatedStrings=0;
  for(let i=0;i<oldRender.length;i++){
    const before=oldRender[i],after=newRender[i];
    assert.equal(after.op,before.op);assert.equal(after.offset,before.offset);assert.equal(after.end,before.end);
    if(before.op===0x2c){assert.equal(current.p.strings[after.args[0]],old.p.strings[before.args[0]]);if(after.args[0]!==before.args[0])relocatedStrings++;}
    else assert.deepEqual(after.args,before.args);
  }
  assert.equal(relocatedStrings,1);
  let unchanged=0;
  for(const body of old.p.bodies){
    if(body.method===rows.method||body.method===trait.method)continue;
    assert.equal(sha(current.p.bodies.find(b=>b.method===body.method).code),sha(body.code),'untouched method '+body.method);unchanged++;
  }
  assert(unchanged>0);
  const candidate=resolve(process.env.MOONLIGHT_CANDIDATE,'flash/workshop-native/moonlight'),base=dirname(installed);
  for(const file of ['moonlight-original-library.swf','moonlighttreasure_v3_6_1_u1.swf','moonlighttreasure_v3_6_1_u1.ui'])assert.deepEqual(readFileSync(resolve(candidate,file)),readFileSync(resolve(base,file)),file);
});
