export type TerminalLayout = "single" | "columns" | "rows" | "grid";
export function selectPanes(
  current: string[],
  available: string[],
  active: string | null,
  limit: number,
): string[] {
  const next = current
    .filter((id, index) => available.includes(id) && current.indexOf(id) === index)
    .slice(0, limit);
  // Re-entering the workspace fills free panes in tab order, then reveals focus.
  for (const id of available) if (next.length < limit && !next.includes(id)) next.push(id);
  if (active && available.includes(active) && !next.includes(active)) {
    if (next.length >= limit) next[next.length - 1] = active;
    else next.push(active);
  }
  return next;
}
