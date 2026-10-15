import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeActivityMenu, NATIVE_ACTIVITY_MENU_KINDS, type NativeActivityMenuPlayer } from "./GameFrame";

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function fixture() {
  let current = true;
  const status = { version: 1, open: false, actualUserId: 40, characterId: 40, token: "", pending: false, message: "" };
  const result = vi.fn((id: number, token: string, _kind: string, opened: boolean) => {
    if (id !== status.characterId || token !== status.token) return false;
    status.pending = false; if (opened) status.open = false; return true;
  });
  const player: NativeActivityMenuPlayer = {
    workshopOpenActivityMenu: vi.fn((id, token) => { status.characterId = id; status.token = token; status.open = true; return true; }),
    workshopStatusActivityMenu: vi.fn(() => ({ ...status })),
    workshopCloseActivityMenu: vi.fn(token => { if (token !== status.token) return false; status.open = false; return true; }),
    workshopActivityMenuResult: result,
  };
  const openers = Object.fromEntries(NATIVE_ACTIVITY_MENU_KINDS.map(kind => [kind, vi.fn(async (_id: number, _signal?: AbortSignal): Promise<boolean> => true)])) as Record<typeof NATIVE_ACTIVITY_MENU_KINDS[number], ReturnType<typeof vi.fn<(id: number, signal?: AbortSignal) => Promise<boolean>>>>;
  const sign = vi.fn(() => true), activation = vi.fn(() => true), notice = vi.fn();
  const menu = createNativeActivityMenu({ player, isCurrent: () => current, openers, sign, activation, notice });
  return { menu, player, status, result, openers, sign, activation, notice, replacePlayer: () => { current = false; } };
}
afterEach(() => vi.unstubAllGlobals());

describe("game-owned native activity menu", () => {
  it.each(NATIVE_ACTIVITY_MENU_KINDS)("opens %s through the existing host once, with a cancellation signal", async kind => {
    const f = fixture(); expect(f.menu.open(40)).toBe(true); const token = f.status.token;
    expect(f.menu.select(40, token, kind)).toBe(true);
    expect(f.openers[kind]).not.toHaveBeenCalled(); // No AVM2 reentry before synchronous acknowledgement.
    expect(f.menu.select(40, token, kind)).toBe(false); await flush();
    expect(f.openers[kind]).toHaveBeenCalledOnce(); const [id, signal] = f.openers[kind].mock.calls[0]!;
    expect(id).toBe(40); expect(signal?.aborted).toBe(false);
    expect(f.result).toHaveBeenCalledWith(40, token, kind, true, "");
    expect(f.sign).not.toHaveBeenCalled(); expect(f.activation).not.toHaveBeenCalled();
  });
  it.each(["sign", "activation"])("uses the existing original %s window without calling an activity host", async kind => {
    const f = fixture(); expect(f.menu.open()).toBe(true); expect(f.menu.select(40, f.status.token, kind)).toBe(true); await flush();
    expect(kind === "sign" ? f.sign : f.activation).toHaveBeenCalledOnce();
    for (const opener of Object.values(f.openers)) expect(opener).not.toHaveBeenCalled();
  });
  it("rejects wrong role, token, unknown kind, prototype key and non-current player without side effects", async () => {
    const f = fixture(); f.menu.open(40); const token = f.status.token;
    for (const [id, nonce, kind] of [[41, token, "carnival"], [40, "old", "carnival"], [40, token, "__proto__"], [40, token, "unknown"]] as const)
      expect(f.menu.select(id, nonce, kind)).toBe(false);
    f.replacePlayer(); expect(f.menu.select(40, token, "carnival")).toBe(false); await flush();
    for (const opener of Object.values(f.openers)) expect(opener).not.toHaveBeenCalled(); expect(f.result).not.toHaveBeenCalled();
  });
  it("rejects a mismatched AS identity or menu version", () => {
    const f = fixture(); f.status.actualUserId = 41; expect(f.menu.open(40)).toBe(false);
    expect(f.player.workshopOpenActivityMenu).not.toHaveBeenCalled();
    f.status.actualUserId = 40; f.status.version = 0; expect(f.menu.open(40)).toBe(false);
    expect(f.notice).toHaveBeenCalled();
  });
  it("reports missing installation and never opens an HTML activity hub", () => {
    const f = fixture(); delete f.player.workshopOpenActivityMenu;
    expect(f.menu.open(40)).toBe(false); expect(f.notice).toHaveBeenCalledWith(expect.stringContaining("尚未安装"));
    expect(f.result).not.toHaveBeenCalled();
  });
  it("reuses an already open menu and never overwrites an in-flight selection", async () => {
    const f = fixture(); f.openers.carnival.mockImplementation(() => new Promise(() => {}));
    f.menu.open(40); const token = f.status.token; expect(f.menu.open(40)).toBe(true);
    expect(f.player.workshopOpenActivityMenu).toHaveBeenCalledOnce();
    f.menu.select(40, token, "carnival"); expect(f.menu.open(40)).toBe(false); await flush();
    expect(f.status.token).toBe(token); f.menu.cancel();
  });
  it("cancels a queued selection before it can call a host", async () => {
    const f = fixture(); f.menu.open(40); const token = f.status.token;
    f.menu.select(40, token, "carnival"); f.menu.closed(40, token); await flush();
    expect(f.openers.carnival).not.toHaveBeenCalled(); expect(f.result).not.toHaveBeenCalled();
  });
  it("aborts an in-flight opening and ignores its late success after close and reopen", async () => {
    const f = fixture(); let finish!: (opened: boolean) => void;
    f.openers.carnival.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    f.menu.open(40); const token = f.status.token; f.menu.select(40, token, "carnival"); await flush();
    const signal = f.openers.carnival.mock.calls[0]![1]!; f.menu.closed(40, token); expect(signal.aborted).toBe(true);
    expect(f.menu.open(40)).toBe(true); expect(f.status.token).not.toBe(token);
    finish(true); await flush(); expect(f.result).not.toHaveBeenCalled(); expect(f.status.open).toBe(true);
  });
  it("keeps a failed opening in the same AS menu for explicit retry", async () => {
    const f = fixture(); f.openers.carnival.mockResolvedValueOnce(false); f.menu.open(40); const token = f.status.token;
    f.menu.select(40, token, "carnival"); await flush(); expect(f.status.open).toBe(true);
    expect(f.result).toHaveBeenCalledWith(40, token, "carnival", false, expect.stringContaining("未能打开"));
    expect(f.menu.select(40, token, "carnival")).toBe(true); await flush(); expect(f.openers.carnival).toHaveBeenCalledTimes(2);
  });
  it("does not abort an activity after successful handoff when the menu is later cancelled", async () => {
    const f = fixture(); f.menu.open(40); f.menu.select(40, f.status.token, "carnival"); await flush();
    const signal = f.openers.carnival.mock.calls[0]![1]!; f.menu.cancel(); expect(signal.aborted).toBe(false);
  });
  it("does not deliver a result after the owning game player changes", async () => {
    const f = fixture(); let finish!: (opened: boolean) => void;
    f.openers.carnival.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    f.menu.open(40); f.menu.select(40, f.status.token, "carnival"); await flush(); f.replacePlayer(); finish(true); await flush();
    expect(f.result).not.toHaveBeenCalled(); f.menu.cancel();
  });
});
