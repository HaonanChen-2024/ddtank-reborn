// Optional ACT-03A consumer. 117 invalidates; authenticated UserCalendar remains the only state authority.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ByteReader, buildTag, compressSwf, decompressSwf, encodeU30, parseTags } from "./lib.mjs";
import { parseActivityAbc } from "./activity-response.mjs";
import { patchActivityState } from "./activity-state.mjs";

const TAG = "calendar/view/ActivityState", BASE = "f1e37078289eacf3931be73f15ed467e047bd83cf662926e0f0df4fd930b3102";
const GOODS = "calendar/view/goodsExchange/GoodsExchangeView", GOODS_BASE = "507a97a003a477c77bd4d7d50e4fa39f6c6e85c9bd57acfa8361aa07e8c79213";
const MARKER = "_exchangeRefreshLoader", sha = bytes => createHash("sha256").update(bytes).digest("hex");
const u = encodeU30, b = value => Buffer.from([value]), cat = (...parts) => Buffer.concat(parts);
const TARGETS = new Map([[1, [1, 2]], [3, [3, 1]], [12, [3, 2]], [15, [3, 1]]]);

// Decode exact methods, including original debug records; no byte-pattern instruction search.
export function decodeExchangeCode(code) {
  const r = new ByteReader(code), list = [];
  while (r.pos < code.length) {
    const offset = r.pos, op = r.bytes(1)[0], args = [];
    if (op >= 0x0c && op <= 0x1a) args.push(r.bytes(3).readIntLE(0, 3));
    else if ([0x08,0x25,0x2c,0x42,0x49,0x58,0x5a,0x5d,0x5e,0x60,0x61,0x62,0x63,0x66,0x68,0x6c,0x6d,0x80,0xc2,0xf0,0xf1].includes(op)) args.push(r.u30());
    else if ([0x46,0x4a,0x4f].includes(op)) args.push(r.u30(), r.u30());
    else if ([0x24,0x65].includes(op)) args.push(r.bytes(1)[0]);
    else if (op === 0xef) args.push(r.bytes(1)[0],r.u30(),r.bytes(1)[0],r.u30());
    else assert.ok([0x09,0x20,0x26,0x27,0x29,0x2a,0x30,0x47,0x48,0x73,0x76,0x82,0x85,0x87,0x96,0xa0,0xa1,0xab,0xd0,0xd1,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7].includes(op), `unsupported exchange opcode ${op.toString(16)}`);
    list.push({offset,op,args,end:r.pos});
  }
  const byOffset = new Map(list.map(i => [i.offset,i]));
  for (const i of list) if (i.op >= 0x0c && i.op <= 0x1a) {
    const target = i.end + i.args[0]; assert.ok(byOffset.has(target), "exchange branch target is not an instruction");
    if (i.args[0] < 0) assert.equal(code[target], 0x09, "AVM2 backward branch requires Label");
  }
  return list;
}
function assembler() {
  const parts = [], labels = new Map(), jumps = []; let size = 0;
  return {
    op(op,...args) { const bytes=cat(b(op),...args.map(u)); parts.push(bytes);size+=bytes.length; },
    label(name) { assert.ok(!labels.has(name));labels.set(name,size); },
    jump(op,name) { jumps.push({offset:size,name});parts.push(cat(b(op),Buffer.alloc(3)));size+=4; },
    finish() {const bytes=cat(...parts);for(const j of jumps){assert.ok(labels.has(j.name));bytes.writeIntLE(labels.get(j.name)-j.offset-4,j.offset+1,3);}return bytes;},
  };
}
const make = fn => {const a=assembler();fn(a);return a.finish();};
const self = (a, field) => {a.op(0xd0);a.op(0x66,field);};
const manager = a => {a.op(0x60,70);a.op(0x46,71,0);};
const currentUser = (a,n) => {a.op(0x60,35);a.op(0x66,6);a.op(0x66,36);a.op(0x66,n.ID);};
const writeSelf = (a,field,op) => {a.op(0xd0);a.op(op);a.op(0x61,field);};
function eligible(a,n,done) {
  self(a,14);a.jump(0x12,done); self(a,59);a.jump(0x12,done);
  self(a,n._exchangeViewOwner);a.op(0x24,0);a.jump(0x16,done);
  self(a,n._exchangeViewOwner);currentUser(a,n);a.jump(0x14,done);
  self(a,n._exchangeViewOwner);manager(a);a.op(0x66,n.calendarStateUserId);a.jump(0x14,done);
  for(const [field,value] of [[74,1],[77,6],[n.IsOnly,1]]){self(a,59);a.op(0x66,field);a.op(0x24,value);a.jump(0x14,done);}
}
function loaderListeners(a,n,add) {
  for(const event of [84,82]){a.op(0xd2);a.op(0x60,81);a.op(0x66,event);self(a,n.__exchangeStateComplete);a.op(0x4f,add?24:52,2);}
}
function socketListener(a,n,add) {
  a.op(0x60,57);a.op(0x66,6);a.op(0x60,n.CrazyTankSocketEvent);a.op(0x66,n.MAIL_RESPONSE);
  self(a,n.__exchangeStateRefresh);a.op(0x4f,add?24:52,2);
}
function additions(n) {
  const refresh = make(a => {
    a.op(0xd0);a.op(0x30);eligible(a,n,"done");self(a,59);a.op(0x66,88);a.jump(0x11,"done");
    self(a,n._exchangeRefreshLoader);a.jump(0x12,"request");
    writeSelf(a,n._exchangeRefreshAgain,0x26);a.jump(0x10,"done");
    a.label("request");manager(a);a.op(0x46,n.request,0);a.op(0x80,73);a.op(0xd6);
    a.op(0xd0);a.op(0xd2);a.op(0x61,n._exchangeRefreshLoader);loaderListeners(a,n,true);
    a.label("done");a.op(0x47);
  });
  const complete = make(a => {
    a.op(0xd0);a.op(0x30);a.op(0xd1);a.op(0x66,51);a.op(0x80,73);a.op(0xd6);loaderListeners(a,n,false);
    self(a,n._exchangeRefreshLoader);a.op(0xd2);a.jump(0x14,"done");
    writeSelf(a,n._exchangeRefreshLoader,0x20);self(a,n._exchangeRefreshAgain);a.op(0xd7);writeSelf(a,n._exchangeRefreshAgain,0x27);
    eligible(a,n,"done");self(a,14);self(a,59);a.op(0x66,88);a.op(0x96);a.op(0x61,69);
    // Never rebuild selected materials on false/error. True was merged by the existing authenticated analyzer.
    self(a,59);a.op(0x66,88);a.jump(0x12,"again");self(a,86);a.jump(0x12,"again");
    self(a,86);a.op(0x4f,n.refreshExchangeState,0);
    a.label("again");a.op(0xd3);a.jump(0x12,"done");a.op(0xd0);a.op(0x20);a.op(0x4f,n.__exchangeStateRefresh,1);
    a.label("done");a.op(0x47);
  });
  const owner = make(a => {a.op(0xd0);currentUser(a,n);a.op(0x61,n._exchangeViewOwner);a.op(0xd0);self(a,18);a.op(0x66,92);a.op(0x61,n._exchangeDetailHeight);});
  const listen = make(a => socketListener(a,n,true));
  const request = make(a => {a.op(0xd0);a.op(0x20);a.op(0x4f,n.__exchangeStateRefresh,1);});
  const cleanup = make(a => {
    socketListener(a,n,false);self(a,n._exchangeRefreshLoader);a.op(0xd6);a.op(0xd2);a.jump(0x12,"clear");loaderListeners(a,n,false);
    a.label("clear");writeSelf(a,n._exchangeRefreshLoader,0x20);writeSelf(a,n._exchangeRefreshAgain,0x27);
    a.op(0xd0);a.op(0x24,0);a.op(0x61,n._exchangeViewOwner);
  });
  // VBox owns child y positions. Reparent only material exchanges before the original viewport invalidation.
  // Save/restore the actual original height instead of imposing a guessed ordinary-activity geometry.
  const layout = make(a => {
    self(a,59);a.jump(0x12,"ordinary");self(a,59);a.op(0x66,74);a.op(0x24,1);a.jump(0x14,"ordinary");self(a,86);a.jump(0x12,"ordinary");
    self(a,59);a.op(0x66,n.goodsExchangeInfos);a.jump(0x12,"ordinary");self(a,59);a.op(0x66,n.goodsExchangeInfos);a.op(0x66,n.length);a.op(0x24,1);a.jump(0x14,"ordinary");
    self(a,18);a.op(0x60,98);a.op(0x2c,n.detailStyle);a.op(0x46,n.creatPoint,1);a.op(0x66,n.y);a.op(0x61,92);
    self(a,86);a.op(0x66,101);a.op(0xd0);a.jump(0x13,"fixedPos");
    // Native addChild reparents only the display list. Explicitly dispatch removeChild so
    // BoxContainer also removes its private _childrenList entry before deferred VBox.arrange.
    self(a,86);a.op(0x66,101);a.jump(0x12,"addFixed");self(a,86);a.op(0x66,101);self(a,86);a.op(0x4f,102,1);
    a.label("addFixed");a.op(0xd0);self(a,86);a.op(0x4f,9,1);
    a.label("fixedPos");a.op(0x60,98);self(a,86);a.op(0x2c,n.fixedStyle);a.op(0x4f,99,2);a.jump(0x10,"done");
    a.label("ordinary");self(a,18);self(a,n._exchangeDetailHeight);a.op(0x61,92);self(a,86);a.jump(0x12,"done");
    self(a,86);a.op(0x66,101);self(a,17);a.jump(0x13,"done");
    self(a,86);a.op(0x66,101);a.jump(0x12,"addOrdinary");self(a,86);a.op(0x66,101);self(a,86);a.op(0x4f,102,1);
    a.label("addOrdinary");self(a,17);self(a,86);a.op(0x4f,9,1);
    a.op(0x60,98);self(a,86);a.op(0x2c,145);a.op(0x4f,99,2);a.label("done");
  });
  return {refresh,complete,edits:new Map([[1,[[32,owner]]],[3,[[85,listen]]],[12,[[283,layout],[293,request]]],[15,[[91,cleanup]]]])};
}
function insert(code,points) {
  const list=decodeExchangeCode(code), result=cat(...points.reduce((parts,[at,bytes],i)=>[...parts,code.subarray(i?points[i-1][0]:0,at),bytes],[]),code.subarray(points.at(-1)?.[0]??0));
  const shift = at => at + points.filter(([n])=>n<=at).reduce((sum,[,bytes])=>sum+bytes.length,0);
  for(const i of list)if(i.op>=0x0c&&i.op<=0x1a)result.writeIntLE(shift(i.end+i.args[0])-shift(i.offset)-4,shift(i.offset)+1,3);
  decodeExchangeCode(result);return result;
}
function restore(code,points) {
  let result=Buffer.from(code), delta=0;const locations=[];
  for(const [at,bytes]of points){const start=at+delta;assert.deepEqual(code.subarray(start,start+bytes.length),bytes,"unknown exchange insertion");locations.push([start,bytes.length]);delta+=bytes.length;}
  const unshift = at => at-locations.filter(([start,length])=>start+length<=at).reduce((sum,[,length])=>sum+length,0);
  for(const i of decodeExchangeCode(code))if(i.op>=0x0c&&i.op<=0x1a&&!locations.some(([start,length])=>i.offset>=start&&i.offset<start+length))result.writeIntLE(unshift(i.end+i.args[0])-unshift(i.offset)-4,i.offset+1,3);
  for(const [start,length]of [...locations].reverse())result=cat(result.subarray(0,start),result.subarray(start+length));
  decodeExchangeCode(result);return result;
}
function replace(bytes,changes) {let result=bytes,previous=bytes.length;for(const e of changes.sort((a,b)=>b.start-a.start)){assert.ok(e.end<=previous);previous=e.start;result=cat(result.subarray(0,e.start),e.bytes,result.subarray(e.end));}return result;}
const stringPool = strings => cat(u(strings.length),...strings.slice(1).map(text=>{const value=Buffer.from(text);return cat(u(value.length),value);}));
const qname = (ns,name) => cat(b(7),u(ns),u(name));
function methodEnd(bytes,p) {
  const r=new ByteReader(bytes);r.pos=p.namePoolEnd;const count=r.u30();assert.equal(count,p.methods.length);
  for(let i=0;i<count;i++){const argc=r.u30();r.u30();for(let j=0;j<argc;j++)r.u30();r.u30();const flags=r.bytes(1)[0];if(flags&8){const n=r.u30();for(let j=0;j<n;j++){r.u30();r.bytes(1);}}if(flags&128)for(let j=0;j<argc;j++)r.u30();}
  return r.pos;
}
function body(method,code,maxStack,locals,scope=9) {return cat(u(method),u(maxStack),u(locals),u(scope),u(scope+1),u(code.length),code,u(0),u(0));}
function pool(p) {
  const strings=p.strings.slice(0,205), names=[], n={}, put=(text,ns=2)=>{const name=strings.length;strings.push(text);n[text]=118+names.length;names.push(qname(ns,name));};
  for(const text of [MARKER,"_exchangeRefreshAgain","_exchangeViewOwner","_exchangeDetailHeight","__exchangeStateRefresh","__exchangeStateComplete"])put(text,1);
  for(const text of ["ID","calendarStateUserId","IsOnly","request","Boolean","Number","creatPoint","y","refreshExchangeState","goodsExchangeInfos","length"])put(text);
  const namespaceName=strings.length;strings.push("ddt.events");put("CrazyTankSocketEvent",21);put("MAIL_RESPONSE");
  const methodNames=["calendar.view:ActivityState/private:__exchangeStateRefresh","calendar.view:ActivityState/private:__exchangeStateComplete"].map(text=>{strings.push(text);return strings.length-1;});
  n.detailStyle=strings.length;strings.push("Calendar.Activity.ExchangeDetailSize");n.fixedStyle=strings.length;strings.push("Calendar.Activity.ExchangeFixedPos");
  const traits=cat(...[[n[MARKER],73],[n._exchangeRefreshAgain,n.Boolean],[n._exchangeViewOwner,103],[n._exchangeDetailHeight,n.Number]].map(([name,type])=>cat(u(name),b(0),u(0),u(type),u(0))),
    ...[[n.__exchangeStateRefresh,18],[n.__exchangeStateComplete,19]].map(([name,method])=>cat(u(name),b(1),u(0),u(method))));
  const methods=cat(...methodNames.map((name,i)=>cat(u(1),u(20),u(i?81:29),u(name),b(0))));
  return {strings,n,nameCount:118+names.length,names:cat(...names),namespace:cat(b(22),u(namespaceName)),traits,methods};
}
function patchAbc(bytes) {
  let p=parseActivityAbc(bytes);const state=p.strings.includes(MARKER), spec=pool(p), extra=additions(spec.n);
  const block=p.traitBlocks.find(t=>t.owner===112);assert.ok(block);assert.equal(p.strings[p.names[112].name],"ActivityState");
  if(state){
    assert.equal(p.methods.length,20);assert.equal(p.bodies.length,20);assert.equal(p.names.length,spec.nameCount);assert.equal(p.namespaces.length,22);
    assert.deepEqual(p.strings,spec.strings);assert.equal(block.count,32);
    assert.deepEqual(bytes.subarray(block.end-spec.traits.length,block.end),spec.traits);
    assert.deepEqual(bytes.subarray(p.namePoolEnd-spec.names.length,p.namePoolEnd),spec.names);
    assert.deepEqual(bytes.subarray(p.namespacePoolEnd-spec.namespace.length,p.namespacePoolEnd),spec.namespace);
    const end=methodEnd(bytes,p);assert.deepEqual(bytes.subarray(end-spec.methods.length,end),spec.methods);
    for(const [index,code,locals]of [[18,extra.refresh,3],[19,extra.complete,4]]){const target=p.bodies.find(x=>x.method===index);assert.deepEqual(bytes.subarray(target.start,target.end),body(index,code,3,locals));}
    const firstNew=p.bodies.find(x=>x.method===18), countAt=p.bodies[0].start-u(20).length;
    const changes=[
      {start:p.stringCountOffset,end:p.stringPoolEnd,bytes:stringPool(p.strings.slice(0,205))},
      {start:p.namespaceCountOffset,end:p.namespacePoolEnd,bytes:cat(u(21),bytes.subarray(p.namespaceDataOffset,p.namespacePoolEnd-spec.namespace.length))},
      {start:p.nameCountOffset,end:p.namePoolEnd,bytes:cat(u(118),bytes.subarray(p.nameDataOffset,p.namePoolEnd-spec.names.length))},
      {start:p.namePoolEnd,end,bytes:cat(u(18),bytes.subarray(p.namePoolEnd+u(20).length,end-spec.methods.length))},
      {start:block.countOffset,end:block.end,bytes:cat(u(26),bytes.subarray(block.dataOffset,block.end-spec.traits.length))},
      {start:countAt,end:p.bodies[0].start,bytes:u(18)}, {start:firstNew.start,end:bytes.length,bytes:Buffer.alloc(0)},
    ];
    for(const [method,points]of extra.edits){const target=p.bodies.find(x=>x.method===method);changes.push({start:target.start,end:target.end,bytes:body(method,restore(target.code,points),...TARGETS.get(method))});}
    const original=replace(bytes,changes);assert.equal(sha(original),BASE,"unknown exchange base or metadata");
    assert.deepEqual(patchAbc(original).out,bytes,"unknown exchange patch bytes");return {out:bytes,changed:false};
  }
  assert.equal(sha(bytes),BASE,"unknown ActivityState base; preserve existing bytes");assert.equal(p.methods.length,18);assert.equal(block.count,26);
  const end=methodEnd(bytes,p),countAt=p.bodies[0].start-u(18).length;
  const changes=[
    {start:p.stringCountOffset,end:p.stringPoolEnd,bytes:stringPool(spec.strings)},
    {start:p.namespaceCountOffset,end:p.namespacePoolEnd,bytes:cat(u(22),bytes.subarray(p.namespaceDataOffset,p.namespacePoolEnd),spec.namespace)},
    {start:p.nameCountOffset,end:p.namePoolEnd,bytes:cat(u(spec.nameCount),bytes.subarray(p.nameDataOffset,p.namePoolEnd),spec.names)},
    {start:p.namePoolEnd,end,bytes:cat(u(20),bytes.subarray(p.namePoolEnd+u(18).length,end),spec.methods)},
    {start:block.countOffset,end:block.end,bytes:cat(u(32),bytes.subarray(block.dataOffset,block.end),spec.traits)},
    {start:countAt,end:p.bodies[0].start,bytes:u(20)},
    {start:bytes.length,end:bytes.length,bytes:cat(body(18,extra.refresh,3,3),body(19,extra.complete,3,4))},
  ];
  for(const [method,points]of extra.edits){const target=p.bodies.find(x=>x.method===method);assert.equal(target.exceptions,0);const [stack,locals]=TARGETS.get(method);changes.push({start:target.start,end:target.end,bytes:body(method,insert(target.code,points),Math.max(stack,3),method===15?3:locals)});}
  const out=replace(bytes,changes);p=parseActivityAbc(out);assert.equal(p.methods.length,20);
  for(const target of p.bodies.filter(x=>TARGETS.has(x.method)||x.method>=18))decodeExchangeCode(target.code);
  return {out,changed:true};
}

function goodsSpec(p) {
  const strings=p.strings.slice(0,173), n={}, names=[];
  for(const text of ["refreshExchangeState","ActiveType","HasKey","IsOnly","isAttend","text"]){n[text]=98+names.length;names.push(qname(4,strings.length));strings.push(text);}
  for(const text of ["_exchangeTitleHeight","_exchangeExplainWidth","_exchangeExplainHeight"]){n[text]=98+names.length;names.push(qname(1,strings.length));strings.push(text);}
  n.Number=98+names.length;names.push(qname(4,strings.length));strings.push("Number");
  for(const text of ["getBounds","bottom"]){n[text]=98+names.length;names.push(qname(4,strings.length));strings.push(text);}
  const success=strings.length;strings.push("tank.calendar.Activity.GetResult0");
  const normal=strings.indexOf("calendar.view.GoodsExchangeView.explain");assert.ok(normal>0);
  const methodName=strings.length;strings.push("calendar.view.goodsExchange:GoodsExchangeView/refreshExchangeState");
  const pos=strings.length;strings.push("CalendarGrid.GoodsExchangeView.CompactPos");
  const title=strings.length;strings.push("CalendarGrid.GoodsExchangeView.CompactTitleSize");
  const explain=strings.length;strings.push("CalendarGrid.GoodsExchangeView.CompactExplainSize");
  const code=make(a=>{
    a.op(0xd0);a.op(0x30);self(a,41);a.jump(0x12,"done");self(a,8);a.jump(0x12,"done");
    a.op(0x2c,normal);a.op(0xd5);
    for(const [field,value]of [[n.ActiveType,1],[n.HasKey,6],[n.IsOnly,1]]){self(a,41);a.op(0x66,field);a.op(0x24,value);a.jump(0x14,"text");}
    self(a,41);a.op(0x66,n.isAttend);a.jump(0x12,"text");a.op(0x2c,success);a.op(0xd5);
    a.label("text");self(a,8);a.op(0x60,4);a.op(0xd1);a.op(0x46,5,1);a.op(0x61,n.text);
    // Original updatePos remains intact. Its normal coordinates are already computed by setData/update.
    // The presentation-only refresh never calls createCell or replaces selected BagCell links.
    for(const [object,field,saved]of [[7,53,n._exchangeTitleHeight],[8,49,n._exchangeExplainWidth],[8,53,n._exchangeExplainHeight]]){self(a,object);self(a,saved);a.op(0x61,field);}
    self(a,41);a.op(0x66,n.ActiveType);a.op(0x24,1);a.jump(0x14,"done");self(a,41);a.op(0x66,42);a.jump(0x12,"done");self(a,41);a.op(0x66,42);a.op(0x66,46);a.op(0x24,1);a.jump(0x14,"done");
    a.op(0x60,50);a.op(0x2c,pos);a.op(0x46,51,1);a.op(0xd6);
    // SimpleTileList.height is a logical layout size, not the drawn cell/background bottom.
    // Read actual bounds in this view's coordinates on every refresh; never add to a previous y.
    self(a,10);self(a,14);a.op(0xd0);a.op(0x46,n.getBounds,1);a.op(0x66,n.bottom);self(a,10);a.op(0x66,53);a.op(0xa1);a.op(0xd2);a.op(0x66,52);a.op(0xa0);a.op(0x61,52);
    self(a,8);self(a,14);a.op(0xd0);a.op(0x46,n.getBounds,1);a.op(0x66,n.bottom);a.op(0x24,2);a.op(0xa0);a.op(0x61,52);
    self(a,7);a.op(0x60,50);a.op(0x2c,title);a.op(0x46,51,1);a.op(0x66,52);a.op(0x61,53);
    a.op(0x60,50);a.op(0x2c,explain);a.op(0x46,51,1);a.op(0xd6);
    self(a,8);a.op(0xd2);a.op(0x66,48);a.op(0x61,49);self(a,8);a.op(0xd2);a.op(0x66,52);a.op(0x61,53);
    a.label("done");a.op(0x47);
  });
  const addition=make(a=>{a.op(0xd0);a.op(0x4f,n.refreshExchangeState,0);});
  const owner=make(a=>{for(const [object,field,saved]of [[7,53,n._exchangeTitleHeight],[8,49,n._exchangeExplainWidth],[8,53,n._exchangeExplainHeight]]){a.op(0xd0);self(a,object);a.op(0x66,field);a.op(0x61,saved);}});
  const trait=cat(...[n._exchangeTitleHeight,n._exchangeExplainWidth,n._exchangeExplainHeight].map(name=>cat(u(name),b(0),u(0),u(n.Number),u(0))),cat(u(n.refreshExchangeState),b(1),u(0),u(16)));
  return {strings,n,nameCount:98+names.length,names:cat(...names),method:cat(u(0),u(27),u(methodName),b(0)),trait,code,addition,owner};
}
function patchGoods(bytes) {
  const p=parseActivityAbc(bytes), patched=p.strings.includes("refreshExchangeState"), spec=goodsSpec(p);
  const block=p.traitBlocks.find(t=>t.owner===90), target=p.bodies.find(x=>x.method===10), constructor=p.bodies.find(x=>x.method===1);assert.ok(block&&target&&constructor);
  const end=methodEnd(bytes,p), countAt=p.bodies[0].start-u(p.bodies.length).length;
  if(patched){
    assert.equal(p.methods.length,17);assert.equal(p.bodies.length,17);assert.equal(p.names.length,spec.nameCount);assert.equal(block.count,25);assert.deepEqual(p.strings,spec.strings);
    assert.deepEqual(bytes.subarray(p.namePoolEnd-spec.names.length,p.namePoolEnd),spec.names);
    assert.deepEqual(bytes.subarray(end-spec.method.length,end),spec.method);assert.deepEqual(bytes.subarray(block.end-spec.trait.length,block.end),spec.trait);
    const added=p.bodies.find(x=>x.method===16);assert.deepEqual(bytes.subarray(added.start,added.end),body(16,spec.code,3,3));
    const original=replace(bytes,[
      {start:p.stringCountOffset,end:p.stringPoolEnd,bytes:stringPool(p.strings.slice(0,173))},
      {start:p.nameCountOffset,end:p.namePoolEnd,bytes:cat(u(98),bytes.subarray(p.nameDataOffset,p.namePoolEnd-spec.names.length))},
      {start:p.namePoolEnd,end,bytes:cat(u(16),bytes.subarray(p.namePoolEnd+u(17).length,end-spec.method.length))},
      {start:block.countOffset,end:block.end,bytes:cat(u(21),bytes.subarray(block.dataOffset,block.end-spec.trait.length))},
      {start:countAt,end:p.bodies[0].start,bytes:u(16)},
      {start:target.start,end:target.end,bytes:body(10,restore(target.code,[[36,spec.addition]]),3,2)},
      {start:constructor.start,end:constructor.end,bytes:body(1,restore(constructor.code,[[27,spec.owner]]),1,1)},
      {start:added.start,end:bytes.length,bytes:Buffer.alloc(0)},
    ]);
    assert.equal(sha(original),GOODS_BASE,"unknown GoodsExchangeView base or metadata");assert.deepEqual(patchGoods(original).out,bytes);return {out:bytes,changed:false};
  }
  assert.equal(sha(bytes),GOODS_BASE,"unknown GoodsExchangeView base; preserve existing bytes");
  const out=replace(bytes,[
    {start:p.stringCountOffset,end:p.stringPoolEnd,bytes:stringPool(spec.strings)},
    {start:p.nameCountOffset,end:p.namePoolEnd,bytes:cat(u(spec.nameCount),bytes.subarray(p.nameDataOffset,p.namePoolEnd),spec.names)},
    {start:p.namePoolEnd,end,bytes:cat(u(17),bytes.subarray(p.namePoolEnd+u(16).length,end),spec.method)},
    {start:block.countOffset,end:block.end,bytes:cat(u(25),bytes.subarray(block.dataOffset,block.end),spec.trait)},
    {start:countAt,end:p.bodies[0].start,bytes:u(17)},
    {start:target.start,end:target.end,bytes:body(10,insert(target.code,[[36,spec.addition]]),3,2)},
    {start:constructor.start,end:constructor.end,bytes:body(1,insert(constructor.code,[[27,spec.owner]]),2,1)},
    {start:bytes.length,end:bytes.length,bytes:body(16,spec.code,3,3)},
  ]);
  parseActivityAbc(out);decodeExchangeCode(spec.code);return {out,changed:true};
}

export function patchExchangeState(input) {
  assert.equal(patchActivityState(input).changed,false,"exchange-state requires installed activity-response and activity-state first");
  const swf=decompressSwf(input);assert.equal(swf.error,null);assert.equal(input.readUInt32LE(4),swf.body.length+8);
  const parsed=parseTags(swf.body);const found=new Set();let changed=false;const proof=[];
  const tags=parsed.tags.map(tag=>{
    if(tag.code!==82)return tag.raw;
    const payload=swf.body.subarray(tag.bodyStart,tag.bodyEnd),r=new ByteReader(payload);r.u32();const name=r.cstring();if(![TAG,GOODS].includes(name))return tag.raw;
    assert.ok(!found.has(name));found.add(name);const bytes=payload.subarray(r.pos), result=name===TAG?patchAbc(bytes):patchGoods(bytes);changed||=result.changed;
    const before=parseActivityAbc(bytes),after=parseActivityAbc(result.out);
    const changedMethod=method=>name===TAG?(TARGETS.has(method)||method>=18):[1,10,16].includes(method);
    for(const old of before.bodies.filter(x=>!changedMethod(x.method)))assert.deepEqual(after.bodies.find(x=>x.method===old.method).code,old.code,"unrelated exchange method changed");
    proof.push({name,baseAbcSha256:name===TAG?BASE:GOODS_BASE,abcSha256:sha(result.out),methods:after.bodies.filter(x=>changedMethod(x.method)).map(x=>({method:x.method,sha256:sha(x.code),length:x.length,maxStack:x.maxStack,localCount:x.localCount,initialScope:x.initialScope,maxScope:x.maxScope,exceptions:x.exceptionTable}))});
    return result.changed?buildTag(82,cat(payload.subarray(0,r.pos),result.out)):tag.raw;
  });
  assert.equal(found.size,2,"expected exactly one ActivityState and GoodsExchangeView ABC");
  return {out:changed?compressSwf(swf.sig,swf.version,cat(parsed.headerPrefix,...tags,parsed.trailing)):input,changed,methods:proof};
}
