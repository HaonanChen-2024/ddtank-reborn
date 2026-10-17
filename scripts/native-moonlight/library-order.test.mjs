import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {ByteReader} from '../../tools/i18n/abc-strings/lib.mjs';
import {scan,q,pinned} from '../native-pair/build-library.mjs';
import {moonlightOwners} from './build-library.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),project=resolve(repo,'../..');
const original=scan(pinned(resolve(project,'runtime/reference-activities-completion-20261014/reference-core/2_v3_6_1_u9.png'),'af361678887e2413efe54e6cd86d37426cc6724ea964080178eea4816a785ae4'));

// Read real instance_info headers, following the existing Christmas resource parser.
function instanceSupers(a){
  const r=new ByteReader(a.abc);r.pos=a.p.namePoolEnd;
  for(let n=r.u30();n;n--){
    const count=r.u30();r.u30();for(let i=0;i<count;i++)r.u30();r.u30();
    const flags=r.bytes(1)[0];
    if(flags&8)for(let count=r.u30();count;count--){r.u30();r.bytes(1);}
    if(flags&128)for(let i=0;i<count;i++)r.u30();
  }
  for(let n=r.u30();n;n--){r.u30();for(let count=r.u30()*2;count;count--)r.u30();}
  const rows=[];
  for(let i=0,count=r.u30();i<count;i++){
    const name=r.u30(),parent=r.u30(),flags=r.bytes(1)[0];
    if(flags&8)r.u30();for(let count=r.u30();count;count--)r.u30();r.u30();
    rows.push({name:q(a.p,name),parent:q(a.p,parent)});r.pos=a.p.traitBlocks[i].end;
  }
  return rows;
}

function assertParentsBeforeChildren(abcs){
  const rows=abcs.flatMap((a,index)=>instanceSupers(a).map(row=>({index,owner:a.name,...row})));
  const declarations=new Map(rows.map(row=>[row.name,row]));
  for(const row of rows){
    const parent=declarations.get(row.parent);
    if(parent&&parent.owner!==row.owner)assert(parent.index<row.index,row.owner+' requires earlier '+parent.owner);
  }
}

test('real Moonlight superclass ABCs precede their derived class definitions',()=>{
  const owners=moonlightOwners.map(name=>{const a=original.abcs.find(a=>a.name===name);assert(a,name);return a;});
  assert.equal(owners.length,28);assertParentsBeforeChildren(owners);
});

test('candidate changes only DoABC order, preserving installed ABC and original art bytes',{skip:!process.env.MOONLIGHT_CANDIDATE},()=>{
  const base=resolve(project,'runtime/client-overlay/workshop-native/moonlight');
  const candidate=resolve(process.env.MOONLIGHT_CANDIDATE,'flash/workshop-native/moonlight');
  const before=scan(readFileSync(resolve(base,'moonlight-original-library.swf')));
  const after=scan(readFileSync(resolve(candidate,'moonlight-original-library.swf')));
  assert.equal(after.abcs.length,29);assertParentsBeforeChildren(after.abcs);
  assert.deepEqual(after.abcs.filter(a=>moonlightOwners.includes(a.name)).map(a=>a.name),moonlightOwners);
  for(const a of before.abcs){
    const b=after.abcs.find(b=>b.name===a.name);assert(b,a.name);
    assert.deepEqual(b.abc,a.abc,a.name+' complete ABC bytes');
    assert.deepEqual(b.prefix,a.prefix,a.name+' DoABC prefix');
    for(const body of a.p.bodies)assert.deepEqual(b.p.bodies.find(b=>b.method===body.method).code,body.code,a.name+' method '+body.method);
  }
  assert.deepEqual(after.headerPrefix,before.headerPrefix);
  assert.deepEqual(after.tags.filter(t=>t.code!==82).map(t=>t.raw),before.tags.filter(t=>t.code!==82).map(t=>t.raw));
  for(const file of ['WorkshopNativeMoonlightBootstrap.swf','moonlighttreasure_v3_6_1_u1.swf','moonlighttreasure_v3_6_1_u1.ui'])assert.deepEqual(readFileSync(resolve(candidate,file)),readFileSync(resolve(base,file)),file);
});
