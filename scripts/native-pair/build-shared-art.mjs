import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {ByteReader,buildTag,compressSwf} from '../../tools/i18n/abc-strings/lib.mjs';
import {scan,pinned,sha} from './build-library.mjs';

export function buildSharedArt({projectRoot,out,compile}){
  const A=resolve(projectRoot,'runtime/reference-activities-completion-20261014/magicwardrobe-native-candidate');
  const inputs=[
    ['corei_v3_6_1_u2.swf','e2adaaccc5eb032be39142c2784c234506da4f2f571bfadde421813ae3aa4310',[[88,'asset.ddtshop.PayTypeLabelTicket']]],
    ['coreii_v3_6_1_u2.swf','96acf56d508c8b6f4fdbfa9a289fa84d811aef17684ae94fb1a2d913e6e08ebb',[[94,'asset.ddtstore.ShortcutTextBg']]],
    ['uicomponent_v3_6_1_u1.swf','2e884e9f4dad50b78ed70a1d2557591e16ff1a101e5ae1f60425e4c657bdbf27',[[188,'asset.ui.scale.bg4'],[105,'asset.ui.btn_close1'],[93,'asset.ui.frame.bg2'],[57,'asest.ui.btn_check7'],[56,'asset.ui.btn_yellow1']]],
  ];
  const selected=[];
  for(const [file,hash,symbols] of inputs){
    const path=resolve(A,file),swf=scan(pinned(path,hash)),exports=[];
    for(const t of swf.tags.filter(t=>t.code===76)){const r=new ByteReader(swf.body.subarray(t.bodyStart,t.bodyEnd));for(let n=r.u16();n;n--)exports.push({id:r.u16(),name:r.cstring()});}
    for(const [id,name] of symbols){assert(exports.some(s=>s.id===id&&s.name===name));const tag=swf.tags.find(t=>[35,36].includes(t.code)&&swf.body.readUInt16LE(t.bodyStart)===id);assert(tag);selected.push({id,name,tag,source:path,sourceSha256:hash});}
  }
  assert.equal(new Set(selected.map(s=>s.id)).size,7);
  const src=resolve(out,'shared-art-source');mkdirSync(src,{recursive:true});
  for(const s of selected){const dot=s.name.lastIndexOf('.'),pkg=s.name.slice(0,dot),name=s.name.slice(dot+1),dir=resolve(src,...pkg.split('.'));mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,name+'.as'),`package ${pkg} { import flash.display.BitmapData; public dynamic class ${name} extends BitmapData { public function ${name}(width:int=0,height:int=0) { super(width,height); } } }\n`,{flag:'wx'});}
  const files=[];
  // One class per bundle allows the host to reuse already-loaded shared skins safely.
  for(const s of selected){
    const root='WorkshopPairSkin'+s.id,main=resolve(src,root+'.as');writeFileSync(main,`package { import flash.display.Sprite; import ${s.name}; public class ${root} extends Sprite { private var keep:Class=${s.name}; } }\n`,{flag:'wx'});
    const glueFile=resolve(out,root+'.glue.swf');compile(main,glueFile,src);const glue=scan(readFileSync(glueFile));
    const id=Buffer.alloc(2);id.writeUInt16LE(s.id);
    const bytes=compressSwf('CWS',14,Buffer.concat([glue.headerPrefix,glue.tags.find(t=>t.code===69).raw,s.tag.raw,...glue.tags.filter(t=>t.code===82).map(t=>t.raw),buildTag(76,Buffer.concat([Buffer.from([1,0]),id,Buffer.from(s.name+'\0')])),buildTag(1,Buffer.alloc(0)),buildTag(0,Buffer.alloc(0))]));
    const checked=scan(bytes),tag=checked.tags.find(t=>t.code===s.tag.code&&checked.body.readUInt16LE(t.bodyStart)===s.id);assert.deepEqual(tag.raw,s.tag.raw);
    const file='pair-shared-art-'+s.id+'.swf';writeFileSync(resolve(out,file),bytes,{flag:'wx'});files.push({file,bytes:bytes.length,sha256:sha(bytes),symbol:s.name});
  }
  return {files,symbols:selected.map(({id,name,tag,source,sourceSha256})=>({id,name,source,sourceSha256,tagCode:tag.code,tagSha256:sha(tag.raw),bitmapPayloadUnchanged:true}))};
}
