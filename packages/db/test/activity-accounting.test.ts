import { describe, expect, it } from "vitest";
import { ActivityAccountingError, ACTIVITY_GROSS_LIMIT, readChargePersistentState, recordActivitySpending } from "../src/activity-accounting.js";
const now = new Date("2026-10-15T01:00:00Z");
describe("persisted activity gross accounting", () => {
  it("GET defaults do not mutate input; positive gross tracks real cost once", () => {
    const initial = readChargePersistentState(undefined, now), next = recordActivitySpending(initial, now, 20);
    expect(initial.grossSpent).toBe(0); expect(next).toMatchObject({ grossSpent: 20, trackingStartedAt: now.toISOString(), grossCapped: false });
    expect(recordActivitySpending(next, now, 0)).toEqual(next);
  });
  it("UTC rollover resets only daily purchases and preserves gross and unknown fields", () => {
    const old = { ...recordActivitySpending(undefined, now, 20), bought: [1,2,3,3,3,3,3], extra: { retained: true } };
    expect(readChargePersistentState(old, new Date("2026-10-16Z"))).toMatchObject({ day: "2026-10-16", bought: [0,0,0,0,0,0,0], grossSpent: 20, extra: { retained: true } });
    expect(old.bought).toEqual([1,2,3,3,3,3,3]);
  });
  it("saturates with the original INT32 contract", () => {
    const s = recordActivitySpending(undefined, now, ACTIVITY_GROSS_LIMIT-1);
    expect(recordActivitySpending(s, now, 20)).toMatchObject({ grossSpent: ACTIVITY_GROSS_LIMIT, grossCapped: true });
  });
  it.each([null,{version:2},{...readChargePersistentState(undefined,now),bought:[2,0,0,0,0,0,0]}, {...readChargePersistentState(undefined,now),day:"2026-02-31"}])("preserves and rejects incompatible state %j", raw => {
    const original=structuredClone(raw);expect(()=>readChargePersistentState(raw,now)).toThrow(ActivityAccountingError);expect(raw).toEqual(original);
  });
});
