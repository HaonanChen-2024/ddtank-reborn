import assert from 'node:assert/strict';
import {spawnSync as spawnChild} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,resolve} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

// Extract the actual owner, without importing unrelated SWF builders into this test.
const source=readFileSync(new URL('./build-activities.mjs',import.meta.url),'utf8');
const ast=ts.createSourceFile('build-activities.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const functionSource=name=>{const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert(node,name);return node.getText(ast).replace(/^export /,'');};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const exchangeSourceFiles=['scripts/workshop-native-exchange.mjs','scripts/native-exchange/WorkshopNativeExchangeBootstrap.as','scripts/native-exchange/build-library.mjs','scripts/native-exchange/audit-candidate.mjs','scripts/native-exchange/extract-resources.mjs'];

test('aggregate accepts the installed menu art while retaining URL, duplicate and copy hash gates',()=>{
  const owner=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='buildNativeActivities');
  let add;
  const visit=node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='add')add=node.initializer;ts.forEachChild(node,visit);};
  visit(owner);assert(add&&ts.isArrowFunction(add));
  const out=resolve(tmpdir(),'ddt-native-add-owner'),assets=[],copies=[];
  const context={assert,assets,out,resolve,basename,christmasSceneUrls:['/resource/scene/christmas/test.swf'],
    copyChecked:(source,path,hash)=>{assert.equal(hash,'verified-source-sha');copies.push({source,path,hash});return 123;}};
  const run=runInNewContext('('+add.getText(ast)+')',context);
  const menu='/flash/workshop-native/menu/hall-activity-original-art.swf';
  run('original-menu.swf',menu,'verified-source-sha');
  assert.equal(assets.length,1);assert.equal(assets[0].urlPath,menu);
  assert.equal(assets[0].path,resolve(out,menu.slice(1)));assert.equal(assets[0].bytes,123);
  assert.throws(()=>run('original-menu.swf',menu,'verified-source-sha'));
  for(const url of ['/flash/workshop-native/menu/unknown.swf','/flash/workshop-native/menu/../outside.swf','/flash/workshop-native/menu/../../outside.swf','/flash/workshop-native/menu/hall-activity-original-art.swf?x=1','https://example.com/menu.swf'])assert.throws(()=>run('bad.swf',url,'verified-source-sha'));
  assert.equal(copies.length,1,'rejected URLs do not copy files');
  assert.throws(()=>run('scene.swf',context.christmasSceneUrls[0],'bad-sha'));
  assert.equal(assets.length,1,'failed copy must not enter manifest');
  run('scene.swf',context.christmasSceneUrls[0],'verified-source-sha');
  assert.equal(assets.length,2,'existing scene exception remains available');
});

function fixture(t,mode='success',afterChild){
  const root=mkdtempSync(resolve(tmpdir(),'ddt-exchange-isolation-'));
  t.after(()=>{assert(root.startsWith(resolve(tmpdir(),'ddt-exchange-isolation-')));assert(root!==resolve(tmpdir()));rmSync(root,{recursive:true,force:true});});
  const repo=resolve(root,'repo'),outputDir=resolve(root,'candidate/exchange-component');
  for(const file of exchangeSourceFiles){const p=resolve(repo,file);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,'// current '+file+'\n');}
  writeFileSync(resolve(repo,exchangeSourceFiles[0]),`
    import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    import {resolve,dirname,basename} from 'node:path';
    const mode=${JSON.stringify(mode)};
    export function buildNativeExchange({outputDir}){
      if(mode==='nonzero')process.exit(7);
      if(mode==='missing-manifest')return {};
      const path=resolve(${JSON.stringify(repo)},'scripts/native-exchange/WorkshopNativeExchangeBootstrap.as');
      const bytes=readFileSync(path),snapshotPath=resolve(outputDir,'sources',basename(path));
      mkdirSync(dirname(snapshotPath),{recursive:true});
      writeFileSync(snapshotPath,mode==='bad-snapshot'?'different AS':bytes);
      const m={module:mode==='wrong-module'?'wrong':'workshop-native-exchange',outputDir,
        source:{path,sha256:createHash('sha256').update(bytes).digest('hex'),snapshotPath}};
      if(mode==='wrong-output')m.outputDir=resolve(outputDir,'other');
      writeFileSync(resolve(outputDir,'manifest.json'),JSON.stringify(m));
      if(mode==='source-drift')writeFileSync(path,'changed while building');
      return m;
    }
  `);
  let child;
  const spawnSync=(exe,args,options)=>{child={exe,args,options,result:spawnChild(exe,args,options)};afterChild?.({repo,outputDir,result:child.result});return child.result;};
  const context={assert,repo,resolve,dirname,basename,pathToFileURL,sha,read:readFileSync,mkdirSync,writeFileSync,spawnSync,process};
  runInNewContext('const exchangeSourceFiles='+JSON.stringify(exchangeSourceFiles)+';'+functionSource('isolatedExchangeBuild'),context);
  return {repo,outputDir,run:()=>context.isolatedExchangeBuild({projectRoot:root,javaPath:'test-java',outputDir}),child:()=>child,
    evidence:()=>JSON.parse(readFileSync(resolve(root,'candidate/fresh-build-logs/exchange.process.json')))};
}

test('fresh Exchange build runs in a separate process and pins its current manifest/source snapshot',t=>{
  const f=fixture(t),m=f.run(),child=f.child(),e=f.evidence();
  assert.equal(m.module,'workshop-native-exchange');assert.equal(m.compileSourcePins.length,5);
  for(const pin of m.compileSourcePins)assert.equal(pin.sha256,sha(readFileSync(pin.path)));
  assert.equal(child.exe,process.execPath);assert.equal(child.options.cwd,f.repo);assert.equal(child.options.windowsHide,true);
  assert.equal(child.options.timeout,180000);assert.deepEqual(Array.from(child.args.slice(0,4)),['--jitless','--max-old-space-size=8192','--input-type=module','-e']);
  assert.equal(e.status,0);assert.equal(e.signal,null);assert.equal(e.error,null);
  assert.equal(readFileSync(resolve(f.outputDir,'sources/WorkshopNativeExchangeBootstrap.as'),'utf8'),readFileSync(resolve(f.repo,exchangeSourceFiles[1]),'utf8'));
});

for(const [mode,error] of [['nonzero',/Exchange actual build exit/],['missing-manifest',/Exchange actual build exit/],['source-drift',/Exchange actual build exit/],['wrong-module',/workshop-native-exchange/],['wrong-output',/strictly equal/],['bad-snapshot',/Exchange compiled source snapshot/]]){
  test('isolated Exchange rejects '+mode+' without fallback',t=>{
    const f=fixture(t,mode);assert.throws(f.run,error);assert(existsSync(resolve(dirname(f.outputDir),'fresh-build-logs/exchange.process.json')));
    if(mode==='missing-manifest')assert(!existsSync(resolve(f.outputDir,'manifest.json')));
    if(mode==='source-drift')assert.match(f.child().result.stderr,/Exchange source changed during build/);
    if(mode==='nonzero')assert.equal(f.evidence().status,7);
  });
}

test('parent rejects a manifest changed after the successful child result',t=>{
  const f=fixture(t,'success',({outputDir})=>writeFileSync(resolve(outputDir,'manifest.json'),'{}'));
  assert.throws(f.run,/Exchange child manifest hash/);assert.equal(f.evidence().status,0);
});

test('parent rejects source drift after the successful child result',t=>{
  const f=fixture(t,'success',({repo})=>writeFileSync(resolve(repo,exchangeSourceFiles[4]),'drift after child'));
  assert.throws(f.run,/Exchange source changed after build/);assert.equal(f.evidence().status,0);
});

for(const reused of [false,true])test((reused?'reused':'fresh')+' aggregate requires the actual isolated Exchange audit',()=>{
  const stop=new Error('exchange audit reached'),out=resolve(tmpdir(),'ddt-exchange-route-only'),calls=[];
  const modules=['pair','mines','ddplay','gypsy','moonlight','treasure','purr','carnival','first-recharge','charge','forthright','exchange'];
  const components=Object.fromEntries(modules.map(key=>[key,{outputDir:resolve(out,key+'-component')}]));
  components.shared={outputDir:resolve(out,'shared-split'),files:[{file:'native-shared-library.swf'}]};
  components.wardrobe={outputDir:resolve(out,'wardrobe-component'),sources:[{name:'WorkshopNativeWardrobeBridge'}]};
  const context={assert,resolve,existsSync:()=>false,mkdirSync:()=>{},writeFileSync:()=>{},repo:'repo',SOURCE_FILES:[],
    prepareReuse:()=>({transition:{addedAssetCount:16,to:'wardrobe-pair-mines-ddplay-gypsy-moonlight-treasure-purr-carnival-first-recharge-charge-forthright-exchange-devil-caveloot-christmas'}}),materializeReuse:()=>components,
    buildSharedLibraries:()=>components.shared,buildNativeWardrobe:()=>components.wardrobe,buildNativeCommonBridge:()=>({sourceSha256:'current'}),
    isolatedExchangeBuild:options=>{calls.push(['build',options]);return components.exchange;},
    isolatedReuseAudit:options=>{if(options.kind==='exchange'){calls.push(['audit',options]);throw stop;}return {missingHostClasses:runInNewContext('[]',context)};},
    auditCandidate:()=>({missingHostClasses:runInNewContext('[]',context)})};
  for(const key of modules.filter(k=>k!=='exchange')){const name=key==='ddplay'?'DDPlay':key==='gypsy'?'Gypsy':key==='first-recharge'?'FirstRecharge':key[0].toUpperCase()+key.slice(1);context['buildNative'+name]=()=>components[key];context['audit'+name]=()=>({missingHostClasses:runInNewContext('[]',context)});}
  context.buildNativePair=()=>components.pair;
  runInNewContext(functionSource('buildNativeActivities'),context);
  assert.throws(()=>context.buildNativeActivities({outputDir:out,...(reused?{reuseFrom:'manifest',reuseSha256:'sha',reuseLock:'lock',reuseLockSha256:'sha'}:{})}),e=>e===stop);
  assert.deepEqual(calls.map(c=>c[0]),reused?['audit']:['build','audit']);
  const options=calls.at(-1)[1];assert.equal(options.out,components.exchange.outputDir);assert.equal(options.sharedPath,resolve(components.shared.outputDir,'native-shared-library.swf'));
});

test('Exchange stays in final compiler source pins without changing aggregate ABI/hash gates',()=>{
  assert(source.includes('...(exchange.compileSourcePins??[])'));
  assert(source.includes("assert.equal(assets.length,89)"));assert(source.includes("assert.equal(SOURCE_FILES.length,84)"));
  assert(!ast.statements.filter(ts.isImportDeclaration).some(n=>['../workshop-native-exchange.mjs','../native-exchange/audit-candidate.mjs'].includes(n.moduleSpecifier.text)));
});
