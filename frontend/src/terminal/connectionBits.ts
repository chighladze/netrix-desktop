// Decorative activity data, never captured traffic. Avoid near-empty octets.
const candidates = Array.from({ length: 256 }, (_, value) => value.toString(2).padStart(8, "0"))
  .filter(octet => {
    const ones = [...octet].filter(bit => bit === "1").length;
    return ones >= 2 && ones <= 6;
  });

const difference = (left: string, right: string) => [...left].filter((bit, index) => bit !== right[index]).length;

/** Every group changes visibly, and all six groups differ from one another. */
export function createConnectionOctets(previous: readonly string[] = [], random = Math.random): string[] {
  const octets: string[] = [];
  for (let group = 0; group < 6; group++) {
    const choices = candidates.filter(candidate => !previous.includes(candidate)
      && (!previous[group] || difference(candidate, previous[group]) >= 3)
      && octets.every(octet => difference(candidate, octet) >= 3));
    // The 8-bit pool leaves candidates even after five peer exclusions and the
    // previous group's distance constraint; no random-retry loop is needed.
    octets.push(choices[Math.floor(random() * choices.length)]);
  }
  return octets;
}
