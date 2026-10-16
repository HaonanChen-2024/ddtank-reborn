// Offline build only. No service, database, browser or deployment.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync,constants} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {pinned,scan,sha,q} from './native-pair/build-library.mjs';
import {buildTreasureLibrary} from './native-treasure/build-library.mjs';
import {activeLayouts,treasureStyles,treasureTicketSkins} from './native-treasure/extract-resources.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function buildNativeTreasure({outputDir,projectRoot=resolve(repo,'../..'),javaPath=resolve(homedir(),'.jdks/openjdk-22.0.1/bin/java.exe')}={}){
 assert(outputDir);const out=resolve(outputDir);assert(!existsSync(out),'preserve prior candidate');const assetDir=resolve(out,'flash/workshop-native/treasure'),logs=resolve(out,'build-logs');mkdirSync(assetDir,{recursive:true});mkdirSync(logs);
 const compiler=resolve(projectRoot,'runtime/tools/flex-min/lib/mxmlc.jar'),player=resolve(projectRoot,'downloads/flex/playerglobal32_0.swc');pinned(compiler,'cc07d749e376715e650271a9875289e49d94234902fff5e5fae287c478c8557b');pinned(player,'7d4d6168d27603cfb3b750302448e354e0bbc1bdd58f5d101c3dcf6891e9bb65');assert(existsSync(javaPath));
 const source=resolve(repo,'scripts/native-treasure/WorkshopNativeTreasureBootstrap.as'),sourceHash=sha(readFileSync(source)),sourceCopy=resolve(out,'sources',basename(source));mkdirSync(dirname(sourceCopy),{recursive:true});copyFileSync(source,sourceCopy,constants.COPYFILE_EXCL);const bootstrap=resolve(assetDir,'WorkshopNativeTreasureBootstrap.swf');
 const result=spawnSync(javaPath,['-jar',compiler,'-load-config=','-compiler.theme=','-compiler.fonts.local-fonts-snapshot=','-compiler.library-path=','-compiler.external-library-path='+player,'-compiler.source-path='+dirname(source),'-target-player=11.1','-swf-version=14','-debug=false','-static-link-runtime-shared-libraries=true','-output='+bootstrap,source],{windowsHide:true,encoding:'utf8',timeout:60000});writeFileSync(resolve(logs,basename(source)+'.log'),String(result.stdout??'')+String(result.stderr??''),{flag:'wx'});assert.equal(result.status,0,result.stderr??result.error);
 const parsed=scan(readFileSync(bootstrap));assert.equal(parsed.abcs.length,1);const methods=['startNative','openNative','closeNative','statusNative','abortNative','acceptSnapshot','rejectRequest','dispatch'];for(const name of methods)assert(parsed.abcs[0].p.methodTraits.some(t=>q(parsed.abcs[0].p,t.name)==='::'+name));const callbacks=['workshopTreasureAcceptSnapshot','workshopTreasureRejectRequest','workshopTreasureOpenNative','workshopTreasureCloseNative','workshopTreasureStatusNative'];for(const name of callbacks)assert(parsed.abcs[0].p.strings.includes(name));
 const library=buildTreasureLibrary({projectRoot,out:assetDir}),area=resolve(projectRoot,'runtime/reference-activities-completion-20261014/native-maze-analysis-20261015'),assets=[];
 for(const [file,hash]of [['treasurehunting_v3_6_1_u1.swf','8929462943c1da24ae6f6e546120c278306012c24d99a9767f3fb3ce2187ff7f'],['treasurehunting_v3_6_1_u1.ui','f18f82547d7427eb4681d54f38abbbc212bf1a412e434e6728003883c3ba3dd9']]){const path=resolve(area,file),data=pinned(path,hash);copyFileSync(path,resolve(assetDir,file),constants.COPYFILE_EXCL);assets.push({file,bytes:data.length,sha256:hash,source:path});}
 const styles=treasureStyles(projectRoot),sharedSkinDependencies=treasureTicketSkins(projectRoot);assert.equal(library.ownerCount,19);assert.equal(activeLayouts.length,7);writeFileSync(resolve(assetDir,'treasure-styles.xml'),styles.xml,{flag:'wx'});assets.push({file:'treasure-styles.xml',bytes:Buffer.byteLength(styles.xml),sha256:styles.sha256,source:styles.source.path});assert.equal(sha(readFileSync(source)),sourceHash);
 const manifest={version:1,module:'workshop-native-treasure',createdAt:new Date().toISOString(),outputDir:out,
  source:{path:source,sha256:sourceHash,snapshotPath:sourceCopy},
  bootstrap:{file:basename(bootstrap),bytes:readFileSync(bootstrap).length,sha256:sha(readFileSync(bootstrap)),methods,callbacks},library,assets,originalWindow:true,
  styles:{originalCount:109,selected:22,originalSha256:styles.originalSha256,sha256:styles.sha256},
  layouts:{original:11,registered:7,names:[...activeLayouts],localMutations:['module text font Microsoft YaHei','local ticket balances and finite five-draw batch; legacy direct-points entry retained','original 15 category icons and isolated full preview cells','ordered local 14-select-4; special category 15 not selectable','exclude original rank views and real-payment logic','original RecordViewUI with current-role records','original buy-card quantity1..99 window; freeze mode and local30/60-point quote; label explicitly not original server price']},
  protocol:{activityId:'treasure-native',publicProjection:'nativeTreasure',publicProjectionVersion:2,freshEffects:'nativeTreasureAction',
   normalCost:30,advancedCost:60,batchCount:[1,5],bagCapacity:100,categoryCount:15,selectableOriginalIndices:[1,14],specialOriginalIndex:15,previewRows:158,
   requiredSelection:{normal:0,advanced:4},drawFields:['type','choice','mode','count','selection','poolVersion','funding'],allPoolReadinessRequired:true,
   tickets:{balances:'tickets',shop:'ticketShop',drawChoices:'ticketDrawChoices',currency:'local-task-points',localUnitPrices:{normal:30,advanced:60},maxPurchase:99,purchaseFields:['type','choice','mode','count','poolVersion'],purchaseAction:'buy-tickets',purchaseEffect:'tickets-bought',drawFunding:'tickets',ticketsPerDraw:1,ticketDrawPointsCost:0,legacyPointsFunding:'omit funding; preserve original direct-points action and effect shape',originalServerPricesKnown:false},
   bag:'original per-draw rows; preserve legacy and known catalog identities; unknown versions preserve save and refuse; new catalog recycling disabled; complete date/state bagToken',
   uuidOwner:'shared page ledger',animation:'fresh matching entryKey/sourceOriginalIndex draw only; original timer, actual56-frame Glint and Tween flight; last item unlocks; no additional POST'},
  sharedOwner:'workshop-native-activities sole 82-ABC loader',sharedSkinDependencies,
  limitations:['Original 15 categories/158 rows are displayed; ticket purchases and all new draws globally blocked until every original reward has verified local templates, use routes, assets and official weapon evidence.',
   'Original buy-card window exchanges local task points for normal/advanced tickets at explicit local30/60 per ticket, up to99; these are not original server prices or a claim to the original advanced-ticket source. Ticket draws spend one matching ticket per draw and zero points; the legacy direct-points entry remains separate.',
   'Original equal-row/selected-four-plus-special local pool and original counts remain; no original odds, lucky-stone rankings, rank rewards or real-payment integration claimed.',
   'Five original shared bitmap skins are sibling pair-package dependencies, reused rather than new Treasure assets; standalone compilation alone does not prove combined-resource or runtime readiness.',
   'Reference display metadata is isolated from the global item dictionary; private-server equipment statistics are never imported.',
   'Native instance frame55 stops on actual56 instead of original loop to15; raw original art/timeline/frame scripts unchanged.',
   'Candidate only: runtime UI/animation/close/late responses and actual mailbox/relogin acceptance pending.'],installed:false,runtimeValidated:false};writeFileSync(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const m=buildNativeTreasure({outputDir:process.argv[2]});console.log(JSON.stringify({outputDir:m.outputDir,assets:m.assets.length+2,owners:m.library.ownerCount,bootstrap:m.bootstrap,installed:false,runtimeValidated:false},null,2));}
