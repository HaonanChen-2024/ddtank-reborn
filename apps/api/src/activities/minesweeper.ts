/** Local board rules based on boguAdventure prompts; prices and rewards belong to the caller. */
export interface MinesweeperOptions {
  width: number;
  height: number;
  mineCount: number;
  lives: number;
  /** Per round; reset by restart. The default of 1 is a local rule. */
  maxRevives?: number;
  /** Across this persisted session; restart increments round and consumes one. */
  maxRestarts?: number;
  rewardSteps?: readonly number[];
}

export interface MinesweeperState {
  version: 1;
  options: Required<Omit<MinesweeperOptions, "rewardSteps">> & { rewardSteps: number[] };
  round: number;
  status: "ready" | "playing" | "lost" | "won";
  /** Server-only layout. Return viewMinesweeper(state), never this state, to clients. */
  mines: number[];
  opened: number[];
  marked: number[];
  probed: number[];
  position: number | null;
  lives: number;
  revivesUsed: number;
  restartsUsed: number;
  rewardStepsReached: number[];
}

export type MinesweeperAction =
  | { type: "open"; index: number }
  | { type: "mark"; index: number; marked: boolean }
  | { type: "probe" }
  | { type: "revive" }
  | { type: "restart" };

export type MinesweeperEffect =
  | { type: "opened"; round: number; index: number; adjacentMines: number; safeOpened: number }
  | { type: "mine"; round: number; index: number; lives: number }
  | { type: "marked"; round: number; index: number; marked: boolean }
  | { type: "probed"; round: number; index: number }
  | { type: "milestone"; round: number; safeOpened: number }
  | { type: "won"; round: number; safeOpened: number }
  | { type: "revived"; round: number; lives: number }
  | { type: "restarted"; round: number };

export interface MinesweeperResult {
  state: MinesweeperState;
  changed: boolean;
  effects: MinesweeperEffect[];
}

type Random = () => number;
function integer(value: number, min: number, max: number) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function pick(length: number, rng: Random) {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError("RNG must return a number in [0, 1)");
  return Math.floor(value * length);
}
function copy(state: MinesweeperState): MinesweeperState {
  return { ...state, options: { ...state.options, rewardSteps: [...state.options.rewardSteps] },
    mines: [...state.mines], opened: [...state.opened], marked: [...state.marked], probed: [...state.probed],
    rewardStepsReached: [...state.rewardStepsReached] };
}
function neighbors(index: number, width: number, height: number) {
  const x = index % width, y = Math.floor(index / width), result: number[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if ((dx !== 0 || dy !== 0) && x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height)
      result.push((y + dy) * width + x + dx);
  }
  return result;
}
function adjacent(state: MinesweeperState, index: number) {
  return neighbors(index, state.options.width, state.options.height).filter(cell => state.mines.includes(cell)).length;
}
function safeOpened(state: MinesweeperState) {
  return state.opened.filter(index => !state.mines.includes(index)).length;
}

export function createMinesweeper(options: MinesweeperOptions, rng: Random = Math.random): MinesweeperState {
  const { width, height, mineCount, lives } = options;
  const size = width * height;
  const maxRevives = options.maxRevives ?? 1, maxRestarts = options.maxRestarts ?? 3;
  // This is a local allocation bound, not a claim about reference-server dimensions.
  if (!integer(width, 1, 4096) || !integer(height, 1, 4096) || !integer(size, 1, 4096)
    || !integer(mineCount, 0, size - 1) || !integer(lives, 1, 1000)
    || !integer(maxRevives, 0, 1000) || !integer(maxRestarts, 0, 1000))
    throw new RangeError("Invalid minesweeper options");
  const rewardSteps = [...(options.rewardSteps ?? [])];
  if (rewardSteps.some(step => !integer(step, 1, size - mineCount)) || new Set(rewardSteps).size !== rewardSteps.length)
    throw new RangeError("Invalid minesweeper reward steps");
  rewardSteps.sort((a, b) => a - b);
  const available = Array.from({ length: size }, (_, index) => index), mines: number[] = [];
  for (let i = 0; i < mineCount; i++) mines.push(available.splice(pick(available.length, rng), 1)[0]);
  return { version: 1, options: { width, height, mineCount, lives, maxRevives, maxRestarts, rewardSteps },
    round: 1, status: "ready", mines, opened: [], marked: [], probed: [], position: null,
    lives, revivesUsed: 0, restartsUsed: 0, rewardStepsReached: [] };
}

/** Call within the caller's state/cost/reward transaction. Failed and repeated actions have no effects. */
export function actMinesweeper(state: MinesweeperState, action: MinesweeperAction, rng: Random = Math.random): MinesweeperResult {
  const unchanged = (): MinesweeperResult => ({ state, changed: false, effects: [] });
  const finish = (next: MinesweeperState, effects: MinesweeperEffect[]): MinesweeperResult => ({ state: next, changed: true, effects });
  if (action.type === "restart") {
    if (state.status === "ready" || state.restartsUsed >= state.options.maxRestarts) return unchanged();
    const next = createMinesweeper(state.options, rng);
    next.round = state.round + 1;
    next.restartsUsed = state.restartsUsed + 1;
    return finish(next, [{ type: "restarted", round: next.round }]);
  }
  if (action.type === "revive") {
    if (state.status !== "lost" || state.lives !== 0 || state.revivesUsed >= state.options.maxRevives) return unchanged();
    const next = copy(state);
    next.lives = state.options.lives;
    next.revivesUsed++;
    next.status = "playing";
    return finish(next, [{ type: "revived", round: next.round, lives: next.lives }]);
  }
  if (state.lives <= 0 || state.status === "lost" || state.status === "won") return unchanged();
  if (action.type === "probe") {
    if (state.position === null) return unchanged();
    const candidates = neighbors(state.position, state.options.width, state.options.height)
      .filter(index => state.mines.includes(index) && !state.opened.includes(index) && !state.probed.includes(index));
    if (candidates.length === 0) return unchanged();
    const index = candidates[pick(candidates.length, rng)], next = copy(state);
    next.probed.push(index);
    return finish(next, [{ type: "probed", round: next.round, index }]);
  }
  if (action.type !== "mark" && action.type !== "open") return unchanged();
  const index = action.index;
  if (!integer(index, 0, state.options.width * state.options.height - 1) || state.opened.includes(index)) return unchanged();
  if (action.type === "mark") {
    // Explicit desired state makes a repeated request idempotent; do not implement a blind toggle.
    if (typeof action.marked !== "boolean" || state.marked.includes(index) === action.marked) return unchanged();
    const next = copy(state);
    next.marked = action.marked ? [...next.marked, index] : next.marked.filter(cell => cell !== index);
    return finish(next, [{ type: "marked", round: next.round, index, marked: action.marked }]);
  }
  if (state.marked.includes(index)) return unchanged();
  const next = copy(state);
  if (next.status === "ready") {
    // Local first-open safety rule, not a verified reference-server behavior.
    // Relocate a first-hit mine before exposing any cell; all remaining cells remain eligible.
    if (next.mines.includes(index)) {
      const candidates = Array.from({ length: next.options.width * next.options.height }, (_, cell) => cell)
        .filter(cell => cell !== index && !next.mines.includes(cell));
      next.mines[next.mines.indexOf(index)] = candidates[pick(candidates.length, rng)];
    }
    next.status = "playing";
  }
  next.opened.push(index);
  next.position = index;
  if (next.mines.includes(index)) {
    next.lives--;
    if (next.lives === 0) next.status = "lost";
    return finish(next, [{ type: "mine", round: next.round, index, lives: next.lives }]);
  }
  // One action opens one cell, as the reference's walking/count prompts describe; no flood fill.
  const count = safeOpened(next);
  const effects: MinesweeperEffect[] = [{ type: "opened", round: next.round, index, adjacentMines: adjacent(next, index), safeOpened: count }];
  for (const threshold of next.options.rewardSteps) if (count >= threshold && !next.rewardStepsReached.includes(threshold)) {
    next.rewardStepsReached.push(threshold);
    effects.push({ type: "milestone", round: next.round, safeOpened: threshold });
  }
  if (count === next.options.width * next.options.height - next.options.mineCount) {
    next.status = "won";
    effects.push({ type: "won", round: next.round, safeOpened: count });
  }
  return finish(next, effects);
}

/** Public projection deliberately excludes mine layout and closed-cell neighbor counts. */
export function viewMinesweeper(state: MinesweeperState) {
  return { version: state.version, round: state.round, width: state.options.width, height: state.options.height,
    mineCount: state.options.mineCount, status: state.status, lives: state.lives, maxLives: state.options.lives,
    position: state.position, safeOpened: safeOpened(state), safeTotal: state.options.width * state.options.height - state.options.mineCount,
    revivesRemaining: state.options.maxRevives - state.revivesUsed, restartsRemaining: state.options.maxRestarts - state.restartsUsed,
    rewardSteps: [...state.options.rewardSteps], rewardStepsReached: [...state.rewardStepsReached],
    cells: Array.from({ length: state.options.width * state.options.height }, (_, index) => {
      const opened = state.opened.includes(index), marked = state.marked.includes(index), probed = state.probed.includes(index);
      return { index, opened, marked, probed,
        ...(opened ? { mine: state.mines.includes(index), ...(state.mines.includes(index) ? {} : { adjacentMines: adjacent(state, index) }) } : {}),
        ...(!opened && probed ? { mine: true } : {}) };
    }) };
}
