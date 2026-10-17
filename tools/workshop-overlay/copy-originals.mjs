// Original-file reproduction, explicitly separate from generated SWFs and archive recovery.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {sha256,within,freshOutput} from './build-environment.mjs';
export function copyOriginals({root,output,manifest}){
  const packageRoot=realpathSync(join(root,'runtime/live/overlay-originals')),pin=manifest.originalSourcesPackage,manifestPath=realpathSync(resolve(root,pin.path));assert(within(manifestPath,packageRoot));
  const raw=readFileSync(manifestPath);assert.equal(sha256(raw),pin.sha256,'original-source manifest drift');const sources=JSON.parse(raw);assert.equal(sources.entries.length,pin.files);assert.equal(sources.generatedCandidateInput,false);
  const out=freshOutput(root,output),results=[],inputs=[{path:manifestPath,sha256:sha256(raw)}];
  for(const row of sources.entries){try{
    const expected=manifest.entries.find(x=>x.relativePath===row.target);assert(expected?.originalCopy);assert.equal(row.sha256,expected.expectedSha256);assert.equal(row.bytes,expected.expectedBytes);assert.equal(row.generation,false);assert(row.sourceCopy);
    const input=realpathSync(resolve(root,row.path));assert(within(input,packageRoot),'original input escapes fixed package');const bytes=readFileSync(input);assert.equal(sha256(bytes),row.sha256);assert.equal(bytes.length,row.bytes);inputs.push({path:input,sha256:row.sha256});
    const target=resolve(out,row.target);assert(within(target,out));mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes,{flag:'wx'});
    results.push({path:row.target,status:'source-copy-exact',generation:false,sourceCopy:true,sourceKind:row.sourceKind,sourceId:row.sourceId,sha256:row.sha256,bytes:row.bytes});
  }catch(error){results.push({path:row.target,status:'source-copy-error',generation:false,error:String(error.message)});}}
  const inputFilesUnchanged=inputs.every(x=>sha256(readFileSync(x.path))===x.sha256);assert(inputFilesUnchanged,'original input changed');
  const report={mode:'source-copy',generation:false,archiveRecovery:false,originalSourceProofRequired:true,inputFilesUnchanged,results};writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}
