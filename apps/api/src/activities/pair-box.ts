/** Local matching-card rules based on pairBox prompts; payment and prizes are caller-owned. */
export interface PairBoxOptions {
  /** Unique face identifiers; each occurs exactly twice in the shuffled deck. */
  pairs: readonly string[];
  maxRestarts?: number;
}

export interface PairBoxState {
  version: 1;
  options: { pairs: string[]; maxRestarts: number };
  round: number;
  status: "playing" | "won";
  /** Server-only deck. Never serialize this state into an HTTP response. */
  cards: string[];
  flipped: number[];
  matched: number[];
  turns: number;
  restartsUsed: number;
}

export type PairBoxAction = { type: "flip"; index: number } | { type: "hide" } | { type: "restart" };
export type PairBoxEffect =
  | { type: "flipped"; round: number; index: number; value: string }
  | { type: "matched"; round: number; indices: number[]; value: string; matchedPairs: number }
  | { type: "mismatched"; round: number; indices: number[] }
  | { type: "hidden"; round: number; indices: number[] }
  | { type: "won"; round: number; matchedPairs: number; turns: number }
  | { type: "restarted"; round: number };
export interface PairBoxResult { state: PairBoxState; changed: boolean; effects: PairBoxEffect[] }

type Random = () => number;
function pick(length: number, rng: Random) {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError("RNG must return a number in [0, 1)");
  return Math.floor(value * length);
}
function copy(state: PairBoxState): PairBoxState {
  return { ...state, options: { ...state.options, pairs: [...state.options.pairs] }, cards: [...state.cards],
    flipped: [...state.flipped], matched: [...state.matched] };
}

export function createPairBox(options: PairBoxOptions, rng: Random = Math.random): PairBoxState {
  const maxRestarts = options.maxRestarts ?? 3;
  if (!Array.isArray(options.pairs) || options.pairs.length < 1 || options.pairs.length > 128
    || options.pairs.some(value => typeof value !== "string" || value.trim().length === 0)
    || new Set(options.pairs).size !== options.pairs.length
    || !Number.isSafeInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 1000)
    throw new RangeError("Invalid pair-box options");
  const cards = options.pairs.flatMap(value => [value, value]);
  for (let i = cards.length - 1; i > 0; i--) {
    const j = pick(i + 1, rng);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return { version: 1, options: { pairs: [...options.pairs], maxRestarts }, round: 1, status: "playing",
    cards, flipped: [], matched: [], turns: 0, restartsUsed: 0 };
}

/** A mismatch stays visible until hide; only completion permits restarting the deck. */
export function actPairBox(state: PairBoxState, action: PairBoxAction, rng: Random = Math.random): PairBoxResult {
  const unchanged = (): PairBoxResult => ({ state, changed: false, effects: [] });
  const finish = (next: PairBoxState, effects: PairBoxEffect[]): PairBoxResult => ({ state: next, changed: true, effects });
  if (action.type === "restart") {
    if (state.status !== "won" || state.restartsUsed >= state.options.maxRestarts) return unchanged();
    const next = createPairBox(state.options, rng);
    next.round = state.round + 1;
    next.restartsUsed = state.restartsUsed + 1;
    return finish(next, [{ type: "restarted", round: next.round }]);
  }
  if (state.status !== "playing") return unchanged();
  if (action.type === "hide") {
    if (state.flipped.length !== 2) return unchanged();
    const next = copy(state), indices = [...next.flipped];
    next.flipped = [];
    return finish(next, [{ type: "hidden", round: next.round, indices }]);
  }
  if (action.type !== "flip" || !Number.isSafeInteger(action.index) || action.index < 0 || action.index >= state.cards.length
    || state.flipped.length === 2 || state.matched.includes(action.index) || state.flipped.includes(action.index)) return unchanged();
  const next = copy(state), index = action.index;
  next.flipped.push(index);
  const effects: PairBoxEffect[] = [{ type: "flipped", round: next.round, index, value: next.cards[index] }];
  if (next.flipped.length === 2) {
    next.turns++;
    const [first, second] = next.flipped;
    if (next.cards[first] === next.cards[second]) {
      next.matched.push(first, second);
      next.flipped = [];
      effects.push({ type: "matched", round: next.round, indices: [first, second], value: next.cards[first], matchedPairs: next.matched.length / 2 });
      if (next.matched.length === next.cards.length) {
        next.status = "won";
        effects.push({ type: "won", round: next.round, matchedPairs: next.matched.length / 2, turns: next.turns });
      }
    } else effects.push({ type: "mismatched", round: next.round, indices: [first, second] });
  }
  return finish(next, effects);
}

/** No hidden faces, deck order, or pair options are exposed. */
export function viewPairBox(state: PairBoxState) {
  return { version: state.version, round: state.round, status: state.status, turns: state.turns,
    pairCount: state.cards.length / 2, matchedPairs: state.matched.length / 2,
    restartsRemaining: state.options.maxRestarts - state.restartsUsed, canHide: state.flipped.length === 2,
    cards: state.cards.map((value, index) => {
      const matched = state.matched.includes(index), faceUp = matched || state.flipped.includes(index);
      return { index, matched, faceUp, ...(faceUp ? { value } : {}) };
    }) };
}
