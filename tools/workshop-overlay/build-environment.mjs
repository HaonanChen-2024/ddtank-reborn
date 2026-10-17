// Filesystem guards for offline builds. No service, browser, database or install operations.
import assert from 'node:assert/strict';
import {existsSync,realpathSync,readdirSync,readFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const sourceSha256=bytes=>sha256(bytes.toString('utf8').replaceAll('\r\n','\n'));
export const within=(path,base)=>path===base||path.startsWith(base+sep);
export const slash=path=>path.replaceAll('\\','/');
export function projectRoot(here,explicit){
  // Installed location: <project>/source/ddtank-reborn/tools/workshop-overlay/.
  const repo=resolve(here,'../..'),root=realpathSync(resolve(explicit??resolve(repo,'../..')));
  assert(existsSync(join(root,'source/ddtank-reborn/package.json')),'--root must name the DDTank-Workshop project');
  return root;
}
function canonicalFuture(path){
  let parent=path;
  while(!existsSync(parent)){const next=dirname(parent);assert(next!==parent,'no existing output parent');parent=next;}
  return resolve(realpathSync(parent),relative(parent,path));
}
export function freshOutput(root,path,extraInputs=[]){
  assert(path,'--out=<new directory under project/runtime> required');
  const output=canonicalFuture(resolve(path)),runtime=realpathSync(join(root,'runtime'));
  assert(output!==runtime&&within(output,runtime),'output must be a new directory under project/runtime');
  const forbidden=['runtime/client-overlay','runtime/uploads','runtime/live',...extraInputs].map(p=>canonicalFuture(resolve(root,p)));
  assert(!forbidden.some(p=>within(output,p)),'output overlaps a protected input directory');
  assert(!existsSync(output),'output already exists; preserved');
  mkdirSync(output,{recursive:true});return output;
}
export function overlaySnapshot(root){
  const base=join(root,'runtime/client-overlay');
  if(!existsSync(base))return null;
  const rows=[];
  function walk(path){for(const entry of readdirSync(path,{withFileTypes:true})){
    const file=join(path,entry.name);
    if(entry.isDirectory())walk(file);
    else if(entry.isFile()){const bytes=readFileSync(file);rows.push({path:slash(relative(base,file)),sha256:sha256(bytes),bytes:bytes.length});}
    else assert(!entry.isSymbolicLink(),'overlay snapshot refuses symlinks');
  }}
  walk(base);return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
