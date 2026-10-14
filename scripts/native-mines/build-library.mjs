import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ByteReader,buildTag,compressSwf,encodeU30} from '../../tools/i18n/abc-strings/lib.mjs';
import {parseActivityAbc} from '../../tools/i18n/abc-strings/activity-response.mjs';
import {scan,q,sha,pinned} from '../native-pair/build-library.mjs';
import {decode} from '../native-pair/audit-candidate.mjs';

const ROOT='activity/boguAdventure/';
const CONTROL=ROOT+'BoguAdventureControl',MODEL=ROOT+'model/BoguAdventureModel',GAME=ROOT+'view/BoguAdventureGameView';
const selected={
 [CONTROL]:['checkGameOver','walk','dispose'],
 [GAME]:['__onAllEvent','updateReset','__onReviveClick','__onReviveAffirmRevive','onCheckReviveComplete','__onAwardClick','__onResetClick','__onResetTip','__onResetAffirmRevive','onCheckResetComplete','__onFindMineClick','onCancelFun','__onFindAffirmRevive','onCheckComplete','__onSignClick','__onKeyDown','__onStageClick','changeMouseStyle','signCell','updateHp','initEvent','removeEvent'],
 [ROOT+'view/BoguAdventureAwardFrame']:['sendAwardAlter','show'],
 [ROOT+'view/BoguAdventureRewardFrame']:['__onRankClick','__onHelpClick'],
 [ROOT+'view/BoguAdventureRewardView']:['initialize'],
};
const exposed={
 [CONTROL]:['_model','_hp','_bogu'],
 [GAME]:['_control','_map','_changeView','_reviveBtn','_awardBtn','_resetBtn','_freeResetBtn','_signBtn','_findMineBtn','_rewardView','_mouseStyle','_hpBox','_limitResetText','_resetNumText','_fineMineText','_fineMineTimesText','_activityDateText','updateCell','updateMap','updateReset','updateHp','playActionComplete','clearEffect'],
 [ROOT+'view/BoguAdventureAwardFrame']:['_control','_level'],
 [ROOT+'view/BoguAdventureRewardFrame']:['_view','_flag'],
 [ROOT+'view/BoguAdventureRewardView']:['_control'],
};
function entries(a){const r=new ByteReader(a.abc),p=a.p; r.pos=p.nameDataOffset;const result=[];
 for(let i=1;i<p.names.length;i++){const start=r.pos,kind=r.bytes(1)[0];if([7,13,9,14].includes(kind)){r.u30();r.u30();}else if([15,16,27,28].includes(kind))r.u30();else if(kind===29){r.u30();const n=r.u30();for(let j=0;j<n;j++)r.u30();}else assert([17,18].includes(kind));result.push({i,raw:a.abc.subarray(start,r.pos)});}assert.equal(r.pos,p.namePoolEnd);return result;}
function encodeStrings(strings){return strings.slice(1).flatMap(s=>{const b=Buffer.from(s);return[encodeU30(b.length),b];});}
function rebuildPools(a){const p=a.p,strings=[...p.strings],str=s=>{let i=strings.indexOf(s);if(i<0){i=strings.length;strings.push(s);}return i;};
 const pub=p.namespaces.findIndex(n=>n?.kind===22&&p.strings[n.name]==='');assert(pub>0,a.name+' public namespace');
 const helper=str('WorkshopNativeMinesBootstrap'),dispatch=str('dispatch'),owner=str(a.name);str('constructor');
 for(const t of p.methodTraits)str(p.strings[p.names[t.name]?.name]);
 const changes=[],names=entries(a).map(e=>{const n=p.names[e.i],name=p.strings[n.name],namespace=p.namespaces[n.ns];
  if([7,13].includes(n.kind)&&namespace?.kind===5&&exposed[a.name]?.includes(name)){changes.push({index:e.i,kind:'module-private-access',name});return Buffer.concat([Buffer.from([n.kind]),encodeU30(pub),encodeU30(n.name)]);}
  // Only external class QNames are remapped, never the entire ddt.manager namespace.
  if(n.kind===7&&['ddt.manager::LanguageMgr','ddt.manager::ActivityTimeManager','ddt.manager::ServerConfigManager','ddt.manager::PathManager'].includes(q(p,e.i))){changes.push({index:e.i,kind:'local-host-adapter',from:q(p,e.i)});return Buffer.concat([Buffer.from([7]),encodeU30(pub),encodeU30(helper)]);}
  if(a.name===MODEL&&n.kind===29){changes.push({index:e.i,kind:'module-map-list-array'});return Buffer.concat([Buffer.from([7]),encodeU30(pub),encodeU30(str('Array'))]);}
  if(a.name.endsWith('/BoguAdventureRewardItem')&&q(p,e.i)==='ddt.manager::ItemManager'){changes.push({index:e.i,kind:'inventory-template-adapter'});return Buffer.concat([Buffer.from([7]),encodeU30(pub),encodeU30(helper)]);}
  return e.raw;
 });
 const helperQ=p.names.length,dispatchQ=helperQ+1;
 const bytes=Buffer.concat([a.abc.subarray(0,p.stringCountOffset),encodeU30(strings.length),...encodeStrings(strings),a.abc.subarray(p.stringPoolEnd,p.nameCountOffset),encodeU30(p.names.length+2),...names,Buffer.from([7]),encodeU30(pub),encodeU30(helper),Buffer.from([7]),encodeU30(pub),encodeU30(dispatch),a.abc.subarray(p.namePoolEnd)]);
 return {bytes,p:parseActivityAbc(bytes),helperQ,dispatchQ,owner,changes};
}
function bodyBytes(b,code,stack){assert.equal(b.exceptions,0,'patched method must not hide an exception region');return Buffer.concat([encodeU30(b.method),encodeU30(Math.max(b.maxStack??0,stack)),encodeU30(b.localCount),encodeU30(b.initialScope),encodeU30(Math.max(b.maxScope??b.initialScope+1,b.initialScope+1)),encodeU30(code.length),code,encodeU30(0),encodeU30(0)]);}
export function adaptMines(a){const pool=rebuildPools(a),p=pool.p,replacements=[],changes=[...pool.changes];
 const targets=p.methodTraits.filter(t=>selected[a.name]?.includes(p.strings[p.names[t.name]?.name]) || a.name===CONTROL&&p.strings[p.names[t.name]?.name]?.startsWith('__'));
 for(const t of targets){const b=p.bodies.find(b=>b.method===t.method),m=p.methods[t.method],name=p.strings[p.names[t.name].name],parts=[],op=(v,...args)=>parts.push(Buffer.from([v]),...args.map(encodeU30));
  op(0xd0);op(0x30);op(0x60,pool.helperQ);op(0x2c,pool.owner);op(0x2c,p.strings.indexOf(name));op(0xd0);for(let n=1;n<=m.params.length;n++)op(0x62,n);op(0x56,m.params.length);op(0x46,pool.dispatchQ,4);if(q(p,m.returnType)==='::void'){op(0x29);op(0x47);}else{if(m.returnType)op(0x80,m.returnType);op(0x48);}
  const code=Buffer.concat(parts);replacements.push({b,bytes:bodyBytes(b,code,Math.max(6,4+m.params.length))});changes.push({method:t.method,name,kind:'dispatch',oldCodeSha256:sha(b.code),newCodeSha256:sha(code)});
 }
 if(a.name===CONTROL){
  const b=p.bodies.find(b=>b.method===1);assert(b);assert(p.methods[1].params.length===0);const init=p.methodTraits.find(t=>p.strings[p.names[t.name]?.name]==='init');assert(init);
  const code=Buffer.concat([Buffer.from([0xd0,0x30,0xd0,0x49,0,0xd0,0x4f]),encodeU30(init.name),Buffer.from([0,0x47])]);
  replacements.push({b,bytes:bodyBytes(b,code,1)});changes.push({method:1,name:'constructor',kind:'constructor-no-socket',oldCodeSha256:sha(b.code),newCodeSha256:sha(code)});
 }
 // A player bitmap may finish after its controlled container was closed. Preserve
 // the original loader unsubscribe and frame/action construction, but stop before
 // touching a disposed set/control. No restart or late window is created.
 const guard=a.name===ROOT+'player/BoguAdventurePlayer'?{method:'__onLoaderPlayerStateImageComplete',field:'_playerSetNatural',afterUnsubscribe:true}:a.name===ROOT+'view/BoguAdventureChangeView'?{method:'createBoguComplete',field:'_control',afterUnsubscribe:false}:null;
 if(guard){
  const t=p.methodTraits.find(t=>p.strings[p.names[t.name]?.name]===guard.method),b=p.bodies.find(b=>b.method===t.method),ops=decode(b.code);
  const field=p.names.findIndex(n=>n&&p.strings[n.name]===guard.field);assert(field>0);let cut=0;
  if(guard.afterUnsubscribe){const index=ops.findIndex(o=>[0x46,0x4f].includes(o.op)&&p.strings[p.names[o.args[0]]?.name]==='removeEventListener');assert(index>=0);cut=ops[index].end;if(ops[index+1]?.op===0x29)cut=ops[index+1].end;}
  for(const op of ops.filter(o=>o.op>=0x0c&&o.op<=0x1a)){assert(op.offset>=cut&&op.end+op.args[0]>=cut,'guard insertion must not cross an original branch');}
  const prefix=Buffer.concat([Buffer.from([0xd0,0x66]),encodeU30(field),Buffer.from([0x11,1,0,0,0x47])]);
  const code=Buffer.concat([b.code.subarray(0,cut),prefix,b.code.subarray(cut)]);replacements.push({b,bytes:bodyBytes(b,code,b.maxStack)});changes.push({method:t.method,name:guard.method,kind:'disposed-late-completion-guard',insertOffset:cut,originalRemainderUnchanged:true,oldCodeSha256:sha(b.code),newCodeSha256:sha(code)});
 }
 replacements.sort((x,y)=>x.b.start-y.b.start);let at=0;const pieces=[];for(const r of replacements){pieces.push(pool.bytes.subarray(at,r.b.start),r.bytes);at=r.b.end;}pieces.push(pool.bytes.subarray(at));const bytes=Buffer.concat(pieces),checked=parseActivityAbc(bytes);
 for(const old of a.p.bodies)if(!changes.some(c=>c.method===old.method))assert.deepEqual(checked.bodies.find(b=>b.method===old.method).code,old.code,'untouched original method changed');
 return {bytes,changes};
}
export function buildMinesLibrary({projectRoot,out}){
 const path=resolve(projectRoot,'runtime/reference-activities-completion-20261014/reference-core/2_v3_6_1_u9.png'),source=pinned(path,'af361678887e2413efe54e6cd86d37426cc6724ea964080178eea4816a785ae4'),core=scan(source);
 const all=core.abcs.filter(a=>a.name.startsWith(ROOT));assert.equal(all.length,21);const excluded=ROOT+'view/BoguAdventureStateView';
 const owners=all.filter(a=>a.name!==excluded).sort((a,b)=>Number(!a.name.includes('/mornui/'))-Number(!b.name.includes('/mornui/')));assert.equal(owners.length,20);
 const adapted=owners.map(a=>({...a,...adaptMines(a)})),header=Buffer.from(core.headerPrefix);header.writeUInt16LE(1,header.length-2);
 const bytes=compressSwf('CWS',15,Buffer.concat([header,core.tags.find(t=>t.code===69).raw,...adapted.map(a=>buildTag(82,Buffer.concat([a.prefix,a.bytes]))),buildTag(1,Buffer.alloc(0)),buildTag(0,Buffer.alloc(0))]));
 const checked=scan(bytes),forbidden=[];
 for(const a of checked.abcs)for(const b of a.p.bodies)for(const op of decode(b.code)){if(![0x60,0x5d,0x46,0x4f,0x4a,0x66].includes(op.op))continue;const name=a.p.strings[a.p.names[op.args[0]]?.name];if(['SocketManager','CheckMoneyUtils','ActivityTimeManager','ServerConfigManager','PathManager','KeyboardManager','StageReferance','Mouse','SimpleReturnBar','sendBoguAdventureWalk','sendBoguAdventureRGame'].includes(name))forbidden.push({owner:a.name,method:b.method,name});}
 // StageReferance remains in the original, unused key handler only if it was missed: no exemptions.
 assert.deepEqual(forbidden,[]);writeFileSync(resolve(out,'mines-original-library.swf'),bytes,{flag:'wx'});
 return {file:'mines-original-library.swf',bytes:bytes.length,sha256:sha(bytes),source:{path,sha256:sha(source)},excluded:{owner:excluded,reason:'No global StateManager/keyboard lock/SimpleReturnBar; original GameView lives in a controlled container.'},owners:adapted.map(a=>({owner:a.name,originalAbcSha256:sha(a.abc),abcSha256:sha(a.bytes),changes:a.changes})),forbiddenCalls:forbidden};
}
