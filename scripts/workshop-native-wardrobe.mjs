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
  requireMethods(bridge.abc,spec.bridgeClass,[['init',[],'::void'],['openWardrobe',['::Number'],'::Boolean'],['statusWardrobe',[],'::Object'],['closeWardrobe',[],'::void'],['openPair',['::Number','::String'],'::Boolean'],['statusPair',[],'::Object'],['closePair',[],'::void'],['openMines',['::Number','::String'],'::Boolean'],['statusMines',[],'::Object'],['closeMines',[],'::void']]);
  assert.deepEqual(bridge.abc.classes,['::WorkshopNativeWardrobeBridge']);
  for(const callback of ['workshopOpenWardrobe','workshopStatusWardrobe','workshopCloseWardrobe','workshopOpenPair','workshopStatusPair','workshopClosePair','workshopOpenMines','workshopStatusMines','workshopCloseMines'])assert(bridge.abc.p.strings.includes(callback));
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
    bridge:{owner:spec.bridgeOwner,class:spec.bridgeClass,tagCode:82,tagPath:bridgeTagPath,tagBytes:bridgeTag.length,tagSha256:sha(bridgeTag),abcSha256:bridge.abcSha256,compiledSwf:bridge.path,compiledSwfSha256:bridge.sha256,initialize:'WorkshopNativeWardrobeBridge.init():void',initializationEffect:'Register nine ExternalInterface callbacks only; no resource loading or window opening.',callbacks:{open:'workshopOpenWardrobe(expectedCharacterId:Number):Boolean',status:'workshopStatusWardrobe():Object',close:'workshopCloseWardrobe():void',openPair:'workshopOpenPair(expectedCharacterId:Number,generation:String):Boolean',statusPair:'workshopStatusPair():Object',closePair:'workshopClosePair():void',openMines:'workshopOpenMines(expectedCharacterId:Number,generation:String):Boolean',statusMines:'workshopStatusMines():Object',closeMines:'workshopCloseMines():void'},report:'workshopWardrobeReport(status:Object); workshopPairReport(status:Object); workshopMinesReport(status:Object)',insertBefore:'chickActivation/ChickActivationManager setup caller; keep all existing activity/sign callback registration'},
    reproducibility:'Imported assets and compiled ABC payloads are hash-addressed. Flex ProductInfo includes build time, so outer compiled SWF bytes can differ between identical-source builds; no metadata rewrite is performed.',installed:false,browserValidated:false};
  writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [outputDir]=process.argv.slice(2);assert(outputDir,'usage: node scripts/workshop-native-wardrobe.mjs NEW_OUTPUT_DIRECTORY');
  const manifest=buildNativeWardrobe({outputDir});
  console.log(JSON.stringify({outputDir:manifest.outputDir,assets:manifest.assets.map(({file,bytes,sha256})=>({file,bytes,sha256})),bridge:manifest.bridge,installed:false},null,2));
}
