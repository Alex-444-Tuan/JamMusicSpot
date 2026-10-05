export function createSystemClock() {
  return {
    now: () => Date.now(),
  };
}
