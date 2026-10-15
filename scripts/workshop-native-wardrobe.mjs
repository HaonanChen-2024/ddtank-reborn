// Build-only original wardrobe module. No downloads, deployment, login or player/database writes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants,copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ByteReader,buildTag,decompressSwf,parseTags} from '../tools/i18n/abc-strings/lib.mjs';
import {parseActivityAbc} from '../tools/i18n/abc-strings/activity-response.mjs';
import {buildSharedLibraries} from './native-shared/build-library.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sourceDir=resolve(repo,'scripts/native-wardrobe');
const specPath=resolve(sourceDir,'source-spec.json');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const qtext=(p,i)=>{const n=p.names[i];return n?`${p.strings[p.namespaces[n.ns]?.name]??'*'}::${p.strings[n.name]??'*'}`:`#${i}`;};
function abcs(bytes){
  const swf=decompressSwf(bytes);assert.equal(swf.error,null);
  const tags=parseTags(swf.body);assert.equal(tags.trailing.length,0);
  return tags.tags.filter(t=>t.code===82).map(tag=>{
    const r=new ByteReader(swf.body.subarray(tag.bodyStart,tag.bodyEnd));
    const flags=r.u32(),name=r.cstring(),abc=r.bytes(r.buf.length-r.pos),p=parseActivityAbc(abc);
    return {name,flags,abc,p,classes:[...new Set(p.traitBlocks.filter(t=>t.owner!=null).map(t=>qtext(p,t.owner)))]};
  });
}
function verified(path,expected){const bytes=readFileSync(path);assert.equal(sha(bytes),expected,`source changed: ${path}`);return bytes;}
function requireMethods(abc,className,expected){
  assert(abc.classes.includes(`::${className}`));
  for(const [name,params,returnType] of expected){
    const traits=abc.p.methodTraits.filter(t=>qtext(abc.p,t.name)===`::${name}`);
    assert.equal(traits.length,1,`${className}.${name}`);
    const method=abc.p.methods[traits[0].method];
    assert.deepEqual(method.params.map(i=>qtext(abc.p,i)),params);
    assert.equal(qtext(abc.p,method.returnType),returnType);
  }
}

/** Compile only the common bridge; callers must verify all cached components before linking. */
export function buildNativeCommonBridge({outputDir,projectRoot=resolve(repo,'../..'),javaPath=resolve(homedir(),'.jdks/openjdk-22.0.1/bin/java.exe'),sharedLibraries}={}){
  assert(outputDir&&sharedLibraries);const out=resolve(outputDir);assert(!existsSync(out),'preserve previous bridge');mkdirSync(out,{recursive:true});
  const spec=JSON.parse(readFileSync(specPath,'utf8')),compiler=resolve(projectRoot,spec.compiler.path),playerGlobal=resolve(projectRoot,spec.playerGlobal.path);verified(compiler,spec.compiler.sha256);verified(playerGlobal,spec.playerGlobal.sha256);assert(existsSync(javaPath));
  const source=resolve(sourceDir,'WorkshopNativeWardrobeBridge.as'),sourceHash=sha(readFileSync(source)),sourceText=readFileSync(source,'utf8');assert.deepEqual(JSON.parse(sourceText.match(/SHARED_CLASSES:Array\s*=\s*(\[[^;]+\]);/)?.[1]??'null'),sharedLibraries.SharedClassNames);
  const path=resolve(out,'WorkshopNativeWardrobeBridge.swf'),args=['-jar',compiler,'-load-config=','-compiler.theme=','-compiler.fonts.local-fonts-snapshot=','-compiler.library-path=',`-compiler.external-library-path=${playerGlobal}`,'-target-player=11.1','-swf-version=14','-debug=false','-static-link-runtime-shared-libraries=true',`-output=${path}`,source],r=spawnSync(javaPath,args,{windowsHide:true,encoding:'utf8',timeout:60000});writeFileSync(resolve(out,'compile.log'),`${r.stdout??''}${r.stderr??''}`,{flag:'wx'});writeFileSync(resolve(out,'compile.process.json'),JSON.stringify({java:javaPath,args,status:r.status,signal:r.signal,error:r.error?String(r.error):null},null,2)+'\n',{flag:'wx'});assert.equal(r.status,0,r.stderr??r.error);
  const bytes=readFileSync(path),owners=abcs(bytes);assert.equal(owners.length,1);const a=owners[0];assert.deepEqual(a.classes,['::WorkshopNativeWardrobeBridge']);requireMethods(a,spec.bridgeClass,[['init',[],'::void'],...['Wardrobe','Pair','Mines','DDPlay','Gypsy','Moonlight','Treasure','Purr','Carnival','FirstRecharge','Charge','Forthright','Exchange','Devil','CaveLoot'].flatMap(name=>[['open'+name,name==='Wardrobe'?['::Number']:['::Number','::String'],'::Boolean'],['status'+name,[],'::Object'],['close'+name,[],'::void']])]);
  const callbacks={};for(const name of ['Wardrobe','Pair','Mines','DDPlay','Gypsy','Moonlight','Treasure','Purr','Carnival','FirstRecharge','Charge','Forthright','Exchange','Devil','CaveLoot'])for(const kind of ['open','status','close']){const key=kind+(name==='Wardrobe'?'':name),callback='workshop'+kind[0].toUpperCase()+kind.slice(1)+name;assert(a.p.strings.includes(callback));callbacks[key]=callback;}
  const flags=Buffer.alloc(4);flags.writeUInt32LE(1);const tag=buildTag(82,Buffer.concat([flags,Buffer.from(spec.bridgeOwner+'\0'),a.abc])),tagPath=resolve(out,'WorkshopNativeWardrobeBridge.doabc-tag.bin');writeFileSync(tagPath,tag,{flag:'wx'});assert.equal(sha(readFileSync(source)),sourceHash);
  return {owner:spec.bridgeOwner,class:spec.bridgeClass,tagCode:82,tagPath,tagBytes:tag.length,tagSha256:sha(tag),abcSha256:sha(a.abc),compiledSwf:path,compiledSwfSha256:sha(bytes),initialize:'WorkshopNativeWardrobeBridge.init():void',initializationEffect:'Register forty-five ExternalInterface callbacks only; no resource loading or window opening.',callbacks,report:'workshopWardrobe/Pair/Mines/DDPlay/Gypsy/Moonlight/Treasure/Purr/Carnival/FirstRecharge/Charge/Forthright/Exchange/Devil/CaveLootReport(status:Object)',insertBefore:'chickActivation/ChickActivationManager setup caller; keep all existing activity/sign callback registration',bridgeOnlyCompile:true,sourceSha256:sourceHash};
}

export function buildNativeWardrobe({outputDir,projectRoot=resolve(repo,'../..'),javaPath=resolve(homedir(),'.jdks/openjdk-22.0.1/bin/java.exe'),sharedLibraries}={}){
  assert(outputDir,'outputDir is required');
  const out=resolve(outputDir);assert(!existsSync(out),'output directory already exists; preserve prior artifacts');
  const spec=JSON.parse(readFileSync(specPath,'utf8'));
  const compiler=resolve(projectRoot,spec.compiler.path),playerGlobal=resolve(projectRoot,spec.playerGlobal.path);
  verified(compiler,spec.compiler.sha256);verified(playerGlobal,spec.playerGlobal.sha256);assert(existsSync(javaPath),'Java executable missing');
  const originalCore=resolve(projectRoot,spec.originalCore.path);verified(originalCore,spec.originalCore.sha256);
  const inputs=spec.assets.map(asset=>({...asset,path:resolve(projectRoot,asset.source),data:verified(resolve(projectRoot,asset.source),asset.sha256)}));
  const library=abcs(inputs.find(a=>a.file==='magicwardrobe-original-library.swf').data);
  assert.equal(library.length,92);
  for(const owner of ['morn/editor/core/IComponent','morn/editor/core/IBox','morn/editor/core/IClip','morn/editor/core/IContent'])assert(library.some(a=>a.name===owner));
  const sources=['WorkshopNativeWardrobeBootstrap','WorkshopNativeWardrobeBridge'].map(name=>({name,path:resolve(sourceDir,name+'.as')}));
  for(const source of sources){source.sha256=sha(readFileSync(source.path));assert(!/127\.0\.0\.1|nativeUserId|workshop_native_report|expectedUserId\s*:\s*40/.test(readFileSync(source.path,'utf8')),'test-only settings in production source');}
  const assetDir=resolve(out,'flash/workshop-native/wardrobe'),bridgeDir=resolve(out,'bridge'),logs=resolve(out,'build-logs');
  for(const dir of [assetDir,bridgeDir,logs])mkdirSync(dir,{recursive:true});
  const split=sharedLibraries??buildSharedLibraries({projectRoot,outputDir:resolve(out,'shared-split')});
  const moduleLibrary=split.files.find(f=>f.file==='magicwardrobe-module-library.swf');assert.equal(moduleLibrary.abcCount,10);
  const modulePath=resolve(split.outputDir,moduleLibrary.file);verified(modulePath,moduleLibrary.sha256);
  const moduleAbcs=abcs(readFileSync(modulePath));assert.equal(moduleAbcs.length,10);assert(moduleAbcs.every(a=>a.name.startsWith('magicWardrobe/')));
  const bridgeSource=readFileSync(sources.find(s=>s.name.endsWith('Bridge')).path,'utf8');
  const sharedNames=JSON.parse(bridgeSource.match(/SHARED_CLASSES:Array\s*=\s*(\[[^;]+\]);/)?.[1]??'null');assert.deepEqual(sharedNames,split.SharedClassNames,'bridge exact shared inventory');
  const compiled=[];
  for(const source of sources){
    const path=resolve(source.name.endsWith('Bridge')?bridgeDir:assetDir,source.name+'.swf');
    const result=spawnSync(javaPath,['-jar',compiler,'-load-config=','-compiler.theme=','-compiler.fonts.local-fonts-snapshot=','-compiler.library-path=',`-compiler.external-library-path=${playerGlobal}`,'-target-player=11.1','-swf-version=14','-debug=false','-static-link-runtime-shared-libraries=true',`-output=${path}`,source.path],{windowsHide:true,encoding:'utf8',timeout:60000});
    writeFileSync(resolve(logs,source.name+'.log'),`${result.stdout??''}${result.stderr??''}`,{flag:'wx'});
    assert.equal(result.status,0,`${source.name} compile failed: ${result.stderr??result.error??''}`);
    const bytes=readFileSync(path),owners=abcs(bytes);assert.equal(owners.length,1);
    compiled.push({name:source.name,path,bytes:bytes.length,sha256:sha(bytes),abcSha256:sha(owners[0].abc),abc:owners[0]});
  }
  const bootstrap=compiled.find(c=>c.name.endsWith('Bootstrap')),bridge=compiled.find(c=>c.name.endsWith('Bridge'));
  requireMethods(bootstrap.abc,'WorkshopNativeWardrobeBootstrap',[['startNative',['::Object'],'::void'],['openNative',[],'::Object'],['statusNative',[],'::Object'],['closeNative',[],'::Object'],['abortNative',['::String'],'::void']]);
  requireMethods(bridge.abc,spec.bridgeClass,[['init',[],'::void'],['openWardrobe',['::Number'],'::Boolean'],['statusWardrobe',[],'::Object'],['closeWardrobe',[],'::void'],['openPair',['::Number','::String'],'::Boolean'],['statusPair',[],'::Object'],['closePair',[],'::void'],['openMines',['::Number','::String'],'::Boolean'],['statusMines',[],'::Object'],['closeMines',[],'::void'],['openDDPlay',['::Number','::String'],'::Boolean'],['statusDDPlay',[],'::Object'],['closeDDPlay',[],'::void'],['openGypsy',['::Number','::String'],'::Boolean'],['statusGypsy',[],'::Object'],['closeGypsy',[],'::void'],['openMoonlight',['::Number','::String'],'::Boolean'],['statusMoonlight',[],'::Object'],['closeMoonlight',[],'::void'],['openTreasure',['::Number','::String'],'::Boolean'],['statusTreasure',[],'::Object'],['closeTreasure',[],'::void'],['openPurr',['::Number','::String'],'::Boolean'],['statusPurr',[],'::Object'],['closePurr',[],'::void'],['openCarnival',['::Number','::String'],'::Boolean'],['statusCarnival',[],'::Object'],['closeCarnival',[],'::void'],['openFirstRecharge',['::Number','::String'],'::Boolean'],['statusFirstRecharge',[],'::Object'],['closeFirstRecharge',[],'::void'],['openCharge',['::Number','::String'],'::Boolean'],['statusCharge',[],'::Object'],['closeCharge',[],'::void'],['openForthright',['::Number','::String'],'::Boolean'],['statusForthright',[],'::Object'],['closeForthright',[],'::void'],['openExchange',['::Number','::String'],'::Boolean'],['statusExchange',[],'::Object'],['closeExchange',[],'::void'],['openDevil',['::Number','::String'],'::Boolean'],['statusDevil',[],'::Object'],['closeDevil',[],'::void'],['openCaveLoot',['::Number','::String'],'::Boolean'],['statusCaveLoot',[],'::Object'],['closeCaveLoot',[],'::void']]);
  assert.deepEqual(bridge.abc.classes,['::WorkshopNativeWardrobeBridge']);
  for(const callback of ['workshopOpenWardrobe','workshopStatusWardrobe','workshopCloseWardrobe','workshopOpenPair','workshopStatusPair','workshopClosePair','workshopOpenMines','workshopStatusMines','workshopCloseMines','workshopOpenDDPlay','workshopStatusDDPlay','workshopCloseDDPlay','workshopOpenGypsy','workshopStatusGypsy','workshopCloseGypsy','workshopOpenMoonlight','workshopStatusMoonlight','workshopCloseMoonlight','workshopOpenTreasure','workshopStatusTreasure','workshopCloseTreasure','workshopOpenPurr','workshopStatusPurr','workshopClosePurr','workshopOpenCarnival','workshopStatusCarnival','workshopCloseCarnival','workshopOpenFirstRecharge','workshopStatusFirstRecharge','workshopCloseFirstRecharge','workshopOpenCharge','workshopStatusCharge','workshopCloseCharge','workshopOpenForthright','workshopStatusForthright','workshopCloseForthright','workshopOpenExchange','workshopStatusExchange','workshopCloseExchange','workshopOpenDevil','workshopStatusDevil','workshopCloseDevil','workshopOpenCaveLoot','workshopStatusCaveLoot','workshopCloseCaveLoot'])assert(bridge.abc.p.strings.includes(callback));
  const flags=Buffer.alloc(4);flags.writeUInt32LE(1);
  const bridgeTag=buildTag(82,Buffer.concat([flags,Buffer.from(spec.bridgeOwner+'\0'),bridge.abc.abc]));
  const bridgeTagPath=resolve(bridgeDir,'WorkshopNativeWardrobeBridge.doabc-tag.bin');writeFileSync(bridgeTagPath,bridgeTag,{flag:'wx'});
  const assets=inputs.map(input=>{
    const source=input.file==='magicwardrobe-original-library.swf'?modulePath:input.path;
    const data=readFileSync(source),hash=input.file==='magicwardrobe-original-library.swf'?moduleLibrary.sha256:input.sha256;
    const path=resolve(assetDir,input.file);copyFileSync(source,path,constants.COPYFILE_EXCL);assert.equal(sha(readFileSync(path)),hash);
    return {file:input.file,urlPath:spec.publicBasePath+input.file,path,bytes:data.length,sha256:hash,source};
  });
  assets.push({file:'WorkshopNativeWardrobeBootstrap.swf',urlPath:spec.publicBasePath+'WorkshopNativeWardrobeBootstrap.swf',path:bootstrap.path,bytes:bootstrap.bytes,sha256:bootstrap.sha256,abcSha256:bootstrap.abcSha256});
  for(const source of sources)assert.equal(sha(readFileSync(source.path)),source.sha256);
  for(const input of inputs)verified(input.path,input.sha256);
  const manifest={version:1,module:'workshop-native-wardrobe-component',requiresUnifiedManifest:true,builtAt:new Date().toISOString(),outputDir:out,sourceSpec:{path:specPath,sha256:sha(readFileSync(specPath))},sources,toolchain:{javaPath,compiler,compilerSha256:spec.compiler.sha256,playerGlobal,playerGlobalSha256:spec.playerGlobal.sha256},originalCore:spec.originalCore,assets,sharedSplitManifest:resolve(split.outputDir,'manifest.json'),
    bridge:{owner:spec.bridgeOwner,class:spec.bridgeClass,tagCode:82,tagPath:bridgeTagPath,tagBytes:bridgeTag.length,tagSha256:sha(bridgeTag),abcSha256:bridge.abcSha256,compiledSwf:bridge.path,compiledSwfSha256:bridge.sha256,initialize:'WorkshopNativeWardrobeBridge.init():void',initializationEffect:'Register forty-five ExternalInterface callbacks only; no resource loading or window opening.',callbacks:{open:'workshopOpenWardrobe(expectedCharacterId:Number):Boolean',status:'workshopStatusWardrobe():Object',close:'workshopCloseWardrobe():void',openPair:'workshopOpenPair(expectedCharacterId:Number,generation:String):Boolean',statusPair:'workshopStatusPair():Object',closePair:'workshopClosePair():void',openMines:'workshopOpenMines(expectedCharacterId:Number,generation:String):Boolean',statusMines:'workshopStatusMines():Object',closeMines:'workshopCloseMines():void',openDDPlay:'workshopOpenDDPlay(expectedCharacterId:Number,generation:String):Boolean',statusDDPlay:'workshopStatusDDPlay():Object',closeDDPlay:'workshopCloseDDPlay():void',openGypsy:'workshopOpenGypsy(expectedCharacterId:Number,generation:String):Boolean',statusGypsy:'workshopStatusGypsy():Object',closeGypsy:'workshopCloseGypsy():void',openMoonlight:'workshopOpenMoonlight(expectedCharacterId:Number,generation:String):Boolean',statusMoonlight:'workshopStatusMoonlight():Object',closeMoonlight:'workshopCloseMoonlight():void',openTreasure:'workshopOpenTreasure(expectedCharacterId:Number,generation:String):Boolean',statusTreasure:'workshopStatusTreasure():Object',closeTreasure:'workshopCloseTreasure():void',openPurr:'workshopOpenPurr(expectedCharacterId:Number,generation:String):Boolean',statusPurr:'workshopStatusPurr():Object',closePurr:'workshopClosePurr():void',openCarnival:'workshopOpenCarnival(expectedCharacterId:Number,generation:String):Boolean',statusCarnival:'workshopStatusCarnival():Object',closeCarnival:'workshopCloseCarnival():void',openFirstRecharge:'workshopOpenFirstRecharge(expectedCharacterId:Number,generation:String):Boolean',statusFirstRecharge:'workshopStatusFirstRecharge():Object',closeFirstRecharge:'workshopCloseFirstRecharge():void',openCharge:'workshopOpenCharge(expectedCharacterId:Number,generation:String):Boolean',statusCharge:'workshopStatusCharge():Object',closeCharge:'workshopCloseCharge():void',openForthright:'workshopOpenForthright(expectedCharacterId:Number,generation:String):Boolean',statusForthright:'workshopStatusForthright():Object',closeForthright:'workshopCloseForthright():void',openExchange:'workshopOpenExchange(expectedCharacterId:Number,generation:String):Boolean',statusExchange:'workshopStatusExchange():Object',closeExchange:'workshopCloseExchange():void',openDevil:'workshopOpenDevil(expectedCharacterId:Number,generation:String):Boolean',statusDevil:'workshopStatusDevil():Object',closeDevil:'workshopCloseDevil():void',openCaveLoot:'workshopOpenCaveLoot(expectedCharacterId:Number,generation:String):Boolean',statusCaveLoot:'workshopStatusCaveLoot():Object',closeCaveLoot:'workshopCloseCaveLoot():void'},report:'workshopWardrobeReport(status:Object); workshopPairReport(status:Object); workshopMinesReport(status:Object); workshopDDPlayReport(status:Object); workshopGypsyReport(status:Object); workshopMoonlightReport(status:Object); workshopTreasureReport(status:Object); workshopPurrReport(status:Object); workshopCarnivalReport(status:Object); workshopFirstRechargeReport(status:Object); workshopChargeReport(status:Object); workshopForthrightReport(status:Object); workshopExchangeReport(status:Object); workshopDevilReport(status:Object); workshopCaveLootReport(status:Object)',insertBefore:'chickActivation/ChickActivationManager setup caller; keep all existing activity/sign callback registration'},
    reproducibility:'Imported assets and compiled ABC payloads are hash-addressed. Flex ProductInfo includes build time, so outer compiled SWF bytes can differ between identical-source builds; no metadata rewrite is performed.',installed:false,browserValidated:false};
  writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [outputDir]=process.argv.slice(2);assert(outputDir,'usage: node scripts/workshop-native-wardrobe.mjs NEW_OUTPUT_DIRECTORY');
  const manifest=buildNativeWardrobe({outputDir});
  console.log(JSON.stringify({outputDir:manifest.outputDir,assets:manifest.assets.map(({file,bytes,sha256})=>({file,bytes,sha256})),bridge:manifest.bridge,installed:false},null,2));
}
