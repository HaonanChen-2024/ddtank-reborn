#!/usr/bin/env node
// Offline extraction only. Pinned public originals are kept outside the source tree.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateRawSync,inflateSync,crc32} from 'node:zlib';
import {ByteReader} from '../tools/i18n/abc-strings/lib.mjs';
import {zipRecords} from './workshop-bag-layout.mjs';
import {scan,pinned,sha,q} from './native-pair/build-library.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const A=resolve(repo,'../../runtime/reference-activities-completion-20261014');
const source=resolve(A,'native-mines-resources-20261015');
const outputArg=process.argv.find(x=>x.startsWith('--out='));
const out=outputArg?resolve(outputArg.slice(6)):resolve(source,'extracted');
const check=process.argv.includes('--check');
assert(process.argv.slice(2).every(x=>x==='--check'||x.startsWith('--out=')),'unknown argument');
if(!check)assert(!existsSync(out),'output already exists; use --check or a new --out');
const corePath=resolve(A,'reference-core/2_v3_6_1_u9.png');
const oldPath=resolve(repo,'vendor/DDTank41/Source Flash/FlashSV1/2.png');
const artPath=resolve(A,'direct-modules/boguadventure_v3_6_1_u1.swf');
const archivePath=resolve(source,'reference-styles-xml_v3_6_1_u5.png');
const playerPath=resolve(source,'bogu-player-game.png');
const coreBytes=pinned(corePath,'af361678887e2413efe54e6cd86d37426cc6724ea964080178eea4816a785ae4');
const oldBytes=pinned(oldPath,'e42484623db5009eef0752fd8b2e53006060d1eaa30989d1cd3f4d2cec6d8081');
const artBytes=pinned(artPath,'306633351976c16780211629a510b931b9d822a0a656124da4911fbad3cc5204');
const archive=pinned(archivePath,'1d1c4fc983ce7d3df36cb16dd1f62a93591aaf0181c67ffcf11764c927c24f33');
const player=pinned(playerPath,'cc07012615e8fe2c9b8cff59f07b2ed52d06acecba7508ee2d8ca067bedd1a94');
const core=scan(coreBytes),old=scan(oldBytes),art=scan(artBytes);
const owners=core.abcs.filter(a=>a.name.startsWith('activity/boguAdventure/'));
assert.equal(owners.length,21);
function unzip(bytes){return zipRecords(bytes).records.map(r=>({name:r.name,bytes:inflateRawSync(bytes.subarray(r.data,r.data+r.compressedSize))}));}
const entries=unzip(archive),entry=entries.find(x=>x.name==='boguadventure.xml');assert(entry);
const xml=entry.bytes.toString('utf8');assert.deepEqual(Buffer.from(xml),entry.bytes);
const nodes=[...xml.matchAll(/<(set|component|custom|bitmapData|bitmap)\b[^>]*\/>/g)].map(([raw,kind])=>{
  const attrs=Object.fromEntries([...raw.matchAll(/([\w.]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
  return {kind,key:attrs.stylename??attrs.resourceLink,attrs,raw};
});
assert.equal(new Set(nodes.map(n=>n.key)).size,nodes.length);
const byName=new Map(nodes.map(n=>[n.key,n]));
const literalOwners=new Map();
for(const owner of owners)for(const text of owner.p.strings){if(!literalOwners.has(text))literalOwners.set(text,[]);if(!literalOwners.get(text).includes(owner.name))literalOwners.get(text).push(owner.name);}
const selected=new Set(nodes.filter(n=>literalOwners.has(n.key)).map(n=>n.key));
const direct=[...selected];
for(;;){const size=selected.size;for(const key of [...selected])for(const value of Object.values(byName.get(key).attrs))for(const part of value.split(','))if(byName.has(part))selected.add(part);if(selected.size===size)break;}
const selectedNodes=nodes.filter(n=>selected.has(n.key));
const groups={set:'sets',component:'components',bitmapData:'bitmaps',bitmap:'bitmaps',custom:'customDisplay'};
let subset='<style name="boguadventure" version="1.0.1" source="ui/zh_cn/swf/boguadventure.swf">\n';
for(const group of [...new Set(Object.values(groups))]){const groupNodes=selectedNodes.filter(n=>groups[n.kind]===group);if(groupNodes.length)subset+=`  <${group}>\n${groupNodes.map(n=>'    '+n.raw).join('\n')}\n  </${group}>\n`;}
subset+='</style>\n';
const exports=[];for(const tag of art.tags.filter(t=>t.code===76)){const r=new ByteReader(art.body.subarray(tag.bodyStart,tag.bodyEnd));for(let n=r.u16();n;n--)exports.push({id:r.u16(),name:r.cstring()});}
const symbols=new Set(exports.map(x=>x.name));
const assetReferences=new Set([...literalOwners.keys()].filter(x=>symbols.has(x)));
// ChangeView.placeGoods prefixes the two declared kinds MINE and SIGN.
for(const name of ['boguAdventure.mapView.mine','boguAdventure.mapView.sign'])assetReferences.add(name);
const externalStyles=new Set();
for(const node of selectedNodes)for(const [key,value] of Object.entries(node.attrs)){
  if(['backStyle','unSelectedStyle','selectedStyle','resourceLink'].includes(key))for(const part of value.split(','))if(!selected.has(part))assetReferences.add(part);
  if(['filterString','textFormatStyle'].includes(key))for(const part of value.split(','))if(part!=='null'&&!selected.has(part))externalStyles.add(part);
}
const layouts=JSON.parse(readFileSync(resolve(A,'direct-modules/boguadventure.layouts.json'),'utf8'));
for(const layout of Object.values(layouts))for(const [,value] of layout.matchAll(/\bskin="([^"]+)"/g))for(const part of value.split(','))assetReferences.add(part);
const missingArt=[...assetReferences].filter(x=>!symbols.has(x));assert.deepEqual(missingArt,[],'activity art closure');
const oldArchivePath=resolve(repo,'vendor/DDTank41/Source Flash/FlashSV1/ui/vietnam/xml/xml.png');
const oldArchive=readFileSync(oldArchivePath),oldEntries=unzip(oldArchive);
const commonStyleProof=[...externalStyles].map(name=>{
  const find=rows=>rows.flatMap(e=>[...e.bytes.toString('utf8').matchAll(/<set\b[^>]*\/>/g)].filter(([t])=>t.includes(`stylename="${name}"`)).map(([definition])=>({entry:e.name,definition})));
  const original=find(entries),legacy=find(oldEntries);assert(original.length&&legacy.length,`missing shared style ${name}`);return{name,original,legacy,registration:'reuse host; do not re-register'};
});
const componentClasses=[...new Set(selectedNodes.map(n=>n.attrs.classname).filter(Boolean))].map(name=>({name,legacyPresent:name.startsWith('flash.')||old.abcs.some(x=>x.name===name.replaceAll('.','/'))}));
assert(componentClasses.every(x=>x.legacyPresent),'style component class unavailable');
function api(a){return a.p.methodTraits.map(t=>{const m=a.p.methods[t.method];return {name:q(a.p,t.name),kind:t.kind,params:m.params.map(i=>q(a.p,i)),returns:q(a.p,m.returnType)};});}
const hostNames=['ddt/view/sceneCharacter/SceneCharacterPlayerBase','ddt/view/sceneCharacter/SceneCharacterItem','ddt/view/sceneCharacter/SceneCharacterActionItem','ddt/view/sceneCharacter/SceneCharacterStateItem','ddt/view/sceneCharacter/SceneCharacterSet','ddt/view/sceneCharacter/SceneCharacterStateSet','ddt/view/sceneCharacter/SceneCharacterActionSet','ddt/view/sceneCharacter/SceneCharacterDirection','ddt/view/sceneCharacter/SceneCharacterSynthesis','com/pickgliss/loader/BitmapLoader','com/pickgliss/ui/ComponentFactory','com/pickgliss/ui/ComponentModel'];
const hostAbi=hostNames.map(name=>{
  const reference=core.abcs.find(x=>x.name===name),legacy=old.abcs.find(x=>x.name===name);assert(reference&&legacy,name);
  const signature=a=>({params:a.p.methods[1].params.map(i=>q(a.p,i)),flags:a.p.methods[1].flags});
  const referenceMethods=api(reference),legacyMethods=api(legacy);
  return {name,constructorReference:signature(reference),constructorLegacy:signature(legacy),constructorParameterTypesMatch:JSON.stringify(signature(reference))===JSON.stringify(signature(legacy)),referenceMethods,missingOrChangedMethods:referenceMethods.filter(m=>!legacyMethods.some(o=>JSON.stringify(m)===JSON.stringify(o)))};
});
// Fully inflate and unfilter this pinned indexed PNG; verify every referenced cell contains pixels.
assert.equal(player.subarray(0,8).toString('hex'),'89504e470d0a1a0a');let at=8,width,height,palette,alpha;const idat=[];
while(at<player.length){const len=player.readUInt32BE(at),type=player.toString('ascii',at+4,at+8),data=player.subarray(at+8,at+8+len);assert.equal(crc32(player.subarray(at+4,at+8+len)),player.readUInt32BE(at+8+len));if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.deepEqual([...data.subarray(8)],[8,3,0,0,0]);}if(type==='PLTE')palette=data;if(type==='tRNS')alpha=data;if(type==='IDAT')idat.push(data);at+=12+len;}
assert.equal(at,player.length);assert(palette&&alpha);
const raw=inflateSync(Buffer.concat(idat)),pixels=Buffer.alloc(width*height);assert.equal(raw.length,(width+1)*height);
const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
for(let y=0;y<height;y++){const filter=raw[y*(width+1)];assert(filter<=4);for(let x=0;x<width;x++){const i=y*width+x,a=x?pixels[i-1]:0,b=y?pixels[i-width]:0,c=x&&y?pixels[i-width-1]:0;pixels[i]=(raw[y*(width+1)+1+x]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255;assert(pixels[i]*3<palette.length);}}
const usedFrames=Array.from({length:17},(_,index)=>{const x=(index%11)*114,y=Math.floor(index/11)*95;assert(x+114<=width&&y+95<=height);let visiblePixels=0;for(let yy=y;yy<y+95;yy++)for(let xx=x;xx<x+114;xx++)if((alpha[pixels[yy*width+xx]]??255)>0)visiblePixels++;assert(visiblePixels>0);return{index,x,y,width:114,height:95,visiblePixels};});
const manifest={offlineOnly:true,runtimePassed:false,inputs:[{path:corePath,sha256:sha(coreBytes)},{path:oldPath,sha256:sha(oldBytes)},{path:artPath,sha256:sha(artBytes)},{path:archivePath,sha256:sha(archive)},{path:playerPath,sha256:sha(player)},{path:oldArchivePath,sha256:sha(oldArchive)}],originalEntry:{name:entry.name,bytes:entry.bytes.length,sha256:sha(entry.bytes),nodeCount:nodes.length},ownerCount:owners.length,styles:{file:'boguadventure.styles.xml',bytes:Buffer.byteLength(subset),sha256:sha(Buffer.from(subset)),count:selectedNodes.length,counts:Object.fromEntries([...new Set(selectedNodes.map(n=>n.kind))].map(k=>[k,selectedNodes.filter(n=>n.kind===k).length])),directCount:direct.length,selected:selectedNodes.map(n=>({key:n.key,kind:n.kind,owners:literalOwners.get(n.key)??[],dependencyOnly:!direct.includes(n.key)})),omitted:nodes.filter(n=>!selected.has(n.key)).map(n=>n.key),commonStyleProof,componentClasses},art:{path:artPath,totalSymbols:symbols.size,requiredSymbols:[...assetReferences].sort(),missingArt},player:{path:playerPath,bytes:player.length,sha256:sha(player),width,height,decoded:true,frameGrid:{rows:3,columns:11,cellWidth:114,cellHeight:95},usedFrames,unusedRightMargin:width-11*114},hostAbi,remainingHostBoundary:['asset.simpleReturnBar.Button belongs to original StateView; local host return/close adapter must resolve it separately','PathManager.solveBoguAdventurePath is absent in legacy: module adapter must use the packaged local player URL','Reference help wording/old money rules must be replaced by the local API contract, not inferred from these assets'],registration:{method:'ComponentFactory.Instance.setup(new XML(stylesText))',oncePerApplicationDomain:true,loadOrder:'original art + shared Morn; register module styles; load four original layouts into View.uiMap; then construct activity view',duplicatePolicy:'do not register the whole reference archive or any existing shared style',note:'No coordinates, art payloads, or font definitions changed. Inactive NPC/footlight styles were omitted.'}};
const outputs=new Map([['boguadventure.original.xml',entry.bytes],['boguadventure.styles.xml',Buffer.from(subset)],['resource-manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n')]]);
if(!check)mkdirSync(out,{recursive:true});
for(const [file,bytes] of outputs){const path=resolve(out,file);if(check)assert.deepEqual(readFileSync(path),bytes,`${file} reproducibility`);else writeFileSync(path,bytes,{flag:'wx'});}
console.log(JSON.stringify({out,check,styles:manifest.styles.count,styleCounts:manifest.styles.counts,requiredArt:assetReferences.size,missingArt,player:{width,height,usedFrames:usedFrames.length},hostApiDifferences:hostAbi.filter(x=>!x.constructorParameterTypesMatch||x.missingOrChangedMethods.length).map(x=>({name:x.name,constructor:x.constructorParameterTypesMatch,methods:x.missingOrChangedMethods}))},null,2));
