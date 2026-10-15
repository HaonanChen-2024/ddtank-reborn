import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {scan,q} from '../native-pair/build-library.mjs';
import {decode} from '../native-pair/audit-candidate.mjs';
import {adaptTreasure} from './build-library.mjs';
import {parseActivityAbc} from '../../tools/i18n/abc-strings/activity-response.mjs';

const here=dirname(fileURLToPath(import.meta.url)),project=resolve(here,'../../../..');
const source=readFileSync(resolve(here,'WorkshopNativeTreasureBootstrap.as'),'utf8');
const original=scan(readFileSync(resolve(project,'runtime/reference-activities-completion-20261014/reference-core/2_v3_6_1_u9.png')));
const owner='treasureHunting/items/TreasureHuntAwardListCell';
const input=original.abcs.find(a=>a.name===owner),adapted=adaptTreasure(input),output={...input,p:parseActivityAbc(adapted.bytes)};
function body(a,name){const t=a.p.methodTraits.find(t=>a.p.strings[a.p.names[t.name]?.name]===name);assert(t,name);return a.p.bodies.find(b=>b.method===t.method);}
function method(name){const start=source.indexOf('private function '+name+'(');assert(start>=0,'production helper '+name);const open=source.indexOf('{',start);let depth=1,end=open+1;for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}return source.slice(open+1,end-1);}
function run(name,args,context){
 // Execute the production owner with display doubles; actual compilation/ABC is a separate gate.
 let code=method(name).replace(/for\(var o:Object in previewRows\)/g,'for(var o of previewRows.keys())').replace(/for each\(o in owners\)/g,'for(o of owners)').replace(/for each\(var row:Object in projection.preview\)/g,'for(var row of projection.preview)').replace(/:(Object|int|TextField|Boolean|Array)\b/g,'').replace(/ as DisplayObject/g,'');
 code=code.replace(/delete previewRows\[o\]/g,'previewRows.delete(o)').replace(/previewRows\[o\]=([^;]+);/g,'previewRows.set(o,$1);').replace(/previewRows\[o\]/g,'previewRows.get(o)');
 const params={renderPreviewCategory:['o','index','items'],renderPreviewAward:['o','index','items'],clearPreviewCategory:['o'],previewItem:['row']}[name]??[];
 return new Function(...params,'with(this){'+code+'}').call(context,...args);
}
function fixture(){
 const infos=[],context={previewRows:new Map(),projection:{categories:Array.from({length:15},(_,i)=>({name:'原类'+(i+1)})),preview:[]},int:Number};
 class Inventory{constructor(){infos.push(this);}}
 context.cls=name=>{assert.equal(name,'ddt.data.goods.InventoryItemInfo');return Inventory;};
 context.clearPreviewCategory=o=>run('clearPreviewCategory',[o],context);context.previewItem=row=>run('previewItem',[row],context);
 const row={typeIcon:{skin:null,visible:false},itemList:{array:[]}};
 const cell={_bagCell:{info:null},toolTip:null,setCount(count){this.count=count;}};
 return {context,row,cell,infos,render:(index,items)=>run('renderPreviewCategory',[row,index,items],context),renderAward:(index,items)=>run('renderPreviewAward',[cell,index,items],context),clear:()=>context.clearPreviewCategory(row)};
}
const entry=(i,extra={})=>({entryKey:'source-'+i,sourceOriginalIndex:i,templateId:9000+i,count:i,name:'原物品'+i,categoryId:7,pic:'original-'+i,needSex:i%3,status:'blocked',reasons:['缺官方依据'],...extra});

test('actual original setInfo and renderer dispatch, while row initialize and preview owner remain original',()=>{
 assert(decode(body(input,'setInfo').code).some(o=>o.op===0x2c&&input.p.strings[o.args[0]]==='treasureHunting.treasure.item'));
 for(const name of ['setInfo','__onRenderList']){const ops=decode(body(output,name).code);assert.equal(ops.filter(o=>o.op===0x46&&q(output.p,o.args[0])==='::dispatch').length,1);assert(!ops.some(o=>[0x46,0x4f].includes(o.op)&&q(output.p,o.args[0]).endsWith('::fillByID')));}
 assert.deepEqual(body(output,'initialize').code,body(input,'initialize').code);
 const preview=original.abcs.find(a=>a.name==='treasureHunting/views/TreasureAwardPreview'),p={...preview,p:parseActivityAbc(adaptTreasure(preview).bytes)};
 for(const name of ['initialize','__onRenderList','dispose'])assert.deepEqual(body(p,name).code,body(preview,name).code);
 const award=original.abcs.find(a=>a.name==='treasureHunting/items/TreasureHuntAwardCell'),a={...award,p:parseActivityAbc(adaptTreasure(award).bytes)};
 for(const name of ['initialize','setInfoByTemplateId','setCount','dispose'])assert.deepEqual(body(a,name).code,body(award,name).code);
 assert(a.p.names.some((n,i)=>a.p.strings[n?.name]==='_bagCell'&&q(a.p,i)==='::_bagCell'),'only original cell field exposed');
});
test('actual row disposal dispatches cleanup then exactly one original superclass dispose',()=>{
 const ops=decode(body(output,'dispose').code),dispatch=ops.filter(o=>o.op===0x46&&q(output.p,o.args[0])==='::dispatch'),supers=ops.filter(o=>o.op===0x45);
 assert.equal(dispatch.length,1);assert.equal(supers.length,1);assert.equal(q(output.p,supers[0].args[0]),'::dispose');assert(supers[0].offset>dispatch[0].offset);
});
test('all fifteen categories retain original typeIcon and every source row, including blocked entries',()=>{
 const f=fixture();for(let i=0;i<15;i++){const items=[entry(i+1)];f.render(i,items);assert.equal(f.row.itemList.array,items);assert.equal(f.row.typeIcon.visible,true);assert.equal(f.row.typeIcon.skin,'treasureHunting.treasure.item'+(i+1));assert.equal(f.context.previewRows.size,1);}
 f.clear();assert.equal(f.context.previewRows.size,0);assert.deepEqual(f.row.itemList.array,[]);assert.equal(f.row.typeIcon.visible,false);assert.equal(f.row.typeIcon.skin,null);
});
test('isolated preview displays explicit original identity and count, never same-number global template',()=>{
 const f=fixture(),wrongLocal={TemplateID:11905,Name:'错误同号',Pic:'wrong',CategoryID:11};
 f.context.fillByID=()=>{throw Error('global template lookup forbidden');};f.context.ItemManager={fill:()=>wrongLocal};
 const seven=entry(7,{entryKey:'11905-seven',templateId:11905,count:7,name:'原7行',pic:'source-seven'}),twelve=entry(12,{entryKey:'11905-twelve',templateId:11905,count:12,name:'原12行',pic:'source-twelve'});
 f.renderAward(0,[seven]);const first=f.cell._bagCell.info;assert.equal(first.Name,'原7行');assert.equal(first.Pic,'source-seven');assert.equal(first.Count,7);assert.equal(f.cell.count,7);assert.match(f.cell.toolTip,/缺官方依据/);assert.notEqual(first,wrongLocal);
 f.renderAward(1,[seven,twelve]);assert.equal(f.cell._bagCell.info.Name,'原12行');assert.equal(f.cell._bagCell.info.Pic,'source-twelve');assert.equal(f.cell.count,12);assert.notEqual(f.cell._bagCell.info,first);assert.equal(wrongLocal.Name,'错误同号');
 for(const info of f.infos){assert.equal(info.IsBinds,true);assert.equal(info.TemplateID,11905);assert.equal(info.CategoryID,7);assert(!('Attack' in info));assert(!('Property7' in info));}
 f.renderAward(-1,[]);assert.equal(f.cell._bagCell.info,null);assert.equal(f.cell.count,-1);assert.equal(f.cell.toolTip,null);
});
test('grouping preserves all 158 ordered rows and original quantities without deduplication',()=>{
 const f=fixture();f.context.projection.preview=Array.from({length:158},(_,i)=>entry(i%15+1,{entryKey:'row-'+i,count:i+1,templateId:i===1||i===16?11905:90000+i}));
 const groups=run('preview',[],f.context);assert.equal(groups.length,15);assert.equal(groups.flat().length,158);for(let i=0;i<15;i++)assert.deepEqual(groups[i],f.context.projection.preview.filter(x=>x.sourceOriginalIndex===i+1));assert.equal(groups.flat().filter(x=>x.templateId===11905).length,2);
});
test('repeated render, virtual empty row and repeated disposal retain no overlays or stale items',()=>{
 const f=fixture();f.render(0,[entry(1)]);f.render(0,[entry(1)]);assert.equal(f.context.previewRows.size,1);f.render(-1,[]);assert.deepEqual(f.row.itemList.array,[]);assert.equal(f.row.typeIcon.skin,null);f.clear();f.clear();assert.equal(f.context.previewRows.size,0);
 assert.match(source,/if\(owner==="treasureHunting\/items\/TreasureHuntAwardListCell"\)/);assert.match(source,/if\(name==="dispose"\)\{clearPreviewCategory\(o\);return null;\}/);assert.match(method('closePopup'),/clearPreviewCategories\(\)/);
});
test('popup close clears every original row before original disposal and can reopen',()=>{
 const f=fixture(),second={typeIcon:{},itemList:{}},rows=[f.row,second];let disposed=0,unbound=0,locked=0;
 f.context.clearPreviewCategories=()=>run('clearPreviewCategories',[],f.context);f.context.unbind=()=>unbound++;f.context.lock=()=>locked++;
 for(let pass=0;pass<2;pass++){rows.forEach((row,i)=>run('renderPreviewCategory',[row,i,[entry(i+1)]],f.context));f.context.popup={dispose(){assert.equal(f.context.previewRows.size,0);assert(rows.every(r=>r.itemList.array.length===0));rows.forEach(r=>f.context.clearPreviewCategory(r));disposed++;}};run('closePopup',[],f.context);assert.equal(f.context.popup,null);}
 assert.equal(disposed,2);assert.equal(unbound,2);assert.equal(locked,2);
});
test('compiled candidate contains isolated render path and preserves original row dispose chain',{skip:!process.env.TREASURE_PREVIEW_CANDIDATE},()=>{
 const dir=process.env.TREASURE_PREVIEW_CANDIDATE,assets=resolve(dir,'flash/workshop-native/treasure');
 const boot=scan(readFileSync(resolve(assets,'WorkshopNativeTreasureBootstrap.swf'))).abcs[0],lib=scan(readFileSync(resolve(assets,'treasure-original-library.swf'))).abcs.find(a=>a.name===owner);
 const calls=name=>decode(body(boot,name).code).filter(o=>[0x46,0x4f].includes(o.op)).map(o=>q(boot.p,o.args[0]).split('::').at(-1));
 assert(calls('renderPreviewAward').includes('previewItem'));assert(!calls('renderPreviewAward').includes('fillByID'));assert(!calls('previewItem').includes('fillByID'));assert(calls('closePopup').includes('clearPreviewCategories'));
 for(const name of ['setInfo','__onRenderList','dispose'])assert.deepEqual(body(lib,name).code,body(output,name).code);
});
