// Mechanically extracted local bridge routing; no SWF, AVM2, game or socket executes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {christmasSourceFiles} from './reuse-candidate.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function verifyNaturalReturnBridge(source){
 const match=source.match(/public static function routeChristmasNaturalReturn\(target:String,room:Object,game:Object\):String\s*\{([\s\S]*?)\}\r?\n  private static function/);assert(match,'actual public static bridge method');
 const body=match[1],code=body.replace(/\b(var\s+\w+):(?:Object|\*)/g,'$1').replace(/catch\((\w+):Error\)/g,'catch($1)').replace(/\bresult is String\b/g,'typeof result === "string"').replace(/\bint\(/g,'Math.trunc(');
 assert(!/ExternalInterface|verifyRole|\b(?:open|openReady|loadModule|ensureShared|read|request)\s*\(/.test(body),'routing must remain local and must not load/open/read');
 const init=source.match(/public static function init\(\):void\s*\{([\s\S]*?)\}\r?\n  private static function clientClass/);assert(init);assert.equal((init[1].match(/ExternalInterface[.]addCallback\(/g)??[]).length,48,'existing external callback count');assert(!init[1].includes('routeChristmasNaturalReturn'),'route is never an external callback');
 const fn=new Function('context','target','room','game','with(context){'+code+'}'),rows=[];
 const fixture=()=>{
  const room={ID:51},game={missionInfo:{id:164001}},calls=[],status={phase:'ready',ready:true,open:false,expectedUserId:7,characterId:7,generation:'g1'};
  const module={statusNative(){calls.push('status');return status;},naturalBattleReturn(...args){calls.push(['route',...args]);return'main';}};
  const classes={'ddt.manager.PlayerManager':{Instance:{Self:{ID:7}}},'room.RoomManager':{Instance:{current:room}},'game.GameManager':{Instance:{Current:game}}};
  const context={sharedPhase:'ready',christmas:{phase:'ready',expected:7,generation:'g1',module},expected:7,domain:{},displayDomain(){calls.push('domain');},clientClass(name){assert(Object.hasOwn(classes,name));return classes[name];}};
  return{room,game,calls,status,module,classes,context};
 };
 const run=(label,mutate,expectedTarget='dungeonRoom',delegate=0,target='dungeonRoom')=>{const f=fixture();mutate?.(f);const result=fn(f.context,target,f.room,f.game);assert.equal(result,expectedTarget,label);assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='route').length,delegate,label+' delegates');rows.push(label);return f;};
 const success=run('closed ready module routes exact current room/game once',null,'main',1);assert.deepEqual(success.calls.at(-1),['route','dungeonRoom',success.room,success.game]);
 const other=run('non-dungeon target is untouched without probing host',null,'farm',0,'farm');assert.deepEqual(other.calls,[]);
 for(const phase of ['idle','loading','failed'])run('shared '+phase+' refuses',f=>f.context.sharedPhase=phase);
 for(const phase of ['registered','loading-bootstrap','failed'])run('module record '+phase+' refuses',f=>f.context.christmas.phase=phase);
 run('missing domain refuses',f=>f.context.domain=null);run('unloaded module refuses',f=>f.context.christmas.module=null);
 run('missing expected role refuses',f=>f.context.expected=0);run('record role drift refuses',f=>f.context.christmas.expected=8);run('missing generation refuses',f=>f.context.christmas.generation='');
 run('domain identity exception falls back',f=>f.context.displayDomain=()=>{throw Error('domain');});
 run('missing Self refuses',f=>f.classes['ddt.manager.PlayerManager'].Instance.Self=null);run('actual role drift refuses',f=>f.classes['ddt.manager.PlayerManager'].Instance.Self.ID=8);
 run('current room replacement refuses',f=>f.classes['room.RoomManager'].Instance.current={...f.room});run('current GameInfo replacement refuses',f=>f.classes['game.GameManager'].Instance.Current={...f.game});
 run('null room refuses',f=>f.room=null);run('null GameInfo refuses',f=>f.game=null);run('host class exception falls back',f=>f.context.clientClass=()=>{throw Error('host');});
 run('status exception falls back',f=>f.module.statusNative=()=>{throw Error('status');});run('null module status refuses',f=>f.module.statusNative=()=>null);
 for(const phase of ['new','loading','failed'])run('module status '+phase+' refuses',f=>f.status.phase=phase);
 run('module not ready refuses',f=>f.status.ready=false);run('module expected role drift refuses',f=>f.status.expectedUserId=8);run('module character drift refuses',f=>f.status.characterId=8);run('module generation drift refuses',f=>f.status.generation='g2');
 run('module delegation exception falls back',f=>f.module.naturalBattleReturn=(...args)=>{f.calls.push(['route',...args]);throw Error('route');},'dungeonRoom',1);
 run('module refusal keeps original target',f=>f.module.naturalBattleReturn=(...args)=>{f.calls.push(['route',...args]);return args[0];},'dungeonRoom',1);
 for(const value of [null,undefined,true,1,{},'farm',''])run('bad delegated target '+String(value)+' falls back',f=>f.module.naturalBattleReturn=(...args)=>{f.calls.push(['route',...args]);return value;},'dungeonRoom',1);
 assert.equal(christmasSourceFiles.length,9);assert.equal(new Set(christmasSourceFiles).size,9);for(const file of ['scripts/native-christmas/verify-challenge-loading.mjs','scripts/native-christmas/verify-host-transport.mjs','scripts/native-christmas/verify-natural-battle-return.mjs','scripts/native-christmas/patch-battle-return.mjs'])assert(christmasSourceFiles.includes(file),'real audit dependency pinned');
 return{method:'Mechanical extraction of actual AS3 bridge method into JavaScript with host identity fixtures; not AVM2 or live return',sourceSha256:sha(Buffer.from(source)),methodBodySha256:sha(Buffer.from(body)),count:rows.length,rows,externalCallbacks:48,localRouteRegisteredExternally:false,christmasSourcePins:christmasSourceFiles};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(verifyNaturalReturnBridge(readFileSync(resolve(process.argv[2]??'scripts/native-wardrobe/WorkshopNativeWardrobeBridge.as'),'utf8')),null,2));
