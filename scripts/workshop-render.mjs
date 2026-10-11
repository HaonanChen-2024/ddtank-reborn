#!/usr/bin/env node
// Isolated headless Chromium render test. No desktop controls, clicks, or existing browser profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(repo, "../../runtime");
const chrome = process.env.WORKSHOP_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
assert.ok(existsSync(chrome), "Chrome executable is unavailable");
const fixture = process.argv.find(arg => arg.startsWith("--fixture="))?.slice(10) ?? "smoke";
assert.ok(["smoke", "wardrobe"].includes(fixture), "unknown private fixture");
const account = fixture === "wardrobe" ? JSON.parse(readFileSync(join(runtime, "credentials/wardrobe-fixture-account.json"), "utf8")) : JSON.parse(readFileSync(join(runtime, "credentials/smoke-accounts.json"), "utf8"))[0];
const probe = process.argv.find(arg => arg.startsWith("--probe="))?.slice(8);
const wardrobeProbe = probe === "wardrobe";
assert.ok(!wardrobeProbe || fixture === "wardrobe", "wardrobe writes require the private wardrobe fixture");
const probeSource = resolve(process.argv.find(arg => arg.startsWith("--probe-file="))?.slice(13) ?? join(runtime,
  wardrobeProbe ? "content-research/WorkshopWardrobeProbe.swf" : "client-research/WorkshopProbe.swf"));
assert.ok(probeSource.startsWith(runtime + "/") || probeSource.startsWith(runtime + "\\"), "compiled test probe must stay in private runtime");
assert.ok(probeSource.toLowerCase().endsWith(".swf"), "compiled test probe requires an SWF file");
const seconds = Number(process.argv.find(arg => arg.startsWith("--seconds="))?.slice(10) ?? (wardrobeProbe ? 90 : 30));
const session = JSON.parse(readFileSync(join(runtime, "workshop-session.json"), "utf8"));
const host = session.publicHost ?? "127.0.0.1";
assert.equal(host, "127.0.0.1", "private render fixtures require the loopback stack; temporary login tickets must not be served on LAN");
const apiUrl = `http://${host}:8080`;
const webUrl = `http://${host}:5173`;
assert.ok(Number.isInteger(seconds) && seconds >= 10 && seconds <= 120, "render duration must be 10..120 seconds");
assert.ok(!probe || ["observe", "shop", "battle", "wardrobe", "language"].includes(probe), "unknown probe action");
const probeParameters = {};
if (fixture === "wardrobe" && probe) {
  const journal = JSON.parse(readFileSync(join(runtime, "content-research/wardrobe-lifecycle.json"), "utf8"));
  assert.equal(journal.phase, "awaiting-visual", "wardrobe fixture must be held and unrolled-back before rendering");
  assert.equal(journal.fixture?.username, account.username, "wardrobe account differs from its journal");
  for (const value of [journal.fixture?.characterId, journal.mail?.itemId, journal.template?.id])
    assert.ok(Number.isSafeInteger(value) && value > 0, "missing exact wardrobe fixture identity");
  assert.ok(typeof journal.template?.pic === "string" && /^[A-Za-z0-9_-]+$/.test(journal.template.pic), "invalid wardrobe fixture Pic");
  Object.assign(probeParameters, { probeUserId: journal.fixture.characterId, probeItemId: journal.mail.itemId,
    probeTemplateId: journal.template.id, probePic: journal.template.pic });
}
const response = await fetch(`${apiUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: account.username, password: account.password }) });
assert.equal(response.status, 200);
const { game } = await response.json();
const sensitiveValues = [...new Set([account.password, account.username, game.flashvars?.user, game.flashvars?.key]
  .filter(value => typeof value === "string" && value.length > 0).flatMap(value => [value, encodeURIComponent(value)]))];
const redactDiagnostics = value => sensitiveValues.reduce((output, secret) => output.replaceAll(secret, "[redacted]"), value);
const diagnosticReplacer = (_key, value) => typeof value === "string" ? redactDiagnostics(value) : value;
const id = randomUUID();
const output = join(runtime, "client-render", id);
mkdirSync(output, { recursive: true });
const publicFile = join(repo, "apps/web/public", `workshop-render-${id}.html`);
const probeFile = join(repo, "apps/web/public", `workshop-probe-${id}-Loading.swf`);
const probeLoadingFile = join(repo, "apps/web/public", `workshop-probe-${id}-DDT_Loading.swf`);
const screenshot = join(output, "boot.png");
let wardrobeRestored = !wardrobeProbe, wardrobeError = "";
const delay = ms => new Promise(res => setTimeout(res, ms));
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#161822;color:white}#host{width:1000px;height:600px}#status{font:14px sans-serif;padding:8px}</style><div id="host"></div><div id="status">Loading real client...</div><script>
const config=${JSON.stringify(game)};
window.workshopProbeEvidence=[];window.workshop_probe_report=value=>{window.workshopProbeEvidence.push(value);console.info('WORKSHOP_PROBE',JSON.stringify(value));};
window.RufflePlayer={config:{publicPath:config.rufflePath.slice(0,config.rufflePath.lastIndexOf('/')+1),autoplay:'on',unmuteOverlay:'hidden',splashScreen:false,allowScriptAccess:true,socketProxy:config.socketProxy,fontSources:['/fonts/NotoSans-Regular.ttf','/fonts/NotoSans-Bold.ttf','/fonts/NotoSansSC-Regular.otf','/fonts/NotoSansSC-Bold.otf'],defaultFonts:{sans:['Noto Sans SC','Noto Sans'],serif:['Noto Sans SC','Noto Sans'],typewriter:['Noto Sans SC','Noto Sans']}}};
window.game_interruption=()=>document.getElementById('status').textContent='Game connection interrupted';
const script=document.createElement('script');script.src=config.rufflePath;
script.onload=async()=>{try{const p=window.RufflePlayer.newest().createPlayer();p.style.width='1000px';p.style.height='600px';document.getElementById('host').appendChild(p);await p.ruffle().load({url:${probe ? JSON.stringify(`${webUrl}/workshop-probe-${id}-Loading.swf`) : "config.swfUrl"},parameters:${probe ? `{...config.flashvars,...${JSON.stringify(probeParameters)},probeClient:config.swfUrl,probeAction:${JSON.stringify(probe)}}` : "config.flashvars"},base:config.base,socketProxy:config.socketProxy});document.getElementById('status').textContent='Ruffle loaded; inspect captured game state separately';}catch(e){document.getElementById('status').textContent='Ruffle error: '+String(e);}};
document.head.appendChild(script);
</script>`;
try {
  writeFileSync(publicFile, html, { flag: "wx" });
  if (probe) {
    writeFileSync(probeFile, readFileSync(probeSource), { flag: "wx" });
    // The original bootstrap replaces Loading.swf in the root URL to locate its next stage.
    const loading = await fetch(game.swfUrl.replace("Loading.swf", "DDT_Loading.swf"));
    assert.equal(loading.status, 200);
    writeFileSync(probeLoadingFile, Buffer.from(await loading.arrayBuffer()), { flag: "wx" });
  }
  const profile = join(output, "profile");
  const child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-features=WebGPU", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--window-size=1024,700", "--hide-scrollbars", `${webUrl}/workshop-render-${id}.html`], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = "", socket;
  const evidence = { errors: [], requests: [], websocketFrames: 0, probe: [] };
  child.stderr.on("data", b => { diagnostics += b; });
  const exited = new Promise(res => child.once("exit", res));
  try {
    const activePort = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(activePort); i++) await delay(100);
    assert.ok(existsSync(activePort), "isolated headless browser did not start");
    const port = readFileSync(activePort, "utf8").split("\n")[0];
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find(p => p.url.includes(`workshop-render-${id}`));
    assert.ok(page, "render test tab not found");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { socket.addEventListener("open", res, { once: true }); socket.addEventListener("error", rej, { once: true }); });
    const pending = new Map(); let seq = 0;
    socket.addEventListener("message", event => {
      const m = JSON.parse(event.data);
      if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (p) m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      else if (m.method === "Network.responseReceived") evidence.requests.push({ path: new URL(m.params.response.url).pathname, status: m.params.response.status });
      else if (m.method === "Network.webSocketFrameSent" || m.method === "Network.webSocketFrameReceived") evidence.websocketFrames++;
      else if (m.method === "Runtime.exceptionThrown") evidence.errors.push(m.params.exceptionDetails.text);
      else if (m.method === "Runtime.consoleAPICalled" && m.params.args[0]?.value === "WORKSHOP_PROBE") {
        try { evidence.probe.push(JSON.parse(m.params.args[1].value)); } catch {}
      }
    });
    const command = (method, params = {}) => new Promise((resolveCommand, reject) => {
      const id = ++seq;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`render command deadline: ${method}`)); }, 30_000);
      pending.set(id, { resolve: result => { clearTimeout(timeout); resolveCommand(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await command("Network.enable");
    await command("Runtime.enable");
    // Use elapsed real time. Virtual time skips the animation frames the real Ruffle player needs.
    let mixedCaptured = false;
    for (let elapsed = 0; elapsed < seconds; elapsed++) {
      await delay(1000);
      if (!wardrobeProbe) continue;
      if (!mixedCaptured && evidence.probe.some(event => event.phase === "original-mixed-observed")) {
        const mixedCapture = await command("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(output, "mixed.png"), Buffer.from(mixedCapture.data, "base64"));
        mixedCaptured = true;
      }
      wardrobeRestored = evidence.probe.some(event => event.phase === "original-mixed-restored");
      const error = evidence.probe.find(event => event.phase === "wardrobe-probe-error" || event.phase === "wardrobe-load-error");
      if (error) wardrobeError = redactDiagnostics(String(error.text));
      if (wardrobeRestored || wardrobeError) break;
    }
    const capture = await command("Page.captureScreenshot", { format: "png" });
    writeFileSync(screenshot, Buffer.from(capture.data, "base64"));
    writeFileSync(join(output, "network.json"), JSON.stringify(evidence, diagnosticReplacer, 2));
    await command("Browser.close");
    await Promise.race([exited, delay(3000)]);
  } finally {
    socket?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill(); // Only this run's isolated browser.
    writeFileSync(join(output, "network.json"), JSON.stringify(evidence, diagnosticReplacer, 2));
    writeFileSync(join(output, "browser.log"), redactDiagnostics(diagnostics));
  }
  assert.ok(existsSync(screenshot), "missing screenshot");
  assert.ok(wardrobeRestored && !wardrobeError,
    `wardrobe restoration was not verified: ${wardrobeError || "deadline"}; read the exact journal and restore or roll back the fixture normally`);
  console.log(JSON.stringify({ screenshot, renderCaptured: true, gameplayAccepted: false, ...(wardrobeProbe ? { wardrobeRestored: true } : {}) }));
} finally {
  if (existsSync(publicFile)) unlinkSync(publicFile); // Only this run's uniquely named temporary HTML.
  if (existsSync(probeFile)) unlinkSync(probeFile);
  if (existsSync(probeLoadingFile)) unlinkSync(probeLoadingFile);
}
