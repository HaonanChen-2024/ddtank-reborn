#!/usr/bin/env node
// Private ID 11 ordinary arena. --run observes loading; --battle uses bounded pure prediction and original aim/shoot APIs.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workshop = resolve(repo, "../..");
const runtime = join(workshop, "runtime");
const privateRoot = join(runtime, "playability-research");
const FIXTURE_ID = 11;
const FACING_BLOCK = "all actual legal network angles face away from target; no direction change invoked";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const delay = ms => new Promise(done => setTimeout(done, ms));
const inside = (root, file) => { const rel = relative(root, file); return rel !== "" && !isAbsolute(rel) && !rel.startsWith(".." + sep) && rel !== ".."; };

function options(args) {
  assert.ok(args.every(arg => ["--run", "--battle", "--validate", "--compile-only", "--diagnose-facing"].includes(arg) || /^--(?:ledger|seconds)=.+$/.test(arg)), "unknown solo option; no assist, input or arbitrary fixture options are accepted");
  const modes = args.filter(arg => ["--run", "--battle", "--validate", "--compile-only"].includes(arg));
  assert.ok(modes.length <= 1, "choose exactly one solo mode");
  for (const key of ["ledger", "seconds"]) assert.ok(args.filter(arg => arg.startsWith(`--${key}=`)).length <= 1, "duplicate solo option");
  const arg = (key, fallback) => args.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
  const seconds = Number(arg("seconds", "240"));
  const battle = modes[0] === "--battle";
  const diagnoseFacing = args.includes("--diagnose-facing");
  assert.ok(args.filter(arg => arg === "--diagnose-facing").length <= 1 && (!diagnoseFacing || battle), "--diagnose-facing requires --battle and may occur only once");
  assert.ok(Number.isInteger(seconds) && seconds >= 60 && seconds <= (battle ? 720 : 360), battle ? "solo battle deadline must be 60..720 seconds" : "solo observation deadline must be 60..360 seconds");
  const ledger = resolve(arg("ledger", join(privateRoot, "xp-report.json")));
  assert.ok(inside(privateRoot, ledger), "fixture ledger must remain in private playability research");
  return { mode: modes[0] ?? "--validate", battle, diagnoseFacing, seconds, ledger };
}
function identity(id) {
  assert.ok(Number.isSafeInteger(id) && id === FIXTURE_ID && id !== 6, "only exact private fixture ID 11 is allowed; real player ID 6 is rejected");
}
function fixture(ledger) {
  const data = JSON.parse(readFileSync(ledger, "utf8"));
  identity(data.userId);
  assert.ok(typeof data.credentialFile === "string", "private ID 11 credential ledger is incomplete");
  const credentials = resolve(data.credentialFile);
  assert.ok(inside(privateRoot, credentials) && existsSync(credentials), "private fixture credentials must remain in playability research");
  return { characterId: FIXTURE_ID, credentials };
}
function loopback(url, protocols = ["http:"]) {
  const value = new URL(url);
  assert.ok(protocols.includes(value.protocol) && ["127.0.0.1", "localhost"].includes(value.hostname) && !value.username && !value.password, "original client URLs must stay on loopback");
  return value;
}
function sameSelfTurnCapture(source, latest) {
  const before = source?.battle?.shootingGate, after = latest?.battle?.shootingGate;
  const eligible = gate => gate && [gate.currentTurn, gate.selfLivingId, gate.currentLivingId, gate.mapCurrentPlayerLivingId].every(Number.isSafeInteger) &&
    gate.currentLivingId === gate.selfLivingId && gate.mapCurrentPlayerLivingId === gate.selfLivingId &&
    gate.shootEnabled === true && gate.shootType === 0 && gate.shootCount > 0 && gate.selfMoving === false && gate.mapMoving === false &&
    gate.selfActionCount === 0 && gate.currentPlayerActionCount === 0 && gate.mapActionCount === 0;
  return Boolean(eligible(before) && eligible(after) &&
    ["currentTurn", "currentLivingId", "selfLivingId", "mapCurrentPlayerLivingId"].every(key => before[key] === after[key]));
}
function sameCaptureScene(report, latest) {
  if (!report.captureState) return true; // Preserve the existing observation-only captures.
  const eligible = snapshot => snapshot?.state === report.captureState && !snapshot.nextState &&
    snapshot.views?.includes(report.captureView) &&
    (report.phase !== "solo-projectile-visible" || snapshot.battle?.activeOwnProjectiles > 0);
  return Boolean(report.captureReady && eligible(report.snapshot) && eligible(latest));
}
function zeroShotFacingSnapshot(snapshot) {
  const battle = snapshot?.battle, game = snapshot?.game;
  return Boolean(snapshot?.userId === FIXTURE_ID && snapshot.state === "fighting" && !snapshot.nextState &&
    snapshot.views?.includes("game.view::GameView") && game?.roomType === 0 && game.timeType === 3 && game.containsSelf === true &&
    game.resourcesObserved === true && game.mapCompleted === true && Number.isSafeInteger(game.mapIndex) && game.mapIndex > 0 &&
    Number.isSafeInteger(snapshot.room?.id) && snapshot.room.id > 0 && snapshot.room.type === 0 && snapshot.room.timeType === 3 &&
    ["GAME_CREATE", "GAME_LOAD", "START_LOAD", "GAME_START", "PLAYER_CHANGE"].every(key => Number.isSafeInteger(snapshot.eventCounts?.[key]) && snapshot.eventCounts[key] > 0) &&
    !snapshot.eventCounts.GAME_OVER &&
    battle?.enabled === true && battle.activeShot === null && battle.gameOverObserved === false && battle.result === null &&
    battle.expVisible === false && battle.smallCardsVisible === false &&
    ["requestedShots", "selfShootEvents", "ownProjectilesAdded", "ownProjectilesRemoved", "activeOwnProjectiles", "completedShotObservations", "aimCandidatesConsumed"].every(key => battle[key] === 0) &&
    battle.firedTurns && !Object.values(battle.firedTurns).some(value => value === true));
}
function isFacingDiagnosticReport(report) {
  return Boolean(report?.phase === "solo-aim-blocked" && report.reason === FACING_BLOCK && report.publicDirectionChangeInvoked === false &&
    report.captureReady === true && report.captureState === "fighting" && report.captureView === "game.view::GameView" &&
    Number.isSafeInteger(report.turn) && report.turn === report.snapshot?.battle?.shootingGate?.currentTurn &&
    zeroShotFacingSnapshot(report.snapshot) && sameSelfTurnCapture(report.snapshot, report.snapshot));
}
function sameFacingBoundary(report, snapshot) {
  return Boolean(isFacingDiagnosticReport(report) && zeroShotFacingSnapshot(snapshot) && sameCaptureScene(report, snapshot) &&
    sameSelfTurnCapture(report.snapshot, snapshot) && report.snapshot.game.mapIndex === snapshot.game.mapIndex && report.snapshot.room.id === snapshot.room.id &&
    ["GAME_CREATE", "GAME_LOAD", "START_LOAD", "GAME_START", "PLAYER_CHANGE"].every(key => report.snapshot.eventCounts[key] === snapshot.eventCounts[key]));
}
function facingDiagnosticResult(report, observation, now = Date.now()) {
  const observedAt = Date.parse(observation?.observedAt), elapsed = observation?.elapsedMs;
  if (observation?.phase !== "solo-observation" || !sameFacingBoundary(report, observation.snapshot) ||
      observation.snapshot.battle.lastAimBlock !== FACING_BLOCK || !Number.isFinite(elapsed) || !Number.isFinite(report.elapsedMs) ||
      elapsed <= report.elapsedMs || elapsed - report.elapsedMs > 2000 || !Number.isFinite(observedAt) || now < observedAt || now - observedAt > 2000) return null;
  return { kind: "facing-blocked-zero-shots", reason: report.reason, turn: report.turn, mapIndex: observation.snapshot.game.mapIndex,
    reportElapsedMs: report.elapsedMs, confirmationElapsedMs: elapsed, confirmedAt: observation.observedAt, requestedShots: 0,
    publicDirectionChangeInvoked: false, naturalBattleOutcomeObserved: false, publicApiBattleLifecycleObserved: false, fullBattleAccepted: false,
    scope: "this original turn reported a facing block, followed by a same-turn zero-shot observation; shootingGate is from the previous 250ms tick, with no fresh direction or position readback; diagnostic exit is not natural settlement, victory or full gameplay acceptance" };
}
function cdpFailure(call, kind, error, redact) {
  const message = redact(String(error?.message ?? "CDP failure")).replace(/\b(?:https?|wss?):\/\/[^\s\"'<>]+/gi, "[URL omitted]");
  const record = { id: call.id, method: call.method, stage: call.stage, kind, message };
  for (const key of ["probePhase", "captureId", "turn"]) if (call[key] !== undefined) record[key] = call[key];
  if (Number.isSafeInteger(error?.code)) record.code = error.code;
  return { record, error: new Error(`solo CDP ${call.method} [${call.stage}${call.captureId ? `:${call.captureId}` : ""}]: ${message}`) };
}
function terminalFailure(diagnostic, collectorFailure) {
  return diagnostic ? new Error(`original facing diagnostic: ${diagnostic.reason}; same original turn observed with zero public shooting requests; no natural battle outcome or full gameplay acceptance`) : collectorFailure;
}
function offlineQuickAlphaEmpty(rect, alphaAt) {
  // The fixture supplies an already intersected rectangle; native Flash clipping/edge reads are not simulated.
  const empty = (x, y) => alphaAt(Math.trunc(x), Math.trunc(y)) <= 150;
  return empty(rect.x + rect.width, rect.y + rect.height) && empty(rect.x, rect.y + rect.height) &&
    empty(rect.x + rect.width, rect.y) && empty(rect.x, rect.y);
}
function offlineEulerStep(position, velocity, mass, drag, force, dt) {
  const acceleration = (force - drag * velocity) / mass;
  velocity += acceleration * dt;
  return { position: position + velocity * dt, velocity, acceleration };
}
function offlineTrajectory(force, blocked) {
  // An explicit empty-terrain fixture using the recorded numerical physics, not the actual game map.
  let x = 186, y = 160, vx = Math.trunc(force * Math.cos(-29 * Math.PI / 180)), vy = Math.trunc(force * Math.sin(-29 * Math.PI / 180));
  for (let step = 0; step < 400; step++) {
    const nextX = offlineEulerStep(x, vx, 10, 2, 0, .04), nextY = offlineEulerStep(y, vy, 10, 2, 7000, .04);
    vx = nextX.velocity; vy = nextY.velocity;
    const count = Math.max(Math.abs(Math.trunc(nextX.position) - Math.trunc(x)), Math.abs(Math.trunc(nextY.position) - Math.trunc(y)));
    for (let n = count; n > 0; n -= 3) {
      const ratio = n / count, px = nextX.position + (x - nextX.position) * ratio, py = nextY.position + (y - nextY.position) * ratio;
      if (px + 3 > 1593 && px - 3 < 1603 && py + 3 > 173 && py - 3 < 183) return true;
      if (blocked(px, py) || px < 0 || px > 1850 || py > 1000) return false;
    }
    x = nextX.position; y = nextY.position;
  }
  return false;
}
function compileProbe() {
  const source = join(repo, "research/client/WorkshopSoloProbe.as");
  const compiler = join(runtime, "tools/flex-min/lib/mxmlc.jar");
  const playerGlobal = join(workshop, "downloads/flex/playerglobal32_0.swc");
  assert.ok([source, compiler, playerGlobal].every(existsSync), "existing local AS3 compiler dependencies are unavailable");
  const output = join(privateRoot, "solo-probe", `compile-${randomUUID()}`);
  mkdirSync(output, { recursive: true });
  const swf = join(output, "WorkshopSoloProbe.swf");
  const java = process.env.WORKSHOP_JAVA ?? (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin/java.exe") : "java");
  const result = spawnSync(java, ["-jar", compiler, "-load-config=", "-compiler.theme=", "-compiler.fonts.local-fonts-snapshot=", "-compiler.library-path=", `-compiler.external-library-path=${playerGlobal}`, "-target-player=11.1", "-swf-version=14", "-static-link-runtime-shared-libraries=true", `-output=${swf}`, source], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
  writeFileSync(join(output, "compile.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`, { flag: "wx" });
  assert.equal(result.status, 0, "solo AS3 compilation failed; inspect private compile.log");
  return { swf, sourceSha256: sha256(readFileSync(source)), swfSha256: sha256(readFileSync(swf)), compilerSha256: sha256(readFileSync(compiler)), playerGlobalSha256: sha256(readFileSync(playerGlobal)) };
}

async function run(config, compiler) {
  const session = JSON.parse(readFileSync(join(runtime, "workshop-session.json"), "utf8"));
  assert.equal(session.publicHost, "127.0.0.1", "solo fixture requires the loopback stack");
  const selected = fixture(config.ledger);
  const chrome = process.env.WORKSHOP_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  assert.ok(existsSync(chrome), "existing local Chromium is unavailable");
  const runId = randomUUID(), output = join(privateRoot, "solo-probe", `render-${runId}`);
  mkdirSync(output, { recursive: true });
  const prefix = `workshop-solo-${runId}`, publicRoot = join(repo, "apps/web/public");
  const ticketFile = join(publicRoot, `${prefix}.html`), probeFile = join(publicRoot, `${prefix}-Loading.swf`), loadingFile = join(publicRoot, `${prefix}-DDT_Loading.swf`);
  const temporaryFiles = [];
  const createTemporary = (file, bytes) => {
    const fd = openSync(file, "wx", 0o600);
    temporaryFiles.push(file); // Own the created path even if the subsequent write fails.
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
  };
  const sensitive = new Set();
  const remember = value => { if (typeof value === "string" && value.length) { sensitive.add(value); sensitive.add(encodeURIComponent(value)); } };
  const redact = value => [...sensitive].sort((a, b) => b.length - a.length).reduce((text, secret) => text.replaceAll(secret, "[redacted]"), String(value));
  const replacer = (_key, value) => typeof value === "string" ? redact(value) : value;
  const evidence = { runId, started: new Date().toISOString(), phase: "preflight-ready", characterId: FIXTURE_ID, compiler,
    controllerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), processes: { controller: process.pid, browser: null }, roomType: 0, timeType: 3, selectedMapId: 0,
    originalPublicAPIs: true, simulatedInput: false, assistedRoomLoading: false, manualLoadingProgress: false,
    gameplayDataMayChangeNormally: true, fullBattleAccepted: false, visualAccepted: false, gameplayAccepted: false, persistenceAccepted: false,
    battleMode: config.battle, diagnoseFacing: config.diagnoseFacing, scope: config.battle ? "bounded pure original Euler prediction over full current private terrain clones, at most 16 original public shooting requests with original multishot count preserved, natural settlement and return; prediction is not damage or visual/persistence acceptance" : "normal ordinary arena natural loading and original battle components; no fire, skip, settlement or UI-input acceptance", probe: [], requests: [], errors: [], cdpErrors: [], captures: [] };
  const checkpoint = () => { evidence.lastCheckpoint = new Date().toISOString(); writeFileSync(join(output, "evidence.json"), JSON.stringify(evidence, replacer, 2)); };
  let child, socket, browserError, diagnostics = "", interrupted = false;
  const stop = () => { interrupted = true; evidence.interrupted = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  checkpoint();
  try {
    const account = JSON.parse(readFileSync(selected.credentials, "utf8"));
    assert.ok(typeof account.username === "string" && account.username.length && typeof account.password === "string" && account.password.length, "private fixture credentials are incomplete");
    remember(account.username); remember(account.password);
    const api = "http://127.0.0.1:8080", web = "http://127.0.0.1:5173";
    const login = await fetch(`${api}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: account.username, password: account.password }), signal: AbortSignal.timeout(15_000) });
    assert.equal(login.status, 200, "private fixture login failed");
    const auth = await login.json(), game = auth.game;
    remember(auth.token); remember(game?.flashvars?.user); remember(game?.flashvars?.key);
    assert.ok(game?.flashvars && typeof auth.token === "string", "normal original client login configuration is incomplete");
    const readback = await fetch(`${api}/api/account/me`, { headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(15_000) });
    assert.equal(readback.status, 200, "private account character readback failed");
    const current = await readback.json();
    assert.ok(Array.isArray(current.characters) && current.characters.length === 1, "fixture account must contain exactly one isolated character");
    identity(Number(current.characters[0].id));
    evidence.accountCharacterGuard = { exactCharacterId: FIXTURE_ID, checkedBeforeClientLoad: true, grade: current.characters[0].level };
    evidence.phase = "exact-fixture-verified"; checkpoint();
    for (const value of [game.swfUrl, game.base, game.rufflePath, game.flashvars.config]) loopback(value);
    assert.ok(game.swfUrl.endsWith("/Loading.swf"), "unexpected original bootstrap URL");
    assert.ok(Array.isArray(game.socketProxy) && game.socketProxy.length > 0, "original loopback socket proxy unavailable");
    for (const proxy of game.socketProxy) { assert.ok(["127.0.0.1", "localhost"].includes(proxy.host)); loopback(proxy.proxyUrl, ["ws:"]); }
    const originalLoading = await fetch(game.swfUrl.replace("/Loading.swf", "/DDT_Loading.swf"), { signal: AbortSignal.timeout(15_000) });
    assert.equal(originalLoading.status, 200, "original bootstrap next stage is unavailable");
    const bootstrap = Buffer.from(await originalLoading.arrayBuffer()), probe = readFileSync(compiler.swf);
    evidence.originalBootstrapSha256 = sha256(bootstrap);
    // Keep the configured web Origin for normal HTTP/WS guards, as the official renderer does.
    const pageRoot = `${web}/${prefix}-`;
    const probeParameters = { probeUserId: FIXTURE_ID, probeSeconds: config.seconds, probeClient: game.swfUrl, probeBattle: String(config.battle) };
    const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#161822}#host{width:1000px;height:600px}</style><div id="host"></div><script>
const config=${JSON.stringify(game)}, parameters=${JSON.stringify(probeParameters)};let player;const sent=new Set();
const actions={'solo-main-ready':'enter','solo-roomlist-ready':'create','solo-room-created-ready':'setup','solo-room-setup-ready':'start'};
window.workshop_solo_report=value=>{console.info('WORKSHOP_SOLO',JSON.stringify(value));const action=actions[value.phase];if(action&&!sent.has(action)){sent.add(action);setTimeout(()=>{try{player.ruffle().callExternalInterface('workshopSoloCommand',{action});}catch(e){console.error('solo original API bridge failed',String(e));}},0);}};
window.game_interruption=()=>console.error('original game connection interrupted');
window.RufflePlayer={config:{publicPath:config.rufflePath.slice(0,config.rufflePath.lastIndexOf('/')+1),autoplay:'on',unmuteOverlay:'hidden',splashScreen:false,allowScriptAccess:true,socketProxy:config.socketProxy,fontSources:${JSON.stringify(["NotoSans-Regular.ttf", "NotoSans-Bold.ttf", "NotoSansSC-Regular.otf", "NotoSansSC-Bold.otf"].map(font => `${web}/fonts/${font}`))},defaultFonts:{sans:['Noto Sans SC','Noto Sans'],serif:['Noto Sans SC','Noto Sans'],typewriter:['Noto Sans SC','Noto Sans']}}};
const script=document.createElement('script');script.src=config.rufflePath;script.onload=async()=>{try{player=window.RufflePlayer.newest().createPlayer();player.style.width='1000px';player.style.height='600px';document.getElementById('host').appendChild(player);await player.ruffle().load({url:${JSON.stringify(pageRoot + "Loading.swf")},parameters:{...config.flashvars,...parameters},base:config.base,socketProxy:config.socketProxy});}catch(e){console.error('solo original player load failed',String(e));}};document.head.appendChild(script);
</script>`;
    createTemporary(ticketFile, html);
    createTemporary(probeFile, probe);
    createTemporary(loadingFile, bootstrap);
    evidence.phase = "temporary-ticket-ready"; evidence.pageOrigin = web; checkpoint();
    const profile = join(output, "profile");
    child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-features=WebGPU", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--window-size=1024,700", "--hide-scrollbars", "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    evidence.processes = { controller: process.pid, browser: child.pid, isolatedProfile: profile };
    evidence.phase = "isolated-browser-started"; checkpoint();
    child.once("error", error => { browserError = error; });
    child.stderr.on("data", data => { if (diagnostics.length < 1_000_000) diagnostics += data; });
    const exited = new Promise(done => child.once("exit", done));
    const activePort = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 120 && !existsSync(activePort); i++) { if (browserError || child.exitCode !== null) break; await delay(100); }
    if (browserError) throw browserError;
    assert.ok(existsSync(activePort), "isolated solo browser did not start");
    const port = Number(readFileSync(activePort, "utf8").split("\n")[0]);
    assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
    const page = pages.find(value => value.type === "page"); assert.ok(page, "isolated solo render page unavailable");
    loopback(page.webSocketDebuggerUrl, ["ws:"]);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((done, reject) => {
      const timeout = setTimeout(() => reject(new Error("isolated CDP connection deadline")), 12_000);
      socket.addEventListener("open", () => { clearTimeout(timeout); done(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("isolated CDP connection failed")); }, { once: true });
    });
    const pending = new Map(), requests = new Map(); let sequence = 0;
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id) { const task = pending.get(message.id); pending.delete(message.id); if (task) message.error ? task.fail("response", message.error) : task.resolve(message.result); }
      else if (message.method === "Network.requestWillBeSent" && evidence.requests.length < 6000) {
        const source = new URL(message.params.request.url);
        const record = { path: ["http:", "https:", "ws:", "wss:"].includes(source.protocol) ? source.pathname : source.protocol, method: message.params.request.method, resourceType: message.params.type };
        requests.set(message.params.requestId, record); evidence.requests.push(record);
      } else if (message.method === "Network.responseReceived") { const record = requests.get(message.params.requestId); if (record) record.status = message.params.response.status; }
      else if (message.method === "Network.loadingFinished") { const record = requests.get(message.params.requestId); if (record) { record.finished = true; record.encodedBytes = message.params.encodedDataLength; } }
      else if (message.method === "Network.loadingFailed") { const record = requests.get(message.params.requestId); if (record) record.error = redact(message.params.errorText); }
      else if (message.method === "Runtime.exceptionThrown") evidence.errors.push(redact(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text));
      else if (message.method === "Runtime.consoleAPICalled") {
        if (message.params.args[0]?.value === "WORKSHOP_SOLO") {
          try { const value = JSON.parse(message.params.args[1].value); value.observedAt = new Date().toISOString(); evidence.probe.push(value); } catch { evidence.errors.push("solo probe report could not be decoded"); }
        } else if (message.params.type === "error" && evidence.errors.length < 500) evidence.errors.push(redact(message.params.args.map(value => value.value ?? value.description ?? "").join(" ")));
      }
    });
    const cdp = (method, params = {}, context = {}) => {
      assert.ok(["Network.enable", "Runtime.enable", "Page.enable", "Page.navigate", "Page.captureScreenshot", "Browser.close"].includes(method), "solo CDP only permits initialization and passive evidence");
      return new Promise((done, reject) => {
        const id = ++sequence, call = { id, method, stage: context.stage ?? "initialization" };
        for (const key of ["probePhase", "captureId", "turn"]) if (context[key] !== undefined) call[key] = context[key];
        const fail = (kind, error) => {
          clearTimeout(timeout); pending.delete(id);
          const failure = cdpFailure(call, kind, error, redact); evidence.cdpErrors.push(failure.record); reject(failure.error);
        };
        const timeout = setTimeout(() => fail("timeout", { message: "30 second CDP deadline" }), 30_000);
        pending.set(id, { resolve: value => { clearTimeout(timeout); done(value); }, fail });
        try { socket.send(JSON.stringify({ id, method, params })); } catch (error) { fail("send", error); }
      });
    };
    await cdp("Network.enable"); await cdp("Runtime.enable"); await cdp("Page.enable");
    await cdp("Page.navigate", { url: `${web}/${prefix}.html` });
    evidence.phase = "observing-natural-chain"; checkpoint();
    const captured = new Set(), capturePhases = new Set(["solo-main-ready", "solo-roomlist-ready", "solo-room-created-ready", "solo-room-setup-ready", "solo-room-loading-visible", "solo-fighting-ready",
      ...(config.battle ? ["solo-self-turn-ready", "solo-aim-ready", "solo-aim-blocked", "solo-self-shoot-observed", "solo-projectile-visible", "solo-projectile-finished", "solo-damage-observed", "solo-own-hit-observed", "solo-exp-visible", "solo-small-cards-visible", "solo-return-match-room", "solo-return-roomlist", "solo-return-main"] : [])]);
    const until = Date.now() + config.seconds * 1000; let nextCheckpoint = Date.now() + 5000, facingCandidate = null, facingCancelled = false;
    while (Date.now() < until && !interrupted) {
      await delay(250);
      for (const value of evidence.probe.filter(value => capturePhases.has(value.phase) && !captured.has(value.captureId ?? value.phase))) {
        const captureId = value.captureId ?? value.phase;
        assert.ok(/^[a-z0-9-]+$/.test(captureId), "unexpected passive stage capture name");
        const latest = evidence.probe.findLast(value => value.snapshot)?.snapshot;
        const isSelfTurnCapture = value.phase === "solo-self-turn-ready";
        const isFacingCapture = config.diagnoseFacing && isFacingDiagnosticReport(value);
        const selfTurnStillCurrent = snapshot => sameSelfTurnCapture(value.snapshot, snapshot) &&
          captureId === `solo-self-turn-ready-${value.snapshot?.battle?.shootingGate?.currentTurn}` &&
          !evidence.probe.some(event => event.phase === "solo-shoot-requested" && event.turn === value.snapshot?.battle?.shootingGate?.currentTurn);
        const captureStillCurrent = snapshot => sameCaptureScene(value, snapshot) && (!isSelfTurnCapture || selfTurnStillCurrent(snapshot)) &&
          (!isFacingCapture || sameFacingBoundary(value, snapshot));
        // Battle captures require an observed original stable state. Missed short stages
        // stay unaccepted; an earlier phase never labels a later scene as its screenshot.
        if (!captureStillCurrent(latest)) {
          captured.add(captureId);
          evidence.captures.push({ phase: value.phase, captureId, skipped: "original stage no longer stable at passive capture" });
          continue;
        }
        const image = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1000, height: 600, scale: 1 } },
          { stage: "stage-capture", probePhase: value.phase, captureId, turn: value.snapshot?.battle?.shootingGate?.currentTurn });
        const afterCapture = evidence.probe.findLast(event => event.snapshot)?.snapshot;
        if (!captureStillCurrent(afterCapture)) {
          captured.add(captureId);
          evidence.captures.push({ phase: value.phase, captureId, skipped: "original stage or Self turn eligibility changed during passive capture" });
          continue;
        }
        const path = join(output, `${captureId}.png`); writeFileSync(path, Buffer.from(image.data, "base64")); captured.add(captureId);
        evidence.captures.push({ phase: value.phase, captureId, path, sha256: sha256(readFileSync(path)), capturedAt: new Date().toISOString(), latestObservedState: afterCapture?.state ?? null });
        checkpoint();
      }
      if (config.diagnoseFacing && !facingCancelled) {
        const firstBlock = evidence.probe.find(value => value.phase === "solo-aim-blocked");
        if (!facingCandidate && firstBlock) {
          if (isFacingDiagnosticReport(firstBlock)) facingCandidate = firstBlock;
          else facingCancelled = true;
        }
        if (facingCandidate) {
          const latest = evidence.probe.findLast(value => value.snapshot);
          const shotOrTerminal = evidence.errors.length > 0 || evidence.probe.some(value =>
            ["solo-shoot-requested", "solo-self-shoot-event", "solo-projectile-added", "solo-settlement-event", "solo-battle-complete", "solo-probe-error"].includes(value.phase) ||
            (value.phase === "solo-server-event" && value.event === "GAME_OVER"));
          if (shotOrTerminal || !sameFacingBoundary(facingCandidate, latest?.snapshot) || latest.elapsedMs - facingCandidate.elapsedMs > 2000) {
            evidence.facingDiagnosticCancelled = { reason: "original scene, Self turn or zero-shot boundary changed; no diagnostic short circuit", reportElapsedMs: facingCandidate.elapsedMs };
            facingCancelled = true; facingCandidate = null;
          } else {
            const result = facingDiagnosticResult(facingCandidate, latest);
            if (result) {
              evidence.diagnosticTermination = { ...result, reportProbeIndex: evidence.probe.indexOf(facingCandidate), confirmationProbeIndex: evidence.probe.indexOf(latest) };
              evidence.phase = "facing-diagnostic-stop"; checkpoint(); break;
            }
          }
        }
      }
      if (Date.now() >= nextCheckpoint) { checkpoint(); nextCheckpoint = Date.now() + 5000; }
      if (evidence.probe.some(value => ["solo-complete", "solo-battle-complete", "solo-probe-error"].includes(value.phase))) break;
    }
    const complete = evidence.probe.find(value => value.phase === (config.battle ? "solo-battle-complete" : "solo-complete"));
    const loading = config.battle ? evidence.probe.find(value => value.phase === "solo-fighting-ready") : complete;
    evidence.naturalLoadingObserved = Boolean(loading && loading.snapshot.eventCounts.GAME_CREATE && loading.snapshot.eventCounts.GAME_LOAD && loading.snapshot.eventCounts.START_LOAD && loading.snapshot.eventCounts.GAME_START && loading.snapshot.loadingViewObservedInDisplayTree && loading.snapshot.naturalProgressMax === 100 && evidence.probe.some(value => value.phase === "solo-room-loading-visible"));
    evidence.originalBattleComponentsObserved = Boolean(loading && loading.snapshot.state === "fighting" && loading.snapshot.game.mapCompleted && loading.snapshot.views.includes("game.view::GameView"));
    if (config.battle) {
      evidence.publicApiBattleLifecycleObserved = !evidence.diagnosticTermination && Boolean(complete?.publicApiBattleLifecycleObserved && complete.snapshot.state === "main");
      evidence.fullBattleAccepted = Boolean(evidence.publicApiBattleLifecycleObserved && complete.fullBattleAccepted);
      evidence.battle = complete?.snapshot.battle ?? evidence.probe.findLast(value => value.snapshot?.battle)?.snapshot.battle ?? null;
    }
    evidence.requiresVisualReview = true;
    evidence.resourceFailures = evidence.requests.filter(value => value.error || value.status >= 400);
    // Record the domain diagnosis before collector cleanup can fail. A diagnostic exit never completes the original battle lifecycle.
    if (evidence.diagnosticTermination) evidence.naturalBattleOutcomeObserved = false;
    checkpoint();
    let collectorFailure = null;
    try {
      const final = await cdp("Page.captureScreenshot", { format: "png" }, { stage: "final-capture", probePhase: evidence.phase });
      writeFileSync(join(output, "final.png"), Buffer.from(final.data, "base64"));
    } catch (error) { collectorFailure = error; }
    try { await cdp("Browser.close", {}, { stage: "browser-close" }); await Promise.race([exited, delay(3000)]); }
    catch (error) { collectorFailure ??= error; }
    const failure = terminalFailure(evidence.diagnosticTermination, collectorFailure);
    if (failure) throw failure;
    assert.ok(!interrupted && evidence.naturalLoadingObserved && evidence.originalBattleComponentsObserved, "natural ordinary arena chain is incomplete; inspect exact private evidence; no loading assistance performed");
    if (config.battle) assert.ok(evidence.publicApiBattleLifecycleObserved, evidence.battle?.lastAimBlock ? `original finite aiming blocked: ${evidence.battle.lastAimBlock}; inspect exact private evidence` : "original public API battle lifecycle is incomplete; inspect exact private evidence");
    console.log(JSON.stringify({ output, characterId: FIXTURE_ID, battleMode: config.battle, naturalLoadingObserved: true, originalBattleComponentsObserved: true,
      publicApiBattleLifecycleObserved: evidence.publicApiBattleLifecycleObserved ?? false, resourceFailures: evidence.resourceFailures.length,
      visualAccepted: false, persistenceAccepted: false, fullBattleAccepted: evidence.fullBattleAccepted }));
  } catch (error) {
    evidence.failure = redact(error.message); throw new Error(evidence.failure);
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    try { socket?.close(); } catch { evidence.errors.push("isolated CDP socket close failed; continuing owned browser cleanup"); }
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    for (const file of temporaryFiles) if (existsSync(file)) unlinkSync(file);
    evidence.ended = new Date().toISOString();
    evidence.cleanup = { temporaryTicketDeleted: !existsSync(ticketFile), temporaryBootstrapFilesDeleted: temporaryFiles.every(file => !existsSync(file)), isolatedBrowserShutdownRequested: Boolean(child) };
    checkpoint(); writeFileSync(join(output, "browser.log"), redact(diagnostics));
  }
}

const config = options(process.argv.slice(2));
if (config.mode === "--validate") {
  assert.throws(() => identity(6)); assert.throws(() => identity(12));
  assert.throws(() => options(["--assist-room-loading"])); assert.throws(() => options(["--run", "--compile-only"]));
  assert.throws(() => options(["--run", "--battle"])); assert.throws(() => options(["--run", "--seconds=720"]));
  assert.equal(options(["--run"]).seconds, 240); assert.equal(options(["--run"]).battle, false);
  assert.equal(options(["--battle", "--seconds=720"]).seconds, 720); assert.equal(options(["--battle"]).battle, true);
  assert.throws(() => options(["--battle", "--seconds=721"]));
  assert.equal(options(["--run"]).diagnoseFacing, false); assert.equal(options(["--battle"]).diagnoseFacing, false);
  assert.equal(options(["--battle", "--diagnose-facing"]).diagnoseFacing, true);
  for (const args of [["--diagnose-facing"], ["--run", "--diagnose-facing"], ["--validate", "--diagnose-facing"],
    ["--compile-only", "--diagnose-facing"], ["--battle", "--diagnose-facing", "--diagnose-facing"]]) assert.throws(() => options(args));
  const gate = { currentTurn: 3, selfLivingId: 1, currentLivingId: 1, mapCurrentPlayerLivingId: 1, shootEnabled: true, shootType: 0, shootCount: 1,
    selfMoving: false, mapMoving: false, selfActionCount: 0, currentPlayerActionCount: 0, mapActionCount: 0 };
  const turnSnapshot = change => ({ battle: { shootingGate: { ...gate, ...change } } });
  assert.equal(sameSelfTurnCapture(turnSnapshot(), turnSnapshot()), true);
  for (const change of [{ currentTurn: 4 }, { selfLivingId: 2, currentLivingId: 2, mapCurrentPlayerLivingId: 2 }, { currentLivingId: 2 }, { mapCurrentPlayerLivingId: 2 }, { shootEnabled: false }, { mapActionCount: 1 }])
    assert.equal(sameSelfTurnCapture(turnSnapshot(), turnSnapshot(change)), false);
  assert.equal(sameSelfTurnCapture(turnSnapshot(), {}), false);
  const facingSnapshot = { userId: FIXTURE_ID, state: "fighting", nextState: null, views: ["game.view::GameView"], room: { id: 7, type: 0, timeType: 3 },
    eventCounts: { GAME_CREATE: 1, GAME_LOAD: 1, START_LOAD: 1, GAME_START: 1, PLAYER_CHANGE: 1 },
    game: { roomType: 0, timeType: 3, containsSelf: true, resourcesObserved: true, mapCompleted: true, mapIndex: 1201 },
    battle: { enabled: true, shootingGate: { ...gate }, activeShot: null, gameOverObserved: false, result: null, expVisible: false, smallCardsVisible: false,
      requestedShots: 0, selfShootEvents: 0, ownProjectilesAdded: 0, ownProjectilesRemoved: 0, activeOwnProjectiles: 0, completedShotObservations: 0,
      aimCandidatesConsumed: 0, firedTurns: {}, lastAimBlock: "" } };
  const facingReport = { phase: "solo-aim-blocked", reason: FACING_BLOCK, turn: 3, elapsedMs: 1000, publicDirectionChangeInvoked: false,
    captureReady: true, captureState: "fighting", captureView: "game.view::GameView", snapshot: facingSnapshot };
  const facingObservation = { phase: "solo-observation", elapsedMs: 2000, observedAt: "2026-10-11T16:16:02.000Z", snapshot: structuredClone(facingSnapshot) };
  facingObservation.snapshot.battle.lastAimBlock = FACING_BLOCK;
  const observedTime = Date.parse(facingObservation.observedAt), diagnostic = facingDiagnosticResult(facingReport, facingObservation, observedTime);
  assert.equal(diagnostic?.kind, "facing-blocked-zero-shots");
  assert.equal(diagnostic.naturalBattleOutcomeObserved, false); assert.equal(diagnostic.fullBattleAccepted, false);
  assert.equal(facingDiagnosticResult(facingReport, { ...facingReport, observedAt: facingObservation.observedAt }, observedTime), null, "one report is not a later original observation");
  for (const drift of [snapshot => { snapshot.userId = 6; }, snapshot => { snapshot.nextState = "main"; }, snapshot => { snapshot.views = []; },
    snapshot => { snapshot.game.mapIndex = 1343; }, snapshot => { snapshot.room.id++; }, snapshot => { snapshot.eventCounts.PLAYER_CHANGE++; },
    snapshot => { snapshot.battle.shootingGate.currentTurn++; }, snapshot => { snapshot.battle.shootingGate.mapMoving = true; },
    snapshot => { snapshot.battle.requestedShots = 1; }, snapshot => { snapshot.battle.selfShootEvents = 1; },
    snapshot => { snapshot.battle.ownProjectilesAdded = 1; }, snapshot => { snapshot.battle.activeShot = {}; },
    snapshot => { snapshot.battle.gameOverObserved = true; }, snapshot => { snapshot.battle.lastAimBlock = "different block"; }]) {
    const changed = structuredClone(facingObservation); drift(changed.snapshot);
    assert.equal(facingDiagnosticResult(facingReport, changed, observedTime), null, "drift must reject facing diagnostic termination");
  }
  assert.equal(facingDiagnosticResult({ ...facingReport, reason: "original angle controller is locked" }, facingObservation, observedTime), null);
  assert.equal(facingDiagnosticResult(facingReport, facingObservation, observedTime + 2001), null, "stale observation must not terminate");
  const cdpCall = { id: 3, method: "Page.captureScreenshot", stage: "final-capture", probePhase: "facing-diagnostic-stop" };
  const collector = cdpFailure(cdpCall, "response", { code: -32603, message: "Internal error http://localhost/ticket?key=test-secret", data: "must-not-be-recorded" }, value => value.replaceAll("test-secret", "[redacted]"));
  assert.equal(collector.record.method, "Page.captureScreenshot"); assert.equal(collector.record.stage, "final-capture");
  assert.ok(!JSON.stringify(collector).includes("test-secret") && !JSON.stringify(collector).includes("must-not-be-recorded") && !JSON.stringify(collector).includes("http://"));
  assert.match(terminalFailure(diagnostic, collector.error).message, /original facing diagnostic/);
  assert.equal(terminalFailure(null, collector.error), collector.error, "collector failure must remain a failure without a confirmed diagnosis");
  for (const [phase, state, view] of [["solo-exp-visible", "fighting", "game.view.experience::ExpView"],
    ["solo-small-cards-visible", "fighting", "game.view.card::SmallCardsView"], ["solo-return-main", "main", "hall::HallStateView"]]) {
    const snapshot = { state, nextState: null, views: [view] }, report = { phase, captureReady: true, captureState: state, captureView: view, snapshot };
    assert.equal(sameCaptureScene(report, snapshot), true);
    for (const changed of [{ ...snapshot, state: "matchRoom" }, { ...snapshot, nextState: "matchRoom" }, { ...snapshot, views: [] }, undefined])
      assert.equal(sameCaptureScene(report, changed), false, `${phase} must reject a changed post-capture scene`);
    assert.equal(sameCaptureScene({ ...report, captureReady: false }, snapshot), false);
    assert.equal(sameCaptureScene({ ...report, snapshot: { ...snapshot, views: [] } }, snapshot), false);
  }
  const projectileSnapshot = { state: "fighting", nextState: null, views: ["game.view::GameView"], battle: { activeOwnProjectiles: 1 } };
  const projectileReport = { phase: "solo-projectile-visible", captureReady: true, captureState: "fighting", captureView: "game.view::GameView", snapshot: projectileSnapshot };
  assert.equal(sameCaptureScene(projectileReport, projectileSnapshot), true);
  assert.equal(sameCaptureScene(projectileReport, { ...projectileSnapshot, battle: { activeOwnProjectiles: 0 } }), false);
  assert.equal(sameCaptureScene({ phase: "solo-main-ready" }, undefined), true, "default observation-only capture behavior changed");
  const clipped = { x: 2, y: 3, width: 6, height: 6 }, corners = [[8, 9], [2, 9], [8, 3], [2, 3]];
  const fixtureAlphaAt = (points, alpha) => (x, y) => points.some(([px, py]) => px === x && py === y) ? alpha : 0;
  for (const corner of corners) {
    assert.equal(offlineQuickAlphaEmpty(clipped, fixtureAlphaAt([corner], 150)), true);
    assert.equal(offlineQuickAlphaEmpty(clipped, fixtureAlphaAt([corner], 151)), false);
  }
  assert.equal(offlineQuickAlphaEmpty(clipped, fixtureAlphaAt([[5, 3], [5, 6], [7, 8]], 255)), true,
    "interior/perimeter middle and right-1/bottom-1 fixture pixels must not replace the four corners");
  const boundaryReads = [];
  assert.equal(offlineQuickAlphaEmpty({ x: 8, y: 8, width: 2, height: 2 }, (x, y) => { boundaryReads.push([x, y]); return 150; }), true);
  assert.deepEqual(boundaryReads, [[10, 10], [8, 10], [10, 8], [8, 8]], "bitmap boundary coordinates must not be clamped or reduced by one");
  const partialIntersectionReads = [];
  offlineQuickAlphaEmpty({ x: 0, y: 0, width: 3, height: 4 }, (x, y) => { partialIntersectionReads.push([x, y]); return 0; });
  assert.deepEqual(partialIntersectionReads, [[3, 4], [0, 4], [3, 0], [0, 0]], "positive clipped fixture corner order changed");
  const originalEuler = readFileSync(join(privateRoot, "source-aim-recon/EulerVector.as"));
  assert.equal(createHash("sha1").update(Buffer.from(`blob ${originalEuler.length}\0`)).update(originalEuler).digest("hex"), "e7be18c11ff4c7fb1ba1ad06ea8f4997888e4c61", "offline original Euler source blob changed");
  const originalBomb = readFileSync(join(privateRoot, "source-aim-recon/SimpleBomb.as"));
  assert.equal(createHash("sha1").update(Buffer.from(`blob ${originalBomb.length}\0`)).update(originalBomb).digest("hex"), "1f08117de0f6f39321244bba9075bf4b6648f00a", "offline original bomb collision contract blob changed");
  const step = offlineEulerStep(10, -4, 2, .5, 3, .04);
  assert.ok(Math.abs(step.acceleration - 2.5) < 1e-12 && Math.abs(step.velocity + 3.9) < 1e-12 && Math.abs(step.position - 9.844) < 1e-12);
  const xStep = offlineEulerStep(186, 874, 10, 2, 0, .04), yStep = offlineEulerStep(160, -484, 10, 2, 7000, .04);
  assert.ok(Math.abs(xStep.position - 220.68032) < 1e-9 && Math.abs(yStep.position - 141.91488) < 1e-9);
  const fixtureForce = Array.from({ length: 401 }, (_, i) => i + 1000).find(force => offlineTrajectory(force, () => false));
  assert.ok(fixtureForce, "explicit empty-terrain fixture has no predicted target intersection");
  assert.equal(offlineTrajectory(fixtureForce, x => x >= 600), false, "opaque-wall fixture must stop the trajectory before the target");
  assert.deepEqual([0, 150, 151, 255].map(alpha => alpha <= 150), [true, true, false, false]);
  const fullAlpha = Buffer.alloc(128), changedAlpha = Buffer.from(fullAlpha); changedAlpha[63] = 151;
  assert.ok(!fullAlpha.equals(changedAlpha), "full terrain comparison must reject an unsampled changed pixel");
  const selected = fixture(config.ledger), source = readFileSync(join(repo, "research/client/WorkshopSoloProbe.as"), "utf8");
  assert.ok(!/\.sendLoadingProgress\s*\(|\.sendGameCMDShoot\s*\(|\.sendGameCMDDirection\s*\(|\.sendShootTag\s*\(|\.sendGameSkipNext\s*\(|\.moveTo\s*\(|\.playerMoveTo\s*\(|\.startMoving\s*\(|\.stopMoving\s*\(|\.setState\s*\(\s*"(?:roomLoading|gameLoading|fighting|matchRoom|main)"|new\s+(?:MouseEvent|KeyboardEvent|FrameEvent)|\.dispatchEvent\s*\(/.test(source), "solo probe violates the original public API or no-input boundary");
  assert.ok(!/\.(?:Grade|GP|isAttacking|shootEnabled|shootType|shootCount|blood|maxForce|gunAngle|direction|playerAngle|pos|isLockAngle|currentLiving|currentPlayer|currentTurn)\s*=(?!=)/.test(source), "solo probe changes original qualification or battle model fields");
  assert.equal((source.match(/case "/g) ?? []).length, 4, "solo public API command scope changed");
  assert.equal((source.match(/\.beginShoot\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/\.sendShootAction\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/\.manuallySetGunAngle\s*\(/g) ?? []).length, 1);
  assert.ok(source.includes("state.isLockAngle") && source.includes("horizontal * dx > 0") && source.includes("PUBLIC_SHOOT_REQUEST_LIMIT:int = 16") && source.includes("aimAttempt >= PUBLIC_SHOOT_REQUEST_LIMIT") && source.includes("originalPlayerObject(map, local).shootPoint()"), "finite public aiming and actual facing/muzzle gates are incomplete");
  assert.ok(!/new\s+(?:SimpleBomb|BaseBomb|Physics|PhysicalObj)|\.addPhysical\s*\(|\.Dig\s*\(|\.DigFillRect\s*\(|\.bomb\s*\(|\.update\s*\(/.test(source), "pure prediction must not create/update physical actors or change original terrain");
  assert.ok(source.includes('definition("phy.math.EulerVector")') && source.includes("vx.ComputeOneEulerStep(mass, drag, wind, 0.04)") && source.includes("vy.ComputeOneEulerStep(mass, drag, gravity, 0.04)") && source.includes("original.compare(copy)") && source.includes("work < 2") && source.includes("step < 400") && source.includes("checks > 5000"), "bounded original integrator/current full terrain contract is incomplete");
  const alphaSource = source.slice(source.indexOf("private function alphaEmpty("), source.indexOf("private function predictShot("));
  assert.ok(alphaSource.includes("bitmap.rect.intersection(rect)") && !alphaSource.includes(" - 1") && !alphaSource.includes("for (") &&
    ["right), int(clipped.bottom)", "left), int(clipped.bottom)", "right), int(clipped.top)", "left), int(clipped.top)"].every(corner => alphaSource.includes(`bitmap.getPixel32(int(clipped.${corner}) >>> 24) <= 150`)),
    "pure terrain prediction must retain original native intersection and four exclusive-edge corner reads");
  assert.ok(source.includes("if (!gameOverSeen && fighting)") && source.includes("firedTurns[turn] = true") && source.includes("map.currentPlayer == local") && source.includes("shootingGate.mapActionCount == 0"), "battle shooting gate is incomplete");
  assert.ok(source.includes("completedShots > 0 && completedShots == requests && activeShot == null") && source.includes("ownBombCount == ownBombRemoved"), "battle lifecycle accepts unfinished original shots");
  console.log(JSON.stringify({ validated: true, characterId: selected.characterId, mode: "offline", offlinePurePhysicsChecks: true, as3RuntimeChecked: false, credentialsRead: false, login: false, roomCommands: false, sourceSha256: sha256(Buffer.from(source)) }));
} else {
  const compiler = compileProbe();
  if (config.mode === "--compile-only") console.log(JSON.stringify({ compiled: true, login: false, roomCommands: false, ...compiler }));
  else await run(config, compiler);
}
