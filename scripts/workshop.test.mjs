import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import test from "node:test";
import { ensurePortsFree, portOpen, selectLanHost, stopOwnedChild } from "./workshop.mjs";

test("normal IPC stop and forced own-child termination are reported differently", async () => {
  for (const cooperate of [true, false]) {
    const child = spawn(process.execPath, ["--eval", `process.on('message', m => { if (${cooperate} && m === 'workshop-stop') process.exit(0); }); process.send('ready'); setInterval(() => {}, 1000);`], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.workshopName = "fixture";
    await new Promise((res, rej) => { child.once("message", res); child.once("error", rej); });
    try {
      const result = await stopOwnedChild(child, 100);
      assert.equal(result.stopped, true);
      assert.equal(result.forced, !cooperate);
      assert.equal(result.graceful, cooperate);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  }
});

test("LAN selection accepts a local private address and excludes virtual adapters by default", () => {
  const interfaces = {
    WLAN: [{ address: "192.168.1.6", internal: false }],
    VMware: [{ address: "192.168.200.1", internal: false }],
    loopback: [{ address: "127.0.0.1", internal: true }],
    external: [{ address: "8.8.8.8", internal: false }],
  };
  assert.equal(selectLanHost(undefined, interfaces), "192.168.1.6");
  assert.equal(selectLanHost("192.168.200.1", interfaces), "192.168.200.1");
  for (const value of ["0.0.0.0", "127.0.0.1", "8.8.8.8", "192.168.1.7"]) {
    assert.throws(() => selectLanHost(value, interfaces), /本机网卡/);
  }
  assert.throws(() => selectLanHost(undefined, { ...interfaces, Ethernet: [{ address: "10.1.1.2", internal: false }] }), /唯一/);
});

test("an occupied loopback port is refused without stopping its owner", async () => {
  const owner = net.createServer((socket) => socket.end());
  await new Promise((resolve) => owner.listen(0, "127.0.0.1", resolve));
  const port = owner.address().port;
  try {
    assert.equal(await portOpen(port), true);
    await assert.rejects(ensurePortsFree({ existing: port }), /端口已占用/);
    assert.equal(owner.listening, true);
    assert.equal(await portOpen(port), true);
  } finally { await new Promise((resolve) => owner.close(resolve)); }
  assert.equal(await portOpen(port), false);
  await ensurePortsFree({ closed: port });
});
