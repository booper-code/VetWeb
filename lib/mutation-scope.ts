/** Invalidates pending UI completions on clinic, user, logout or device changes. */
export function createMutationScope() {
  let generation = 0;
  return {
    capture: () => generation,
    isCurrent: (captured: number) => captured === generation,
    invalidate: () => { generation += 1; }
  };
}
