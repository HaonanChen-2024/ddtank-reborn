import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {scan} from '../native-pair/build-library.mjs';
import {decode} from '../native-pair/audit-candidate.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const source=readFileSync(process.env.DEVIL_POSITION_SOURCE??resolve(repo,'scripts/native-devil/WorkshopNativeDevilBootstrap.as'),'utf8');
// Verbatim Point values from cached original devilturn.xml, not invented layout data.
// original-styles-a.json SHA256 18050994d15edbcf25d54a97255bcd01b30f33b47785c70089e9c84f90d21d01.
// Inline values keep the normal regression independent of private runtime evidence files.
const points=Object.entries({
 'mallitem.cellPos':[227,4],'boxConvert.cellPos':[2,2],'box.cellPos':[12,23],'lotteryViewPos':[0,0],
 lotteryCellPos0:[388,26],lotteryCellPos1:[491,47],lotteryCellPos2:[510,151],lotteryCellPos3:[491,255],
 lotteryCellPos4:[388,276],lotteryCellPos5:[284,255],lotteryCellPos6:[261,151],lotteryCellPos7:[284,48],
 diceCellPos0:[88,70],diceCellPos1:[183,70],diceCellPos2:[280,70],diceCellPos3:[374,70],diceCellPos4:[471,70],
 goodsCellPos:[346,70],goodsBoxPos:[246,59],'diceView.rateCell':[83,251],'diceView.shopCell':[10,10],'diceView.shopIconPos':[28,259]
}).map(([name,[x,y]])=>({name:'devilTurn.'+name,x,y}));
assert.equal(points.length,22);
assert.equal(new Set(points.map(p=>p.name)).size,22);

// Execute the actual AS helper body, translating only its local type and `is String`.
// This host check is not AVM2; the Point below is an explicit native-object double.
const signature='public static function setPos(o:Object,pos:*):void {';
const start=source.indexOf(signature);assert(start>=0);
const end=source.indexOf('\n',start),line=source.slice(start,end<0?source.length:end);
assert(line.endsWith('}'));
const body=line.slice(signature.length,-1).replace(/\bvar points:Object=/,'var points=').replace(/\bpos is String\b/g,'typeof pos === "string"');
const setPos=new Function('o','pos',body);
const isolated=name=>'workshop.devil.original.'+name.slice('devilTurn.'.length);

test('ordinary lottery construction accepts the actual isolated coordinate key',()=>{
 const target={};setPos(target,'workshop.devil.original.lotteryCellPos0');assert.deepEqual(target,{x:388,y:26});
});

test('actual library lottery init supplies the isolated coordinate namespace',{skip:!process.env.DEVIL_POSITION_LIBRARY},()=>{
 const lib=scan(readFileSync(resolve(process.env.DEVIL_POSITION_LIBRARY)));
 const a=lib.abcs.find(a=>a.name==='devilTurn/view/DevilTurnLotteryView');assert(a);
 const trait=a.p.methodTraits.find(t=>a.p.strings[a.p.names[t.name]?.name]==='init');assert(trait);
 const ops=decode(a.p.bodies.find(b=>b.method===trait.method).code);
 const key=ops.filter(o=>o.op===0x2c).map(o=>a.p.strings[o.args[0]]).find(s=>s?.endsWith('.lotteryCellPos'));
 assert.equal(key,'workshop.devil.original.lotteryCellPos');
 const target={};setPos(target,key+'0');assert.deepEqual(target,{x:388,y:26});
});

test('all 22 original Point coordinates retain their legacy and isolated identities',()=>{
 for(const point of points)for(const name of [point.name,isolated(point.name)]){
  const target={x:-1,y:-1};setPos(target,name);
  assert.deepEqual(target,{x:point.x,y:point.y},name);
 }
});

test('Point object input keeps the original direct x/y copy path',()=>{
 class Point {constructor(x,y){this.x=x;this.y=y;}toString(){throw Error('Point must not be converted to a coordinate key');}}
 const point=new Point(12.5,-23.25),target={x:0,y:0};
 setPos(target,point);assert.deepEqual(target,{x:12.5,y:-23.25});assert.deepEqual([point.x,point.y],[12.5,-23.25]);
});

test('unknown coordinates and non-prefix lookalikes still reject without moving the object',()=>{
 for(const name of ['devilTurn.lotteryCellPos8','workshop.devil.original.lotteryCellPos8','workshop.devil.original.unknown','other.workshop.devil.original.lotteryCellPos0','workshop.devil.originalX.lotteryCellPos0']){
  const target={x:11,y:22};assert.throws(()=>setPos(target,name),/未核实原坐标：/);assert.deepEqual(target,{x:11,y:22},name);
 }
});
