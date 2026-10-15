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
function method(name){
 const start=source.indexOf('private function '+name+'(');assert(start>=0,'production helper '+name);
 const open=source.indexOf('{',start);let depth=1,end=open+1;
 for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}
 return source.slice(open+1,end-1);
}
function run(name,args,context){
 // Execute the production display-owner helper with small display/Dictionary doubles.
 // Compilation and ABC assertions below cover the actual Flash output; this is no render/AVM2 acceptance.
 let code=method(name).replace(/for\(var o:Object in previewRows\)/g,'for(var o of previewRows.keys())').replace(/for each\(o in owners\)/g,'for(o of owners)').replace(/:(Object|int|TextField|Boolean|Array)\b/g,'').replace(/ as DisplayObject/g,'');
 code=code.replace(/delete previewRows\[o\]/g,'previewRows.delete(o)').replace(/previewRows\[o\]=([^;]+);/g,'previewRows.set(o,$1);').replace(/previewRows\[o\]/g,'previewRows.get(o)');
 return new Function('o','index','items','with(this){'+code+'}').call(context,...args);
}
function fixture(){
 const cells=[],labels=[],context={previewRows:new Map(),projection:{previewTemplateIds:[11019,11001,11021,11002],categories:[{name:'强化石2级'},{name:'强化石1级'},{name:'合成石'},{name:'幸运符'}]},int:Number};
 class Cell{constructor(index,info){this.info=info;this.parent=null;this.disposed=0;cells.push(this);}setContentSize(w,h){this.size=[w,h];}dispose(){this.disposed++;if(this.parent)this.parent.removeChild(this);}}
 context.cls=name=>{assert.equal(name,'bagAndInfo.cell.BagCell');return Cell;};
 context.fillByID=id=>({TemplateID:id});context.text=(x,y,w,h,value,color)=>{const label={x,y,width:w,height:h,text:value,color,parent:null};labels.push(label);return label;};
 context.clearPreviewCategory=o=>run('clearPreviewCategory',[o],context);
 const row={children:[],typeIcon:{skin:'treasureHunting.treasure.item1',visible:true},itemList:{array:[]},addChild(child){this.children.push(child);child.parent=this;},removeChild(child){this.children.splice(this.children.indexOf(child),1);child.parent=null;}};
 return {context,row,cells,labels,render:(index,items)=>run('renderPreviewCategory',[row,index,items],context),clear:()=>context.clearPreviewCategory(row)};
}
test('actual original setInfo is replaced while render/list/initialize remain original',()=>{
 assert(decode(body(input,'setInfo').code).some(o=>o.op===0x2c&&input.p.strings[o.args[0]]==='treasureHunting.treasure.item'));
 const ops=decode(body(output,'setInfo').code);
 assert.equal(ops.filter(o=>o.op===0x46&&q(output.p,o.args[0])==='::dispatch').length,1);
 assert(!ops.some(o=>o.op===0x2c&&output.p.strings[o.args[0]]==='treasureHunting.treasure.item'));
 for(const name of ['initialize','__onRenderList'])assert.deepEqual(body(output,name).code,body(input,name).code);
 const preview=original.abcs.find(a=>a.name==='treasureHunting/views/TreasureAwardPreview'),p={...preview,p:parseActivityAbc(adaptTreasure(preview).bytes)};
 for(const name of ['initialize','__onRenderList','dispose'])assert.deepEqual(body(p,name).code,body(preview,name).code);
});
test('actual row disposal dispatches local cleanup then exactly one original superclass dispose',()=>{
 const ops=decode(body(output,'dispose').code),dispatch=ops.filter(o=>o.op===0x46&&q(output.p,o.args[0])==='::dispatch'),supers=ops.filter(o=>o.op===0x45);
 assert.equal(dispatch.length,1);assert.equal(supers.length,1);assert.equal(q(output.p,supers[0].args[0]),'::dispose');assert(supers[0].offset>dispatch[0].offset);
});
test('four categories use validated local material icons and names inside original left column',()=>{
 const f=fixture();for(let i=0;i<4;i++){const items=[{template:f.context.projection.previewTemplateIds[i],count:1}];f.render(i,items);assert.equal(f.row.itemList.array,items);assert.equal(f.row.children.length,2);const cell=f.row.children[0],label=f.row.children[1];assert.equal(cell.info.TemplateID,f.context.projection.previewTemplateIds[i]);assert.equal(label.text,f.context.projection.categories[i].name);assert(cell.x>=0&&cell.x+cell.size[0]<147);assert(label.x>=0&&label.x+label.width<147);assert(label.y+label.height<=115);assert.equal(f.row.typeIcon.visible,false);assert.equal(f.row.typeIcon.skin,null);}
 f.clear();assert.equal(f.context.previewRows.size,0);assert.equal(f.row.children.length,0);assert(f.cells.every(c=>c.disposed===1));
});
test('repeated render, virtual-list empty row and disposal do not retain overlays',()=>{
 const f=fixture();f.render(0,[{template:11019,count:1}]);f.render(0,[{template:11019,count:1}]);assert.equal(f.row.children.length,2);assert.equal(f.cells[0].disposed,1);assert.equal(f.context.previewRows.size,1);
 f.render(-1,[]);assert.deepEqual(f.row.itemList.array,[]);assert.equal(f.row.children.length,0);assert.equal(f.context.previewRows.size,0);assert(f.cells.every(c=>c.disposed===1));
 f.render(3,[{template:11002,count:1}]);f.clear();f.clear();assert.equal(f.row.children.length,0);assert.equal(f.context.previewRows.size,0);assert(f.cells.every(c=>c.disposed===1));
 assert.match(source,/if\(owner==="treasureHunting\/items\/TreasureHuntAwardListCell"\)/);
 assert.match(source,/if\(name==="dispose"\)\{clearPreviewCategory\(o\);return null;\}/);
 assert.match(method('closePopup'),/clearPreviewCategories\(\)/);
});
test('popup close clears every owned row before original disposal and reopens without retained cells',()=>{
 const f=fixture(),second={...f.row,children:[],typeIcon:{},itemList:{}},rows=[f.row,second];let disposed=0,unbound=0,locked=0;
 f.context.clearPreviewCategories=()=>run('clearPreviewCategories',[],f.context);f.context.unbind=()=>unbound++;f.context.lock=()=>locked++;
 for(let pass=0;pass<2;pass++){
  rows.forEach((row,i)=>run('renderPreviewCategory',[row,i,[{template:11019,count:1}]],f.context));
  f.context.popup={dispose(){assert.equal(f.context.previewRows.size,0);assert(rows.every(r=>r.children.length===0));rows.forEach(r=>f.context.clearPreviewCategory(r));disposed++;}};
  run('closePopup',[],f.context);assert.equal(f.context.popup,null);
 }
 assert.equal(disposed,2);assert.equal(unbound,2);assert.equal(locked,2);assert(f.cells.every(c=>c.disposed===1));
});
test('compiled candidate contains the display cleanup helpers and original row superclass chain',{skip:!process.env.TREASURE_PREVIEW_CANDIDATE},()=>{
 const dir=process.env.TREASURE_PREVIEW_CANDIDATE,assets=resolve(dir,'flash/workshop-native/treasure');
 const boot=scan(readFileSync(resolve(assets,'WorkshopNativeTreasureBootstrap.swf'))).abcs[0],lib=scan(readFileSync(resolve(assets,'treasure-original-library.swf'))).abcs.find(a=>a.name===owner);
 const calls=name=>decode(body(boot,name).code).filter(o=>[0x46,0x4f].includes(o.op)).map(o=>q(boot.p,o.args[0]).split('::').at(-1));
 for(const name of ['clearPreviewCategory','fillByID','text','setContentSize','addChild'])assert(calls('renderPreviewCategory').includes(name),name);
 for(const name of ['removeChild','dispose'])assert(calls('clearPreviewCategory').includes(name),name);
 assert(calls('closePopup').includes('clearPreviewCategories'));
 assert.deepEqual(body(lib,'setInfo').code,body(output,'setInfo').code);assert.deepEqual(body(lib,'dispose').code,body(output,'dispose').code);
});
