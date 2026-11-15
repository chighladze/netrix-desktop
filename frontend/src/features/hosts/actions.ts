import { ApiError, fetchJsonOrThrow, getApiBase } from "../../api";
import type {
  HostConnectionUpdate,
  HostMutation,
  HostPatch,
  SavedHostDto,
  TerminalHost,
} from "../../types/host";
import { decodeHost, requestHost, requestHosts, writeHost } from "./api";

export interface HostsState {
  hosts: SavedHostDto[];
  hostsLoading: boolean;
  hostsError: string | null;
  hostsEpoch: number;
  selectedHost: TerminalHost | null;
  updateTabHost: (id: number, changes: HostConnectionUpdate) => void;
}
export interface HostsActions {
  setHosts: (hosts: SavedHostDto[]) => void;
  fetchHosts: () => Promise<SavedHostDto[]>;
  createHost: (payload: HostMutation) => Promise<SavedHostDto>;
  patchHost: (
    id: number,
    changes: Omit<HostPatch, "revision"> & { revision?: number },
  ) => Promise<SavedHostDto>;
  deleteHost: (id: number) => Promise<void>;
}

export function createHostsActions(
  set: (update: Partial<HostsState> | ((state: HostsState) => Partial<HostsState>)) => void,
  get: () => HostsState & HostsActions,
): HostsActions {
  let flight: { epoch: number; promise: Promise<SavedHostDto[]> } | undefined;
  const queues = new Map<number, Promise<unknown>>();
  const invalidate = () => set((state) => ({ hostsEpoch: state.hostsEpoch + 1 }));
  const upsert = (host: SavedHostDto) => {
    set((state) => ({
      hostsEpoch: state.hostsEpoch + 1,
      hosts: [...state.hosts.filter((h) => h.id !== host.id), host].sort(
        (a, b) => a.name.localeCompare(b.name) || a.id - b.id,
      ),
      selectedHost: state.selectedHost?.id === host.id ? host : state.selectedHost,
    }));
    // A live terminal keeps the connection snapshot it actually opened with.
    get().updateTabHost(host.id, {
      name: host.name,
      terminal_theme: host.terminal_theme,
      terminal_font_size: host.terminal_font_size,
      terminal_background: host.terminal_background,
      terminal_foreground: host.terminal_foreground,
      terminal_appearance: host.terminal_appearance,
    });
  };
  const enqueue = <T>(id: number, task: () => Promise<T>): Promise<T> => {
    const pending = (queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(task);
    queues.set(id, pending);
    void pending
      .finally(() => {
        if (queues.get(id) === pending) queues.delete(id);
      })
      .catch(() => undefined);
    return pending;
  };
  return {
    setHosts: (hosts) => {
      invalidate();
      set({ hosts: hosts.map(decodeHost) });
    },
    fetchHosts: () => {
      const epoch = get().hostsEpoch;
      if (flight?.epoch === epoch) return flight.promise;
      set({ hostsLoading: true, hostsError: null });
      const promise = requestHosts()
        .then((hosts) => {
          if (get().hostsEpoch === epoch) {
            set({ hosts });
            return hosts;
          }
          return get().fetchHosts();
        })
        .catch((error: unknown) => {
          if (get().hostsEpoch === epoch)
            set({ hostsError: error instanceof Error ? error.message : "Failed to load hosts" });
          throw error;
        })
        .finally(() => {
          if (flight?.promise === promise) {
            flight = undefined;
            set({ hostsLoading: false });
          }
        });
      flight = { epoch, promise };
      return promise;
    },
    createHost: async (payload) => {
      invalidate();
      try {
        const host = await writeHost(payload);
        upsert(host);
        return host;
      } catch (error) {
        try {
          invalidate();
          await get().fetchHosts();
        } catch {
          /* Preserve the original failure. */
        }
        throw error;
      } finally {
        invalidate();
      }
    },
    patchHost: (id, changes) =>
      enqueue(id, async () => {
        invalidate();
        try {
          const current = get().hosts.find((h) => h.id === id) ?? (await requestHost(id));
          const host = await writeHost(
            { ...changes, revision: changes.revision ?? current.revision },
            id,
          );
          upsert(host);
          return host;
        } catch (error) {
          // Reconcile conflicts and uncertain network outcomes without losing the form's input.
          try {
            invalidate();
            await get().fetchHosts();
          } catch {
            /* Preserve the original failure. */
          }
          throw error;
        } finally {
          invalidate();
        }
      }),
    deleteHost: (id) =>
      enqueue(id, async () => {
        invalidate();
        try {
          try {
            await fetchJsonOrThrow<void>(`${await getApiBase()}/hosts/${id}`, { method: "DELETE" });
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
          }
          set((state) => ({
            hostsEpoch: state.hostsEpoch + 1,
            hosts: state.hosts.filter((h) => h.id !== id),
            selectedHost: state.selectedHost?.id === id ? null : state.selectedHost,
          }));
        } catch (error) {
          try {
            invalidate();
            await get().fetchHosts();
          } catch {
            /* Preserve the original failure. */
          }
          throw error;
        } finally {
          invalidate();
        }
      }),
  };
}
