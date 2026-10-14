import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateRawSync} from 'node:zlib';
import {ByteReader} from '../../tools/i18n/abc-strings/lib.mjs';
import {zipRecords} from '../workshop-bag-layout.mjs';
import {scan,pinned,sha,q} from '../native-pair/build-library.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),A=resolve(repo,'../../runtime/reference-activities-completion-20261014'),area=resolve(A,'native-ddplay-analysis-20261015');
const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6)??resolve(area,'resources-b'),check=process.argv.includes('--check');
assert(process.argv.slice(2).every(x=>x==='--check'||x.startsWith('--out=')));if(!check)assert(!existsSync(out),'preserve prior extraction');
const corePath=resolve(A,'reference-core/2_v3_6_1_u9.png'),coreBytes=pinned(corePath,'af361678887e2413efe54e6cd86d37426cc6724ea964080178eea4816a785ae4'),core=scan(coreBytes);
const artPath=resolve(area,'ddplay_v3_6_1_u1.swf'),artBytes=pinned(artPath,'5c52f584b50e7e69e824450229cc83a62112c569717b73c08476bb354daaf082'),art=scan(artBytes);
const archivePath=resolve(A,'native-mines-resources-20261015/reference-styles-xml_v3_6_1_u5.png'),archive=pinned(archivePath,'1d1c4fc983ce7d3df36cb16dd1f62a93591aaf0181c67ffcf11764c927c24f33');
const unzip=b=>zipRecords(b).records.map(r=>({name:r.name,bytes:inflateRawSync(b.subarray(r.data,r.data+r.compressedSize))}));
const entries=unzip(archive),entry=entries.find(x=>x.name==='ddplay.xml');assert(entry);const xml=entry.bytes.toString('utf8');
const owners=core.abcs.filter(a=>a.name.startsWith('DDPlay/')&&a.name!=='DDPlay/DDPlayQuickBuy');assert.equal(owners.length,5);
const nodes=[...xml.matchAll(/<(set|component|custom|bitmapData|bitmap)\b[^>]*\/>/gs)].map(([raw,kind])=>({raw,kind,attrs:Object.fromEntries([...raw.matchAll(/([\w.]+)=(['"])(.*?)\2/gs)].map(m=>[m[1],m[3]]))}));for(const n of nodes)n.key=n.attrs.stylename??n.attrs.resourceLink;
const byName=new Map(nodes.map(n=>[n.key,n]));assert.equal(byName.size,nodes.length);
const texts=new Set(owners.flatMap(a=>a.p.strings)),selected=new Set(nodes.filter(n=>texts.has(n.key)&&!n.key.startsWith('DDPlay.quick')).map(n=>n.key));
for(;;){const size=selected.size;for(const key of [...selected])for(const value of Object.values(byName.get(key).attrs))for(const part of value.split(','))if(byName.has(part)&&!part.startsWith('DDPlay.quick'))selected.add(part);if(size===selected.size)break;}
const oldArchive=readFileSync(resolve(repo,'vendor/DDTank41/Source Flash/FlashSV1/ui/vietnam/xml/xml.png')),oldEntries=unzip(oldArchive);
const active=nodes.filter(n=>selected.has(n.key)),groups={set:'sets',component:'components',custom:'customs',bitmapData:'bitmaps',bitmap:'bitmaps'};let subset='<style name="ddplay" version="1.0.1" source="ui/zh_cn/swf/ddplay.swf">\n';
const oldNodes=oldEntries.flatMap(e=>[...e.bytes.toString('utf8').matchAll(/<(set|component|custom|bitmapData|bitmap)\b[^>]*\/>/gs)].map(([raw,kind])=>({raw,kind,attrs:Object.fromEntries([...raw.matchAll(/([\w.]+)=(['"])(.*?)\2/gs)].map(m=>[m[1],m[3]]))})));
const frame=oldNodes.find(n=>n.attrs.stylename==='SimpleFrameBackgoundOne');assert(frame,'old host standard frame background');
for(const n of active)if(n.attrs.parentStyle==='SimpleFrameBackgoundOneIII'){n.raw=n.raw.replace('parentStyle="SimpleFrameBackgoundOneIII"','parentStyle="SimpleFrameBackgoundOne"');n.attrs.parentStyle='SimpleFrameBackgoundOne';}
const missingBackground=entries.flatMap(e=>[...e.bytes.toString('utf8').matchAll(/<component\b[^>]*\/>/gs)].map(([raw])=>raw)).find(raw=>raw.includes('stylename="core.ddplayBgAsset"'));assert(missingBackground);
active.push({raw:missingBackground,kind:'component',key:'core.ddplayBgAsset',attrs:{classname:'com.pickgliss.ui.image.ScaleBitmapImage',stylename:'core.ddplayBgAsset',resourceLink:'asset.core.ddplayBgAsset'}});selected.add('core.ddplayBgAsset');
for(const group of [...new Set(Object.values(groups))]){const rows=active.filter(n=>groups[n.kind]===group);if(rows.length)subset+=`  <${group}>\n${rows.map(n=>'    '+n.raw).join('\n')}\n  </${group}>\n`;}subset+='</style>\n';
const symbols=[];for(const t of art.tags.filter(t=>t.code===76)){const r=new ByteReader(art.body.subarray(t.bodyStart,t.bodyEnd));for(let n=r.u16();n;n--)symbols.push({id:r.u16(),name:r.cstring()});}
const available=new Set(symbols.map(x=>x.name)),directArt=[...texts].filter(s=>available.has(s));const external=[];
for(const node of active)for(const [key,value] of Object.entries(node.attrs))if(['backStyle','unSelectedStyle','selectedStyle','resourceLink','parentStyle','targetFieldStyle','upStyle','downStyle','closestyle','titleStyle','textFormatStyle','filterString'].includes(key))for(const part of value.split(','))if(part&&part!=='null'&&!selected.has(part)&&!available.has(part))external.push(part);
const find=(rows,key)=>rows.flatMap(e=>[...e.bytes.toString('utf8').matchAll(/<(set|component|custom|bitmapData|bitmap)\b[^>]*\/>/gs)].filter(([raw])=>[...raw.matchAll(/([\w.]+)=(['"])(.*?)\2/gs)].some(m=>['stylename','resourceLink'].includes(m[1])&&m[3]===key)).map(([definition])=>({entry:e.name,definition})));
const common=[...new Set(external)].filter(k=>k!=='asset.core.ddplayBgAsset').sort().map(key=>({key,legacy:find(oldEntries,key),reference:find(entries,key)}));assert(common.every(c=>c.legacy.length),'all shared styles exist in old host');
const old=scan(pinned(resolve(repo,'vendor/DDTank41/Source Flash/FlashSV1/2.png'),'e42484623db5009eef0752fd8b2e53006060d1eaa30989d1cd3f4d2cec6d8081'));
const sharedNames=new Set(old.abcs.map(a=>a.name));const styleClasses=[...new Set(active.map(n=>n.attrs.classname).filter(Boolean))].map(name=>({name,present:name.startsWith('DDPlay.')||name.startsWith('flash.')||sharedNames.has(name.replaceAll('.','/'))}));assert(styleClasses.every(c=>c.present));
const result={offlineOnly:true,executed:false,ownerCount:owners.length,owners:owners.map(a=>({owner:a.name,sha256:sha(a.abc)})),art:{path:artPath,sha256:sha(artBytes),bytes:artBytes.length,abcCount:art.abcs.length,symbols,directArt},style:{count:active.length,sha256:sha(Buffer.from(subset)),counts:Object.fromEntries([...new Set(active.map(n=>n.kind))].map(k=>[k,active.filter(n=>n.kind===k).length])),selected:active.map(n=>n.key),omitted:nodes.filter(n=>!selected.has(n.key)).map(n=>n.key),common},styleClasses,inputs:[{path:corePath,sha256:sha(coreBytes)},{path:archivePath,sha256:sha(archive)}],limitations:['Static dependency closure; runtime animation/UI acceptance remains pending.','Original QuickBuy owner/styles omitted; every local spin and exchange requires explicit action.']};
const outputs=new Map([['ddplay.styles.xml',Buffer.from(subset)],['ddplay.resource-manifest.json',Buffer.from(JSON.stringify(result,null,2)+'\n')]]);if(!check)mkdirSync(out,{recursive:true});for(const [file,bytes]of outputs){const path=resolve(out,file);if(check)assert.deepEqual(readFileSync(path),bytes);else writeFileSync(path,bytes,{flag:'wx'});}console.log(JSON.stringify({out,styles:active.length,art:directArt.length,artAbc:art.abcs.length,missingCommon:common.filter(c=>!c.legacy.length).map(c=>c.key)},null,2));
