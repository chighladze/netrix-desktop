import { describe, expect, it, vi } from "vitest";
import { fetchJsonOrThrow } from "../../api";
import { createFolderActions, type FolderState } from "./folderActions";
import { folderAncestors, inFolder, validateFolderDestination } from "./folders";
import type { SavedHostDto } from "../../types/host";

vi.mock("../../api", () => ({ getApiBase: async () => "http://127.0.0.1:8000", fetchJsonOrThrow: vi.fn() }));
const request = vi.mocked(fetchJsonOrThrow);
const host = (id: number, group: string): SavedHostDto => ({ id, revision: id, name: `Host ${id}`, hostname: "example.test", port: 22, connection_type: "ssh", group });
function setup() {
  request.mockReset();
  let state: FolderState = { hosts: [host(1, "Prod/DB"), host(2, "Prod/Web"), host(3, "Production")], hostsEpoch: 0, definedGroups: new Set(["Prod/Empty", "Other"]), collapsedGroups: new Set(["Prod", "Prod/DB", "Other"]), hostGroupsBusy: false, selectedHost: host(1, "Prod/DB") };
  const fetchHosts = vi.fn(async () => state.hosts), addToast = vi.fn();
  const actions = createFolderActions(update => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; }, () => ({ ...state, fetchHosts, addToast }));
  return { get: () => state, actions, fetchHosts, addToast };
}
describe("host folders", () => {
  it("renames every empty/collapsed descendant and merges public host responses", async () => {
    const { get, actions } = setup();
    request.mockResolvedValue([ { ...host(1, "Live/DB"), revision: 10 }, { ...host(2, "Live/Web"), revision: 11 } ]);
    await actions.moveHostFolder("Prod", "Live");
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ source: "Prod", destination: "Live", hosts: [{ id: 1, revision: 1 }, { id: 2, revision: 2 }] });
    expect(get().hosts.map(h => h.group)).toEqual(["Live/DB", "Live/Web", "Production"]);
    expect([...get().definedGroups]).toEqual(["Live/Empty", "Other", "Live"]);
    expect([...get().collapsedGroups]).toEqual(["Live", "Live/DB", "Other"]);
    expect(get().selectedHost?.group).toBe("Live/DB");
    expect(JSON.parse(localStorage.getItem("definedGroups")!)).toContain("Live/Empty");
    expect(get().hostGroupsBusy).toBe(false);
  });
  it("leaves folder metadata untouched on a conflict and refreshes host state", async () => {
    const { get, actions, fetchHosts } = setup();
    request.mockRejectedValue(new Error("Folder changed"));
    await expect(actions.moveHostFolder("Prod", "Live")).rejects.toThrow("Folder changed");
    expect([...get().definedGroups]).toEqual(["Prod/Empty", "Other"]);
    expect([...get().collapsedGroups]).toEqual(["Prod", "Prod/DB", "Other"]);
    expect(fetchHosts).toHaveBeenCalledOnce();
    expect(get().hostGroupsBusy).toBe(false);
  });
  it("checks empty folders with the backend and rejects collisions or cycles locally", async () => {
    const { get, actions } = setup();
    await expect(actions.moveHostFolder("Prod", "Other")).rejects.toThrow("already exists");
    await expect(actions.moveHostFolder("Prod", "Prod/Child")).rejects.toThrow("outside");
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue([]);
    await actions.moveHostFolder("Other", "Prod/Other");
    expect([...get().definedGroups]).toContain("Prod/Other");
    expect(JSON.parse(request.mock.calls[0][1]!.body as string).hosts).toEqual([]);
  });
  it("validates descendant lengths and keeps similarly named branches separate", () => {
    expect(inFolder("Production/DB", "Prod")).toBe(false);
    expect(validateFolderDestination("Prod", "x".repeat(99), ["Prod", "Prod/DB"])).toContain("nested");
    expect(folderAncestors("Prod/Europe/DB")).toEqual([{ name: "Prod", path: "Prod" }, { name: "Europe", path: "Prod/Europe" }, { name: "DB", path: "Prod/Europe/DB" }]);
  });

  it("keeps a committed move when preference storage fails and blocks concurrent folder mutations", async () => {
    const { get, actions, addToast } = setup();
    let finish!: (value: unknown[]) => void;
    request.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = actions.moveHostFolder("Other", "Archive");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await expect(actions.moveHostFolder("Prod", "Live")).rejects.toThrow("Wait");
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    finish([]);
    await pending;
    expect(get().definedGroups.has("Archive")).toBe(true);
    expect(get().definedGroups.has("Other")).toBe(false);
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining("could not be saved"), "error");
    expect(get().hostGroupsBusy).toBe(false);
    storage.mockRestore();
  });
});
