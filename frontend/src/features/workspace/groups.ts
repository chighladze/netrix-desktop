import type { TerminalLayout } from "./panes";

export interface TerminalGroup {
  id: string;
  layout: TerminalLayout;
  tabIds: string[];
  activeTabId?: string;
  paneSlots?: (string | null)[];
}

export const paneLimit = (layout: TerminalLayout) => layout === "grid" ? 4 : layout === "single" ? 1 : 2;

export const findTerminalGroup = (groups: TerminalGroup[], tabId: string | null) =>
  groups.find((group) => tabId !== null && group.tabIds.includes(tabId));

/** Membership and pane position are separate: closing pane 2 must not move pane 3. */
export function terminalGroupSlots(group: TerminalGroup): (string | null)[] {
  const seen = new Set<string>();
  const slots = Array.from({ length: 4 }, (_, index) => {
    const id = (group.paneSlots ?? group.tabIds)[index];
    if (!id || !group.tabIds.includes(id) || seen.has(id)) return null;
    seen.add(id);
    return id;
  });
  for (const id of group.tabIds) {
    if (seen.has(id)) continue;
    const index = slots.indexOf(null);
    if (index < 0) break;
    slots[index] = id;
    seen.add(id);
  }
  return slots;
}

export function visibleTerminalSlots(group: TerminalGroup, active: string | null, layout = group.layout): (string | null)[] {
  if (layout === "single") return [active];
  const slots = terminalGroupSlots(group).slice(0, paneLimit(layout));
  if (active && group.tabIds.includes(active) && !slots.includes(active)) slots[slots.length - 1] = active;
  return slots;
}

export function canFillTerminalPane(group: TerminalGroup | undefined, index: number): group is TerminalGroup {
  return !!group && group.layout !== "single" && Number.isInteger(index) && index >= 0
    && index < paneLimit(group.layout) && terminalGroupSlots(group)[index] === null;
}

/** A group occupies one slot in the strip, at its first member's position. */
export function terminalStripEntries<T extends { id: string }>(tabs: T[], groups: TerminalGroup[]) {
  const seen = new Set<string>();
  return tabs.flatMap((tab) => {
    const group = findTerminalGroup(groups, tab.id);
    if (!group) return [{ tab, group: undefined as TerminalGroup | undefined }];
    if (seen.has(group.id)) return [];
    seen.add(group.id);
    return [{ tab: tabs.find((item) => item.id === group.tabIds[0]) ?? tab, group }];
  });
}
