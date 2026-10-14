import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ByteReader,buildTag,compressSwf,encodeU30} from '../../tools/i18n/abc-strings/lib.mjs';
import {parseActivityAbc} from '../../tools/i18n/abc-strings/activity-response.mjs';
import {scan,q,sha,pinned} from '../native-pair/build-library.mjs';
import {decode} from '../native-pair/audit-candidate.mjs';
const selected={
 'DDPlay/DDPlayManaer':['setup','initEvent','__addDDPlayBtn','openOrClose','show','__onClose','__progressShow','__complainShow','showDDPlayView'],
 'DDPlay/DDPlayView':['initEvent','removeEvent','sendPkg','__updateScore','__start','_timerHandler','__response','_bagUpdate','__scoreExchange','doUpHonor','stopDoUpHonor','__checkBoxClick','refreshShow','show','dispose'],
 'DDPlay/DDPlayExchangeFrame':['initEvent','removeEvent','__numberChange','__updateScore','__exchange','__responseHandler','dispose']
};
const helper='WorkshopNativeDDPlayBootstrap';
const adapters=new Set(['ddt.manager::LanguageMgr','ddt.manager::PlayerManager','ddt.manager::InviteManager','ddt.manager::MessageTipManager','ddt.manager::ChatManager']);
const exposedFields={
 'DDPlay/DDPlayView':['_bg','_boguTypePoints','_sixBogu1','_sixBogu2','_sixBogu3','_boguMaskSp1','_boguMaskSp2','_boguMaskSp3','_boguMask1','_boguMask2','_boguMask3','_tripleMc','_fivefoldMc','_tenfoldMc','_triple','_fivefold','_tenfold','_lights','_shine1','_shine2','_shine3','_titleLight','_finallyLight','_finallyFireWork','_upBtn','_stopUpBtn','_selectedTxt','_exchangeBtn','timer','_explameTxt','_coinsTxt','_scoreTxt','isPlaying','_multiple','tw1','tw2','tw3','startLottery','reSetBogu'],
 'DDPlay/DDPlayExchangeFrame':['_bg','_exchangeBtn','_chooseNum','_exchangeNum','_currentScore','_proportion','_currentScoreBg','_currentScore2','_score','_fold']
};
function entries(a){const r=new ByteReader(a.abc),p=a.p; r.pos=p.nameDataOffset;const rows=[];for(let i=1;i<p.names.length;i++){const start=r.pos,k=r.bytes(1)[0];if([7,13,9,14].includes(k)){r.u30();r.u30();}else if([15,16,27,28].includes(k))r.u30();else if(k===29){r.u30();for(let n=r.u30();n;n--)r.u30();}else assert([17,18].includes(k));rows.push({i,raw:a.abc.subarray(start,r.pos)});}assert.equal(r.pos,p.namePoolEnd);return rows;}
function pools(a){const p=a.p,strings=[...p.strings],str=s=>{let i=strings.indexOf(s);if(i<0){i=strings.length;strings.push(s);}return i;};
 const pub=p.namespaces.findIndex(n=>n?.kind===22&&p.strings[n.name]==='');assert(pub>0);
 str(helper);str('dispatch');str(a.name);str('animationComplete');
 const exposed=new Set(exposedFields[a.name]??[]);
 const changes=[],names=entries(a).map(e=>{const n=p.names[e.i],name=p.strings[n.name],ns=p.namespaces[n.ns];if([7,13].includes(n.kind)&&ns?.kind===5&&exposed.has(name)){changes.push({kind:'module-private-access',name});return Buffer.concat([Buffer.from([n.kind]),encodeU30(pub),encodeU30(n.name)]);}if(n.kind===7&&adapters.has(q(p,e.i))){changes.push({kind:'local-host-adapter',from:q(p,e.i)});return Buffer.concat([Buffer.from([7]),encodeU30(pub),encodeU30(str(helper))]);}return e.raw;});
 const helperQ=p.names.length,dispatchQ=helperQ+1;
 const bytes=Buffer.concat([a.abc.subarray(0,p.stringCountOffset),encodeU30(strings.length),...strings.slice(1).flatMap(s=>{const b=Buffer.from(s);return[encodeU30(b.length),b];}),a.abc.subarray(p.stringPoolEnd,p.nameCountOffset),encodeU30(p.names.length+2),...names,Buffer.from([7]),encodeU30(pub),encodeU30(str(helper)),Buffer.from([7]),encodeU30(pub),encodeU30(str('dispatch')),a.abc.subarray(p.namePoolEnd)]);
 return {bytes,p:parseActivityAbc(bytes),helperQ,dispatchQ,changes};
}
function body(b,code,stack){assert.equal(b.exceptions,0);return Buffer.concat([encodeU30(b.method),encodeU30(Math.max(b.maxStack,stack)),encodeU30(b.localCount),encodeU30(b.initialScope),encodeU30(Math.max(b.maxScope,b.initialScope+1)),encodeU30(code.length),code,encodeU30(0),encodeU30(0)]);}
function call(p,pool,a,name,m){const pieces=[],op=(v,...args)=>pieces.push(Buffer.from([v]),...args.map(encodeU30));op(0x60,pool.helperQ);op(0x2c,p.strings.indexOf(a.name));op(0x2c,p.strings.indexOf(name));op(0xd0);for(let i=1;i<=m.params.length;i++)op(0x62,i);op(0x56,m.params.length);op(0x46,pool.dispatchQ,4);return Buffer.concat(pieces);}
export function adaptDDPlay(a){const pool=pools(a),p=pool.p,replacements=[],changes=[...pool.changes];
 const targets=p.methodTraits.filter(t=>selected[a.name]?.includes(p.strings[p.names[t.name]?.name]));
 for(const t of targets){const b=p.bodies.find(b=>b.method===t.method),m=p.methods[t.method],name=p.strings[p.names[t.name].name],pieces=[Buffer.from([0xd0,0x30]),call(p,pool,a,name,m)];if(q(p,m.returnType)==='::void'){pieces.push(Buffer.from([0x29]));if(name==='dispose'){const nameIndex=p.names.findIndex((n,i)=>q(p,i)==='::dispose');assert(nameIndex>0);pieces.push(Buffer.from([0xd0,0x45]),encodeU30(nameIndex),Buffer.from([0,0x29]));}pieces.push(Buffer.from([0x47]));}else {if(m.returnType)pieces.push(Buffer.from([0x80]),encodeU30(m.returnType));pieces.push(Buffer.from([0x48]));}const code=Buffer.concat(pieces);replacements.push({b,bytes:body(b,code,Math.max(6,4+m.params.length))});changes.push({kind:'dispatch',method:t.method,name,oldCodeSha256:sha(b.code),newCodeSha256:sha(code)});}
 if(a.name==='DDPlay/DDPlayView'){const t=p.methodTraits.find(t=>p.strings[p.names[t.name]?.name]==='__lotteryCom'),b=p.bodies.find(b=>b.method===t.method);assert(b&&b.code.at(-1)===0x47);
  const callBytes=call(p,pool,a,'animationComplete',{params:[]}),code=Buffer.concat([b.code.subarray(0,-1),callBytes,Buffer.from([0x29,0x47])]);for(const op of decode(b.code).filter(o=>o.op>=0x0c&&o.op<=0x1a))assert(op.end+op.args[0]<b.code.length-1,'completion insertion branch');
  replacements.push({b,bytes:body(b,code,6)});changes.push({kind:'original-animation-complete-hook',method:b.method,name:'__lotteryCom',originalPrefixUnchanged:true,oldCodeSha256:sha(b.code),newCodeSha256:sha(code)});
 }
 replacements.sort((x,y)=>x.b.start-y.b.start);let at=0;const pieces=[];for(const r of replacements){pieces.push(pool.bytes.subarray(at,r.b.start),r.bytes);at=r.b.end;}pieces.push(pool.bytes.subarray(at));const bytes=Buffer.concat(pieces),checked=parseActivityAbc(bytes);
 for(const old of a.p.bodies)if(!changes.some(c=>c.method===old.method))assert.deepEqual(checked.bodies.find(b=>b.method===old.method).code,old.code);
 return {bytes,changes};
}
export function buildDDPlayLibrary({projectRoot,out,bitmapGlue}){
 const A=resolve(projectRoot,'runtime/reference-activities-completion-20261014'),path=resolve(A,'reference-core/2_v3_6_1_u9.png'),source=pinned(path,'af361678887e2413efe54e6cd86d37426cc6724ea964080178eea4816a785ae4'),core=scan(source);
 const originals=core.abcs.filter(a=>a.name.startsWith('DDPlay/')&&a.name!=='DDPlay/DDPlayQuickBuy');assert.equal(originals.length,5);originals.sort((a,b)=>Number(a.name==='DDPlay/DDPlayView')-Number(b.name==='DDPlay/DDPlayView'));
 const owners=originals.map(a=>({...a,...adaptDDPlay(a)})),back=core.abcs.find(a=>a.name==='com/greensock/easing/Back');assert(back);const header=Buffer.from(core.headerPrefix);header.writeUInt16LE(1,header.length-2);
 const artPath=resolve(A,'native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf'),art=scan(pinned(artPath,'a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827'));const exports=[];
 for(const t of art.tags.filter(t=>t.code===76)){const r=new ByteReader(art.body.subarray(t.bodyStart,t.bodyEnd));for(let n=r.u16();n;n--)exports.push({id:r.u16(),name:r.cstring()});}
 const symbol=exports.find(e=>e.name==='asset.core.ddplayBgAsset');assert(symbol);const bitmap=art.tags.find(t=>[6,20,21,35,36,90].includes(t.code)&&art.body.readUInt16LE(t.bodyStart)===symbol.id);assert(bitmap);
 const tables=bitmap.code===6?art.tags.find(t=>t.code===8):null;if(bitmap.code===6)assert(tables);
 const glue=scan(readFileSync(bitmapGlue)),skin=glue.abcs;assert.equal(skin.length,1);assert(skin[0].p.traitBlocks.some(t=>t.owner!=null&&q(skin[0].p,t.owner)==='asset.core::ddplayBgAsset'));const id=Buffer.alloc(2);id.writeUInt16LE(symbol.id);const symbolTag=buildTag(76,Buffer.concat([Buffer.from([1,0]),id,Buffer.from(symbol.name+'\0')]));
 const bytes=compressSwf('CWS',15,Buffer.concat([header,core.tags.find(t=>t.code===69).raw,...(tables?[tables.raw]:[]),bitmap.raw,...skin.map(a=>buildTag(82,Buffer.concat([a.prefix,a.abc]))),buildTag(82,Buffer.concat([back.prefix,back.abc])),...owners.map(a=>buildTag(82,Buffer.concat([a.prefix,a.bytes]))),symbolTag,buildTag(1,Buffer.alloc(0)),buildTag(0,Buffer.alloc(0))]));
 const checked=scan(bytes),forbidden=[];for(const a of checked.abcs)for(const b of a.p.bodies)for(const op of decode(b.code)){if(![0x60,0x5d,0x46,0x4f,0x4a,0x66].includes(op.op))continue;const name=a.p.strings[a.p.names[op.args[0]]?.name];if(['SocketManager','UIModuleLoader','UIModuleSmallLoading','LeavePageManager','ShopManager','BaglockedManager','DDPlayQuickBuy','DDPlayEnter','DDPlayStart','DDPlayExchange','sendBuyGoods'].includes(name))forbidden.push({owner:a.name,method:b.method,name});}assert.deepEqual(forbidden,[]);
 writeFileSync(resolve(out,'ddplay-original-library.swf'),bytes,{flag:'wx'});return {file:'ddplay-original-library.swf',bytes:bytes.length,sha256:sha(bytes),source:{path,sha256:sha(source)},ownerCount:owners.length,owners:owners.map(a=>({owner:a.name,originalAbcSha256:sha(a.abc),abcSha256:sha(a.bytes),changes:a.changes})),animationDependencies:[{owner:back.name,abcSha256:sha(back.abc),unchanged:true}],bitmap:{symbol:symbol.name,id:symbol.id,source:artPath,tagSha256:sha(bitmap.raw),jpegTablesSha256:tables?sha(tables.raw):null,originalPayloadUnchanged:true,abcOwners:skin.map(a=>a.name)},excluded:['DDPlay/DDPlayQuickBuy'],forbiddenCalls:forbidden};
}
