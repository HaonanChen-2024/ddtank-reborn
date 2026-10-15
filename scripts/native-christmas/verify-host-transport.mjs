// Static host members plus a bounded interpreter of the compiled packet helpers; not AVM2.
import assert from 'node:assert/strict';
import {ByteReader} from '../../tools/i18n/abc-strings/lib.mjs';
import {q,sha} from '../native-pair/build-library.mjs';
import {decode} from '../native-pair/audit-candidate.mjs';

const routes={enterChristmasRoom:'sceneEnter',sendLeaveChristmasRoom:'sceneLeave',sendChristmasRoomMove:'sceneMove',sendStartFightWithMonster:'sceneFight'};
const donorPins={enterChristmasRoom:'5f50f0bcb41ad12a3ae724820117828099958889f0b0f096d0a51d9cdde2a76e',sendLeaveChristmasRoom:'595cae843f245b8a1055fd4153f1b3ad3ff2ded5d0e665949d627175d8d7192f',sendChristmasRoomMove:'e2f6205bb843e84c4d0b36448255819acd7df87d766cee996e7378a1ca3eaea9',sendStartFightWithMonster:'60402698c49e0f1c66be62c0a0ac33a6c1b0c2e02ec30f1d4e8321300cec1080'};
const simple=(a,t)=>a.p.strings[a.p.names[t.name]?.name];
function method(a,name){const ts=a.p.methodTraits.filter(t=>simple(a,t)===name);assert.equal(ts.length,1,'one method '+a.name+'.'+name);const t=ts[0],b=a.p.bodies.find(b=>b.method===t.method);assert(b);return{t,b,m:a.p.methods[t.method]};}
function publicMethod(a,name,kind,params,result){const r=method(a,name),ns=a.p.namespaces[a.p.names[r.t.name].ns];assert.equal(q(a.p,r.t.name),'::'+name,'public member '+name);assert.equal(ns.kind,22,'public namespace '+name);assert.equal(r.t.kind&15,kind,'trait kind '+name);assert.deepEqual(r.m.params.map(i=>q(a.p,i)),params,'parameters '+name);assert.equal(q(a.p,r.m.returnType),result,'result '+name);return r;}
function structure(a){
 const r=new ByteReader(a.abc);r.pos=4;const ints=[0];for(let n=r.u30(),i=1;i<n;i++)ints.push(r.u30());r.pos=a.p.namePoolEnd;const methods=[];
 for(let n=r.u30();n;n--){const count=r.u30();r.u30();for(let j=0;j<count;j++)r.u30();r.u30();const flags=r.bytes(1)[0],options=[];if(flags&8)for(let j=r.u30();j;j--)options.push({index:r.u30(),kind:r.bytes(1)[0]});if(flags&128)for(let j=0;j<count;j++)r.u30();methods.push({options});}
 for(let n=r.u30();n;n--){r.u30();for(let j=r.u30()*2;j;j--)r.u30();}assert.equal(r.u30(),1,'one host class');const name=r.u30(),superName=r.u30(),flags=r.bytes(1)[0];if(flags&8)r.u30();for(let n=r.u30();n;n--)r.u30();const constructor=r.u30();return{name:q(a.p,name),superName:q(a.p,superName),constructor,options:methods[constructor].options,ints};
}
function hostContract(abcs){
 const one=name=>{const rows=abcs.filter(a=>a.name===name);assert.equal(rows.length,1,'one actual host owner '+name);return rows[0];};
 const manager=one('ddt/manager/SocketManager'),out=one('ddt/manager/GameSocketOut'),socket=one('road7th/comm/ByteSocket'),packet=one('road7th/comm/PackageOut');
 publicMethod(manager,'Instance',2,[],'ddt.manager::SocketManager');publicMethod(manager,'out',2,[],'ddt.manager::GameSocketOut');publicMethod(manager,'socket',2,[],'road7th.comm::ByteSocket');
 const send=publicMethod(out,'sendPackage',1,['road7th.comm::PackageOut'],'::void'),wire=publicMethod(socket,'send',1,['road7th.comm::PackageOut'],'::void');
 assert.equal(sha(send.b.code),'bc41b898a84fee7c4febd2d4f8b2e27e51ce3eb687c091f33e4346472c9e7613');assert.equal(sha(wire.b.code),'7a8e9d35134065452c27cdc0c11f7c64d5f8e5bbddd59b825422a2925b140157');
 assert.deepEqual(decode(send.b.code).filter(o=>o.op===0x46||o.op===0x4f).map(o=>[q(out.p,o.args[0]),o.args[1]]),[['::send',1]],'sendPackage delegates to the existing socket');
 const p=structure(packet);assert.equal(p.name,'road7th.comm::PackageOut');assert.equal(p.superName,'flash.utils::ByteArray');assert.deepEqual(packet.p.methods[p.constructor].params.map(i=>q(packet.p,i)),['::int','::int','::int','::int']);assert.equal(p.options.length,3);for(const o of p.options){assert.equal(o.kind,3);assert.equal(p.ints[o.index],0);}assert.equal(sha(packet.p.bodies.find(b=>b.method===p.constructor).code),'77afb26131a0254912a9385df0de502020df9ed372fa61d1008a706678078404');
 for(const name of Object.keys(routes))assert(!out.p.methodTraits.some(t=>simple(out,t)===name),'do not assume donor-only host helper '+name);
 return{owners:[manager,out,socket,packet].map(a=>({owner:a.name,abcSha256:sha(a.abc)})),sendPackage:{method:send.b.method,codeSha256:sha(send.b.code),public:true},socketSend:{method:wire.b.method,codeSha256:sha(wire.b.code),public:true},packageOut:{superClass:p.superName,constructor:p.constructor,optionalTrailingZeros:3,inheritedNativeWriters:['writeByte','writeInt','writeUTF']},missingDonorHelpers:Object.keys(routes)};
}
function compiledContract(a){
 const frames=[],sent=[],trace=[];
 class Packet{constructor(code){this.code=code;this.fields=[];this.bytes=[];}writeByte(v){this.fields.push(['byte',v]);this.bytes.push(Buffer.from([v&255]));}writeInt(v){this.fields.push(['int',v]);const b=Buffer.alloc(4);b.writeInt32BE(v);this.bytes.push(b);}writeUTF(v){this.fields.push(['UTF',v]);const value=Buffer.from(v),b=Buffer.alloc(2);b.writeUInt16BE(value.length);this.bytes.push(b,value);}}
 const host={Instance:{out:{sendPackage(packet){assert(packet instanceof Packet);sent.push(packet);}}}},self={cls(name){assert(['road7th.comm.PackageOut','ddt.manager.SocketManager'].includes(name),'only checked host owners');return name==='road7th.comm.PackageOut'?Packet:host;}};
 // Only these seven straight-line helpers are interpreted. No renderer, socket or SWF runs.
 const run=(name,args=[])=>{const {b}=method(a,name);assert.equal(b.exceptions,0);const stack=[],locals=[self,...args];trace.push({name,method:b.method,codeSha256:sha(b.code)});for(const o of decode(b.code)){
  const argc=o.args[1],property=[0x46,0x4f,0x66,0x5d].includes(o.op)?q(a.p,o.args[0]).split('::').at(-1):'';
  if(o.op===0xd0||o.op===0xd1||o.op===0xd2||o.op===0xd3)stack.push(locals[o.op-0xd0]);
  else if(o.op===0x62)stack.push(locals[o.args[0]]);else if(o.op>=0xd4&&o.op<=0xd7)locals[o.op-0xd4]=stack.pop();else if(o.op===0x63)locals[o.args[0]]=stack.pop();
  else if(o.op===0x30)stack.pop();else if(o.op===0x80){assert.equal(q(a.p,o.args[0]),'::Object');}else if(o.op===0x24||o.op===0x25)stack.push(o.args[0]);else if(o.op===0x2c)stack.push(a.p.strings[o.args[0]]);
  else if(o.op===0x5d){assert.equal(property,'int');stack.push({int:Math.trunc});}
  else if(o.op===0x66){const target=stack.pop();stack.push(target===self&&Object.values(routes).includes(property)?{boundHelper:property}:target[property]);}
  else if(o.op===0x46||o.op===0x4f){const values=stack.splice(stack.length-argc,argc),target=stack.pop();let result;if(target===self&&['newScenePacket','sendScenePacket'].includes(property))result=run(property,values);else{assert(target&&typeof target[property]==='function','checked callable '+property);result=target[property](...values);}if(o.op===0x46)stack.push(result);}
  else if(o.op===0x42){const values=stack.splice(stack.length-o.args[0],o.args[0]),C=stack.pop();assert.equal(C,Packet);stack.push(new C(...values));}
  else if(o.op===0x55){const values=stack.splice(stack.length-o.args[0]*2,o.args[0]*2),obj={};for(let i=0;i<values.length;i+=2)obj[values[i]]=values[i+1];stack.push(obj);}
  else if(o.op===0x48){const value=stack.pop();assert.equal(stack.length,0);return value;}else if(o.op===0x47){assert.equal(stack.length,0);return;}else assert([0xef,0xf0,0xf1].includes(o.op),'unexpected helper opcode '+o.op);
 }assert.fail('helper missing return');};
 const resolved=run('out');assert.deepEqual(Object.keys(resolved),Object.keys(routes));for(const [name,helper]of Object.entries(routes))assert.deepEqual(resolved[name],{boundHelper:helper});
 const fixtures=[{name:'sceneEnter',args:[{x:123.9,y:-456.7}],fields:[['byte',17],['byte',2],['int',123],['int',-456]],hex:'11020000007bfffffe38'},{name:'sceneLeave',args:[],fields:[['byte',17],['byte',1]],hex:'1101'},{name:'sceneMove',args:[-10,234,'-10,234,0,0'],fields:[['byte',21],['int',-10],['int',234],['UTF','-10,234,0,0']],hex:'15fffffff6000000ea000b2d31302c3233342c302c30'},{name:'sceneFight',args:[364003],fields:[['byte',22],['int',364003]],hex:'1600058de3'}];
 for(const f of fixtures){const before=sent.length;run(f.name,f.args);assert.equal(sent.length,before+1,'one host send');const p=sent.at(-1);assert.equal(p.code,145);assert.deepEqual(p.fields,f.fields,f.name+' original field order');assert.equal(Buffer.concat(p.bytes).toString('hex'),f.hex,f.name+' big-endian body golden');frames.push({method:f.name,packet:145,fields:f.fields,bodyHex:f.hex});}
 return{method:'Bounded interpretation of actual compiled straight-line ABC helpers, with checked host member signatures; not AVM2 or live transport',routes,frames,methods:[...new Map(trace.map(t=>[t.name,t])).values()]};
}
const copyAbc=a=>({...a,p:{...a.p,methodTraits:a.p.methodTraits.map(t=>({...t})),names:a.p.names.map(n=>n&&({...n})),namespaces:a.p.namespaces.map(n=>n&&({...n})),methods:a.p.methods.map(m=>({...m,params:[...m.params]})),bodies:a.p.bodies.map(b=>({...b,code:Buffer.from(b.code)}))}});
export function verifyHostTransport({host,original,bootstrap}){
 const hostAbcs=host.flatMap(h=>h.swf.abcs),actual=hostContract(hostAbcs),compiled=compiledContract(bootstrap),donor=original.abcs.find(a=>a.name==='ddt/manager/GameSocketOut');assert(donor);const originalMethods=[];
 for(const [name,pin]of Object.entries(donorPins)){const {b}=method(donor,name);assert.equal(sha(b.code),pin,'original serializer '+name);originalMethods.push({name,method:b.method,codeSha256:pin});}
 const rejected=[],bad=(name,work)=>{assert.throws(work);rejected.push(name);};
 bad('missing host GameSocketOut',()=>hostContract(hostAbcs.filter(a=>a.name!=='ddt/manager/GameSocketOut')));
 for(const [owner,name,mutate]of [['ddt/manager/GameSocketOut','sendPackage',(a,t)=>{a.p.methodTraits=a.p.methodTraits.filter(x=>x!==t);}],['ddt/manager/GameSocketOut','sendPackage',(a,t)=>{a.p.namespaces[a.p.names[t.name].ns].kind=5;}],['ddt/manager/GameSocketOut','sendPackage',(a,t)=>{a.p.methods[t.method].params=[];}],['road7th/comm/ByteSocket','send',(a,t)=>{a.p.methodTraits=a.p.methodTraits.filter(x=>x!==t);}],['ddt/manager/SocketManager','out',(a,t)=>{t.kind=(t.kind&~15)|1;}]]){
  const rows=hostAbcs.map(copyAbc),a=rows.find(a=>a.name===owner),t=method(a,name).t;mutate(a,t);bad(owner+'.'+name+' mutation '+rejected.length,()=>hostContract(rows));
 }
 const mutant=(name,helper,change)=>{const a=copyAbc(bootstrap),b=method(a,helper).b;change(a,b,decode(b.code));bad(name,()=>compiledContract(a));};
 mutant('packet code differs from 145','newScenePacket',(a,b,ops)=>{const op=ops.find(o=>o.op===0x25&&o.args[0]===145);assert(op);b.code[op.offset+1]=146;});
 mutant('movement command differs from 21','sceneMove',(a,b,ops)=>{const op=ops.find(o=>o.op===0x24&&o.args[0]===21);assert(op);b.code[op.offset+1]=23;});
 mutant('movement x/y swapped','sceneMove',(a,b,ops)=>{const x=ops.find(o=>o.op===0xd1),y=ops.find(o=>o.op===0xd2);assert(x&&y);b.code[x.offset]=0xd2;b.code[y.offset]=0xd1;});
 mutant('fight payload uses wrong local','sceneFight',(a,b,ops)=>{const op=ops.find(o=>o.op===0xd1);assert(op);b.code[op.offset]=0xd0;});
 return{scope:'Only native Christmas raw145 transport members and compiled serializers',host:actual,compiled,originalMethods,rejectedMutationCount:rejected.length,rejectedMutations:rejected,runtimeValidated:false};
}
