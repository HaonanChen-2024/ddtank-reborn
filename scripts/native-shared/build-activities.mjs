import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,copyFileSync,writeFileSync,constants} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSharedLibraries} from './build-library.mjs';
import {buildNativeWardrobe} from '../workshop-native-wardrobe.mjs';
import {buildNativePair} from '../workshop-native-pair.mjs';
import {buildNativeMines} from '../workshop-native-mines.mjs';
import {auditMines} from '../native-mines/audit-candidate.mjs';
import {buildNativeDDPlay} from '../workshop-native-ddplay.mjs';
import {auditDDPlay} from '../native-ddplay/audit-candidate.mjs';
import {buildNativeGypsy} from '../workshop-native-gypsy.mjs';
import {auditGypsy} from '../native-gypsy/audit-candidate.mjs';
import {scan,sha,q} from '../native-pair/build-library.mjs';
import {decode,auditCandidate} from '../native-pair/audit-candidate.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const read=p=>readFileSync(p);
function copyChecked(source,path,hash){const data=read(source);assert.equal(sha(data),hash);mkdirSync(dirname(path),{recursive:true});copyFileSync(source,path,constants.COPYFILE_EXCL);assert.equal(sha(read(path)),hash);return data.length;}
function method(a,name){const ts=a.p.methodTraits.filter(t=>a.p.strings[a.p.names[t.name]?.name]===name);assert.equal(ts.length,1,name);return a.p.bodies.find(b=>b.method===ts[0].method);}
function callNames(a,body){return decode(body.code).filter(o=>[0x46,0x4f,0x4a].includes(o.op)).map(o=>a.p.strings[a.p.names[o.args[0]]?.name]);}

export function buildNativeActivities({outputDir,projectRoot=resolve(repo,'../..'),javaPath}={}){
  assert(outputDir);const out=resolve(outputDir);assert(!existsSync(out),'output directory exists; preserve prior candidates');mkdirSync(out,{recursive:true});
  const shared=buildSharedLibraries({projectRoot,outputDir:resolve(out,'shared-split')});
  const wardrobe=buildNativeWardrobe({projectRoot,javaPath,outputDir:resolve(out,'wardrobe-component'),sharedLibraries:shared});
  const pair=buildNativePair({projectRoot,javaPath,outputDir:resolve(out,'pair-component')});
  const pairAudit=auditCandidate({projectRoot,outputDir:pair.outputDir});assert.deepEqual(pairAudit.missingHostClasses,[]);
  const mines=buildNativeMines({projectRoot,javaPath,outputDir:resolve(out,'mines-component')});
  const common=shared.files.find(f=>f.file==='native-shared-library.swf');
  const minesAudit=auditMines({projectRoot,outputDir:mines.outputDir,sharedPath:resolve(shared.outputDir,common.file)});assert.deepEqual(minesAudit.missingHostClasses,[]);
  const ddplay=buildNativeDDPlay({projectRoot,javaPath,outputDir:resolve(out,'ddplay-component')});
  const ddplayAudit=auditDDPlay({projectRoot,outputDir:ddplay.outputDir,sharedPath:resolve(shared.outputDir,common.file)});assert.deepEqual(ddplayAudit.missingHostClasses,[]);
  const gypsy=buildNativeGypsy({projectRoot,javaPath,outputDir:resolve(out,'gypsy-component')});
  const gypsyAudit=auditGypsy({projectRoot,outputDir:gypsy.outputDir,sharedPath:resolve(shared.outputDir,common.file)});assert.deepEqual(gypsyAudit.missingHostClasses,[]);
  const assets=[];
  const add=(source,urlPath,hash)=>{
    assert(/^\/flash\/workshop-native\/(shared|wardrobe|pair|mines|ddplay|gypsy)\/[A-Za-z0-9_.-]+$/.test(urlPath));assert(!assets.some(a=>a.urlPath===urlPath));
    const path=resolve(out,urlPath.slice(1)),bytes=copyChecked(source,path,hash);assets.push({file:basename(path),path,urlPath,bytes,sha256:hash,source});
  };
  for(const a of wardrobe.assets)add(a.path,a.urlPath,a.sha256);
  add(resolve(shared.outputDir,common.file),'/flash/workshop-native/shared/'+common.file,common.sha256);
  const pairDir=resolve(pair.outputDir,'flash/workshop-native/pair');
  for(const a of [pair.bootstrap,pair.libraries.find(l=>l.file==='pair-original-library.swf'),...pair.assets,...pair.art.files])add(resolve(pairDir,a.file),'/flash/workshop-native/pair/'+a.file,a.sha256);
  const minesDir=resolve(mines.outputDir,'flash/workshop-native/mines');
  for(const a of [mines.bootstrap,mines.library,...mines.assets])add(resolve(minesDir,a.file),'/flash/workshop-native/mines/'+a.file,a.sha256);
  const ddplayDir=resolve(ddplay.outputDir,'flash/workshop-native/ddplay');
  for(const a of [ddplay.bootstrap,ddplay.library,...ddplay.assets])add(resolve(ddplayDir,a.file),'/flash/workshop-native/ddplay/'+a.file,a.sha256);
  const gypsyDir=resolve(gypsy.outputDir,'flash/workshop-native/gypsy');
  for(const a of [gypsy.bootstrap,gypsy.library,...gypsy.assets])add(resolve(gypsyDir,a.file),'/flash/workshop-native/gypsy/'+a.file,a.sha256);
  assert.equal(assets.length,32);assert(!assets.some(a=>a.file==='pair-shared-library.swf'));
  const sharedMap=new Map(common.owners.map(o=>[o.owner,o.abcSha256]));
  const duplicatedPairBuild=pair.libraries.find(l=>l.file==='pair-shared-library.swf');assert.equal(duplicatedPairBuild.owners.length,82);for(const owner of duplicatedPairBuild.owners)assert.equal(owner.abcSha256,sharedMap.get(owner.owner));
  const bridge={...wardrobe.bridge};
  bridge.tagPath=resolve(out,'bridge',basename(bridge.tagPath));copyChecked(wardrobe.bridge.tagPath,bridge.tagPath,bridge.tagSha256);
  bridge.compiledSwf=resolve(out,'bridge',basename(wardrobe.bridge.compiledSwf));copyChecked(wardrobe.bridge.compiledSwf,bridge.compiledSwf,bridge.compiledSwfSha256);
  const bridgeSwf=scan(read(bridge.compiledSwf));assert.equal(bridgeSwf.abcs.length,1);const bridgeAbc=bridgeSwf.abcs[0];
  assert.deepEqual([...new Set(bridgeAbc.p.traitBlocks.filter(t=>t.owner!=null).map(t=>q(bridgeAbc.p,t.owner)))],['::WorkshopNativeWardrobeBridge']);
  const initCalls=callNames(bridgeAbc,method(bridgeAbc,'init'));assert.equal(initCalls.filter(n=>n==='addCallback').length,15);assert(initCalls.every(n=>n==='addCallback'));
  const ensureCalls=callNames(bridgeAbc,method(bridgeAbc,'ensureShared'));assert.equal(ensureCalls.filter(n=>n==='Loader').length,1);
  for(const className of shared.SharedClassNames)assert(bridgeAbc.p.strings.includes(className),'compiled shared inventory '+className);
  const publicCallbacks=['workshopOpenWardrobe','workshopStatusWardrobe','workshopCloseWardrobe','workshopOpenPair','workshopStatusPair','workshopClosePair','workshopOpenMines','workshopStatusMines','workshopCloseMines','workshopOpenDDPlay','workshopStatusDDPlay','workshopCloseDDPlay','workshopOpenGypsy','workshopStatusGypsy','workshopCloseGypsy'];
  const pairCallbacks=['workshopPairAcceptSnapshot','workshopPairRejectRequest','workshopPairOpenNative','workshopPairCloseNative','workshopPairStatusNative'];
  const minesCallbacks=mines.bootstrap.callbacks;
  const pairBoot=scan(read(resolve(pairDir,pair.bootstrap.file))).abcs[0];for(const name of pairCallbacks)assert(pairBoot.p.strings.includes(name));assert.equal(new Set([...publicCallbacks,...pairCallbacks,...minesCallbacks,...ddplay.bootstrap.callbacks,...gypsy.bootstrap.callbacks]).size,35);
  for(const moduleName of ['wardrobe','pair','mines','ddplay','gypsy']){
    const file=assets.find(a=>a.urlPath.includes('/'+moduleName+'/WorkshopNative')&&a.file.endsWith('Bootstrap.swf'));
    const a=scan(read(file.path)).abcs[0];assert(a.p.strings.includes('sharedDomain'));assert(a.p.strings.includes('abortNative'));assert(!a.p.strings.includes('pair-shared-library.swf'));assert(!a.p.strings.includes('native-shared-library.swf'));
  }
  const wardrobeLib=assets.find(a=>a.file==='magicwardrobe-original-library.swf');assert.equal(scan(read(wardrobeLib.path)).abcs.length,10);
  const sourceFiles=['scripts/native-shared/build-activities.mjs','scripts/native-shared/build-library.mjs','scripts/workshop-native-wardrobe.mjs','scripts/workshop-native-pair.mjs','scripts/workshop-native-mines.mjs','scripts/native-wardrobe/WorkshopNativeWardrobeBridge.as','scripts/native-wardrobe/WorkshopNativeWardrobeBootstrap.as','scripts/native-pair/WorkshopNativePairBootstrap.as','scripts/native-pair/build-library.mjs','scripts/native-pair/build-shared-art.mjs','scripts/native-pair/audit-candidate.mjs','scripts/native-mines/WorkshopNativeMinesBootstrap.as','scripts/native-mines/build-library.mjs','scripts/native-mines/audit-candidate.mjs','scripts/workshop-native-ddplay.mjs','scripts/native-ddplay/WorkshopNativeDDPlayBootstrap.as','scripts/native-ddplay/build-library.mjs','scripts/native-ddplay/audit-candidate.mjs','scripts/native-ddplay/extract-resources.mjs','scripts/workshop-native-gypsy.mjs','scripts/native-gypsy/WorkshopNativeGypsyBootstrap.as','scripts/native-gypsy/build-library.mjs','scripts/native-gypsy/audit-candidate.mjs','scripts/native-gypsy/extract-resources.mjs'].map(file=>({file,path:resolve(repo,file),sha256:sha(read(resolve(repo,file)))}));
  const manifest={version:1,module:'workshop-native-activities',variant:'wardrobe-pair-mines-ddplay-gypsy',builtAt:new Date().toISOString(),outputDir:out,assets,bridge,sources:sourceFiles,
    components:{shared:resolve(shared.outputDir,'manifest.json'),wardrobe:resolve(wardrobe.outputDir,'manifest.json'),pair:resolve(pair.outputDir,'manifest.json'),mines:resolve(mines.outputDir,'manifest.json'),ddplay:resolve(ddplay.outputDir,'manifest.json'),gypsy:resolve(gypsy.outputDir,'manifest.json')},
    verification:{sharedAbcCount:82,sharedClassCount:84,sharedPublicClassCount:82,wardrobeAbcCount:10,pairAbcCount:26,minesAbcCount:20,ddplayBusinessAbcCount:5,ddplayLibraryAbcCount:7,gypsyBusinessAbcCount:8,gypsyLibraryAbcCount:9,gypsyArtAbcCount:1,gypsyShiningFrames:40,gypsyShiningTags:85,initCallbackCount:15,moduleCallbackCount:20,callbacksDisjoint:true,sharedLoaderConstructionSites:1,sharedImportSites:1,originalAbcSplitUnchanged:true,pairLegacyCalls:pairAudit.forbiddenCalls,pairDispatchCount:pairAudit.dispatchCount,minesLegacyCalls:minesAudit.forbiddenCalls,minesDispatchCount:minesAudit.dispatchCount,ddplayLegacyCalls:ddplayAudit.forbiddenCalls,ddplayDispatchCount:ddplayAudit.dispatchCount,gypsyLegacyCalls:gypsyAudit.forbiddenCalls,gypsyDispatchCount:gypsyAudit.dispatchCount},
    contract:{sharedDomain:'current com.pickgliss.loader.DisplayLoader.Context.applicationDomain; same role, one owner, terminal failed state',pairOpen:'workshopOpenPair(characterId:Number,generation:String):Boolean',pairClose:'workshopClosePair():void; no generation change or UUID cancellation',hostBeforeOpen:true,wardrobeAbiPreserved:true},
    limitations:['Static/compiled checks do not prove AVM2/Ruffle runtime acceptance.','Wardrobe production paging Ruffle panic remains unresolved.','Pair-first, wardrobe-first, concurrent first-open, cancellation and UI/API mail cycle await runtime acceptance.'],installed:false,browserValidated:false,runtimeAccepted:false};
  writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const m=buildNativeActivities({outputDir:process.argv[2]});console.log(JSON.stringify({outputDir:m.outputDir,module:m.module,assets:m.assets.length,bridge:m.bridge,verification:m.verification,installed:false,runtimeAccepted:false},null,2));}
