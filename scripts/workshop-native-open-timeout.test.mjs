import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const groups = [];
const test = (name, run) => groups.push({ name, run });
let scenarios = 0;

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const ts = require("typescript");
const sourcePath = new URL("../apps/web/src/components/GameFrame.tsx", import.meta.url);
const source = readFileSync(sourcePath, "utf8");
const tree = ts.createSourceFile(sourcePath.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const owners = new Map();
let budgetSource;
function visit(node) {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
    ts.isIdentifier(d.name) && d.name.text === "NATIVE_ACTIVITY_OPEN_TIMEOUT_MS")) budgetSource = node.getText(tree);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression)
    && node.left.expression.text === "window" && node.left.name.text.startsWith("workshopShow")
    && ts.isArrowFunction(node.right) && node.right.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    owners.set(node.left.name.text, node.getText(tree) + ";");
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert(budgetSource, "Use the actual production timeout constant");
const specs = [
  ["Wardrobe", "wardrobe"], ["Pair", "pair"], ["Mines", "mines"], ["DDPlay", "ddplay"],
  ["Gypsy", "gypsy"], ["Moonlight", "moonlight"], ["Treasure", "treasure"], ["Purr", "purr"],
  ["Carnival", "carnival"], ["FirstRecharge", "firstRecharge"], ["Charge", "charge"],
  ["Forthright", "forthright"], ["Exchange", "exchange"], ["Devil", "devil"],
  ["CaveLoot", "caveloot"], ["Christmas", "christmas"],
];
const compiled = new Map(specs.map(([name]) => {
  const owner = owners.get("workshopShow" + name);
  assert(owner, "Missing actual owner " + name);
  return [name, new vm.Script(ts.transpileModule(budgetSource + "\n" + owner, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, { filename: sourcePath.pathname })];
}));

// Execute the actual owner functions. Only the clock, Ruffle transport callbacks,
// and unrelated HTTP host attachment are substituted; waiting/cancellation is not copied.
async function run([name, prefix], options = {}) {
  scenarios++;
  let elapsed = 0, closeCalls = 0, openCalls = 0, generation = "", started = false;
  const abort = new AbortController();
  if (options.aborted) abort.abort();
  const owner = {
    ["workshopOpen" + name]: (_characterId, value) => {
      openCalls++;
      started = true;
      generation = value;
      return !options.openRefused;
    },
    ["workshopStatus" + name]: () => {
      if (elapsed >= (options.throwAt ?? Infinity)) throw Error("Actual callback failure");
      const failed = elapsed >= (options.failAt ?? Infinity);
      const open = started && elapsed >= (options.readyAt ?? 0) && !failed;
      return {
        phase: failed ? "error" : open ? "open" : "loading-bootstrap",
        visible: open, open,
        actualUserId: elapsed >= (options.identityAt ?? Infinity) ? 41 : 40,
        expectedUserId: started ? 40 : 0,
        generation: elapsed >= (options.generationAt ?? Infinity) ? "other-generation" : generation,
        errors: failed ? [{ message: "Actual module failure" }] : [],
      };
    },
    ["workshopClose" + name]: () => { closeCalls++; },
  };
  const context = {
    window: { setTimeout: callback => {
      elapsed += 100;
      if (elapsed >= (options.abortAt ?? Infinity)) abort.abort();
      if (elapsed >= (options.playerChangedAt ?? Infinity)) context.player = {};
      if (elapsed >= (options.cancelledAt ?? Infinity)) context.cancelled = true;
      callback();
    } },
    Date: { now: () => elapsed }, Number,
    cancelled: false, player: owner, queryClient: { setQueryData() {} },
    crypto: { randomUUID: () => "test-generation" },
    [prefix + "Request"]: null,
    [prefix + "Host"]: null,
    [prefix + "CharacterId"]: 0,
    [prefix + "Generation"]: "",
    ["attachNative" + name + "Host"]: () => ({ cancel() {} }),
  };
  vm.createContext(context);
  compiled.get(name).runInContext(context);
  const result = await context.window["workshopShow" + name](options.characterId ?? 40, abort.signal);
  assert.equal(context[prefix + "Request"], null, name + " must release the pending open request");
  const beforeLateAbort = closeCalls;
  abort.abort();
  assert.equal(closeCalls, beforeLateAbort, name + " must remove its abort listener when done");
  return { result, elapsed, closeCalls, openCalls };
}

test("all 16 production activity owners use the bounded two-phase loading budget", () => {
  assert.deepEqual([...owners.keys()].sort(), specs.map(([name]) => "workshopShow" + name).sort());
  const context = vm.createContext({});
  const budget = new vm.Script(budgetSource + "\nNATIVE_ACTIVITY_OPEN_TIMEOUT_MS;").runInContext(context);
  assert.equal(budget, 125_000, "60s shared + 60s module + bounded polling margin");
  for (const [name] of specs) {
    assert(owners.get("workshopShow" + name).includes("Date.now() + NATIVE_ACTIVITY_OPEN_TIMEOUT_MS"), name);
  }
});

for (const spec of specs) test(spec[0] + ": actual open owner accepts slow loads and preserves rejection/cancellation", async () => {
  for (const readyAt of [0, 14_900, 16_000, 59_900, 119_900, 124_900]) {
    assert.deepEqual(await run(spec, { readyAt }), {
      result: true, elapsed: readyAt, closeCalls: 0, openCalls: 1,
    }, spec[0] + " ready at " + readyAt);
  }
  assert.deepEqual(await run(spec, { readyAt: 125_100 }), {
    result: false, elapsed: 125_000, closeCalls: 1, openCalls: 1,
  }, "Over-budget loading stays bounded");
  for (const failure of ["failAt", "throwAt", "abortAt", "playerChangedAt", "cancelledAt"]) {
    assert.deepEqual(await run(spec, { readyAt: 10_000, [failure]: 500 }), {
      result: false, elapsed: 500, closeCalls: 1, openCalls: 1,
    }, spec[0] + " " + failure);
  }
  assert.deepEqual(await run(spec, { readyAt: 600, identityAt: 500 }), {
    result: false, elapsed: 125_000, closeCalls: 1, openCalls: 1,
  }, "A visible window with the wrong actual role is never accepted");
  if (spec[0] !== "Wardrobe") assert.deepEqual(await run(spec, { readyAt: 600, generationAt: 500 }), {
    result: false, elapsed: 125_000, closeCalls: 1, openCalls: 1,
  }, "A visible window from a different host generation is never accepted");
  assert.deepEqual(await run(spec, { aborted: true }), {
    result: false, elapsed: 0, closeCalls: 0, openCalls: 0,
  }, "A user close before opening does not call the player");
  assert.deepEqual(await run(spec, { characterId: 40.5 }), {
    result: false, elapsed: 0, closeCalls: 0, openCalls: 0,
  }, "Invalid identity does not call the player");
  assert.deepEqual(await run(spec, { openRefused: true }), {
    result: false, elapsed: 0, closeCalls: 1, openCalls: 1,
  }, "Native open refusal is immediate");
});

if (process.argv.includes("--worker")) {
  // Keep vm's async functions in a plain Node process: Node 24's node:test
  // async_hooks can abort natively in CleanupQueue::Add during this workload.
  // No assertion or production behavior is disabled by this separation.
  for (const group of groups) await group.run();
  console.log(JSON.stringify({ groups: groups.map(group => group.name), scenarios, passed: true }));
} else {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
    encoding: "utf8", timeout: 30_000,
  });
  const { test: nodeTest } = await import("node:test");
  nodeTest("actual activity open functions in an isolated plain-Node VM worker", async t => {
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.passed, true);
    assert.equal(proof.scenarios, 271);
    assert.deepEqual(proof.groups, groups.map(group => group.name));
    for (const name of proof.groups) await t.test(name, () => assert.equal(proof.passed, true));
  });
}
