// Pure extraction of the existing room/email bitmap assembly routines.
// Inputs are byte buffers plus reviewed recipes. No paths, filesystem, process, network or installers.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function buildImagePatch(input,recipe,readAsset,{decompressSwf,parseTags,compressSwf,buildTag,encodeBitmap,decodeBitmap,PNG,createCanvas,loadImage}) {
 assert.equal(hash(input),recipe.inputSha256,'bitmap base drift');
 const s=decompressSwf(input);assert.equal(s.error,null);const parsed=parseTags(s.body),changed=new Map(),results=[];
 for(const row of recipe.rows){
  const found=parsed.tags.filter(t=>t.code===row.beforeTagCode&&t.bodyEnd-t.bodyStart>=2&&s.body.readUInt16LE(t.bodyStart)===row.id);assert.equal(found.length,1);const tag=found[0];assert.equal(hash(tag.raw),row.beforeTagSha256);
  let payload;
  if(row.operation==='exact-donor-payload'){
   const donor=await readAsset(row.donorSwf),d=decompressSwf(donor),dt=parseTags(d.body).tags.filter(t=>t.code===row.donorTagCode&&t.bodyEnd-t.bodyStart>=2&&d.body.readUInt16LE(t.bodyStart)===row.donorId);assert.equal(dt.length,1);assert.equal(hash(dt[0].raw),row.donorTagSha256);payload=Buffer.from(d.body.subarray(dt[0].bodyStart,dt[0].bodyEnd));payload.writeUInt16LE(row.id);
  }else{
   const bytes=await readAsset(row.image);assert.equal(hash(bytes),row.image.sha256);
   let im;try{im=await loadImage(bytes);}catch(error){
    // Some source PNG metadata is misclassified by the canvas Buffer loader.
    // Decode/re-encode the same RGBA pixels, then require the original target tag hash below.
    assert(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'fallback accepts PNG only');
    im=await loadImage(PNG.sync.write(PNG.sync.read(bytes)));
   }
   assert.deepEqual([im.width,im.height],row.sourceSize);
   const c=createCanvas(row.width,row.height),ctx=c.getContext('2d');if(row.smoothing){ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality=row.smoothing;}
   ctx.drawImage(im,...row.sourceCrop,...row.drawRect);const rgba=Buffer.from(ctx.getImageData(0,0,c.width,c.height).data);
   if(row.operation==='encode-existing-lossless')payload=encodeBitmap(decodeBitmap(s.body.subarray(tag.bodyStart,tag.bodyEnd)),rgba);
   else{assert.equal(row.operation,'encode-lossless2');const prefix=Buffer.alloc(7);prefix.writeUInt16LE(row.id);prefix[2]=5;prefix.writeUInt16LE(row.width,3);prefix.writeUInt16LE(row.height,5);payload=encodeBitmap({id:row.id,width:row.width,height:row.height,prefix,raw:Buffer.alloc(rgba.length),rgba:Buffer.alloc(rgba.length)},rgba);}
   if(row.outputPngSha256)assert.equal(hash(PNG.sync.write({width:c.width,height:c.height,data:rgba})),row.outputPngSha256,'normalized PNG changed');
  }
  const raw=buildTag(row.afterTagCode,payload);assert.equal(hash(raw),row.afterTagSha256,'output bitmap tag differs');changed.set(tag,raw);results.push({id:row.id,tagSha256:hash(raw)});
 }
 assert.equal(changed.size,recipe.rows.length);const bytes=compressSwf(s.sig,s.version,Buffer.concat([parsed.headerPrefix,...parsed.tags.map(t=>changed.get(t)??t.raw),parsed.trailing]));
 if(recipe.outputSha256)assert.equal(hash(bytes),recipe.outputSha256,'full assembled SWF differs');return {bytes,sha256:hash(bytes),changed:results,nonTargetTagsUnchanged:true};
}
