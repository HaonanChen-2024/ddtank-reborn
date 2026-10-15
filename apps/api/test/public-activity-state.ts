import assert from "node:assert/strict";

// Public Snowfield status fields are not the private activity save named `state`.
// Numeric path components only come from real arrays, so object/dotted-key lookalikes fail.
export function assertPublicActivityStates(value: unknown): void {
  const walk = (current: unknown, path: (string | number)[]): void => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => walk(entry, [...path, index]));
    } else if (current !== null && typeof current === "object") {
      for (const [key, entry] of Object.entries(current)) {
        const next = [...path, key];
        if (key === "state") {
          const publicStates = next.length === 3 && next[0] === "nativeChristmasSnowfield"
            ? next[1] === "scene" ? ["outside", "loading", "inside", "fighting", "settling"]
              : next[1] === "attempt" ? ["none", "admitted", "launching", "fighting", "settling"] : []
            : next.length === 4 && next[0] === "nativeChristmasSnowfield" && next[1] === "challenges"
              && typeof next[2] === "number" ? ["unavailable", "alive", "reserved", "fighting", "dead"] : [];
          assert(typeof entry === "string" && publicStates.includes(entry), `Unexpected private or invalid public state at ${JSON.stringify(next)}`);
        }
        walk(entry, next);
      }
    }
  };
  walk(value, []);
}
