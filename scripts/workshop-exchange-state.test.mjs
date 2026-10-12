import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ByteReader, buildTag, compressSwf, decompressSwf, parseTags } from "../tools/i18n/abc-strings/lib.mjs";
import { parseActivityAbc, patchActivityResponse } from "../tools/i18n/abc-strings/activity-response.mjs";
import { calendarStatePrefix, patchActivityState } from "../tools/i18n/abc-strings/activity-state.mjs";
import { decodeExchangeCode, patchExchangeState } from "../tools/i18n/abc-strings/exchange-state.mjs";

const original=readFileSync(new URL("../apps/api/assets/flash/2.png",import.meta.url));
const base=patchActivityState(patchActivityResponse(original).out).out, result=patchExchangeState(base);
function abcs(swf){const {body}=decompressSwf(swf), map=new Map();for(const tag of parseTags(body).tags)if(tag.code===82){const r=new ByteReader(body.subarray(tag.bodyStart,tag.bodyEnd));r.u32();const name=r.cstring(),bytes=r.bytes(r.buf.length-r.pos);map.set(name,{bytes,p:parseActivityAbc(bytes)});}return map;}
const before=abcs(base),after=abcs(result.out), viewAbc=after.get("calendar/view/ActivityState").p, goodsAbc=after.get("calendar/view/goodsExchange/GoodsExchangeView").p;

// Execute emitted instructions, including original setData/lifecycle methods. These are isolated objects,
// not a Flash/AVM2 verifier, renderer, server, or duplicate JavaScript state-merge implementation.
function execute(p,code,locals,classes,scopes=[]) {
  const map=new Map(decodeExchangeCode(code).map(i=>[i.offset,i])),stack=[];let pc=0,steps=0,peak=0;
  const name=id=>p.strings[p.names[id]?.name],pop=()=>{assert.ok(stack.length,"underflow");return stack.pop();};
  while(pc<code.length){assert.ok(++steps<10000);const i=map.get(pc);assert.ok(i);pc=i.end;const n=i.args[0];let object,value,args;
    switch(i.op){
      case 0xd0:case 0xd1:case 0xd2:case 0xd3:stack.push(locals[i.op-0xd0]);break;
      case 0xd4:case 0xd5:case 0xd6:case 0xd7:locals[i.op-0xd4]=pop();break;
      case 0x62:stack.push(locals[n]);break;case 0x63:locals[n]=pop();break;
      case 0x60:stack.push(classes[name(n)]);break;
      case 0x5d:case 0x5e:stack.push(name(n) in classes?classes:locals[0]);break;
      case 0x66:if(p.names[n].kind===27){value=pop();object=pop();stack.push(object[value]);}else{object=pop();stack.push(object[name(n)]);}break;
      case 0x61:case 0x68:value=pop();object=pop();object[name(n)]=value;break;
      case 0x46:case 0x4f:args=stack.splice(stack.length-i.args[1]);object=pop();value=object[name(n)](...args);if(i.op===0x46)stack.push(value);break;
      case 0x4a:args=stack.splice(stack.length-i.args[1]);object=pop();stack.push(new object[name(n)](...args));break;
      case 0x49:args=stack.splice(stack.length-n);pop();break;
      case 0x65:stack.push(scopes[n]);break;case 0x6c:object=pop();stack.push(object[n]);break;
      case 0x30:scopes.push(pop());break;case 0x2a:value=pop();stack.push(value,value);break;
      case 0x87:pop();value=pop();stack.push(value);break;
      case 0x20:stack.push(null);break;case 0x26:stack.push(true);break;case 0x27:stack.push(false);break;
      case 0x24:case 0x25:stack.push(n);break;case 0x2c:stack.push(p.strings[n]);break;
      case 0x29:pop();break;case 0x96:stack.push(!pop());break;case 0x73:stack.push(Number(pop())|0);break;
      case 0x76:stack.push(Boolean(pop()));break;case 0x85:stack.push(String(pop()));break;
      case 0xab:value=pop();stack.push(pop()===value);break;case 0xa0:value=pop();stack.push(pop()+value);break;case 0xa1:value=pop();stack.push(pop()-value);break;
      case 0x10:pc+=n;break;case 0x11:if(pop())pc+=n;break;case 0x12:if(!pop())pc+=n;break;
      case 0x13:value=pop();if(pop()===value)pc+=n;break;case 0x14:value=pop();if(pop()!==value)pc+=n;break;
      case 0x16:value=pop();if(pop()<=value)pc+=n;break;case 0x18:value=pop();if(pop()>=value)pc+=n;break;
      case 0xc2:locals[n]++;break;case 0x47:pc=code.length;break;
      case 0xf0:case 0xf1:case 0xef:case 0x80:case 0x82:case 0x09:break;
      default:assert.fail(`fixture missing ${i.op.toString(16)}`);
    }peak=Math.max(peak,stack.length);
  }assert.equal(stack.length,0);return {peak,locals:locals.length};
}
function run(p,method,object,args,classes){const body=p.bodies.find(x=>x.method===method),out=execute(p,body.code,[object,...args],classes);assert.ok(out.peak<=body.maxStack,`method ${method} stack`);assert.ok(out.locals<=body.localCount);}
class Emitter {
  listeners=new Map();
  addEventListener(type,fn){const set=this.listeners.get(type)??new Set();set.add(fn);this.listeners.set(type,set);}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  emit(type,event={}){const value=Object.defineProperties({currentTarget:this},Object.getOwnPropertyDescriptors(event));for(const fn of [...(this.listeners.get(type)??[])])fn(value);}
  count(){return [...this.listeners.values()].reduce((n,s)=>n+s.size,0);}
}
function fixture(mode={}){
  const item={ActiveID:100003,ActiveType:1,HasKey:6,IsOnly:1,isAttend:false,goodsExchangeInfos:[{}],Title:"local exchange",...mode};
  const socket=new Emitter(),self={ID:31},loaders=[],points={
    "Calendar.Activity.ExchangeDetailSize":{x:414,y:236},"Calendar.Activity.ExchangeFixedPos":{x:57,y:300},
    "CalendarGrid.GoodsExchangeView.GoodsExchangeViewPos":{x:11,y:222},"CalendarGrid.GoodsExchangeView.CompactPos":{x:25,y:0},
    "CalendarGrid.GoodsExchangeView.CompactTitleSize":{x:300,y:22},"CalendarGrid.GoodsExchangeView.CompactExplainSize":{x:350,y:28},
  };
  const manager={calendarStateUserId:31,_eventActives:[item],get eventActives(){return this._eventActives;},request(){const loader=new Emitter();loaders.push(loader);return loader;}};
  const classes={PlayerManager:{Instance:{Self:self}},CalendarManager:{getInstance:()=>manager},SocketManager:{Instance:socket},
    CrazyTankSocketEvent:{MAIL_RESPONSE:"mail"},LoaderEvent:{COMPLETE:"complete",LOAD_ERROR:"error"},MouseEvent:{CLICK:"click"},Event:{CHANGE:"change"},
    ActiveEventsInfo:{COMMON:0,PICC:2},PositionUtils:{creatPoint:key=>points[key],setPos:(o,key)=>Object.assign(o,points[key])},LanguageMgr:{GetTranslation:key=>key}};
  // AVM2 native reparent updates the display list without dispatching the old parent's
  // AS3 removeChild override. BoxContainer separately owns _childrenList for VBox.arrange.
  const childContainer=(box=false)=>({displayChildren:[],_childrenList:[],
    addChild(child){if(box&&this._childrenList.includes(child))return child;
      if(child.parent){const list=child.parent.displayChildren;list.splice(list.indexOf(child),1);}
      this.displayChildren.push(child);if(box)this._childrenList.push(child);child.parent=this;return child;},
    removeChild(child){assert.equal(child.parent,this);this.displayChildren.splice(this.displayChildren.indexOf(child),1);
      if(box)this._childrenList.splice(this._childrenList.indexOf(child),1);child.parent=null;return child;},
    arrange(){if(box)for(const [index,child]of this._childrenList.entries())child.y=500+index*100;},
  });
  const goods={...childContainer(),_info:item,_titleText:{height:42},_explainText:{width:300,height:48,text:"normal"},_openBagBtn:{height:27},_cellList:{y:28,height:66,boundsBottom:94,getBounds(relative){assert.equal(relative,goods);return {bottom:this.boundsBottom};}},selected:{itemId:537},rebuilds:0,
    init(){},initEvent(){},update(){this.rebuilds++;this._openBagBtn.y=this._cellList.y+this._cellList.height-27+25;this._explainText.y=this._cellList.y+this._cellList.height+25;},
  };
  goods.refreshExchangeState=()=>run(goodsAbc,16,goods,[],classes);goods.setData=info=>run(goodsAbc,10,goods,[info],classes);run(goodsAbc,1,goods,[],classes);
  const input={text:"",textField:new Emitter()},view={...childContainer(),_getButton:Object.assign(new Emitter(),{enable:true}),_backButton:new Emitter(),_piccBtn:new Emitter(),_titleField:{},
    _scrollList:{height:368,invalidateViewport(){this.invalidations=(this.invalidations??0)+1;}},_detail:{height:500,getInputField:()=>input,setData(){}},_content:{...childContainer(true),height:0},_goodsExchange:goods,
    configUI(){},__getAward(){},__back(){},__piccHandler(){},__inputChanged(){},_exchangeRefreshLoader:null,_exchangeRefreshAgain:false,
  };
  for(const [key,method]of [["addEvent",3],["removeEvent",15],["__exchangeStateRefresh",18],["__exchangeStateComplete",19]])view[key]=(...args)=>run(viewAbc,method,view,args,classes);
  view.showGoodsExchangeView=()=>{view._goodsExchange??=goods;goods.setData(view._activityInfo);if(!goods.parent)view._content.addChild(goods);};
  view.hideGoodsExchangeView=()=>{view._goodsExchange=null;if(goods.parent)goods.parent.removeChild(goods);};
  run(viewAbc,1,view,[{}],classes);
  const setData=info=>run(viewAbc,12,view,[info],classes);
  const respond=(loader,{value="true",owner=self.ID,id=item.ActiveID,mode={},error=false}={})=>{
    if(!error){const row={ActiveID:String(id),ActiveType:"1",HasKey:"6",IsOnly:"1",isAttend:value,...mode};
      const xml={UserID:String(owner),Item:Object.assign({length:()=>1},[row])};
      // Prefix ends at the original success continuation; append a real return instruction for this isolated slice.
      execute(after.get("ddt/data/analyze/CalendarSignAnalyze").p,Buffer.concat([calendarStatePrefix(),Buffer.from([0x47])]),[{_onCompleteCall:()=>{},onAnalyzeComplete(){}},xml],classes,[{},{2:xml}]);
    }loader.emit(error?"error":"complete");
  };
  return {item,goods,view,manager,self,socket,loaders,setData,respond,classes};
}

test("requires personal-state base; two exact ABC owners only; idempotent; original claims and packet sender survive",()=>{
  assert.throws(()=>patchExchangeState(original));assert.throws(()=>patchExchangeState(patchActivityResponse(original).out));
  assert.equal(result.changed,true);assert.equal(patchExchangeState(result.out).changed,false);assert.deepEqual(patchExchangeState(result.out).out,result.out);
  const changed=[...before].filter(([name,a])=>!a.bytes.equals(after.get(name).bytes)).map(([name])=>name).sort();
  assert.deepEqual(changed,["calendar/view/ActivityState","calendar/view/goodsExchange/GoodsExchangeView"]);
  for(const [name,methods]of [[changed[0],[1,3,12,15]],[changed[1],[1,10]]])for(const body of before.get(name).p.bodies)if(!methods.includes(body.method))assert.deepEqual(after.get(name).p.bodies.find(b=>b.method===body.method).code,body.code);
});

test("actual 117 invalidation never reads shared packet or declares success; API true updates button/text without replacing selected materials",()=>{
  const f=fixture();f.setData(f.item);assert.equal(f.loaders.length,1);f.respond(f.loaders[0],{value:"false"});
  const selection=f.goods.selected, rebuilds=f.goods.rebuilds;f.socket.emit("mail",{get pkg(){assert.fail("shared packet cursor consumed");}});
  assert.equal(f.loaders.length,2);assert.equal(f.item.isAttend,false);assert.equal(f.view._getButton.enable,true);
  f.respond(f.loaders[1]);assert.equal(f.item.isAttend,true);assert.equal(f.view._getButton.enable,false);
  assert.equal(f.goods._explainText.text,"tank.calendar.Activity.GetResult0");assert.equal(f.goods.selected,selection);assert.equal(f.goods.rebuilds,rebuilds);
  f.socket.emit("mail");assert.equal(f.loaders.length,2);
});

test("an in-flight pre-commit false snapshot cannot swallow subsequent 117; notifications coalesce once",()=>{
  const f=fixture();f.setData(f.item);for(let i=0;i<5;i++)f.socket.emit("mail");assert.equal(f.loaders.length,1);
  f.respond(f.loaders[0],{value:"false"});assert.equal(f.loaders.length,2);assert.equal(f.item.isAttend,false);assert.equal(f.loaders[0].count(),0);
  f.respond(f.loaders[1]);assert.equal(f.loaders.length,2);assert.equal(f.view._getButton.enable,false);assert.equal(f.view._exchangeRefreshLoader,null);assert.equal(f.loaders[1].count(),0);
});

test("false, error, wrong ActiveID/mode, and non-lowercase state preserve selection and do not grey",()=>{
  for(const reply of [{value:"false"},{value:"True"},{id:999},{mode:{HasKey:"3"}},{mode:{IsOnly:"0"}},{error:true}]){
    const f=fixture();f.setData(f.item);const selection=f.goods.selected,count=f.goods.rebuilds;f.respond(f.loaders[0],reply);
    assert.equal(f.item.isAttend,false);assert.equal(f.view._getButton.enable,true);assert.equal(f.goods.selected,selection);assert.equal(f.goods.rebuilds,count);assert.equal(f.loaders[0].count(),0);assert.equal(f.loaders.length,1);
  }
});

test("late account responses, owner mismatch, disposed views, and duplicate completed callbacks cannot mutate another button",()=>{
  const f=fixture();f.setData(f.item);f.self.ID=32;f.manager.calendarStateUserId=32;f.respond(f.loaders[0],{owner:31});
  assert.equal(f.item.isAttend,false);assert.equal(f.view._getButton.enable,true);f.socket.emit("mail");assert.equal(f.loaders.length,1);
  const g=fixture();g.setData(g.item);const old=g.loaders[0];g.view.removeEvent();assert.equal(old.count(),0);assert.equal(g.socket.count(),0);
  g.view._getButton=null;g.respond(old);assert.equal(g.view._getButton,null);assert.equal(g.view._exchangeViewOwner,0);assert.equal(g.loaders.length,1);
  const h=fixture();h.setData(h.item);h.respond(h.loaders[0],{value:"false"});h.socket.emit("mail");const pending=h.view._exchangeRefreshLoader;
  h.view.__exchangeStateComplete({currentTarget:h.loaders[0]});assert.equal(h.view._exchangeRefreshLoader,pending);
});

test("ordinary activities and repeated exchanges keep normal layout/requests; single-slot geometry changes before viewport invalidation",()=>{
  for(const mode of [{ActiveType:0,HasKey:3},{ActiveType:0,HasKey:1},{ActiveType:0,HasKey:2},{ActiveType:0,HasKey:4},{ActiveType:2},{IsOnly:0}]){
    const f=fixture(mode);f.setData(f.item);f.socket.emit("mail");assert.equal(f.loaders.length,0);
  }
  const f=fixture();f.setData(f.item);assert.equal(f.goods.parent,f.view);assert.equal(f.view._scrollList.height,236);assert.deepEqual([f.goods.x,f.goods.y],[57,300]);
  assert.deepEqual(f.view._content._childrenList,[]);assert.deepEqual(f.view._content.displayChildren,[]);
  f.view._content.arrange();assert.equal(f.goods.y,300,"deferred VBox layout must not move the detached fixed exchange");
  assert.deepEqual([f.goods._titleText.height,f.goods._explainText.width,f.goods._explainText.height,f.goods._explainText.y,f.goods._openBagBtn.y],[22,350,28,96,67]);
  const multi={...f.item,goodsExchangeInfos:[{},{}]};f.setData(multi);assert.equal(f.goods.parent,f.view._content);assert.equal(f.view._scrollList.height,368);assert.deepEqual([f.goods.x,f.goods.y],[11,222]);
  assert.deepEqual(f.view._content._childrenList,[f.goods]);assert.deepEqual(f.view._content.displayChildren,[f.goods]);
  f.view._content.arrange();assert.equal(f.goods.y,500,"restored multi-slot exchange is again arranged by VBox");
  assert.deepEqual([f.goods._titleText.height,f.goods._explainText.width,f.goods._explainText.height,f.goods._explainText.y,f.goods._openBagBtn.y],[42,300,48,119,92]);
  f.setData({...f.item,ActiveType:0,HasKey:3});assert.equal(f.view._scrollList.height,368);assert.equal(f.view._goodsExchange,null);
  assert.deepEqual(f.view._content._childrenList,[]);assert.deepEqual(f.view._content.displayChildren,[]);
});

test("single-slot explanation uses actual rendered bounds, not logical tile height; repeated false/true refresh never drifts",()=>{
  const f=fixture();f.goods._cellList.height=46;f.goods._cellList.boundsBottom=93;f.setData(f.item);
  const selection=f.goods.selected,rebuilds=f.goods.rebuilds;
  for(const attended of [false,false,true,true,false]){
    f.item.isAttend=attended;f.goods.refreshExchangeState();
    assert.equal(f.goods._explainText.y,95);assert.equal(f.goods._openBagBtn.y,66);
    assert.ok(f.goods._explainText.y>=f.goods._cellList.boundsBottom+2);
    assert.equal(f.goods._explainText.width,350);assert.equal(f.goods._explainText.height,28);
    assert.equal(f.goods._explainText.text,attended?"tank.calendar.Activity.GetResult0":"calendar.view.GoodsExchangeView.explain");
    assert.equal(f.goods.selected,selection);assert.equal(f.goods.rebuilds,rebuilds);
  }
  f.setData({...f.item,goodsExchangeInfos:[{},{}]});
  assert.equal(f.goods._explainText.y,99);assert.equal(f.goods._openBagBtn.y,72);
  assert.equal(f.goods._explainText.width,300);assert.equal(f.goods._explainText.height,48);
});

test("tampered instruction, slot metadata, original sender or new method body is rejected without producing output",()=>{
  function corrupt(swf,target,mutate){const s=decompressSwf(swf),parsed=parseTags(s.body);const tags=parsed.tags.map(t=>{if(t.code!==82)return t.raw;const r=new ByteReader(s.body.subarray(t.bodyStart,t.bodyEnd));r.u32();if(r.cstring()!==target)return t.raw;const payload=Buffer.from(s.body.subarray(t.bodyStart,t.bodyEnd)),p=parseActivityAbc(payload.subarray(r.pos));mutate(payload,r.pos,p);return buildTag(82,payload);});return compressSwf(s.sig,s.version,Buffer.concat([parsed.headerPrefix,...tags,parsed.trailing]));}
  for(const name of ["calendar/view/ActivityState","calendar/view/goodsExchange/GoodsExchangeView"]){
    const owner=name.endsWith("ActivityState")?112:90;
    for(const mutate of [(buf,start,p)=>{buf[start+p.bodies[1].offset]^=1;},(buf,start,p)=>{const block=p.traitBlocks.find(t=>t.owner===owner);buf[start+block.end-1]^=1;},(buf,start,p)=>{buf[start+p.bodies.at(-1).offset+3]^=1;}])assert.throws(()=>patchExchangeState(corrupt(result.out,name,mutate)));
  }
});

test("all changed/new method CFG joins obey stack, scope, local and real branch-target bounds",()=>{
  for(const owner of result.methods)for(const proof of owner.methods){const p=after.get(owner.name).p,body=p.bodies.find(x=>x.method===proof.method),code=body.code,list=decodeExchangeCode(code),map=new Map(list.map(i=>[i.offset,i]));
    assert.equal(body.exceptions,0);const queue=[[0,0,0]],seen=new Map();
    while(queue.length){const [pc,depth,scope]=queue.pop(),i=map.get(pc);assert.ok(i);if(seen.has(pc)){assert.deepEqual(seen.get(pc),[depth,scope]);continue;}seen.set(pc,[depth,scope]);
      const op=i.op,n=i.args[0];let pop=0,push=0,scopeDelta=0;
      if([0x60,0x62,0x65,0x5d,0x5e,0x24,0x25,0x2c,0x20,0x26,0x27,0xd0,0xd1,0xd2,0xd3].includes(op))push=1;
      else if([0x63,0x29,0xd4,0xd5,0xd6,0xd7].includes(op))pop=1;
      else if(op===0x66){pop=1;push=1;}else if([0x61,0x68].includes(op))pop=2;
      else if([0x46,0x4f,0x4a].includes(op)){pop=1+i.args[1];push=op===0x4f?0:1;}
      else if(op===0x49)pop=1+n;else if([0x76,0x80,0x82,0x96].includes(op)){pop=1;push=1;}
      else if([0x87,0xab,0xa0,0xa1].includes(op)){pop=2;push=1;}else if(op===0x2a){pop=1;push=2;}
      else if(op===0x30){pop=1;scopeDelta=1;}else if([0x11,0x12].includes(op))pop=1;
      else if(op>=0x13&&op<=0x1a)pop=2;else assert.ok([0x47,0x10,0xf0,0xf1,0xef,0x09].includes(op),`CFG opcode ${op.toString(16)}`);
      assert.ok(depth>=pop);const next=depth-pop+push,newScope=scope+scopeDelta;assert.ok(next<=body.maxStack);assert.ok(body.initialScope+newScope<=body.maxScope);
      const local=[0x62,0x63].includes(op)?n:op>=0xd0&&op<=0xd7?(op-0xd0)%4:null;if(local!==null)assert.ok(local<body.localCount);
      if(op===0x47){assert.equal(next,0);continue;}if(op>=0x0c&&op<=0x1a){queue.push([i.end+n,next,newScope]);if(op===0x10)continue;}queue.push([i.end,next,newScope]);
    }
  }
});
