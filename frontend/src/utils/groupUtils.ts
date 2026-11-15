import type { SavedHostDto } from "../types/host";

export interface HostGroup {
  name: string;
  path: string;
  parentPath: string | null;
  isExpanded: boolean;
  hosts: SavedHostDto[];
  subgroups: HostGroup[];
}

/**
 * Parses a group_path and returns an array of segments.
 * Example: "Production/Europe/London" → ["Production", "Europe", "London"]
 */
export function normalizeGroupPath(path: string | null | undefined): string {
  return (path ?? "").split("/").map(segment => segment.trim()).filter(Boolean).join("/");
}

export function parseGroupPath(path: string | undefined): string[] {
  if (!path || path.trim() === "") return [];
  return normalizeGroupPath(path).split("/").filter(Boolean);
}

/**
 * Returns the parent path from a full path.
 * Example: "Production/Europe/London" → "Production/Europe"
 */
export function getParentPath(path: string): string | null {
  const segments = parseGroupPath(path);
  if (segments.length <= 1) return null;
  return segments.slice(0, -1).join("/");
}

/**
 * Returns the group name from a path (last segment).
 * Example: "Production/Europe/London" → "London"
 */
export function getGroupName(path: string): string {
  const segments = parseGroupPath(path);
  return segments[segments.length - 1] || "";
}

/**
 * Checks whether a path is a child of parentPath.
 */
export function isChildPath(path: string, parentPath: string): boolean {
  if (!path || !parentPath) return false;
  return path.startsWith(parentPath + "/");
}

/**
 * Validates a group path.
 */
export function isValidGroupPath(path: string): boolean {
  if (!path || path.trim() === "") return false;
  // Allow letters, digits, underscores, hyphens, and spaces
  const normalized = normalizeGroupPath(path);
  const parts = normalized.split("/");
  return normalized.length > 0 && [...normalized].length <= 100 && parts.length <= 16
    && parts.every(part => part !== "." && part !== ".." && !/[\u0000-\u001f\u007f-\u009f]/u.test(part));
}

/**
 * Builds a group tree from an array of hosts.
 */
export function buildGroupTree(
  hosts: SavedHostDto[],
  collapsedGroups: Set<string> = new Set(),
  knownPaths: Set<string> = new Set(),
  descending = false,
): HostGroup[] {
  const groupMap = new Map<string, HostGroup>();
  const rootGroups: HostGroup[] = [];

  // First, collect all unique paths
  const allPaths = new Set<string>();
  
  hosts.forEach((host) => {
    if (host.group) {
      const segments = parseGroupPath(host.group);
      // Add all intermediate paths
      for (let i = 1; i <= segments.length; i++) {
        allPaths.add(segments.slice(0, i).join("/"));
      }
    }
  });

  // Include any explicitly known group paths (even if no hosts yet)
  knownPaths.forEach((p) => {
    if (p && p.trim() !== "") {
      const segments = parseGroupPath(p);
      for (let i = 1; i <= segments.length; i++) {
        allPaths.add(segments.slice(0, i).join("/"));
      }
    }
  });

  // Create groups for all paths
  allPaths.forEach((path) => {
    if (!groupMap.has(path)) {
      const parentPath = getParentPath(path);
      const group: HostGroup = {
        name: getGroupName(path),
        path: path,
        parentPath: parentPath,
        isExpanded: !collapsedGroups.has(path), // Default is expanded (if not in collapsed set)
        hosts: [],
        subgroups: [],
      };
      groupMap.set(path, group);
    }
  });

  // Assign hosts to their groups
  hosts.forEach((host) => {
    const groupPath = normalizeGroupPath(host.group);
    if (groupPath && groupMap.has(groupPath)) {
      const group = groupMap.get(groupPath)!;
      group.hosts.push(host);
    }
  });

  // Build the hierarchy
  groupMap.forEach((group) => {
    if (group.parentPath && groupMap.has(group.parentPath)) {
      const parent = groupMap.get(group.parentPath)!;
      parent.subgroups.push(group);
    } else {
      // This is a top-level group
      rootGroups.push(group);
    }
  });

  // Sort groups and subgroups by name
  const sortGroups = (groups: HostGroup[]) => {
    groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * (descending ? -1 : 1));
    groups.forEach((g) => sortGroups(g.subgroups));
  };
  sortGroups(rootGroups);

  return rootGroups;
}

/**
 * Returns all hosts that have no group assigned.
 */
export function getUngroupedHosts(hosts: SavedHostDto[]): SavedHostDto[] {
  return hosts.filter((host) => !normalizeGroupPath(host.group));
}

/**
 * Finds a group by its path in the tree.
 */
export function findGroupByPath(
  groups: HostGroup[],
  path: string
): HostGroup | null {
  for (const group of groups) {
    if (group.path === path) return group;
    const found = findGroupByPath(group.subgroups, path);
    if (found) return found;
  }
  return null;
}

/**
 * Returns all available paths for moving a group (excluding current and children).
 */
export function getAvailableMovePaths(
  groups: HostGroup[],
  excludePath?: string
): string[] {
  const paths: string[] = [];
  
  const traverse = (grps: HostGroup[]) => {
    grps.forEach((g) => {
      if (!excludePath || (g.path !== excludePath && !isChildPath(g.path, excludePath))) {
        paths.push(g.path);
        traverse(g.subgroups);
      }
    });
  };
  
  traverse(groups);
  return paths.sort();
}

/**
 * Creates a new group path.
 */
export function createGroupPath(parentPath: string | null, groupName: string): string {
  const sanitizedName = groupName.trim();
  if (!parentPath) return sanitizedName;
  return `${parentPath}/${sanitizedName}`;
}
