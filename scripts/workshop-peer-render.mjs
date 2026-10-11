#!/usr/bin/env node
// Two real original SWFs. Actions use ExternalInterface -> original AS3 public APIs; CDP is read-only evidence.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GSPacket } from "../packages/protocol/src/index.ts";
import { ActionType, solveAim } from "../packages/fight/src/index.ts";
import { loadPackedAssets } from "../packages/fight/src/node.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(repo, "../../runtime");
const assets = loadPackedAssets();
if (process.argv.includes("--validate")) { assert.ok(assets.createMap(1007)); console.log("peer render: real map assets and protocol imports valid; no login or writes"); process.exit(0); }
const session = JSON.parse(readFileSync(join(runtime, "workshop-session.json"), "utf8"));
assert.equal(session.publicHost, "127.0.0.1", "private peer fixtures may only be rendered on the loopback stack");
const chrome = process.env.WORKSHOP_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
assert.ok(existsSync(chrome));
const seconds = Number(process.argv.find(x => x.startsWith("--seconds="))?.slice(10) ?? 240);
assert.ok(Number.isInteger(seconds) && seconds >= 60 && seconds <= 360);
const assistRoomLoading = process.argv.includes("--assist-room-loading");
const observeOnly = process.argv.includes("--observe-only");
const expectedFile = process.argv.find(x => x.startsWith("--expect-stats="))?.slice(15);
const expectedStats = expectedFile ? JSON.parse(readFileSync(expectedFile, "utf8")) : null;
const id = randomUUID(), output = join(runtime, "peer-render", id);
mkdirSync(output, { recursive: true });
const file = join(output, "peer-report.json");
const report = { started: new Date().toISOString(), realOriginalSwf: true, simulatedInput: false, sequentialClientStartup: true, actions: "ExternalInterface to original public AS3 APIs", ok: false, roomAccepted: false, renderedBattleAccepted: false, battleAccepted: false, assistedRoomLoading: false, naturalFreedomAccepted: false, peers: {}, events: [], shots: [], damage: [], results: [], screenshots: [] };
report.processes = { controller: process.pid, browsers: [] };
report.observeOnly = observeOnly;
const peers = {}, commands = { A: [], B: [] }, browsers = [], tempFiles = [];
let map, livings = [], currentTurn, roomId, endedAt, stopped = false;
let roomReadyAt, gameLoadAt;
const fired = new Set(), packets = new Set(), stages = new Set();
const mainReadyAt = {};
process.on("SIGINT", () => { stopped = true; report.interrupted = true; });
process.on("SIGTERM", () => { stopped = true; report.interrupted = true; });
const bounds = { x: -15, y: -20, width: 30, height: 30 };
const delay = ms => new Promise(r => setTimeout(r, ms));
const sensitiveValues = new Set();
const cleanDiagnostics = value => [...sensitiveValues].reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
const diagnosticReplacer = (_key, value) => typeof value === "string" ? cleanDiagnostics(value) : value;
const checkpoint = () => writeFileSync(file, JSON.stringify(report, diagnosticReplacer, 2));
const enqueue = (peer, command) => { commands[peer].push(command); report.events.push({ at: new Date().toISOString(), peer, phase: "queued-command", ...command }); };
function packet(value) {
  const p = GSPacket.parse(Uint8Array.from(value.bytes)); p.offset = 20;
  const sub = p.readByte();
  const digest = createHash("sha256").update(Uint8Array.from(value.bytes)).digest("hex");
  report.events.push({ at: new Date().toISOString(), peer: value.peer, phase: "server-packet", code: p.code, sub, living: p.parameter1, bytes: value.bytes.length });
  if (p.code !== 91 || packets.has(digest)) return;
  packets.add(digest);
  if (sub === 103) { p.readInt(); const mapId = p.readInt(); assert.equal(mapId, 1007); map = assets.createMap(mapId); report.map = mapId; gameLoadAt ??= Date.now(); }
  else if (sub === 99) {
    livings = []; const n = p.readInt(); assert.equal(n, 2);
    for (let i = 0; i < n; i++) {
      const l = { id: p.readInt(), x: p.readInt(), y: p.readInt(), direction: p.readInt(), blood: p.readInt(), maxBlood: p.readInt(), team: p.readInt(), isLiving: true };
      p.readInt(); p.readInt(); p.readInt(); const buffs = p.readInt(); for (let j = 0; j < buffs; j++) { p.readInt(); p.readInt(); }
      p.readInt(); p.readBoolean(); p.readBoolean(); p.readBoolean(); p.readBoolean(); p.readInt(); livings.push(l);
    }
    report.startedPlayers = livings.map(x => ({ ...x }));
  } else if (sub === 6) {
    assert.ok(map); const positive = p.readBoolean(), one = p.readByte(); p.readByte(); const three = p.readByte();
    map.wind = ((positive ? 1 : -1) * ((one === 10 ? 0 : one) * 10 + (three === 10 ? 0 : three)) / 10) || 0;
    p.readBoolean(); p.readInt(); const boxes = p.readInt(); for (let i = 0; i < boxes; i++) for (let j = 0; j < 4; j++) p.readInt();
    const n = p.readInt();
    for (let i = 0; i < n; i++) { const livingId = p.readInt(), l = livings.find(x => x.id === livingId); assert.ok(l, `TURN living ${livingId} exists`); l.isLiving = p.readBoolean(); l.x = p.readInt(); l.y = p.readInt(); l.blood = p.readInt(); p.readBoolean(); l.energy = p.readInt(); for (let j = 0; j < 6; j++) p.readInt(); }
    currentTurn = { index: p.readInt(), living: p.parameter1 }; assert.equal(p.offset, p.length, "actual TURN layout"); drive();
  } else if (sub === 2) {
    assert.ok(map); map.wind = p.readInt() / 10; p.readBoolean(); p.readByte(); p.readByte(); p.readByte();
    const n = p.readInt();
    for (let i = 0; i < n; i++) {
      p.readInt(); p.readInt(); const dig = p.readBoolean(); p.readInt(); const x = p.readInt(), y = p.readInt(); p.readInt(); p.readInt();
      const ball = p.readInt(); p.readString(); p.readInt(); p.readInt(); report.shots.push({ received: true, shooter: p.parameter1, ball, x, y });
      const count = p.readInt();
      for (let j = 0; j < count; j++) {
        p.readInt(); const type = p.readInt(), a = p.readInt(), b = p.readInt(), c = p.readInt(), d = p.readInt();
        if (type === ActionType.BOMB && dig && c === 1) map.dig(a, b, assets.shape(ball));
        const l = livings.find(x => x.id === a);
        if (l && type === ActionType.START_MOVE) { l.x = b; l.y = c; l.isLiving = d === 1; }
        if (l && type === ActionType.KILL_PLAYER) { l.blood = d; l.isLiving = d > 0; report.damage.push({ shooter: p.parameter1, target: a, damage: b, blood: d }); }
      }
    }
  } else if (sub === 100) {
    const n = p.readInt(); report.results = [];
    for (let i = 0; i < n; i++) { const living = p.readInt(), win = p.readBoolean(), fields = Array.from({ length: 26 }, () => p.readInt()); report.results.push({ living, win, grade: fields[0], gp: fields[1], gained: fields[3] }); }
    report.battleAccepted = report.results.length === 2 && report.damage.some(x => x.damage > 0) && report.shots.some(x => x.received);
    endedAt ??= Date.now();
  }
}
function drive() {
  for (const role of ["A", "B"]) if (expectedStats && peers[role]?.state === "main" && !stages.has("verified-login-" + role)) {
    assert.equal(peers[role].grade, expectedStats[role].grade, "actual original SWF login grade");
    assert.equal(peers[role].gp, expectedStats[role].gp, "actual original SWF login GP");
    stages.add("verified-login-" + role);
  }
  if (observeOnly) { report.observed = peers.A?.state === "main" && peers.B?.state === "main" && peers.A.mainRendered && peers.B.mainRendered; checkpoint(); return; }
  for (const role of ["A", "B"]) {
    const p = peers[role]; if (!p) continue;
    if (p.state === "main" && p.mainRendered && !p.nextState) mainReadyAt[role] ??= Date.now();
    if (mainReadyAt[role] && Date.now() - mainReadyAt[role] >= 2000 && p.state === "main" && !stages.has(role + "-hall")) { stages.add(role + "-hall"); enqueue(role, { action: "state", state: "roomlist" }); }
  }
  if (peers.A?.userId > 0 && peers.B?.userId > 0 && !stages.has("observe-peer")) { stages.add("observe-peer"); enqueue("A", { action: "observe-peer", peerId: peers.B.userId }); }
  if (peers.A?.state === "roomlist" && peers.B?.state === "roomlist" && peers.A.roomListRendered && peers.B.roomListRendered && peers.A.targetGrade >= 4 && peers.A.grade >= 12 && !stages.has("create")) { stages.add("create"); enqueue("A", { action: "challenge", peerId: peers.B.userId }); }
  if (peers.A?.roomId > 0) roomId = peers.A.roomId;
  if (roomId && peers.A?.state === "challengeRoom" && !stages.has("setup")) { stages.add("setup"); enqueue("A", { action: "setup" }); }
  if (roomId && peers.B?.state === "roomlist" && !stages.has("join")) { stages.add("join"); enqueue("B", { action: "join", room: roomId }); }
  if (peers.A?.roomId === roomId && peers.B?.roomId === roomId && peers.A?.players === 2 && peers.B?.players === 2 && peers.A?.map === 1007 && peers.B?.map === 1007) {
    report.roomAccepted = true;
    roomReadyAt ??= Date.now();
    if (!stages.has("ready")) { stages.add("ready"); enqueue("B", { action: "ready" }); }
    if (peers.B.ready && Date.now() - roomReadyAt > 4000 && !peers.A.nextState && !peers.B.nextState && !stages.has("start")) { stages.add("start"); enqueue("A", { action: "start" }); }
  }
  for (const role of ["A", "B"]) if (assistRoomLoading && map && Date.now() - gameLoadAt > 2500 && peers[role]?.gameMap === 1007 && peers[role]?.state === "challengeRoom" && !peers[role].nextState && !stages.has("load-" + role)) { report.assistedRoomLoading = true; stages.add("load-" + role); enqueue(role, { action: "load" }); }
  if (["A", "B"].every(role => peers[role]?.state === "fighting" && peers[role].fightingRendered && !peers[role].nextState)) report.renderedBattleAccepted = true;
  if (map && currentTurn && !fired.has(currentTurn.index)) {
    const actor = ["A", "B"].find(x => peers[x]?.livingId === currentTurn.living && peers[x]?.state === "fighting");
    if (actor) {
      const me = livings.find(x => x.id === currentTurn.living), foe = livings.find(x => x.team !== me?.team && x.isLiving);
      if (me && foe) {
        const weapon = peers[actor].weapon; assert.ok(assets.ballConfigs.has(weapon), `actual peer weapon ${weapon} has ball data`);
        const ball = assets.ball(assets.ballConfigs.get(weapon).common);
        const sol = solveAim({ map, ball, from: { ...me, bound: bounds }, target: { x: foe.x, y: foe.y - 10 }, bodies: livings.filter(x => x.id !== me.id && x.isLiving).map(x => ({ ...x, bound: bounds })) });
        fired.add(currentTurn.index);
        if (sol) { enqueue(actor, { action: "fire", turn: currentTurn.index, direction: sol.direction, x: sol.muzzle.x, y: sol.muzzle.y, force: sol.force, angle: sol.angle }); report.shots.push({ peer: actor, shooter: me.id, force: sol.force, angle: sol.angle, predictedMiss: sol.miss }); }
        else enqueue(actor, { action: "skip", turn: currentTurn.index });
      }
    }
  }
  checkpoint();
}
const bridge = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.headers.origin && req.headers.origin !== "http://127.0.0.1:5173") { res.writeHead(403); res.end(); return; }
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5173"); res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const role = url.searchParams.get("peer");
  if (!url.pathname.startsWith("/" + id + "/") || !["A", "B"].includes(role)) { res.writeHead(404); res.end(); return; }
  try {
    if (url.pathname.endsWith("/commands")) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(commands[role].splice(0))); }
    else if (url.pathname.endsWith("/report")) {
      let body = ""; for await (const chunk of req) { body += chunk; assert.ok(body.length < 1_000_000); }
      const value = JSON.parse(body); value.peer = role;
      if (value.phase === "state") { if (peers[role]?.state !== value.state) report.events.push({ at: new Date().toISOString(), ...value, phase: "state-transition" }); peers[role] = value; report.peers[role] = value; drive(); }
      else if (value.phase === "packet") packet(value);
      else {
        report.events.push({ at: new Date().toISOString(), ...value });
        if (value.phase.endsWith("error")) report.clientErrors = (report.clientErrors ?? []).concat(value);
        if (["command-error", "load-error", "bridge-error", "probe-error"].includes(value.phase))
          report.error = `original client ${role} ${value.phase}: ${value.text}`;
      }
      res.end("ok");
    } else { res.writeHead(404); res.end(); }
  } catch (error) { report.error = error.message; checkpoint(); res.writeHead(500); res.end("peer test failed"); }
});
await new Promise(res => bridge.listen(0, "127.0.0.1", res));
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}/${id}`;
async function browser(role, pageUrl, sensitive) {
  for (const value of sensitive) if (typeof value === "string" && value.length) {
    sensitiveValues.add(value); sensitiveValues.add(encodeURIComponent(value));
  }
  const profile = join(output, "profile-" + role);
  const child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-features=WebGPU", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--window-size=1024,700", "--hide-scrollbars", pageUrl], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const clean = value => cleanDiagnostics(String(value));
  const item = { role, child, diagnostics: "", network: [], console: [], websocketFrames: 0 }; browsers.push(item);
  report.processes.browsers.push({ role, pid: child.pid });
  child.stderr.on("data", b => { item.diagnostics += b; });
  for (let i = 0; i < 120 && !existsSync(join(profile, "DevToolsActivePort")); i++) await delay(100);
  assert.ok(existsSync(join(profile, "DevToolsActivePort")), "isolated peer browser started");
  const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const page = pages.find(x => x.url === pageUrl); assert.ok(page);
  const socket = new WebSocket(page.webSocketDebuggerUrl); item.socket = socket;
  await new Promise((res, rej) => { socket.addEventListener("open", res, { once: true }); socket.addEventListener("error", rej, { once: true }); });
  let seq = 0; const pending = new Map();
  socket.addEventListener("message", event => {
    const m = JSON.parse(event.data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (p) m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === "Network.responseReceived") item.network.push({ path: new URL(m.params.response.url).pathname, status: m.params.response.status });
    else if (m.method.startsWith("Network.webSocketFrame")) item.websocketFrames++;
    else if (m.method === "Runtime.consoleAPICalled" && item.console.length < 1000) item.console.push({ at: new Date(m.params.timestamp).toISOString(), type: m.params.type, text: clean(m.params.args.map(x => String(x.value ?? x.description ?? "")).join(" ")).slice(0, 6000) });
    else if (m.method === "Runtime.exceptionThrown") item.console.push({ at: new Date(m.params.timestamp).toISOString(), type: "exception", text: clean(JSON.stringify(m.params.exceptionDetails)).slice(0, 6000) });
  });
  item.readOnly = (method, params = {}) => {
    assert.ok(["Network.enable", "Runtime.enable", "Page.captureScreenshot"].includes(method), "CDP is restricted to passive network, console and screenshots");
    return new Promise((res, rej) => { const key = ++seq; const timeout = setTimeout(() => { pending.delete(key); rej(new Error("read-only capture timed out")); }, 30_000); pending.set(key, { resolve: x => { clearTimeout(timeout); res(x); }, reject: e => { clearTimeout(timeout); rej(e); } }); socket.send(JSON.stringify({ id: key, method, params })); });
  };
  await item.readOnly("Network.enable");
  await item.readOnly("Runtime.enable");
  item.sanitize = clean;
}
async function capture(stage) {
  for (const b of browsers) {
    const name = `${stage}-${b.role}.png`;
    const image = await b.readOnly("Page.captureScreenshot", { format: "png" }); writeFileSync(join(output, name), Buffer.from(image.data, "base64")); report.screenshots.push(name);
  }
  checkpoint();
}
try {
  const accounts = JSON.parse(readFileSync(join(runtime, "credentials/smoke-accounts.json"), "utf8")).slice(0, 2); assert.equal(accounts.length, 2);
  const compiled = readFileSync(join(runtime, "client-research/WorkshopPeerProbe.swf"));
  report.probeBytes = compiled.length;
  report.probeSha256 = createHash("sha256").update(compiled).digest("hex");
  for (let index = 0; index < 2; index++) {
    const role = index ? "B" : "A", account = accounts[index];
    const response = await fetch("http://127.0.0.1:8080/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: account.username, password: account.password }) }); assert.equal(response.status, 200); const { game } = await response.json();
    const prefix = `workshop-peer-${id}-${role}`, publicDir = join(repo, "apps/web/public");
    const htmlFile = join(publicDir, prefix + ".html"), swfFile = join(publicDir, prefix + "-Loading.swf"), loadingFile = join(publicDir, prefix + "-DDT_Loading.swf"); tempFiles.push(htmlFile, swfFile, loadingFile);
    const originalLoading = await fetch(game.swfUrl.replace("Loading.swf", "DDT_Loading.swf")); assert.equal(originalLoading.status, 200);
    writeFileSync(swfFile, compiled, { flag: "wx" }); writeFileSync(loadingFile, Buffer.from(await originalLoading.arrayBuffer()), { flag: "wx" });
    const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#161822}#host{width:1000px;height:600px}</style><div id="host"></div><script>
      const config=${JSON.stringify(game)},bridge=${JSON.stringify(bridgeUrl)},role=${JSON.stringify(role)};
      window.workshop_peer_report=value=>fetch(bridge+'/report?peer='+role,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}).catch(()=>{});
      window.RufflePlayer={config:{publicPath:config.rufflePath.slice(0,config.rufflePath.lastIndexOf('/')+1),autoplay:'on',unmuteOverlay:'hidden',splashScreen:false,allowScriptAccess:true,socketProxy:config.socketProxy,fontSources:['/fonts/NotoSans-Regular.ttf','/fonts/NotoSans-Bold.ttf','/fonts/NotoSansSC-Regular.otf','/fonts/NotoSansSC-Bold.otf'],defaultFonts:{sans:['Noto Sans SC','Noto Sans'],serif:['Noto Sans SC','Noto Sans'],typewriter:['Noto Sans SC','Noto Sans']}}};
      const script=document.createElement('script');script.src=config.rufflePath;script.onload=async()=>{const player=window.RufflePlayer.newest().createPlayer();player.style.width='1000px';player.style.height='600px';document.getElementById('host').appendChild(player);await player.ruffle().load({url:${JSON.stringify(`http://127.0.0.1:5173/${prefix}-Loading.swf`)},parameters:{...config.flashvars,probeClient:config.swfUrl,peer:role},base:config.base,socketProxy:config.socketProxy});setInterval(async()=>{try{const commands=await(await fetch(bridge+'/commands?peer='+role)).json();for(const command of commands)player.ruffle().callExternalInterface('workshopPeerCommand',command);}catch(e){window.workshop_peer_report({phase:'bridge-error',text:String(e)});}},350);};document.head.appendChild(script);
      </script>`;
    writeFileSync(htmlFile, html, { flag: "wx" }); await browser(role, `http://127.0.0.1:5173/${prefix}.html`, [account.password, account.username, game.flashvars?.user, game.flashvars?.key]);
    if (role === "A") {
      const readyDeadline = Date.now() + Math.min(seconds, 90) * 1000;
      let readySince;
      while (Date.now() < readyDeadline && !report.error && !stopped) {
        const p = peers.A;
        const ready = p?.rawHooksReady && !p.nextState && (observeOnly ? p.state === "main" && p.mainRendered : p.state === "roomlist" && p.roomListRendered);
        if (ready) readySince ??= Date.now(); else readySince = undefined;
        if (readySince && Date.now() - readySince >= 2000) { report.events.push({ at: new Date().toISOString(), peer: "A", phase: "original-view-ready-before-B", state: p.state, originalViews: p.originalViews }); await capture("A-ready"); break; }
        await delay(300);
      }
      assert.ok(readySince && Date.now() - readySince >= 2000, "A original display view did not finish enter before sequential B startup");
    }
  }
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !report.error && !stopped) {
    if (observeOnly && report.observed) { await capture("observed-lobby"); break; }
    if (report.roomAccepted && Date.now() - roomReadyAt > 2500 && !stages.has("capture-room")) { stages.add("capture-room"); await capture("room"); }
    if (report.renderedBattleAccepted && !stages.has("capture-battle")) { stages.add("capture-battle"); await capture("battle"); }
    if (report.battleAccepted && !stages.has("capture-result")) { stages.add("capture-result"); await delay(3000); await capture("result"); }
    if (endedAt && Date.now() - endedAt > 15_000 && !stages.has("exit")) { stages.add("exit"); enqueue("A", { action: "exit" }); enqueue("B", { action: "exit" }); }
    if (stages.has("exit") && ["A", "B"].every(role => peers[role]?.state === "main" && peers[role].mainRendered && !peers[role].nextState)) { report.returnedToLobby = true; await capture("lobby"); break; }
    await delay(300);
  }
  await capture("final");
  report.ok = !report.error && (observeOnly ? report.observed === true : report.roomAccepted && report.renderedBattleAccepted && report.battleAccepted && report.returnedToLobby === true);
  report.naturalFreedomAccepted = !observeOnly && report.ok && !report.assistedRoomLoading;
  if (!report.ok) report.limit = "bounded actual SWF test incomplete; partial room/map/render evidence is retained";
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  stopped = true;
  for (const role of ["A", "B"]) enqueue(role, { action: "exit" }); await delay(1500);
  for (const b of browsers) { b.socket?.close(); if (b.child.exitCode === null && b.child.signalCode === null) b.child.kill(); writeFileSync(join(output, `browser-${b.role}.log`), cleanDiagnostics(b.diagnostics)); writeFileSync(join(output, `console-${b.role}.json`), JSON.stringify(b.console, diagnosticReplacer, 2)); writeFileSync(join(output, `network-${b.role}.json`), JSON.stringify({ requests: b.network, websocketFrames: b.websocketFrames }, diagnosticReplacer, 2)); }
  await new Promise(res => bridge.close(res));
  for (const f of tempFiles) if (existsSync(f)) { assert.ok(resolve(f).startsWith(resolve(repo, "apps/web/public") + "\\")); assert.ok(f.includes(id)); unlinkSync(f); }
  report.ok = report.ok && !report.error;
  report.naturalFreedomAccepted = report.naturalFreedomAccepted && report.ok;
  report.ended = new Date().toISOString(); report.cleanup = "shutdown requested only for this run's isolated browsers; temporary loopback bridge closed and UUID-named public files removed"; checkpoint();
  if (!report.ok) process.exitCode = 1; console.log(JSON.stringify({ ok: report.ok, roomAccepted: report.roomAccepted, renderedBattleAccepted: report.renderedBattleAccepted, battleAccepted: report.battleAccepted, error: report.error, report: file }, diagnosticReplacer));
}
