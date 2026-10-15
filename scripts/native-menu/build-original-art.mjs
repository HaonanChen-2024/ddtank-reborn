// Offline exact-original resource extraction. Does not modify a host, an installer, or a running game.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {inflateSync,inflateRawSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const specPath=resolve(dirname(fileURLToPath(import.meta.url)),'source-spec.json');
const spec=JSON.parse(readFileSync(specPath,'utf8'));
const Pdefault=resolve(repo,'../..');
const {scan,q,sha,pinned}=await import('../native-pair/build-library.mjs');
const {ByteReader}=await import('../../tools/i18n/abc-strings/lib.mjs');
const originalSymbols=swf=>swf.tags.filter(t=>t.code===76).flatMap(t=>{const r=new ByteReader(swf.body.subarray(t.bodyStart,t.bodyEnd)),a=[];for(let n=r.u16();n;n--)a.push({id:r.u16(),name:r.cstring()});return a;});
const {decodeBitmap}=await import('../workshop-bag-art.mjs');
const {buildTag,compressSwf}=await import('../../tools/i18n/abc-strings/lib.mjs');
const require=createRequire('C:/Users/11322/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const {createCanvas,loadImage}=require('@napi-rs/canvas'),{PNG}=require('pngjs');
const {zipRecords}=await import('../workshop-bag-layout.mjs');
const unzipSync=b=>Object.fromEntries(zipRecords(b).records.map(r=>{const method=b.readUInt16LE(r.local+8),raw=b.subarray(r.data,r.data+r.compressedSize);assert([0,8].includes(method),'ZIP compression');return[r.name,method===0?raw:inflateRawSync(raw)];}));

export async function buildNativeMenuArt({projectRoot=Pdefault,outputDir,javaPath='C:/Users/11322/.jdks/openjdk-22.0.1/bin/java.exe'}={}){
const P=resolve(projectRoot);assert(outputDir,'outputDir required');
const rows=spec.rows.map(x=>[x.kind,x.label,x.style,x.symbol,x.id]);
const sourcePath=resolve(P,spec.source.path);
const source=pinned(sourcePath,spec.source.sha256);
const stylesPath=resolve(P,spec.styles.path);
const stylesBytes=pinned(stylesPath,spec.styles.sha256);
const originalHallAs=resolve(P,spec.hallOwner);
const hallSource=readFileSync(originalHallAs,'utf8');
const archive=unzipSync(stylesBytes),styleXml=Buffer.from(archive['coreI.xml']).toString('utf8').replace(/<!--[\s\S]*?-->/g,'');
const sourceSwf=scan(source),symbols=originalSymbols(sourceSwf);
assert.equal(sourceSwf.abcs.length,1);assert.equal(rows.length,18);assert.equal(new Set(rows.map(x=>x[3])).size,18);
const out=resolve(outputDir);assert(!existsSync(out),'preserve prior output');
for(const folder of ['original-tags','png','original-classes','sources/workshop/menu/art','build-logs'])mkdirSync(resolve(out,folder),{recursive:true});

const reports=[];
for(const [kind,label,style,symbol,id]of rows){
 const matches=symbols.filter(x=>x.name===symbol);assert.deepEqual(matches,[{id,name:symbol}]);
 const candidates=sourceSwf.tags.filter(t=>[20,21,35,36,39,90].includes(t.code)&&sourceSwf.body.readUInt16LE(t.bodyStart)===id);assert.equal(candidates.length,1);
 const tag=candidates[0],body=sourceSwf.body.subarray(tag.bodyStart,tag.bodyEnd);assert([35,36].includes(tag.code));
 let originalStyle=null;
 if(style){
  assert(hallSource.includes('"'+style+'"'));
  const styles=[...styleXml.matchAll(/<component\b[^>]*>/g)].map(m=>m[0]).filter(t=>t.includes('stylename="'+style+'"'));
  assert.equal(styles.length,1,'unique exact-case original style '+style);originalStyle=styles[0];
  assert(originalStyle.includes('classname="com.pickgliss.ui.controls.SimpleBitmapButton"'));assert(originalStyle.includes('backStyle="'+symbol+'"'));
 }
 let width,height,rgba,encodedImageSha256=null,alphaSha256=null;
 if(tag.code===36){const image=decodeBitmap(body);({width,height,rgba}=image);}
 else{
  const n=body.readUInt32LE(2);assert(n>0&&n+6<body.length);let jpg=body.subarray(6,6+n);
  if(jpg.subarray(0,4).equals(Buffer.from('ffd9ffd8','hex')))jpg=jpg.subarray(2);
  assert(jpg.subarray(0,2).equals(Buffer.from('ffd8','hex')));const image=await loadImage(jpg);width=image.width;height=image.height;
  const c=createCanvas(width,height),ctx=c.getContext('2d');ctx.drawImage(image,0,0);rgba=Buffer.from(ctx.getImageData(0,0,width,height).data);
  const alpha=inflateSync(body.subarray(6+n));assert.equal(alpha.length,width*height);for(let i=0;i<alpha.length;i++)rgba[i*4+3]=alpha[i];
  encodedImageSha256=sha(body.subarray(6,6+n));alphaSha256=sha(alpha);
 }
 const expected=spec.rows.find(x=>x.symbol===symbol);assert.equal(width,expected.width);assert.equal(height,expected.height);
 if(tag.code===36){const raw=inflateSync(body.subarray(7));assert.equal(raw.length,width*height*4);const alpha=Buffer.alloc(width*height);for(let i=0;i<alpha.length;i++)alpha[i]=raw[i*4];alphaSha256=sha(alpha);}
 assert(width>0&&height>0&&width<=90&&height<=90,'bounded original hall bitmap');
 const png=new PNG({width,height});png.data=rgba;const pngBytes=PNG.sync.write(png),name=symbol.split('.').at(-1);
 assert.deepEqual(Buffer.from(PNG.sync.read(pngBytes).data),rgba,'PNG independent decode exact RGBA');
 writeFileSync(resolve(out,'original-tags',name+'.tag.bin'),tag.raw,{flag:'wx'});writeFileSync(resolve(out,'png',name+'.png'),pngBytes,{flag:'wx'});
 const exportSymbol='workshop.menu.art.'+name;assert.equal(expected.exportSymbol,exportSymbol);
 reports.push({kind,label,style,symbol,exportSymbol,className:exportSymbol.replace(/\.([^.]*)$/,'::$1'),id,sourcePath,sourceSha256:sha(source),tagCode:tag.code,tagBytes:tag.raw.length,tagSha256:sha(tag.raw),tagFile:'original-tags/'+name+'.tag.bin',width,height,rgbaSha256:sha(rgba),encodedImageSha256,alphaSha256,png:{file:'png/'+name+'.png',bytes:pngBytes.length,sha256:sha(pngBytes)},styleSource:{path:stylesPath,sha256:sha(stylesBytes),entry:'coreI.xml',xml:originalStyle},originalPixelsUnchanged:true});
}

const java=javaPath,ffdec=resolve(P,spec.ffdec);
const args=['-Djava.awt.headless=true','-jar',ffdec,'-selectclass',rows.map(x=>x[3]).join(','),'-export','script',resolve(out,'original-classes'),sourcePath];
const result=spawnSync(java,args,{windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
writeFileSync(resolve(out,'build-logs/ffdec.log'),String(result.stdout??'')+String(result.stderr??''),{flag:'wx'});assert.equal(result.status,0,result.stderr??result.error);
for(const item of reports){
 const name=item.symbol.split('.').at(-1),path=resolve(out,'original-classes/scripts/asset/hall',name+'.as'),as=readFileSync(path,'utf8');
 assert(as.includes('extends BitmapData'));assert(as.includes('super(param1,param2)'));assert(new RegExp('param1:int = '+item.width+',\\s*param2:int = '+item.height).test(as));
 assert(!/SocketManager|ExternalInterface|URLRequest|Loader/.test(as));
 // FFDec adds an Embed directive for convenience; the original bitmap tags are instead copied verbatim below.
 assert.equal(as.split('package asset.hall').length,2);
 const compileSource=as.replace(/\s*\[Embed\(source="[^"]+"\)\]/,'').replace('package asset.hall','package workshop.menu.art');assert(!compileSource.includes('[Embed('));
 writeFileSync(resolve(out,'sources/workshop/menu/art',name+'.as'),compileSource,{flag:'wx'});item.originalClassSource={path:'original-classes/scripts/asset/hall/'+name+'.as',sha256:sha(Buffer.from(as)),compileSourceSha256:sha(Buffer.from(compileSource)),onlyChanges:['remove FFDec Embed metadata; original tag is copied verbatim','namespace asset.hall to isolated workshop.menu.art'],constructorUnchanged:true};
}
const compiler=resolve(P,spec.compiler.path),player=resolve(P,spec.player.path);
pinned(compiler,spec.compiler.sha256);pinned(player,spec.player.sha256);
// Compc supplies only the reviewed BitmapData classes; no retention/document class or Hall business code.
const gluePath=resolve(out,'menu-art-class-glue.swc'),compileArgs=['-cp',compiler,'flex2.tools.Compc','-load-config=','-compiler.theme=','-compiler.fonts.local-fonts-snapshot=','-compiler.library-path=','-compiler.external-library-path='+player,'-compiler.source-path='+resolve(out,'sources'),'-target-player=11.1','-swf-version=14','-debug=false','-include-classes='+reports.map(x=>x.exportSymbol).join(','),'-output='+gluePath];
const compiled=spawnSync(java,compileArgs,{windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
writeFileSync(resolve(out,'build-logs/flex.log'),String(compiled.stdout??'')+String(compiled.stderr??''),{flag:'wx'});assert.equal(compiled.status,0,compiled.stderr??compiled.error);
const swc=unzipSync(readFileSync(gluePath));assert(swc['library.swf']);const glueBytes=Buffer.from(swc['library.swf']);writeFileSync(resolve(out,'menu-art-class-glue-library.swf'),glueBytes,{flag:'wx'});
const glue=scan(glueBytes),wanted=new Set(reports.map(x=>x.className));
const selected=glue.abcs.filter(a=>a.p.traitBlocks.some(t=>t.owner!=null&&wanted.has(q(a.p,t.owner)))).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
const excluded=glue.abcs.filter(a=>!selected.includes(a));assert.equal(excluded.length,1);assert(/^_[a-f0-9]{64}_flash_display_Sprite$/.test(excluded[0].name),'only Compc-generated root may be excluded');
assert.equal(excluded[0].p.traitBlocks.filter(t=>t.owner!=null).length,1);
const classes=selected.flatMap(a=>a.p.traitBlocks.filter(t=>t.owner!=null).map(t=>q(a.p,t.owner))).sort();
assert.deepEqual(classes,reports.map(x=>x.className).sort());
for(const a of selected){assert(!a.p.strings.some(x=>/SocketManager|ExternalInterface|URLRequest|URLLoader|Christmas|Workshop/.test(x)),'no business/network/loader behavior');}
const header=Buffer.from(sourceSwf.headerPrefix);header.writeUInt16LE(1,header.length-2);
const entries=reports.flatMap(x=>{const id=Buffer.alloc(2);id.writeUInt16LE(x.id);return[id,Buffer.from(x.exportSymbol+'\0')];}),count=Buffer.alloc(2);count.writeUInt16LE(reports.length);
const rawTags=reports.map(x=>readFileSync(resolve(out,x.tagFile))),glueTags=glue.tags.filter(t=>t.code===82),library=compressSwf('CWS',15,Buffer.concat([header,sourceSwf.tags.find(t=>t.code===69).raw,...rawTags,...selected.map(a=>glueTags[glue.abcs.indexOf(a)].raw),buildTag(76,Buffer.concat([count,...entries])),buildTag(1,Buffer.alloc(0)),buildTag(0,Buffer.alloc(0))]));
const libPath=resolve(out,spec.art.file);writeFileSync(libPath,library,{flag:'wx'});const checked=scan(library);
assert.deepEqual(originalSymbols(checked),reports.map(x=>({id:x.id,name:x.exportSymbol})));assert.equal(checked.abcs.length,18);assert(!originalSymbols(checked).some(x=>x.id===0));assert.equal(checked.tags.filter(t=>[35,36].includes(t.code)).length,18);assert.deepEqual(checked.abcs.flatMap(a=>a.p.traitBlocks.filter(t=>t.owner!=null).map(t=>q(a.p,t.owner))).sort(),classes);
for(const x of reports){const tag=checked.tags.find(t=>t.code===x.tagCode&&checked.body.readUInt16LE(t.bodyStart)===x.id);assert.equal(sha(tag.raw),x.tagSha256);const body=checked.body.subarray(tag.bodyStart,tag.bodyEnd);const rawAlpha=x.tagCode===35?inflateSync(body.subarray(6+body.readUInt32LE(2))):Buffer.from(inflateSync(body.subarray(7)).filter((_,i)=>i%4===0));assert.equal(sha(rawAlpha),x.alphaSha256,'independent alpha re-extraction');}

const xml='<components>\n'+reports.filter(x=>x.style).map(x=>'  '+x.styleSource.xml).join('\n')+'\n</components>\n';writeFileSync(resolve(out,'original-activity-menu-styles.xml'),xml,{flag:'wx'});
// Contact sheet is a labelled static montage of decoded original pixels, never a runtime acceptance screenshot.
const sheet=createCanvas(900,650),ctx=sheet.getContext('2d');ctx.fillStyle='#20232a';ctx.fillRect(0,0,sheet.width,sheet.height);ctx.textAlign='center';ctx.fillStyle='#f7e4bc';ctx.font='20px "Microsoft YaHei"';ctx.fillText('原活动菜单素材 · 17个原图标 + 原背景',450,30);
for(let i=0;i<reports.length;i++){
 const x=reports[i],col=i%6,row=Math.floor(i/6),px=col*150,py=50+row*190;
 ctx.fillStyle='#30343c';ctx.fillRect(px+5,py,140,180);const im=await loadImage(readFileSync(resolve(out,x.png.file)));ctx.drawImage(im,px+75-x.width/2,py+8);
 ctx.fillStyle='#f2d387';ctx.font='14px "Microsoft YaHei"';ctx.fillText(x.label,px+75,py+102);ctx.fillStyle='#ddd';ctx.font='11px Arial';ctx.fillText(x.symbol.split('.').at(-1),px+75,py+124);ctx.fillText(x.width+' × '+x.height+' | tag '+x.tagCode,px+75,py+142);ctx.fillText(x.kind,px+75,py+160);
}
ctx.fillStyle='#bdc1cb';ctx.font='12px "Microsoft YaHei"';ctx.fillText('本图仅为原件像素联系表；没有在游戏中加载或安装。原图中文标题保持不变。',450,640);
const sheetBytes=sheet.toBuffer('image/png');writeFileSync(resolve(out,'original-menu-contact-sheet.png'),sheetBytes,{flag:'wx'});
const manifest={version:1,kind:'original-activity-menu-art-candidate',createdAt:new Date().toISOString(),source:{path:sourcePath,bytes:source.length,sha256:sha(source)},styleSource:{path:stylesPath,bytes:stylesBytes.length,sha256:sha(stylesBytes),entry:'coreI.xml'},originalHallOwner:{path:originalHallAs,sha256:sha(Buffer.from(hallSource))},rows:reports,library:{file:spec.art.file,urlPath:spec.art.urlPath,path:libPath,bytes:library.length,sha256:sha(library),classCount:classes.length,classes,documentClass:false,bitmapCount:18,originalRawTagsPreserved:18},contactSheet:{file:'original-menu-contact-sheet.png',bytes:sheetBytes.length,sha256:sha(sheetBytes),width:900,height:650,staticMontageOnly:true},background:{symbol:'asset.hall.activeBg',originalSize:[70,61],originalHall:{sizeGrid:'34,30,34,30',sizeGridOrder:spec.background.sizeGridOrder,centerSize:spec.background.centerSize,width:330,height:'100+80*lastRowIndex'},notGameCapture:true},compilation:{ffdecExit:result.status,flexExit:compiled.status,sourceClassesAreOriginalDecompilation:true,pixelTagsCopiedVerbatim:true,originalHallBusinessAbcImported:false},network:false,installed:false,runtimeValidated:false,limitations:['The minimal SWF supplies only 18 original BitmapData classes, no document class and no original Hall network/business logic.','Root must integrate the library/style loading and validate actual class-domain visibility and disposal.','Original labels are baked into the icon pixels; do not paint a second dynamic caption over them.','Decoding JPEG may differ slightly across decoders for PNG preview only; the SWF preserves original JPEG/alpha and Lossless2 tag bytes exactly.','Static montage is not AVM2/runtime rendering proof.']};
writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
const manifestPath=resolve(out,'manifest.json');return {art:manifest.library,manifest,manifestPath,outputDir:out};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=await buildNativeMenuArt({outputDir:process.argv[2],projectRoot:process.argv[3]??Pdefault,javaPath:process.argv[4]??undefined});console.log(JSON.stringify({art:result.art,manifestPath:result.manifestPath,installed:false,runtimeValidated:false},null,2));}
