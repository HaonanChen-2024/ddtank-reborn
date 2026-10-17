// One command, separate strict and extra-historical-input generation reports.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,copyFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {freshOutput,overlaySnapshot,sha256} from './build-environment.mjs';
import {copyOriginals} from './copy-originals.mjs';
export function buildAll({here,root,options,manifest,before}){
  const output=freshOutput(root,options.out,manifest.allowedDataRoots),phases=[];
  const run=(name,script,args)=>{
    const out=join(output,name),common=['--root='+root,'--out='+out];if(options.deps)common.push('--deps='+options.deps);
    let status=0,log='';try{log=execFileSync(process.execPath,[join(here,script),...args,...common],{encoding:'utf8',maxBuffer:4e6,timeout:60000,windowsHide:true});}
    catch(error){status=error.status??1;log=String(error.stdout??'')+'\n'+String(error.stderr??error.message);}
    writeFileSync(join(output,name+'.log'),log,{flag:'wx'});
    const report=existsSync(join(out,'report.json'))?JSON.parse(readFileSync(join(out,'report.json'))):null;
    phases.push({name,status,report:name+'/report.json',reportPresent:report!==null});return report;
  };
  const strict=run('strict','rebuild.mjs',['rebuild']),extended=run('extended','extended-build.mjs',[]),results=[];
  let originals;try{originals=copyOriginals({root,output:join(output,'source-originals'),manifest});phases.push({name:'source-originals',status:originals.results.some(x=>x.status==='source-copy-error')?1:0,report:'source-originals/report.json',reportPresent:true});}
  catch(error){originals={error:String(error.message)};phases.push({name:'source-originals',status:1,reportPresent:false,error:originals.error});}
  for(const target of manifest.entries){
    const a=strict?.results.find(x=>x.path===target.relativePath),b=target.extendedGeneration?extended?.results.find(x=>x.name===target.extendedGeneration.recipe):null,c=target.originalCopy?originals?.results?.find(x=>x.path===target.relativePath):null;
    let result={path:target.relativePath,status:'exception',generation:false,strictRebuild:false,...target.exception};
    let product;
    if(a?.status==='rebuilt-exact'){result={path:target.relativePath,status:'generated-exact',generation:true,strictRebuild:true,sha256:a.sha256,bytes:a.bytes};product=join(output,'strict/rebuilt',target.relativePath);}
    else if(b?.status==='rebuilt-exact-with-historical-raw-inputs'){result={path:target.relativePath,status:'generated-exact',generation:true,strictRebuild:false,additionalHistoricalRawInputs:true,sha256:b.sha256,bytes:b.bytes};product=join(output,'extended',b.name+'.swf');}
    else if(c?.status==='source-copy-exact'){result={...c,strictRebuild:false,additionalOriginalPackage:true};product=join(output,'source-originals',target.relativePath);}
    else if(target.originalCopy){result={path:target.relativePath,status:'build-error',generation:false,error:c?.error??originals?.error??'source-copy phase result unavailable'};}
    else if(a?.status==='build-error'||a?.status==='generated-mismatch'||target.extendedGeneration){result={path:target.relativePath,status:'build-error',generation:false,error:b?.error??a?.error??'required phase did not produce an exact result'};}
    else if(!a){result={path:target.relativePath,status:'build-error',generation:false,error:'strict phase report unavailable'};}
    if(product){const bytes=readFileSync(product);assert.equal(sha256(bytes),target.expectedSha256);assert.equal(bytes.length,target.expectedBytes);const destination=join(output,'rebuilt',target.relativePath);mkdirSync(dirname(destination),{recursive:true});copyFileSync(product,destination);}
    results.push(result);
  }
  const unchanged=JSON.stringify(before)===JSON.stringify(overlaySnapshot(root));assert(unchanged,'live overlay drift during aggregate build');
  const summary={targets:results.length,reproducedExact:results.filter(x=>['generated-exact','source-copy-exact'].includes(x.status)).length,generatedExact:results.filter(x=>x.status==='generated-exact').length,strictExact:results.filter(x=>x.status==='generated-exact'&&x.strictRebuild).length,extraHistoricalExact:results.filter(x=>x.status==='generated-exact'&&!x.strictRebuild).length,sourceCopyExact:results.filter(x=>x.status==='source-copy-exact').length,exceptions:results.filter(x=>x.status==='exception').length,errors:results.filter(x=>x.status==='build-error').length};
  const report={mode:'all',generationAndRecoverySeparated:true,originalSourceCopySeparate:true,additionalHistoricalInputsExplicit:true,allFilesRebuildableFromStrictRoots:false,liveOverlayPresent:before!==null,liveOverlayUnchanged:unchanged,inputFilesUnchanged:strict?.inputFilesUnchanged===true&&extended?.inputFilesUnchanged===true&&originals?.inputFilesUnchanged===true,serviceOperations:0,browserOperations:0,databaseOperations:0,summary,phases,results};
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,...summary,liveOverlayPresent:report.liveOverlayPresent,liveOverlayUnchanged:unchanged}));
  return summary.errors||phases.some(x=>x.status!==0)?1:0;
}
