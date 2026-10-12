// Pure gates for pairing an original-client appearance screenshot with its job.
const fields = ["job", "templateID", "dye", "hidden", "hair", "baseline"];
const validIdentity = row => Number.isSafeInteger(row?.job) && row.job >= 0 &&
  Number.isSafeInteger(row?.templateID) && row.templateID > 0 && [0, 1].includes(row?.hair) &&
  ["dye", "hidden", "baseline"].every(key => typeof row?.[key] === "boolean");

export const latestAppearanceSnapshot = rows => rows.filter(row => row.phase === "appearance-observation").at(-1);

// Loading a standalone A/B layer does not prove the original composite selected it.
export const appearanceHairBranchMatches = row => row?.categoryId !== 3 ||
  ([0, 1].includes(row.hair) && row.componentHairType === (row.hair === 1 ? "B" : "A"));

export const appearanceSnapshotEligible = (row, ready) => row?.phase === "appearance-observation" &&
  ready?.phase === "official-frame-ready" && validIdentity(row) && validIdentity(ready) &&
  row.ready === true && row.selfUnchanged === true && Number.isSafeInteger(row.tick) && row.tick > 0 &&
  fields.every(key => row[key] === ready[key]);

export const freshAppearanceSnapshot = (row, now = Date.now()) => Number.isFinite(now) &&
  [row?.receivedAt, row?.reportedAt].every(value => Number.isFinite(value) && value > 0 && now - value >= 0 && now - value <= 1500);

// The new frame-ready event can precede its first periodic observation. An old
// job's invalidation before that event is not evidence about the new scene.
// Use event order, not timestamps, to define the boundary; never skip an
// explicit invalidation or mismatched observation received after that boundary.
export const appearancePreCaptureDecision = (rows, ready, now, deadline) => {
  const readyIndex = rows.indexOf(ready);
  const result = (decision, reason, before, beforeIndex) => ({ decision, reason, readyIndex, before, beforeIndex });
  if (readyIndex < 0 || ready?.phase !== "official-frame-ready" || !validIdentity(ready) ||
      !Number.isFinite(now) || now <= 0 || !Number.isFinite(deadline)) return result("reject", "invalid ready boundary or deadline");
  let before, beforeIndex;
  for (let index = readyIndex + 1; index < rows.length; index++) {
    const row = rows[index];
    if (row.phase === "official-probe-error") return result("reject", "probe error after ready");
    if (row.phase !== "appearance-observation") continue;
    if (!appearanceSnapshotEligible(row, ready)) return result("reject", "appearance invalidated or mismatched after ready", row, index);
    before = row; beforeIndex = index;
  }
  if (now >= deadline) return result("reject", "fresh observation wait timed out", before, beforeIndex);
  if (!before) return result("wait", "awaiting first observation after ready");
  return freshAppearanceSnapshot(before, now) ? result("observed", "fresh exact appearance observed after ready", before, beforeIndex) :
    result("reject", "appearance observation after ready is stale or has invalid timestamps", before, beforeIndex);
};

// A queued observation may arrive after the screenshot while having been produced just before it.
// Wait only for that same ready job; an explicit scene change must still fail immediately.
export const appearancePostCaptureDecision = (row, ready, capturedAt) => {
  if (!row) return "wait";
  if (!appearanceSnapshotEligible(row, ready) || !Number.isFinite(row.reportedAt) || row.reportedAt <= 0) return "reject";
  return row.reportedAt < capturedAt ? "wait" : "observed";
};

export const sameAppearanceScene = (before, after, ready, capturedAt, now = Date.now()) =>
  appearanceSnapshotEligible(before, ready) && appearanceSnapshotEligible(after, ready) &&
  Number.isFinite(capturedAt) && capturedAt > 0 && after.reportedAt >= capturedAt &&
  after.tick > before.tick && after.reportedAt > before.reportedAt && freshAppearanceSnapshot(after, now);

export const allAppearanceCapturesAccepted = (captures, checks, expectedJobs) =>
  captures.length === expectedJobs && new Set(captures.map(row => row.job)).size === expectedJobs &&
  captures.every(row => {
    if (!Number.isSafeInteger(row.appearanceCaptureCheckIndex)) return false;
    const check = checks[row.appearanceCaptureCheckIndex];
    return check?.phase === "after" && check.accepted === true && check.job === row.job && check.templateID === row.templateID;
  });
