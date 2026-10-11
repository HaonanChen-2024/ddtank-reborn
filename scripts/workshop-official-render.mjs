#!/usr/bin/env node
// Private headless render of original AS3 components. No desktop input or game command writes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workshop = resolve(repo, "../..");
const runtime = join(workshop, "runtime");
const privateRoot = join(runtime, "content-research/official-probe");
const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const view = arg("view", "appearances");
assert.ok(["appearances", "bag", "hall"].includes(view), "view must be appearances, bag or hall");
const probeName = view === "appearances" ? "WorkshopOfficialWardrobeProbe" : "WorkshopBagViewProbe";
const probeSource = join(repo, `research/client/${probeName}.as`);
const probeSwf = join(privateRoot, `${probeName}.swf`);
assert.ok(existsSync(probeSource), "official probe source is unavailable");
const compiler = join(runtime, "tools/flex-min/lib/mxmlc.jar");
const playerGlobal = join(workshop, "downloads/flex/playerglobal32_0.swc");
const java = process.env.WORKSHOP_JAVA ?? (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin/java.exe") : "java");
assert.ok(existsSync(compiler) && existsSync(playerGlobal), "existing local Flex compiler dependencies are unavailable");
mkdirSync(privateRoot, { recursive: true });
const compile = spawnSync(java, ["-jar", compiler, "-load-config=", "-compiler.theme=", "-compiler.fonts.local-fonts-snapshot=", "-compiler.library-path=", `-compiler.external-library-path=${playerGlobal}`, "-target-player=11.1", "-swf-version=14", "-static-link-runtime-shared-libraries=true", `-output=${probeSwf}`, probeSource], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
writeFileSync(join(privateRoot, "compile.log"), `${compile.stdout ?? ""}${compile.stderr ?? ""}`);
assert.equal(compile.status, 0, "official probe compilation failed; read private compile.log");
const compilerEvidence = { sourceSha256: sha256(probeSource), swfSha256: sha256(probeSwf), compilerSha256: sha256(compiler), playerGlobalSha256: sha256(playerGlobal) };
if (process.argv.includes("--compile-only")) { console.log(JSON.stringify({ compiled: true, ...compilerEvidence })); process.exit(0); }

const sex = arg("sex", "m");
assert.ok(["m", "f"].includes(sex), "sex must be m or f");
const seconds = Number(arg("seconds", "240"));
assert.ok(Number.isInteger(seconds) && seconds >= 10 && seconds <= 300, "render deadline must be 10..300 seconds");
const journal = resolve(arg("journal", join(runtime, "content-research/official-install.json")));
assert.ok(journal.startsWith(runtime + sep), "official journal must stay in the private runtime");
const manifest = JSON.parse(readFileSync(journal, "utf8"));
assert.ok(["awaiting-visual", "verified", "read-only-repeat"].includes(manifest.phase), "official fixture must be installed and held for visual checks");
const fixture = manifest.fixtures?.[sex];
assert.ok(Number.isSafeInteger(fixture?.characterId) && fixture.characterId > 0, "exact private fixture character ID is missing");
const credentialPath = resolve(fixture.credentialsPath);
assert.ok(credentialPath.startsWith(join(runtime, "credentials") + sep), "private credentials must stay in their runtime directory");
const account = JSON.parse(readFileSync(credentialPath, "utf8"));
assert.ok(typeof account.username === "string" && typeof account.password === "string", "private fixture credentials are incomplete");
const only = arg("only", "").split(",").filter(Boolean).map(Number);
const baseline = process.argv.includes("--baseline");
assert.ok(only.every(id => Number.isSafeInteger(id) && id > 0), "only requires exact numeric template IDs");
const templates = manifest.templates.filter(row => row.installed === true && (row.needSex === 0 || row.needSex === (sex === "m" ? 1 : 2)) && (!only.length || only.includes(row.id)))
  .map(({ id, pic, categoryId, needSex, officialId, name, sourceId }) => ({ id, pic, categoryId, needSex, officialId, name, sourceId }));
assert.ok(templates.length > 0, "no installed templates match the exact fixture");
for (const row of templates) assert.ok(Number.isSafeInteger(row.id) && [1, 2, 3, 4, 5, 6].includes(row.categoryId) && /^[A-Za-z0-9_-]+$/.test(row.pic), "installed appearance mapping is invalid");
if (only.length) assert.equal(templates.length, only.length, "one or more requested template IDs are not installed for this fixture");
if (baseline) assert.ok(templates.every(row => Number.isSafeInteger(row.sourceId) && row.sourceId > 0), "legacy baseline requires exact source template IDs");
const expectedJobs = view !== "appearances" ? 1 : baseline ? templates.length : templates.reduce((sum, row) => sum + (row.categoryId === 3 ? 4 : 2), 0);
const session = JSON.parse(readFileSync(join(runtime, "workshop-session.json"), "utf8"));
assert.equal(session.publicHost ?? "127.0.0.1", "127.0.0.1", "temporary client tickets require the loopback stack");
const apiUrl = "http://127.0.0.1:8080", webUrl = "http://127.0.0.1:5173";
const login = await fetch(`${apiUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: account.username, password: account.password }) });
assert.equal(login.status, 200, "exact private fixture login failed");
const { game } = await login.json();
assert.ok(game?.swfUrl && game.rufflePath && game.flashvars, "original client login configuration is incomplete");
const sensitiveValues = [...new Set([account.password, account.username, game.flashvars.user, game.flashvars.key].filter(value => typeof value === "string" && value.length > 0).flatMap(value => [value, encodeURIComponent(value)]))];
const redact = value => sensitiveValues.reduce((output, secret) => output.replaceAll(secret, "[redacted]"), value);
const replacer = (_key, value) => typeof value === "string" ? redact(value) : value;
const runId = randomUUID();
const output = join(privateRoot, `render-${sex}-${runId}`);
mkdirSync(output, { recursive: true });
const publicFile = join(repo, "apps/web/public", `workshop-official-${runId}.html`);
const probeFile = join(repo, "apps/web/public", `workshop-official-${runId}-Loading.swf`);
const loadingFile = join(repo, "apps/web/public", `workshop-official-${runId}-DDT_Loading.swf`);
const probeParameters = { probeView: view, probeUserId: fixture.characterId, probeTemplates: JSON.stringify(templates), probeBaseline: String(baseline), probeClient: game.swfUrl, probeGameModule: `${apiUrl}/flash/ui/vietnam/swf/game.swf` };
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#161822}#host{width:1000px;height:600px}</style><div id="host"></div><script>
const config=${JSON.stringify(game)};window.workshopProbeEvidence=[];
window.workshop_probe_report=value=>{window.workshopProbeEvidence.push(value);console.info('WORKSHOP_OFFICIAL',JSON.stringify(value));};
window.RufflePlayer={config:{publicPath:config.rufflePath.slice(0,config.rufflePath.lastIndexOf('/')+1),autoplay:'on',unmuteOverlay:'hidden',splashScreen:false,allowScriptAccess:true,socketProxy:config.socketProxy,fontSources:['/fonts/NotoSans-Regular.ttf','/fonts/NotoSans-Bold.ttf','/fonts/NotoSansSC-Regular.otf','/fonts/NotoSansSC-Bold.otf'],defaultFonts:{sans:['Noto Sans SC','Noto Sans'],serif:['Noto Sans SC','Noto Sans'],typewriter:['Noto Sans SC','Noto Sans']}}};
window.game_interruption=()=>console.error('original game connection interrupted');
const script=document.createElement('script');script.src=config.rufflePath;script.onload=async()=>{try{const p=window.RufflePlayer.newest().createPlayer();p.style.width='1000px';p.style.height='600px';document.getElementById('host').appendChild(p);await p.ruffle().load({url:${JSON.stringify(`${webUrl}/workshop-official-${runId}-Loading.swf`)},parameters:{...config.flashvars,...${JSON.stringify(probeParameters)}},base:config.base,socketProxy:config.socketProxy});}catch(e){console.error('official player load failed',String(e));}};document.head.appendChild(script);
</script>`;
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const evidence = { runId, view, sex, characterId: fixture.characterId, templates, expectedJobs, baseline, compiler: compilerEvidence, probe: [], requests: [], errors: [], captures: [], inventoryWrites: false, offlineImageComposition: false, gameplayAccepted: false };
let child, socket, diagnostics = "";
try {
  writeFileSync(publicFile, html, { flag: "wx" });
  writeFileSync(probeFile, readFileSync(probeSwf), { flag: "wx" });
  const loading = await fetch(game.swfUrl.replace("Loading.swf", "DDT_Loading.swf"));
  assert.equal(loading.status, 200, "original bootstrap next stage is unavailable");
  writeFileSync(loadingFile, Buffer.from(await loading.arrayBuffer()), { flag: "wx" });
  const chrome = process.env.WORKSHOP_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  assert.ok(existsSync(chrome), "local Chromium is unavailable");
  const profile = join(output, "profile");
  child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-features=WebGPU", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--window-size=1024,700", "--hide-scrollbars", "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", data => { diagnostics += data; });
  const exited = new Promise(resolveExit => child.once("exit", resolveExit));
  const activePort = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(activePort); i++) await delay(100);
  assert.ok(existsSync(activePort), "isolated headless browser did not start");
  const port = readFileSync(activePort, "utf8").split("\n")[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(row => row.type === "page");
  assert.ok(page, "isolated headless render page is unavailable");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map(); let seq = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) { const job = pending.get(message.id); pending.delete(message.id); if (job) message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result); }
    else if (message.method === "Network.responseReceived") evidence.requests.push({ path: new URL(message.params.response.url).pathname, status: message.params.response.status });
    else if (message.method === "Runtime.exceptionThrown") evidence.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    else if (message.method === "Runtime.consoleAPICalled") {
      if (message.params.args[0]?.value === "WORKSHOP_OFFICIAL") { try { evidence.probe.push(JSON.parse(message.params.args[1].value)); } catch {} }
      else if (message.params.type === "error") evidence.errors.push(message.params.args.map(value => value.value ?? value.description ?? "").join(" "));
    }
  });
  const command = (method, params = {}) => new Promise((resolveCommand, reject) => {
    const id = ++seq;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`render command deadline: ${method}`)); }, 30_000);
    pending.set(id, { resolve: result => { clearTimeout(timeout); resolveCommand(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command("Network.enable"); await command("Runtime.enable"); await command("Page.enable");
  await command("Page.navigate", { url: `${webUrl}/workshop-official-${runId}.html` });
  const captured = new Set();
  for (let elapsed = 0; elapsed < seconds; elapsed++) {
    await delay(1000);
    for (const ready of evidence.probe.filter(row => row.phase === "official-frame-ready" && !captured.has(row.job))) {
      const image = await command("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1000, height: 600, scale: 1 } });
      const path = join(output, `${String(ready.job).padStart(2, "0")}-${ready.templateID}-${ready.dye ? "dyed" : "original"}-${ready.hair === 1 ? "B" : "A"}.png`);
      writeFileSync(path, Buffer.from(image.data, "base64")); captured.add(ready.job);
      evidence.captures.push({ job: ready.job, templateID: ready.templateID, path, sha256: sha256(path) });
      writeFileSync(join(output, "evidence.json"), JSON.stringify(evidence, replacer, 2));
    }
    if (evidence.probe.some(row => row.phase === "official-render-complete" || row.phase === "official-probe-error")) break;
  }
  const final = await command("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(output, "final.png"), Buffer.from(final.data, "base64"));
  evidence.originalClientRenderCompleted = evidence.probe.some(row => row.phase === "official-render-complete" && row.jobs === expectedJobs && row.selfUnchanged);
  evidence.allJobsCaptured = captured.size === expectedJobs;
  evidence.allLayersLoaded = evidence.probe.filter(row => row.phase === "official-frame-ready").length === expectedJobs && evidence.probe.filter(row => row.phase === "official-frame-ready").every(row => row.components.every(component => component.completed && component.allLayerLoadsSucceeded !== false));
  evidence.requiresVisualReview = true;
  await command("Browser.close"); await Promise.race([exited, delay(3000)]);
  assert.ok(evidence.originalClientRenderCompleted && evidence.allJobsCaptured && evidence.allLayersLoaded, "original component rendering is incomplete; inspect exact private evidence");
  console.log(JSON.stringify({ output, view, sex, templates: templates.length, captures: evidence.captures.length, originalClientRenderCompleted: true, gameplayAccepted: false, requiresVisualReview: true }));
} finally {
  socket?.close();
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  writeFileSync(join(output, "evidence.json"), JSON.stringify(evidence, replacer, 2));
  writeFileSync(join(output, "browser.log"), redact(diagnostics));
  for (const path of [publicFile, probeFile, loadingFile]) if (existsSync(path)) unlinkSync(path);
}
