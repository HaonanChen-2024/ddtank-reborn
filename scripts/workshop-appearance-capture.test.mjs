import assert from "node:assert/strict";
import test from "node:test";
import { allAppearanceCapturesAccepted, appearanceHairBranchMatches, appearancePostCaptureDecision, appearancePreCaptureDecision, appearanceSnapshotEligible, freshAppearanceSnapshot, latestAppearanceSnapshot, sameAppearanceScene } from "./workshop-appearance-capture.mjs";

const ready = { phase: "official-frame-ready", job: 2, templateID: 13999100, dye: false, hidden: true, hair: 0, baseline: false };
const before = { ...ready, phase: "appearance-observation", ready: true, tick: 100, selfUnchanged: true, reportedAt: 9000, receivedAt: 9001 };
const after = { ...before, tick: 101, reportedAt: 10001, receivedAt: 10002 };

test("waits across the observed old-job invalidation, new-ready, new-observation ordering", () => {
  // render-m-41f45bb2: job 10 invalidated at tick 329, then job 11 ready;
  // the renderer previously rejected immediately before job 11's first tick.
  const invalidated = { ...before, job: 10, templateID: 13417, dye: true, hidden: false, ready: false, tick: 329,
    reportedAt: 1791814914777, receivedAt: 1791814914778 };
  const next = { ...ready, job: 11, templateID: 13417 };
  const now = 1791814914900, deadline = now + 1500;
  const rows = [invalidated, { phase: "official-render-requested", job: 11 }, next];
  assert.equal(appearancePreCaptureDecision(rows, next, now, deadline).decision, "wait");
  const current = { ...before, ...next, phase: "appearance-observation", tick: 330, reportedAt: now + 200, receivedAt: now + 201 };
  rows.push(current);
  const accepted = appearancePreCaptureDecision(rows, next, now + 202, deadline);
  assert.equal(accepted.decision, "observed"); assert.equal(accepted.before, current);
  assert.equal(accepted.readyIndex, 2); assert.equal(accepted.beforeIndex, 3);
  assert.equal(appearanceSnapshotEligible(accepted.before, next), true);
});

test("pre-capture never falls back to observations before the exact ready event and times out", () => {
  const rows = [before, ready];
  assert.equal(appearancePreCaptureDecision(rows, ready, 10000, 11500).decision, "wait");
  assert.equal(appearancePreCaptureDecision(rows, ready, 11499, 11500).decision, "wait");
  assert.equal(appearancePreCaptureDecision(rows, ready, 11500, 11500).decision, "reject");
  assert.equal(appearancePreCaptureDecision(rows, ready, 12000, 11500).decision, "reject");
  assert.equal(appearancePreCaptureDecision(rows, { ...ready }, 10000, 11500).decision, "reject");
});

test("pre-capture rejects any explicit post-ready invalidation or mismatch, even followed by a good snapshot", () => {
  for (const change of [{ job: 1 }, { templateID: 13999101 }, { dye: true }, { hidden: false }, { hair: 1 },
    { baseline: true }, { ready: false }, { selfUnchanged: false }, { tick: 0 }]) {
    const bad = { ...after, ...change };
    for (const rows of [[ready, bad], [ready, bad, after], [ready, after, bad]]) {
      assert.equal(appearancePreCaptureDecision(rows, ready, 10003, 11500).decision, "reject");
    }
  }
  assert.equal(appearancePreCaptureDecision([ready, { phase: "official-probe-error" }, after], ready, 10003, 11500).decision, "reject");
});

test("pre-capture preserves the 1500ms freshness gate and the bounded wait", () => {
  assert.equal(appearancePreCaptureDecision([ready, before], ready, 10500, 11500).decision, "observed");
  for (const change of [{ reportedAt: 8999 }, { receivedAt: 8999 }, { reportedAt: 10501 }, { receivedAt: 10501 },
    { reportedAt: undefined }, { receivedAt: undefined }]) {
    assert.equal(appearancePreCaptureDecision([ready, { ...before, ...change }], ready, 10500, 11500).decision, "reject");
  }
  assert.equal(appearancePreCaptureDecision([ready, after], ready, 10003, 10003).decision, "reject");
});

test("rejects the observed hair B job whose standalone layer loaded but composite still used A", () => {
  assert.equal(appearanceHairBranchMatches({ categoryId: 3, hair: 1, componentHairType: "A" }), false);
  assert.equal(appearanceHairBranchMatches({ categoryId: 3, hair: 0, componentHairType: "B" }), false);
  for (const hair of [0, 1]) assert.equal(appearanceHairBranchMatches({ categoryId: 3, hair, componentHairType: hair ? "B" : "A" }), true);
  assert.equal(appearanceHairBranchMatches({ categoryId: 3, hair: 1 }), false);
  assert.equal(appearanceHairBranchMatches({ categoryId: 13, hair: 0 }), true);
});

test("pairs a screenshot with a fresh newer observation of the exact appearance job", () => {
  assert.equal(appearanceSnapshotEligible(before, ready), true);
  assert.equal(freshAppearanceSnapshot(before, 10000), true);
  assert.equal(sameAppearanceScene(before, after, ready, 10000, 10003), true);
});

test("rejects stale, future, absent and one-sided timestamps", () => {
  for (const change of [{ reportedAt: 8499 }, { receivedAt: 8499 }, { reportedAt: 10001 }, { receivedAt: 10001 }, { reportedAt: undefined }, { receivedAt: undefined }, { reportedAt: 0 }]) {
    assert.equal(freshAppearanceSnapshot({ ...before, ...change }, 10000), false);
  }
  assert.equal(freshAppearanceSnapshot({ ...before, reportedAt: 8500, receivedAt: 8500 }, 10000), true);
  assert.equal(sameAppearanceScene(before, after, ready, 10000, 12000), false);
});

test("rejects job changes and every mismatched appearance variant", () => {
  for (const change of [{ job: 3 }, { templateID: 13999101 }, { dye: true }, { hidden: false }, { hair: 1 }, { baseline: true }]) {
    assert.equal(appearanceSnapshotEligible({ ...before, ...change }, ready), false);
    assert.equal(sameAppearanceScene(before, { ...after, ...change }, ready, 10000, 10003), false);
  }
  for (const key of ["job", "templateID", "dye", "hidden", "hair", "baseline"]) {
    assert.equal(appearanceSnapshotEligible({ ...before, [key]: undefined }, ready), false);
  }
});

test("keeps the latest not-ready observation instead of falling back to an old ready scene", () => {
  const invalidated = { ...after, ready: false };
  const latest = latestAppearanceSnapshot([before, { phase: "other" }, invalidated]);
  assert.equal(latest, invalidated);
  assert.equal(appearanceSnapshotEligible(latest, ready), false);
  assert.equal(sameAppearanceScene(before, latest, ready, 10000, 10003), false);
  assert.equal(appearanceSnapshotEligible({ ...before, selfUnchanged: false }, ready), false);
  assert.equal(latestAppearanceSnapshot([{ phase: "storage-observation" }]), undefined);
});

test("requires a new post-capture tick rather than a replayed or pre-capture observation", () => {
  for (const change of [{ tick: before.tick }, { tick: before.tick - 1 }, { reportedAt: before.reportedAt }, { reportedAt: 9999 }]) {
    assert.equal(sameAppearanceScene(before, { ...after, ...change }, ready, 10000, 10003), false);
  }
  assert.equal(sameAppearanceScene(before, undefined, ready, 10000, 10003), false);
});

test("waits past the observed 12ms queued-message boundary without tolerating changed scenes", () => {
  const capturedAt = 1791764469093;
  const queued = { ...after, reportedAt: 1791764469081, receivedAt: capturedAt };
  assert.equal(appearancePostCaptureDecision(queued, ready, capturedAt), "wait");
  assert.equal(appearancePostCaptureDecision(undefined, ready, capturedAt), "wait");
  const current = { ...queued, tick: queued.tick + 1, reportedAt: capturedAt + 238, receivedAt: capturedAt + 238 };
  assert.equal(appearancePostCaptureDecision(current, ready, capturedAt), "observed");
  assert.equal(appearancePostCaptureDecision({ ...current, reportedAt: capturedAt }, ready, capturedAt), "observed");
  for (const change of [{ job: 3 }, { templateID: 13999101 }, { ready: false }, { selfUnchanged: false }, { dye: true }, { reportedAt: undefined }]) {
    assert.equal(appearancePostCaptureDecision({ ...queued, ...change }, ready, capturedAt), "reject");
  }
  // Waiting for the right message does not alter the final freshness requirement.
  assert.equal(sameAppearanceScene(before, current, ready, capturedAt, capturedAt + 2000), false);
});

test("accepts only capture lists whose every image points to its own successful after gate", () => {
  const checks = [{ ...ready, phase: "before", accepted: true }, { ...ready, phase: "after", accepted: true }];
  const captures = [{ job: ready.job, templateID: ready.templateID, appearanceCaptureCheckIndex: 1 }];
  assert.equal(allAppearanceCapturesAccepted(captures, checks, 1), true);
  assert.equal(allAppearanceCapturesAccepted([{ ...captures[0], appearanceCaptureCheckIndex: 0 }], checks, 1), false);
  assert.equal(allAppearanceCapturesAccepted([{ ...captures[0], templateID: 13999101 }], checks, 1), false);
  assert.equal(allAppearanceCapturesAccepted(captures, [checks[0], { ...checks[1], accepted: false }], 1), false);
  assert.equal(allAppearanceCapturesAccepted([{ job: 2, templateID: 13999100 }], checks, 1), false);
  assert.equal(allAppearanceCapturesAccepted([...captures, ...captures], checks, 2), false);
});
