#!/usr/bin/env node
// Exact bitmap-caption owner. Offline candidates first; installation uses its own three-file journal.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,readdirSync,openSync,closeSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve,join,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decompressSwf,parseTags} from '../tools/i18n/abc-strings/lib.mjs';
import {decodeBitmap,hash} from './workshop-bag-art.mjs';
import {decodeJpeg3,patchCalendar} from './workshop-calendar-art.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const names=['coreiconandtip','coreiconandtip1','quest'];
const deps=createRequire(join(process.env.WORKSHOP_NODE_DEPS??join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node'),'package.json'));
const {PNG}=deps('pngjs'),{GlobalFonts,createCanvas,loadImage}=deps('@napi-rs/canvas');
const scriptHash=()=>hash(readFileSync(fileURLToPath(import.meta.url)));
function configuration(name){assert.ok(names.includes(name),'unsupported caption asset');const bytes=readFileSync(join(repo,'research/i18n/tooltip-quest-art',name+'.zh-CN.json'));return{bytes,config:JSON.parse(bytes)};}
function inside(x,y,[a,b,w,h]){return x>=a&&y>=b&&x<a+w&&y<b+h;}
async function imageOf(bytes,entry){const d=decompressSwf(bytes),tags=parseTags(d.body).tags,t=tags.find(t=>t.code===entry.tagCode&&d.body.readUInt16LE(t.bodyStart)===entry.id);assert.ok(t,'missing caption bitmap');const body=d.body.subarray(t.bodyStart,t.bodyEnd);return t.code===36?decodeBitmap(body):decodeJpeg3(body);}

export async function patchTooltipQuestArt(bytes,name){
  const {bytes:configBytes,config}=configuration(name);assert.equal(hash(bytes),config.sourceBaseSha256,'caption source changed; preserved');
  const font=join(process.env.WINDIR??'C:/Windows','Fonts',config.fontFile);assert.ok(GlobalFonts.registerFromPath(font,config.fontFamily),'reviewed Chinese font unavailable');
  const fontFits=[],result=await patchCalendar(bytes,config,fontFits);
  // The shared painter checks SWF/tag/region ownership. Also protect original +/- marks,
  // bind frames and underline pixels outside the explicitly cleared box and actual new ink.
  const labelValueGaps=[];for(const e of config.bitmaps){const before=await imageOf(bytes,e),after=await imageOf(result.out,e),fit=fontFits.find(f=>f.id===e.id);assert.ok(fit?.inkBounds);
    if(e.valueTextStartX!==undefined){const gap=e.valueTextStartX-fit.inkBounds[2]-1;assert.ok(gap>=1,'caption overlaps its original value field');labelValueGaps.push({id:e.id,valueTextStartX:e.valueTextStartX,labelRight:fit.inkBounds[2],gapPixels:gap});}
    for(let y=0;y<e.height;y++)for(let x=0;x<e.width;x++){const p=(y*e.width+x)*4;if(after.raw.subarray(p,p+4).equals(before.raw.subarray(p,p+4)))continue;
      assert.ok(e.regions.some(r=>inside(x,y,r.box)),'caption pixel escaped its reviewed region');
      const r=e.regions[0],ink=fit.inkBounds;if(r.clearBoxes&&!r.clearBoxes.some(b=>inside(x,y,b))&&!(x>=ink[0]&&y>=ink[1]&&x<=ink[2]&&y<=ink[3]))assert.fail('caption changed protected underline pixels');}}
  return{out:result.out,metadata:{version:1,asset:config.asset,sourceSha256:hash(bytes),outputSha256:hash(result.out),configSha256:hash(configBytes),changedBitmapIds:result.changed.map(e=>e.id),changedBitmapCount:result.changed.length,totalTags:result.totalTags,unchangedTags:result.unchangedTags,fontFits,labelValueGaps,allUnselectedTagsByteIdentical:true,captionPixelsOutsideRegionsUnchanged:true,font:'simsun.ttc',runtimeAccepted:false,installed:false}};
}

export async function buildTooltipQuestCandidates(output){
  const out=resolve(output);assert.ok(!existsSync(out),'candidate directory already exists');mkdirSync(out,{recursive:true});const entries=[];
  for(const name of names){const {bytes:configBytes,config}=configuration(name),source=readFileSync(join(repo,'apps/api/assets/flash',config.asset)),result=await patchTooltipQuestArt(source,name);writeFileSync(join(out,name+'.swf'),result.out,{flag:'wx'});writeFileSync(join(out,name+'.config.json'),configBytes,{flag:'wx'});
    const rows=config.bitmaps.length,sheet=createCanvas(920,rows*116),ctx=sheet.getContext('2d');ctx.fillStyle='#626b71';ctx.fillRect(0,0,sheet.width,sheet.height);ctx.font=`14px "${config.fontFamily}"`;
    for(let i=0;i<rows;i++){const e=config.bitmaps[i];ctx.fillStyle='#fff';ctx.fillText(`${e.id}: ${e.className}`,8,i*116+19);for(const [suffix,bytes,x]of [['before',source,8],['after',result.out,470]]){const im=await imageOf(bytes,e),png=PNG.sync.write({width:im.width,height:im.height,data:im.rgba}),file=join(out,`${name}-${e.id}-${suffix}.png`);writeFileSync(file,png,{flag:'wx'});const picture=await loadImage(png);ctx.drawImage(picture,x,i*116+28,im.width*2,im.height*2);if(suffix==='after')for(const scale of[1.5,4]){const zoom=createCanvas(Math.ceil(im.width*scale),Math.ceil(im.height*scale));zoom.getContext('2d').drawImage(picture,0,0,zoom.width,zoom.height);writeFileSync(join(out,`${name}-${e.id}-after-${scale}x.png`),zoom.toBuffer('image/png'),{flag:'wx'});}}}
    writeFileSync(join(out,name+'-comparison.png'),sheet.toBuffer('image/png'),{flag:'wx'});entries.push({name,file:name+'.swf',...result.metadata});
  }
  const manifest={version:1,kind:'tooltip-quest-caption-candidate',builderSha256:scriptHash(),createdAt:new Date().toISOString(),entries};writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
}

const diskHash=path=>existsSync(path)?hash(readFileSync(path)):null;
function atomicReplace(path,bytes){mkdirSync(dirname(path),{recursive:true});const temp=path+'.tooltip-quest-'+randomUUID();let fd,owned=false;try{fd=openSync(temp,'wx');owned=true;writeFileSync(fd,bytes);closeSync(fd);fd=undefined;renameSync(temp,path);}finally{if(fd!==undefined)closeSync(fd);if(owned&&existsSync(temp))unlinkSync(temp);}}
function location(roots={}){const runtime=resolve(roots.runtime??join(repo,'../../runtime'));return{runtime,assets:resolve(roots.assets??join(repo,'apps/api/assets/flash')),journal:join(runtime,'client-overlay-tooltip-quest-art.json'),reports:join(runtime,'client-text-followup','tooltip-quest-installations')};}
function configPins(){return names.map(name=>({name,sha256:hash(configuration(name).bytes)}));}
function receiptEntries(previous,p){assert.equal(previous.version,1);assert.equal(previous.kind,'tooltip-quest-caption-installation');assert.equal(previous.builderSha256,scriptHash(),'installed caption builder changed; preserve overlay');assert.deepEqual(previous.configs,configPins(),'installed caption config changed; preserve overlay');assert.equal(previous.entries.length,3);assert.equal(previous.reportDir,resolve(previous.reportDir));assert.ok(previous.reportDir.startsWith(p.reports+sep),'journal report escaped owner root');
  return previous.entries.map((e,i)=>{assert.equal(e.name,names[i]);const {config}=configuration(e.name);assert.equal(e.target,join(p.runtime,'client-overlay',config.asset));assert.equal(e.backup,join(previous.reportDir,e.name+'.before.swf'));assert.equal(e.sourceSha256,config.sourceBaseSha256);assert.equal(diskHash(e.backup),e.sourceSha256,'caption backup changed; preserved');assert.equal(diskHash(e.target),e.outputSha256,'caption overlay changed; preserve newer work');return e;});}
function foreignJournalCheck(p,targets){function visit(value,file,key){if(typeof value==='string'&&key==='target')assert.ok(!targets.includes(resolve(value)),'another overlay journal owns caption target: '+file);else if(value&&typeof value==='object')for(const[k,v]of Object.entries(value))visit(v,file,k);}
  for(const f of readdirSync(p.runtime).filter(f=>/^client-overlay.*\.json$/.test(f)&&f!=='client-overlay-tooltip-quest-art.json'))visit(JSON.parse(readFileSync(join(p.runtime,f),'utf8')),f);}

export async function manageTooltipQuestArt(command,candidateDirectory,roots={}){
  assert.ok(['install','verify','rollback'].includes(command),'unsupported caption operation');const p=location(roots);if(command==='install')mkdirSync(p.runtime,{recursive:true});else assert.ok(existsSync(p.runtime),'caption runtime directory unavailable');
  const journalBefore=existsSync(p.journal)?readFileSync(p.journal):null,previous=journalBefore?JSON.parse(journalBefore):null;
  for(const name of names){const {config}=configuration(name);assert.equal(diskHash(join(p.assets,config.asset)),config.sourceAssetSha256,'shipped caption source changed; preserved');}
  const oldEntries=previous?receiptEntries(previous,p):null;const targets=names.map(name=>join(p.runtime,'client-overlay',configuration(name).config.asset));foreignJournalCheck(p,targets);
  if(command==='verify'&&!candidateDirectory){if(!previous)for(let i=0;i<names.length;i++){const h=diskHash(targets[i]);assert.ok(h===null||h===configuration(names[i]).config.sourceBaseSha256,'unknown caption overlay; preserved');}return{verified:true,installed:Boolean(previous),entries:oldEntries??[],runtimeAccepted:false};}
  if(command==='rollback'){
    assert.ok(previous,'no caption installation journal');assert.ok(!candidateDirectory,'rollback does not accept a candidate');const restored=[],installedBytes=new Map(oldEntries.map(e=>[e.target,readFileSync(e.target)]));
    try{for(const e of oldEntries){assert.equal(diskHash(e.target),e.outputSha256,'caption overlay changed before rollback');if(e.hadOverlay)atomicReplace(e.target,readFileSync(e.backup));else unlinkSync(e.target);restored.push(e);}assert.equal(hash(readFileSync(p.journal)),hash(journalBefore),'journal changed during rollback');unlinkSync(p.journal);}
    catch(error){for(const e of restored.reverse())if(diskHash(e.target)===(e.hadOverlay?e.sourceSha256:null))atomicReplace(e.target,installedBytes.get(e.target));throw error;}
    return{rolledBack:true,originalAssetsUnchanged:true,backupsPreserved:true,runtimeAccepted:false};
  }
  assert.ok(candidateDirectory,'installation/explicit verification needs a frozen candidate directory');const candidate=resolve(candidateDirectory),manifestBytes=readFileSync(join(candidate,'manifest.json')),manifest=JSON.parse(manifestBytes);assert.equal(manifest.version,1);assert.equal(manifest.kind,'tooltip-quest-caption-candidate');assert.equal(manifest.builderSha256,scriptHash(),'caption builder changed since candidate freeze');assert.equal(manifest.entries.length,3);
  const prepared=[];for(let i=0;i<names.length;i++){const name=names[i],e=manifest.entries[i],{config,bytes:configBytes}=configuration(name);assert.equal(e.name,name);assert.equal(e.file,name+'.swf');assert.equal(e.asset,config.asset);assert.equal(e.configSha256,hash(configBytes),'caption config changed');assert.equal(e.sourceSha256,config.sourceBaseSha256);const source=readFileSync(join(p.assets,config.asset)),rebuilt=await patchTooltipQuestArt(source,name),payload=readFileSync(join(candidate,e.file));assert.deepEqual(e,{name,file:name+'.swf',...rebuilt.metadata},'candidate metadata differs from exact reconstruction');assert.deepEqual(payload,rebuilt.out,'candidate differs from exact caption reconstruction');assert.equal(hash(payload),e.outputSha256);const current=diskHash(targets[i]);assert.ok(current===(oldEntries?.[i].outputSha256??null)||current===config.sourceBaseSha256,'unknown caption overlay; preserved');prepared.push({name,target:targets[i],payload,source,sourceSha256:config.sourceBaseSha256,outputSha256:e.outputSha256,current});}
  if(previous){assert.equal(previous.manifestSha256,hash(manifestBytes),'different caption candidate already installed; rollback first');assert.ok(prepared.every((e,i)=>e.outputSha256===oldEntries[i].outputSha256));return{verified:true,installed:true,unchanged:true,manifestSha256:previous.manifestSha256,runtimeAccepted:false};}
  if(command==='verify')return{verified:true,installed:false,manifestSha256:hash(manifestBytes),runtimeAccepted:false};
  const reportDir=join(p.reports,randomUUID());mkdirSync(reportDir,{recursive:true});const entries=prepared.map(e=>{const backup=join(reportDir,e.name+'.before.swf');writeFileSync(backup,e.source,{flag:'wx'});return{name:e.name,target:e.target,backup,hadOverlay:e.current!==null,sourceSha256:e.sourceSha256,outputSha256:e.outputSha256};});
  const receipt={version:1,kind:'tooltip-quest-caption-installation',builderSha256:scriptHash(),configs:configPins(),candidateDirectory:candidate,manifestSha256:hash(manifestBytes),reportDir,entries,installedAt:new Date().toISOString(),runtimeAccepted:false};const changed=[];
  try{for(const e of prepared){assert.equal(diskHash(e.target),e.current,'caption overlay changed during preparation');atomicReplace(e.target,e.payload);changed.push(e);assert.equal(diskHash(e.target),e.outputSha256);}assert.ok(prepared.every(e=>diskHash(join(p.assets,configuration(e.name).config.asset))===e.sourceSha256),'shipped caption source changed before commit');assert.equal(diskHash(p.journal),null,'caption journal appeared during preparation');atomicReplace(p.journal,Buffer.from(JSON.stringify(receipt,null,2)+'\n'));}
  catch(error){const failed=[];for(const e of changed.reverse()){if(diskHash(e.target)!==e.outputSha256){failed.push(e.target);continue;}if(e.current===null)unlinkSync(e.target);else atomicReplace(e.target,e.source);}if(failed.length)error.message+='; compensation preserved externally changed targets: '+failed.join(', ');throw error;}
  assert.ok(prepared.every(e=>diskHash(join(p.assets,configuration(e.name).config.asset))===e.sourceSha256));return{installed:true,unchanged:false,journal:p.journal,manifestSha256:receipt.manifestSha256,entries,runtimeAccepted:false};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const command=process.argv[2]??'verify';assert.ok(process.argv.length<=4,'usage: workshop-tooltip-quest-art.mjs candidate <fresh-dir> | install <candidate-dir> | verify [candidate-dir] | rollback');const result=command==='candidate'?await buildTooltipQuestCandidates(process.argv[3]??assert.fail('fresh candidate directory required')):await manageTooltipQuestArt(command,process.argv[3]);console.log(JSON.stringify(result));}
