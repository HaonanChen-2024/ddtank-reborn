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
import {buildNativeMoonlight} from '../workshop-native-moonlight.mjs';
import {auditMoonlight} from '../native-moonlight/audit-candidate.mjs';
import {buildNativeTreasure} from '../workshop-native-treasure.mjs';
import {auditTreasure} from '../native-treasure/audit-candidate.mjs';
import {buildNativePurr} from '../workshop-native-purr.mjs';
import {auditPurr} from '../native-purr/audit-candidate.mjs';
import {prepareReuse,materializeReuse,isolatedReuseAudit} from './reuse-candidate.mjs';
import {scan,sha,q} from '../native-pair/build-library.mjs';
import {decode,auditCandidate} from '../native-pair/audit-candidate.mjs';

const SOURCE_FILES=['scripts/native-shared/build-activities.mjs','scripts/native-shared/build-library.mjs','scripts/workshop-native-wardrobe.mjs','scripts/workshop-native-pair.mjs','scripts/workshop-native-mines.mjs','scripts/native-wardrobe/WorkshopNativeWardrobeBridge.as','scripts/native-wardrobe/WorkshopNativeWardrobeBootstrap.as','scripts/native-pair/WorkshopNativePairBootstrap.as','scripts/native-pair/build-library.mjs','scripts/native-pair/build-shared-art.mjs','scripts/native-pair/audit-candidate.mjs','scripts/native-mines/WorkshopNativeMinesBootstrap.as','scripts/native-mines/build-library.mjs','scripts/native-mines/audit-candidate.mjs','scripts/workshop-native-ddplay.mjs','scripts/native-ddplay/WorkshopNativeDDPlayBootstrap.as','scripts/native-ddplay/build-library.mjs','scripts/native-ddplay/audit-candidate.mjs','scripts/native-ddplay/extract-resources.mjs','scripts/workshop-native-gypsy.mjs','scripts/native-gypsy/WorkshopNativeGypsyBootstrap.as','scripts/native-gypsy/build-library.mjs','scripts/native-gypsy/audit-candidate.mjs','scripts/native-gypsy/extract-resources.mjs','scripts/workshop-native-moonlight.mjs','scripts/native-moonlight/WorkshopNativeMoonlightBootstrap.as','scripts/native-moonlight/build-library.mjs','scripts/native-moonlight/audit-candidate.mjs','scripts/native-moonlight/extract-resources.mjs','scripts/workshop-native-treasure.mjs','scripts/native-treasure/WorkshopNativeTreasureBootstrap.as','scripts/native-treasure/build-library.mjs','scripts/native-treasure/audit-candidate.mjs','scripts/native-treasure/extract-resources.mjs','scripts/workshop-native-purr.mjs','scripts/native-purr/WorkshopNativePurrBootstrap.as','scripts/native-purr/build-library.mjs','scripts/native-purr/audit-candidate.mjs','scripts/native-purr/extract-resources.mjs','scripts/native-shared/reuse-candidate.mjs'];
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const read=p=>readFileSync(p);
function copyChecked(source,path,hash){const data=read(source);assert.equal(sha(data),hash);mkdirSync(dirname(path),{recursive:true});copyFileSync(source,path,constants.COPYFILE_EXCL);assert.equal(sha(read(path)),hash);return data.length;}
function method(a,name){const ts=a.p.methodTraits.filter(t=>a.p.strings[a.p.names[t.name]?.name]===name);assert.equal(ts.length,1,name);return a.p.bodies.find(b=>b.method===ts[0].method);}
function callNames(a,body){return decode(body.code).filter(o=>[0x46,0x4f,0x4a].includes(o.op)).map(o=>a.p.strings[a.p.names[o.args[0]]?.name]);}

export function buildNativeActivities({outputDir,projectRoot=resolve(repo,'../..'),javaPath,reuseFrom,reuseSha256,reuseLock,reuseLockSha256}={}){
  assert(outputDir);const out=resolve(outputDir);assert(!existsSync(out),'output directory exists; preserve prior candidates');assert([reuseFrom,reuseSha256,reuseLock,reuseLockSha256].every(Boolean)||[reuseFrom,reuseSha256,reuseLock,reuseLockSha256].every(v=>!v),'reuse manifest and lock require explicit paired SHA pins');const reusable=reuseFrom?prepareReuse({manifestPath:reuseFrom,expectedSha256:reuseSha256,lockPath:reuseLock,lockSha256:reuseLockSha256,repo,projectRoot,sourceFiles:SOURCE_FILES}):null;mkdirSync(out,{recursive:true});const reused=reusable?materializeReuse(reusable,out):null;
  const shared=reused?.shared??buildSharedLibraries({projectRoot,outputDir:resolve(out,'shared-split')});
  const wardrobe=reused?.wardrobe??buildNativeWardrobe({projectRoot,javaPath,outputDir:resolve(out,'wardrobe-component'),sharedLibraries:shared});
  const pair=reused?.pair??buildNativePair({projectRoot,javaPath,outputDir:resolve(out,'pair-component')});
  const pairAudit=reused?isolatedReuseAudit({kind:'pair',repo,out:pair.outputDir,projectRoot,sharedPath:resolve(shared.outputDir,'native-shared-library.swf')}):auditCandidate({projectRoot,outputDir:pair.outputDir});assert.deepEqual(pairAudit.missingHostClasses,[]);
  const mines=reused?.mines??buildNativeMines({projectRoot,javaPath,outputDir:resolve(out,'mines-component')});
  const common=shared.files.find(f=>f.file==='native-shared-library.swf');
  const minesAudit=reused?isolatedReuseAudit({kind:'mines',repo,out:mines.outputDir,projectRoot,sharedPath:resolve(shared.outputDir,'native-shared-library.swf')}):auditMines({projectRoot,outputDir:mines.outputDir,sharedPath:resolve(shared.outputDir,common.file)});assert.deepEqual(minesAudit.missingHostClasses,[]);
  const ddplay=reused?.ddplay??buildNativeDDPlay({projectRoot,javaPath,outputDir:resolve(out,'ddplay-component')});
  const ddplayAudit=reused?isolatedReuseAudit({kind:'ddplay',repo,out:ddplay.outputDir,projectRoot,sharedPath:resolve(shared.outputDir,'native-shared-library.swf')}):auditDDPlay({projectRoot,outputDir:ddplay.outputDir,sharedPath:resolve(shared.outputDir,common.file)});assert.deepEqual(ddplayAudit.missingHostClasses,[]);
  const gypsy=reused?.gypsy??buildNativeGypsy({projectRoot,javaPath,outputDir:resolve(out,'gypsy-component')});
  const gypsyAudit=reused?isolatedReuseAudit({kind:'gypsy',repo,out:gypsy.outputDir,projectRoot,sharedPath:resolve(shared.outputDir,'native-shared-library.swf')}):auditGypsy({projectRoot,outputDir:gypsy.outputDir,sharedPath:resolve(shared.outputDir,common.file)});assert.deepEqual(gypsyAudit.missingHostClasses,[]);
  const moonlight=reused?.moonlight??buildNativeMoonlight({projectRoot,javaPath,outputDir:resolve(out,'moonlight-component')});
  const moonlightAudit=reused?isolatedReuseAudit({kind:'moonlight',repo,out:moonlight.outputDir,projectRoot,sharedPath:resolve(shared.outputDir,'native-shared-library.swf')}):auditMoonlight({projectRoot,outputDir:moonlight.outputDir,sharedPath:resolve(shared.outputDir,common.file)});assert.deepEqual(moonlightAudit.missingHostClasses,[]);
  const treasure=reused?.treasure??buildNativeTreasure({projectRoot,javaPath,outputDir:resolve(out,'treasure-component')});
  const treasureAudit=reused?isolatedReuseAudit({kind:'treasure',repo,out:treasure.outputDir,projectRoot,sharedPath:resolve(shared.outputDir,'native-shared-library.swf')}):auditTreasure({projectRoot,outputDir:treasure.outputDir,sharedPath:resolve(shared.outputDir,common.file)});assert.deepEqual(treasureAudit.missingHostClasses,[]);
  const purr=reused?.purr??buildNativePurr({projectRoot,javaPath,outputDir:resolve(out,'purr-component')});
  const purrAudit=reused?isolatedReuseAudit({kind:'purr',repo,out:purr.outputDir,projectRoot,sharedPath:resolve(shared.outputDir,'native-shared-library.swf')}):auditPurr({projectRoot,outputDir:purr.outputDir,sharedPath:resolve(shared.outputDir,common.file)});assert.deepEqual(purrAudit.missingHostClasses,[]);
  const assets=[];
  const add=(source,urlPath,hash)=>{
    assert(/^\/flash\/workshop-native\/(shared|wardrobe|pair|mines|ddplay|gypsy|moonlight|treasure|purr)\/[A-Za-z0-9_.-]+$/.test(urlPath));assert(!assets.some(a=>a.urlPath===urlPath));
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
  const moonlightDir=resolve(moonlight.outputDir,'flash/workshop-native/moonlight');
  for(const a of [moonlight.bootstrap,moonlight.library,...moonlight.assets])add(resolve(moonlightDir,a.file),'/flash/workshop-native/moonlight/'+a.file,a.sha256);
  const treasureDir=resolve(treasure.outputDir,'flash/workshop-native/treasure');
  for(const a of [treasure.bootstrap,treasure.library,...treasure.assets])add(resolve(treasureDir,a.file),'/flash/workshop-native/treasure/'+a.file,a.sha256);
  const purrDir=resolve(purr.outputDir,'flash/workshop-native/purr');
  for(const a of [purr.bootstrap,purr.library,...purr.assets])add(resolve(purrDir,a.file),'/flash/workshop-native/purr/'+a.file,a.sha256);
  assert.equal(assets.length,45);assert(!assets.some(a=>a.file==='pair-shared-library.swf'));
  const sharedMap=new Map(common.owners.map(o=>[o.owner,o.abcSha256]));
  const duplicatedPairBuild=pair.libraries.find(l=>l.file==='pair-shared-library.swf');assert.equal(duplicatedPairBuild.owners.length,82);for(const owner of duplicatedPairBuild.owners)assert.equal(owner.abcSha256,sharedMap.get(owner.owner));
  const bridge={...wardrobe.bridge};
  bridge.tagPath=resolve(out,'bridge',basename(bridge.tagPath));copyChecked(wardrobe.bridge.tagPath,bridge.tagPath,bridge.tagSha256);
  bridge.compiledSwf=resolve(out,'bridge',basename(wardrobe.bridge.compiledSwf));copyChecked(wardrobe.bridge.compiledSwf,bridge.compiledSwf,bridge.compiledSwfSha256);
  const bridgeSwf=scan(read(bridge.compiledSwf));assert.equal(bridgeSwf.abcs.length,1);const bridgeAbc=bridgeSwf.abcs[0];
  assert.deepEqual([...new Set(bridgeAbc.p.traitBlocks.filter(t=>t.owner!=null).map(t=>q(bridgeAbc.p,t.owner)))],['::WorkshopNativeWardrobeBridge']);
  const initCalls=callNames(bridgeAbc,method(bridgeAbc,'init'));assert.equal(initCalls.filter(n=>n==='addCallback').length,24);assert(initCalls.every(n=>n==='addCallback'));
  const ensureCalls=callNames(bridgeAbc,method(bridgeAbc,'ensureShared'));assert.equal(ensureCalls.filter(n=>n==='Loader').length,1);
  for(const className of shared.SharedClassNames)assert(bridgeAbc.p.strings.includes(className),'compiled shared inventory '+className);
  const publicCallbacks=['workshopOpenWardrobe','workshopStatusWardrobe','workshopCloseWardrobe','workshopOpenPair','workshopStatusPair','workshopClosePair','workshopOpenMines','workshopStatusMines','workshopCloseMines','workshopOpenDDPlay','workshopStatusDDPlay','workshopCloseDDPlay','workshopOpenGypsy','workshopStatusGypsy','workshopCloseGypsy','workshopOpenMoonlight','workshopStatusMoonlight','workshopCloseMoonlight','workshopOpenTreasure','workshopStatusTreasure','workshopCloseTreasure','workshopOpenPurr','workshopStatusPurr','workshopClosePurr'];
  const pairCallbacks=['workshopPairAcceptSnapshot','workshopPairRejectRequest','workshopPairOpenNative','workshopPairCloseNative','workshopPairStatusNative'];
  const minesCallbacks=mines.bootstrap.callbacks;
  const pairBoot=scan(read(resolve(pairDir,pair.bootstrap.file))).abcs[0];for(const name of pairCallbacks)assert(pairBoot.p.strings.includes(name));assert.equal(new Set([...publicCallbacks,...pairCallbacks,...minesCallbacks,...ddplay.bootstrap.callbacks,...gypsy.bootstrap.callbacks,...moonlight.bootstrap.callbacks,...treasure.bootstrap.callbacks,...purr.bootstrap.callbacks]).size,59);
  for(const moduleName of ['wardrobe','pair','mines','ddplay','gypsy','moonlight','treasure','purr']){
    const file=assets.find(a=>a.urlPath.includes('/'+moduleName+'/WorkshopNative')&&a.file.endsWith('Bootstrap.swf'));
    const a=scan(read(file.path)).abcs[0];assert(a.p.strings.includes('sharedDomain'));assert(a.p.strings.includes('abortNative'));assert(!a.p.strings.includes('pair-shared-library.swf'));assert(!a.p.strings.includes('native-shared-library.swf'));
  }
  const wardrobeLib=assets.find(a=>a.file==='magicwardrobe-original-library.swf');assert.equal(scan(read(wardrobeLib.path)).abcs.length,10);
  const sourceFiles=SOURCE_FILES.map(file=>({file,path:resolve(repo,file),sha256:sha(read(resolve(repo,file)))}));
  const manifest={version:1,module:'workshop-native-activities',variant:'wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-purr',builtAt:new Date().toISOString(),outputDir:out,reuse:reusable?{manifestPath:reusable.manifestPath,manifestSha256:reusable.manifestSha256,lockPath:reusable.lockPath,lockSha256:reusable.lockSha256,sourcePinsVerified:reusable.sourcePinsVerified,assetPinsVerified:reusable.assetPinsVerified,compilerInputsVerified:reusable.compilerInputsVerified,componentManifestsVerified:reusable.componentManifestsVerified,linkSourcePinsVerified:reusable.linkSourcePinsVerified,componentManifestPins:Object.fromEntries(Object.entries(reusable.copies).map(([k,v])=>[k,v.manifestSha256])),sourceChanges:reusable.sourceChanges,newLinkHelper:{file:'scripts/native-shared/reuse-candidate.mjs',sha256:sha(read(resolve(repo,'scripts/native-shared/reuse-candidate.mjs')))},componentAudits:'seven actual audit processes exit0; fresh reports and process/stdout/stderr evidence',compiledPayloadsReused:true}:null,assets,bridge,sources:sourceFiles,
    components:{shared:resolve(shared.outputDir,'manifest.json'),wardrobe:resolve(wardrobe.outputDir,'manifest.json'),pair:resolve(pair.outputDir,'manifest.json'),mines:resolve(mines.outputDir,'manifest.json'),ddplay:resolve(ddplay.outputDir,'manifest.json'),gypsy:resolve(gypsy.outputDir,'manifest.json'),moonlight:resolve(moonlight.outputDir,'manifest.json'),treasure:resolve(treasure.outputDir,'manifest.json'),purr:resolve(purr.outputDir,'manifest.json')},
    verification:{sharedAbcCount:82,sharedClassCount:84,sharedPublicClassCount:82,wardrobeAbcCount:10,pairAbcCount:26,minesAbcCount:20,ddplayBusinessAbcCount:5,ddplayLibraryAbcCount:7,gypsyBusinessAbcCount:8,gypsyLibraryAbcCount:9,gypsyArtAbcCount:1,gypsyShiningFrames:40,gypsyShiningTags:85,moonlightBusinessAbcCount:23,moonlightEventAbcCount:1,moonlightLibraryAbcCount:25,moonlightArtAbcCount:1,moonlightMovieFrames:[128,128,128],treasureBusinessAndLayoutAbcCount:17,treasureLibraryAbcCount:17,treasureArtAbcCount:1,treasureGlintFrames:56,treasureSelectedStyleCount:22,purrBusinessAndLayoutAbcCount:19,purrLibraryAbcCount:19,purrArtAbcCount:1,purrEffectFrames:28,initCallbackCount:24,moduleCallbackCount:35,callbacksDisjoint:true,sharedLoaderConstructionSites:1,sharedImportSites:1,originalAbcSplitUnchanged:true,pairLegacyCalls:pairAudit.forbiddenCalls,pairDispatchCount:pairAudit.dispatchCount,minesLegacyCalls:minesAudit.forbiddenCalls,minesDispatchCount:minesAudit.dispatchCount,ddplayLegacyCalls:ddplayAudit.forbiddenCalls,ddplayDispatchCount:ddplayAudit.dispatchCount,gypsyLegacyCalls:gypsyAudit.forbiddenCalls,gypsyDispatchCount:gypsyAudit.dispatchCount,moonlightLegacyCalls:moonlightAudit.forbiddenCalls,moonlightDispatchCount:moonlightAudit.dispatchCount,treasureLegacyCalls:treasureAudit.forbiddenCalls,treasureDispatchCount:treasureAudit.dispatchCount,purrLegacyCalls:purrAudit.forbiddenCalls,purrDispatchCount:purrAudit.dispatchCount},
    contract:{sharedDomain:'current com.pickgliss.loader.DisplayLoader.Context.applicationDomain; same role, one owner, terminal failed state',pairOpen:'workshopOpenPair(characterId:Number,generation:String):Boolean',pairClose:'workshopClosePair():void; no generation change or UUID cancellation',hostBeforeOpen:true,wardrobeAbiPreserved:true},
    limitations:['Static/compiled checks do not prove AVM2/Ruffle runtime acceptance.','Wardrobe production paging Ruffle panic remains unresolved.','Pair-first, wardrobe-first, concurrent first-open, cancellation and UI/API mail cycle await runtime acceptance.'],installed:false,browserValidated:false,runtimeAccepted:false};
  writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert(process.argv.length===3||process.argv.length===11,'unknown build flags');if(process.argv.length===11){assert.equal(process.argv[3],'--reuse-from');assert.equal(process.argv[5],'--reuse-sha256');assert.equal(process.argv[7],'--reuse-lock');assert.equal(process.argv[9],'--reuse-lock-sha256');}const m=buildNativeActivities({outputDir:process.argv[2],reuseFrom:process.argv[4],reuseSha256:process.argv[6],reuseLock:process.argv[8],reuseLockSha256:process.argv[10]});console.log(JSON.stringify({outputDir:m.outputDir,module:m.module,assets:m.assets.length,bridge:m.bridge,verification:m.verification,installed:false,runtimeAccepted:false},null,2));}
