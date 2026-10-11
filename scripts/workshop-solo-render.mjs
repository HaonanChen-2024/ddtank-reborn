#!/usr/bin/env node
// Private ID 11 ordinary arena. Original AS3 APIs only; no input, loading assist, fire or skip.
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
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const delay = ms => new Promise(done => setTimeout(done, ms));
const inside = (root, file) => { const rel = relative(root, file); return rel !== "" && !isAbsolute(rel) && !rel.startsWith(".." + sep) && rel !== ".."; };

function options(args) {
  assert.ok(args.every(arg => ["--run", "--validate", "--compile-only"].includes(arg) || /^--(?:ledger|seconds)=.+$/.test(arg)), "unknown solo option; no assist, input or arbitrary fixture options are accepted");
  const modes = args.filter(arg => ["--run", "--validate", "--compile-only"].includes(arg));
  assert.ok(modes.length <= 1, "choose exactly one solo mode");
  for (const key of ["ledger", "seconds"]) assert.ok(args.filter(arg => arg.startsWith(`--${key}=`)).length <= 1, "duplicate solo option");
  const arg = (key, fallback) => args.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
  const seconds = Number(arg("seconds", "240"));
  assert.ok(Number.isInteger(seconds) && seconds >= 60 && seconds <= 360, "solo observation deadline must be 60..360 seconds");
  const ledger = resolve(arg("ledger", join(privateRoot, "xp-report.json")));
  assert.ok(inside(privateRoot, ledger), "fixture ledger must remain in private playability research");
  return { mode: modes[0] ?? "--validate", seconds, ledger };
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
    gameplayDataMayChangeNormally: true, fullBattleAccepted: false, visualAccepted: false, gameplayAccepted: false,
    scope: "normal ordinary arena natural loading and original battle components; no fire, skip, settlement or UI-input acceptance", probe: [], requests: [], errors: [], captures: [] };
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
    const probeParameters = { probeUserId: FIXTURE_ID, probeSeconds: config.seconds, probeClient: game.swfUrl };
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
      if (message.id) { const task = pending.get(message.id); pending.delete(message.id); if (task) message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); }
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
    const cdp = (method, params = {}) => {
      assert.ok(["Network.enable", "Runtime.enable", "Page.enable", "Page.navigate", "Page.captureScreenshot", "Browser.close"].includes(method), "solo CDP only permits initialization and passive evidence");
      return new Promise((done, reject) => {
        const id = ++sequence, timeout = setTimeout(() => { pending.delete(id); reject(new Error(`solo CDP deadline: ${method}`)); }, 30_000);
        pending.set(id, { resolve: value => { clearTimeout(timeout); done(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
        socket.send(JSON.stringify({ id, method, params }));
      });
    };
    await cdp("Network.enable"); await cdp("Runtime.enable"); await cdp("Page.enable");
    await cdp("Page.navigate", { url: `${web}/${prefix}.html` });
    evidence.phase = "observing-natural-chain"; checkpoint();
    const captured = new Set(), capturePhases = new Set(["solo-main-ready", "solo-roomlist-ready", "solo-room-created-ready", "solo-room-setup-ready", "solo-room-loading-visible", "solo-fighting-ready"]);
    const until = Date.now() + config.seconds * 1000; let nextCheckpoint = Date.now() + 5000;
    while (Date.now() < until && !interrupted) {
      await delay(250);
      for (const value of evidence.probe.filter(value => capturePhases.has(value.phase) && !captured.has(value.phase))) {
        const image = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1000, height: 600, scale: 1 } });
        const path = join(output, `${value.phase}.png`); writeFileSync(path, Buffer.from(image.data, "base64")); captured.add(value.phase);
        evidence.captures.push({ phase: value.phase, path, sha256: sha256(readFileSync(path)), capturedAt: new Date().toISOString(), latestObservedState: evidence.probe.at(-1)?.snapshot?.state ?? null });
        checkpoint();
      }
      if (Date.now() >= nextCheckpoint) { checkpoint(); nextCheckpoint = Date.now() + 5000; }
      if (evidence.probe.some(value => ["solo-complete", "solo-probe-error"].includes(value.phase))) break;
    }
    const final = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(output, "final.png"), Buffer.from(final.data, "base64"));
    const complete = evidence.probe.find(value => value.phase === "solo-complete");
    evidence.naturalLoadingObserved = Boolean(complete && complete.snapshot.eventCounts.GAME_CREATE && complete.snapshot.eventCounts.GAME_LOAD && complete.snapshot.eventCounts.START_LOAD && complete.snapshot.eventCounts.GAME_START && complete.snapshot.loadingViewObservedInDisplayTree && complete.snapshot.naturalProgressMax === 100 && evidence.probe.some(value => value.phase === "solo-room-loading-visible"));
    evidence.originalBattleComponentsObserved = Boolean(complete && complete.snapshot.state === "fighting" && complete.snapshot.game.mapCompleted && complete.snapshot.views.includes("game.view::GameView"));
    evidence.requiresVisualReview = true;
    evidence.resourceFailures = evidence.requests.filter(value => value.error || value.status >= 400);
    await cdp("Browser.close"); await Promise.race([exited, delay(3000)]);
    assert.ok(!interrupted && evidence.naturalLoadingObserved && evidence.originalBattleComponentsObserved, "natural ordinary arena chain is incomplete; inspect exact private evidence; no loading assistance performed");
    console.log(JSON.stringify({ output, characterId: FIXTURE_ID, naturalLoadingObserved: true, originalBattleComponentsObserved: true, resourceFailures: evidence.resourceFailures.length, visualAccepted: false, fullBattleAccepted: false }));
  } catch (error) {
    evidence.failure = redact(error.message); throw new Error(evidence.failure);
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    socket?.close();
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
  const selected = fixture(config.ledger), source = readFileSync(join(repo, "research/client/WorkshopSoloProbe.as"), "utf8");
  assert.ok(!/\.sendLoadingProgress\s*\(|\.setState\s*\(\s*"(?:roomLoading|gameLoading|fighting)"|new\s+(?:MouseEvent|KeyboardEvent|FrameEvent)|\.dispatchEvent\s*\(/.test(source), "solo probe violates the natural loading or no-input boundary");
  assert.equal((source.match(/case "/g) ?? []).length, 4, "solo public API command scope changed");
  console.log(JSON.stringify({ validated: true, characterId: selected.characterId, mode: "offline", credentialsRead: false, login: false, roomCommands: false, sourceSha256: sha256(Buffer.from(source)) }));
} else {
  const compiler = compileProbe();
  if (config.mode === "--compile-only") console.log(JSON.stringify({ compiled: true, login: false, roomCommands: false, ...compiler }));
  else await run(config, compiler);
}
