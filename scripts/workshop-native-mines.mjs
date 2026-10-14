// Build-only original 70-cell Mines module. No deployment, browser, DB or remote actions.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync,constants} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {pinned,scan,sha,q} from './native-pair/build-library.mjs';
import {buildMinesLibrary} from './native-mines/build-library.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function buildNativeMines({outputDir,projectRoot=resolve(repo,'../..'),javaPath=resolve(homedir(),'.jdks/openjdk-22.0.1/bin/java.exe')}={}){
  assert(outputDir);const out=resolve(outputDir);assert(!existsSync(out),'preserve prior candidate: output must be new');
  const compiler=resolve(projectRoot,'runtime/tools/flex-min/lib/mxmlc.jar'),player=resolve(projectRoot,'downloads/flex/playerglobal32_0.swc');
  pinned(compiler,'cc07d749e376715e650271a9875289e49d94234902fff5e5fae287c478c8557b');pinned(player,'7d4d6168d27603cfb3b750302448e354e0bbc1bdd58f5d101c3dcf6891e9bb65');assert(existsSync(javaPath));
  const assetDir=resolve(out,'flash/workshop-native/mines');mkdirSync(assetDir,{recursive:true});mkdirSync(resolve(out,'build-logs'));
  const source=resolve(repo,'scripts/native-mines/WorkshopNativeMinesBootstrap.as'),sourceHash=sha(readFileSync(source)),bootstrap=resolve(assetDir,'WorkshopNativeMinesBootstrap.swf');
  const sourceCopy=resolve(out,'sources',basename(source));mkdirSync(dirname(sourceCopy));copyFileSync(source,sourceCopy,constants.COPYFILE_EXCL);
  const result=spawnSync(javaPath,['-jar',compiler,'-load-config=','-compiler.theme=','-compiler.fonts.local-fonts-snapshot=','-compiler.library-path=',`-compiler.external-library-path=${player}`,`-compiler.source-path=${dirname(source)}`,'-target-player=11.1','-swf-version=14','-debug=false','-static-link-runtime-shared-libraries=true',`-output=${bootstrap}`,source],{windowsHide:true,encoding:'utf8',timeout:60000});
  writeFileSync(resolve(out,'build-logs',basename(source)+'.log'),`${result.stdout??''}${result.stderr??''}`,{flag:'wx'});assert.equal(result.status,0,`compile failed: ${result.stderr??result.error}`);
  const parsed=scan(readFileSync(bootstrap));assert.equal(parsed.abcs.length,1);
  const required=['startNative','openNative','closeNative','statusNative','acceptSnapshot','rejectRequest','dispatch','fillByID','abortNative'];
  for(const name of required)assert(parsed.abcs[0].p.methodTraits.some(t=>q(parsed.abcs[0].p,t.name)==='::'+name),name);
  const callbacks=['workshopMinesAcceptSnapshot','workshopMinesRejectRequest','workshopMinesOpenNative','workshopMinesCloseNative','workshopMinesStatusNative'];
  for(const name of callbacks)assert(parsed.abcs[0].p.strings.includes(name),name);
  const library=buildMinesLibrary({projectRoot,out:assetDir});
  const A=resolve(projectRoot,'runtime/reference-activities-completion-20261014'),assets=[];
  const inputs=[
    ['boguadventure_v3_6_1_u1.swf','direct-modules/boguadventure_v3_6_1_u1.swf','306633351976c16780211629a510b931b9d822a0a656124da4911fbad3cc5204'],
    ['boguadventure_v3_6_1_u1.ui','direct-modules/boguadventure_v3_6_1_u1.ui','c9d136840ea8f9a96598ca925514b93436e4c73484bbb62d84ccc3feb7c55bae'],
    ['bogu-styles.xml','native-mines-resources-20261015/extracted/boguadventure.styles.xml','8bcd590e92be2f3d8557433c487c20410ab93d01274e9c649c639b2d580b8d8f'],
    ['bogu-player-game.png','native-mines-resources-20261015/bogu-player-game.png','cc07012615e8fe2c9b8cff59f07b2ed52d06acecba7508ee2d8ca067bedd1a94']
  ];
  for(const [file,input,hash] of inputs){const path=resolve(A,input),data=pinned(path,hash),target=resolve(assetDir,file);copyFileSync(path,target,constants.COPYFILE_EXCL);assets.push({file,bytes:data.length,sha256:hash,source:path,unchanged:true});}
  assert.equal(sha(readFileSync(source)),sourceHash);
  const manifest={version:1,module:'workshop-native-mines',createdAt:new Date().toISOString(),outputDir:out,source:{path:source,sha256:sourceHash,snapshotPath:sourceCopy},bootstrap:{file:basename(bootstrap),bytes:readFileSync(bootstrap).length,sha256:sha(readFileSync(bootstrap)),methods:required,callbacks},library,assets,
    originalWindow:true,grid:{columns:10,rows:7},layouts:4,styleDefinitions:36,sharedOwner:'workshop-native-activities; the sole 82-class loader',
    protocol:{legacy140Disabled:true,activityId:'mines-native',publicProjection:'nativeMines',freshEffects:'nativeMinesAction',uuidOwner:'page shared activity ledger',manualClaims:[1,2,3]},
    limitations:['Controlled container replaces only the old global StateView; original GameView/Map/Player/ChangeView and Morn views remain.','Compiled candidate only; original movement/explosion, first-open orders, cancellation and mail cycle have not been runtime accepted.','Original ranking has no local backend and is disabled.'],installed:false,runtimeValidated:false};
  writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const m=buildNativeMines({outputDir:process.argv[2]});console.log(JSON.stringify({outputDir:m.outputDir,bootstrap:m.bootstrap,abcCount:m.library.owners.length,assets:m.assets.length+2,installed:false,runtimeValidated:false},null,2));}
