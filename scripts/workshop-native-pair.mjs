// Isolated build only. Never installs a core tag, starts services, opens a window, or calls an API.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync,constants} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {buildLibraries,pinned,scan,sha,q} from './native-pair/build-library.mjs';
import {buildSharedArt} from './native-pair/build-shared-art.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function buildNativePair({outputDir,projectRoot=resolve(repo,'../..'),javaPath=resolve(homedir(),'.jdks/openjdk-22.0.1/bin/java.exe')}={}){
  assert(outputDir);const out=resolve(outputDir);assert(!existsSync(out),'preserve prior candidate: output must be new');
  const compiler=resolve(projectRoot,'runtime/tools/flex-min/lib/mxmlc.jar'),player=resolve(projectRoot,'downloads/flex/playerglobal32_0.swc');
  pinned(compiler,'cc07d749e376715e650271a9875289e49d94234902fff5e5fae287c478c8557b');pinned(player,'7d4d6168d27603cfb3b750302448e354e0bbc1bdd58f5d101c3dcf6891e9bb65');assert(existsSync(javaPath));
  const assetDir=resolve(out,'flash/workshop-native/pair');mkdirSync(assetDir,{recursive:true});mkdirSync(resolve(out,'build-logs'));
  const compile=(source,path,sourcePath=dirname(source))=>{
    const result=spawnSync(javaPath,['-jar',compiler,'-load-config=','-compiler.theme=','-compiler.fonts.local-fonts-snapshot=','-compiler.library-path=',`-compiler.external-library-path=${player}`,`-compiler.source-path=${sourcePath}`,'-target-player=11.1','-swf-version=14','-debug=false','-static-link-runtime-shared-libraries=true',`-output=${path}`,source],{windowsHide:true,encoding:'utf8',timeout:60000});
    writeFileSync(resolve(out,'build-logs',basename(source)+'.log'),`${result.stdout??''}${result.stderr??''}`,{flag:'wx'});assert.equal(result.status,0,`compile failed ${source}: ${result.stderr??result.error}`);
  };
  const source=resolve(repo,'scripts/native-pair/WorkshopNativePairBootstrap.as'),sourceHash=sha(readFileSync(source));
  const bootstrap=resolve(assetDir,'WorkshopNativePairBootstrap.swf');compile(source,bootstrap);
  const parsed=scan(readFileSync(bootstrap));assert.equal(parsed.abcs.length,1);
  const required=['startNative','openNative','closeNative','statusNative','acceptSnapshot','rejectRequest','dispatch'];
  for(const name of required)assert(parsed.abcs[0].p.methodTraits.some(t=>q(parsed.abcs[0].p,t.name)==='::'+name));
  const libraries=buildLibraries({projectRoot,out:assetDir});
  const art=buildSharedArt({projectRoot,out:assetDir,compile});
  const A=resolve(projectRoot,'runtime/reference-activities-completion-20261014'),assets=[];
  for(const [file,hash] of [['pairbox_v3_6_1_u1.swf','5878679871121815b6c036946418fd4bb06c74d5c06e50ccb90e574eda2aa0db'],['pairbox_v3_6_1_u1.ui','9a937f98a73541fde5c7f6bcafa5faa9a166298ce89dcdfa518b4fe5856ee27c']]){const input=resolve(A,'direct-modules',file),bytes=pinned(input,hash);copyFileSync(input,resolve(assetDir,file),constants.COPYFILE_EXCL);assets.push({file,bytes:bytes.length,sha256:hash,source:input,unchanged:true});}
  assert.equal(sha(readFileSync(source)),sourceHash);
  const untouched=libraries[1].owners.filter(o=>!o.changes.length).map(o=>o.owner);
  for(const owner of ['pairBox/item/PairBoxCardItem','pairBox/PairBoxModel'])assert(untouched.includes(owner));
  const manifest={version:1,module:'workshop-native-pair',createdAt:new Date().toISOString(),outputDir:out,source:{path:source,sha256:sourceHash},bootstrap:{file:basename(bootstrap),bytes:readFileSync(bootstrap).length,sha256:sha(readFileSync(bootstrap)),methods:required},libraries,art,assets,
    contract:'scripts/native-pair/README.md',status:'compiled isolated candidate; not integrated or runtime accepted',originalWindow:true,grid:{columns:8,rows:4},originalCardAnimationAbcUnchanged:true,
    integration:{hostCallbacksMissing:true,officialCoreUnchanged:true,requiresCurrentRoleAndPageUuidLedger:true},installed:false,runtimeValidated:false};
  writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const manifest=buildNativePair({outputDir:process.argv[2]});console.log(JSON.stringify({outputDir:manifest.outputDir,owners:manifest.libraries.map(x=>({file:x.file,count:x.owners.length,patched:x.owners.filter(o=>o.changes.length).length})),bootstrap:manifest.bootstrap,status:manifest.status,installed:false},null,2));}
