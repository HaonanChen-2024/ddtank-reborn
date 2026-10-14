import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ByteReader} from '../../tools/i18n/abc-strings/lib.mjs';
import {scan,q,sha} from '../native-pair/build-library.mjs';

/** Read only the six current host files relevant to the shared domain. Never load SWFs. */
export function auditHost({projectRoot,outputDir}) {
  const manifest=JSON.parse(readFileSync(resolve(outputDir,'shared-split/manifest.json'),'utf8'));
  const wanted=new Set(manifest.SharedClassNames.map(n=>n.includes('::')?n:'::'+n));
  assert.equal(wanted.size,82);
  const files=['runtime/client-overlay/2.png','runtime/client-overlay/3.png','runtime/client-overlay/DDT_Loading.swf',
    ...['core','coreii','coreiconandtip'].map(n=>'source/ddtank-reborn/apps/api/assets/flash/ui/vietnam/swf/'+n+'.swf')];
  let contextSlot;
  const hosts=files.map(file=>{
    const path=resolve(projectRoot,file),bytes=readFileSync(path),parsed=scan(bytes);
    const classes=parsed.abcs.flatMap(a=>a.p.traitBlocks.filter(t=>t.owner!=null).map(t=>q(a.p,t.owner)));
    const intersection=classes.filter(name=>wanted.has(name));assert.deepEqual(intersection,[],'unexpected host/shared collision: '+file);
    if(file.endsWith('DDT_Loading.swf')){
      const a=parsed.abcs.find(a=>a.name==='com/pickgliss/loader/DisplayLoader');assert(a);
      assert.equal(a.p.methodTraits.filter(t=>q(a.p,t.name)==='::Context').length,0,'Context is not a getter');
      const block=a.p.traitBlocks[1];assert.equal(block.count,1);const r=new ByteReader(a.abc);r.pos=block.dataOffset;
      contextSlot={owner:a.name,name:q(a.p,r.u30()),kind:r.bytes(1)[0]&15,slot:r.u30(),type:q(a.p,r.u30()),defaultIndex:r.u30()};
      assert.equal(contextSlot.name,'::Context');assert.equal(contextSlot.kind,0);assert.equal(contextSlot.type,'flash.system::LoaderContext');
    }
    return {path,sha256:sha(bytes),bytes:bytes.length,abcCount:parsed.abcs.length,classCount:classes.length,intersection};
  });
  const result={version:1,checkedAt:new Date().toISOString(),sharedPublicClasses:82,hosts,contextSlot,
    conclusions:['No shared public declaration is present in these six host files.','DisplayLoader.Context is a real LoaderContext slot, not an ApplicationDomain getter.','Unknown pre-existing shared declarations are rejected, including an unproven complete legacy 92-class load.','Only this bridge owns the shared library load; ready state reuses its completed load.'],
    limitations:['File declaration analysis does not show the current live ApplicationDomain.','No AVM2, Ruffle, browser or UI execution was performed.']};
  writeFileSync(resolve(outputDir,'host-shared-audit.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=auditHost({projectRoot:process.argv[2],outputDir:process.argv[3]});console.log(JSON.stringify({hosts:result.hosts.length,intersections:result.hosts.map(h=>h.intersection),contextSlot:result.contextSlot,runtimeValidated:false},null,2));}
