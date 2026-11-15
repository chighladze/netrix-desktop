import { fetchJsonOrThrow, getApiBase } from "../../api";
import type { SavedHostDto, TerminalHost } from "../../types/host";
import { normalizeGroupPath } from "../../utils/groupUtils";
import { decodeHost } from "./api";
import { hostGroupPaths } from "./presentation";
import { inFolder, relocateFolder, validateFolderDestination } from "./folders";

export interface FolderState {
  hosts: SavedHostDto[];
  hostsEpoch: number;
  definedGroups: Set<string>;
  collapsedGroups: Set<string>;
  hostGroupsBusy: boolean;
  selectedHost: TerminalHost | null;
}
interface FolderDependencies {
  fetchHosts: () => Promise<SavedHostDto[]>;
  addToast: (message: string, type: "error" | "success" | "info") => void;
}
export function createFolderActions(
  set: (update: Partial<FolderState> | ((state: FolderState) => Partial<FolderState>)) => void,
  get: () => FolderState & FolderDependencies,
) {
  return {
    moveHostFolder: async (sourceValue: string, destinationValue: string) => {
      const source = normalizeGroupPath(sourceValue), destination = normalizeGroupPath(destinationValue);
      const state = get();
      if (state.hostGroupsBusy) throw new Error("Wait for the current folder change to finish.");
      const paths = hostGroupPaths(state.hosts, state.definedGroups);
      if (!paths.includes(source)) throw new Error("This folder no longer exists. Refresh Hosts and try again.");
      const invalid = validateFolderDestination(source, destination, paths);
      if (invalid) throw new Error(invalid);
      const members = state.hosts.filter(host => inFolder(normalizeGroupPath(host.group), source));
      set({ hostGroupsBusy: true, hostsEpoch: state.hostsEpoch + 1 });
      try {
        const response = await fetchJsonOrThrow<unknown[]>(`${await getApiBase()}/host-groups/move`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source, destination, hosts: members.map(({ id, revision }) => ({ id, revision })) }),
        });
        const updated = new Map(response.map(row => { const host = decodeHost(row); return [host.id, host]; }));
        set(current => {
          const definedGroups = new Set([...current.definedGroups].map(path => relocateFolder(path, source, destination)));
          // Retain the moved folder even when its last host is moved elsewhere later.
          definedGroups.add(destination);
          const collapsedGroups = new Set([...current.collapsedGroups].map(path => relocateFolder(path, source, destination)));
          const hosts = current.hosts.map(host => {
            const saved = updated.get(host.id);
            return saved && saved.revision >= host.revision ? saved : host;
          });
          return { hosts, hostsEpoch: current.hostsEpoch + 1, definedGroups, collapsedGroups,
            selectedHost: hosts.find(host => host.id === current.selectedHost?.id) ?? current.selectedHost };
        });
        try {
          localStorage.setItem("definedGroups", JSON.stringify([...get().definedGroups]));
          localStorage.setItem("collapsedGroups", JSON.stringify([...get().collapsedGroups]));
        } catch { get().addToast("Folder updated, but its display preferences could not be saved.", "error"); }
      } catch (error) {
        try { await get().fetchHosts(); } catch { /* Keep the original error. */ }
        throw error;
      } finally { set(current => ({ hostGroupsBusy: false, hostsEpoch: current.hostsEpoch + 1 })); }
    },
  };
}
