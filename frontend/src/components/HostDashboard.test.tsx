import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore, type SavedHostDto } from "../state/store";
import HostDashboard from "./HostDashboard";

vi.mock("../api", async (original) => ({ ...(await original<object>()), getApiBase: async () => "http://127.0.0.1:8000" }));
const host = (id: number, changes: Partial<SavedHostDto> = {}): SavedHostDto => ({ id, revision: 0, name: `Server ${id}`, hostname: `10.0.0.${id}`, port: 22, username: "admin", connection_type: "ssh", ...changes });
const hosts = [host(10, { group: "Prod/Web" }), host(2, { group: " / Prod // DB / " }), host(3, { connection_type: "local", local_command: "pwsh", group: "Local" }), host(4)];
const connections = () => screen.queryAllByRole("button", { name: /^Connect to / }).map((button) => button.getAttribute("aria-label"));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.removeItem("hostsPreferences");
  useAppStore.setState({
    ...useAppStore.getInitialState(), hosts, hostsViewMode: "list",
    hostsPreferences: { sort: "name", descending: false, grouped: true },
    definedGroups: new Set(["Empty"]), collapsedGroups: new Set(),
    fetchHosts: async () => useAppStore.getState().hosts,
    vaultInitialized: true, isVaultUnlocked: true, vaultStatusLoaded: true,
    recentConnections: [{ host: hosts[0], timestamp: 200 }, { host: hosts[1], timestamp: 100 }],
  }, true);
});
afterEach(() => vi.unstubAllGlobals());

describe("Hosts workspace", () => {
  it("offers host creation in an empty flat view even when empty folders exist", () => {
    useAppStore.setState({ hosts: [], hostsPreferences: { sort: "name", descending: false, grouped: false } });
    render(<HostDashboard onConnect={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Add your first host" })).toBeDefined();
  });

  it("filters local profiles and parent groups including descendants", async () => {
    render(<HostDashboard onConnect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(await screen.findByLabelText("Protocol"), { target: { value: "local" } });
    expect(connections()).toEqual(["Connect to Server 3"]);
    expect(screen.queryByRole("region", { name: "Group Empty" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Protocol"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Group"), { target: { value: "group:Prod" } });
    expect(connections()).toEqual(["Connect to Server 2", "Connect to Server 10"]);
    fireEvent.click(screen.getByRole("button", { name: /^Filters\s*1$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(connections()).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Open folder Empty" })).toBeDefined();
  });

  it("keeps host results visible when the folder tree is collapsed and preserves collapse state during search", () => {
    useAppStore.setState({ collapsedGroups: new Set(["Prod", "Prod/DB"]) });
    render(<HostDashboard onConnect={vi.fn()} />);
    expect(connections()).toContain("Connect to Server 2");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search hosts" }), { target: { value: "server prod/db" } });
    expect(connections()).toEqual(["Connect to Server 2"]);
    expect([...useAppStore.getState().collapsedGroups]).toEqual(["Prod", "Prod/DB"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(screen.getByRole("button", { name: "Expand folder Prod" })).toBeDefined();
    expect(connections()).toHaveLength(4);
  });

  it("persists flat natural sorting and supports most-recent-first sorting", async () => {
    const { unmount } = render(<HostDashboard onConnect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Folders" }));
    expect(connections()).toEqual(["Connect to Server 2", "Connect to Server 3", "Connect to Server 4", "Connect to Server 10"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort descending" }));
    expect(connections()).toEqual(["Connect to Server 10", "Connect to Server 4", "Connect to Server 3", "Connect to Server 2"]);
    expect(JSON.parse(localStorage.getItem("hostsPreferences")!)).toEqual({ sort: "name", descending: true, grouped: false });
    unmount();
    render(<HostDashboard onConnect={vi.fn()} />);
    expect(connections()[0]).toBe("Connect to Server 10");
    fireEvent.change(screen.getByLabelText("Sort hosts"), { target: { value: "recent" } });
    fireEvent.click(screen.getByRole("button", { name: /^Recent\s*2$/ }));
    expect(connections()).toEqual(["Connect to Server 10", "Connect to Server 2"]);
    await waitFor(() => expect(screen.getByText("2 of 4")).toBeDefined());
  });

  it("collapses canonical legacy paths and reverses group order", () => {
    render(<HostDashboard onConnect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Sort hosts"), { target: { value: "group" } });
    fireEvent.click(screen.getByRole("button", { name: "Sort descending" }));
    const groups = screen.getAllByRole("button", { name: /^Collapse folder / });
    expect(groups[0].getAttribute("aria-label")).toBe("Collapse folder Prod");
    fireEvent.click(screen.getByRole("button", { name: "Collapse all groups" }));
    expect(useAppStore.getState().collapsedGroups.has("Prod/DB")).toBe(true);
    expect(connections()).toHaveLength(4);
  });

  it("opens actions and a move dialog without starting a connection", async () => {
    const onConnect = vi.fn(), onOpenFiles = vi.fn();
    render(<HostDashboard onConnect={onConnect} onOpenFiles={onOpenFiles} />);
    fireEvent.click(screen.getByRole("button", { name: "Files for Server 2" }));
    expect(onOpenFiles).toHaveBeenCalledWith(hosts[1]);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Server 2" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Move host" });
    expect((within(dialog).getByLabelText("Destination folder") as HTMLSelectElement).value).toBe("Prod/DB");
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("navigates folder subtrees and breadcrumbs and creates hosts in the selected folder", async () => {
    const onConnect = vi.fn();
    render(<HostDashboard onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: "Open folder Prod" }));
    expect(connections()).toEqual(["Connect to Server 2", "Connect to Server 10"]);
    const subfolders = screen.getByLabelText("Subfolders");
    fireEvent.click(within(subfolders).getByRole("button", { name: "Browse Prod/DB, 1 hosts" }));
    expect(connections()).toEqual(["Connect to Server 2"]);
    expect(within(screen.getByRole("navigation", { name: "Folder breadcrumb" })).getByRole("button", { name: "DB" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "New Host" }));
    expect((await screen.findByLabelText("Folder") as HTMLSelectElement).value).toBe("Prod/DB");
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("creates an empty nested folder and rejects a duplicate", async () => {
    render(<HostDashboard onConnect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open folder Prod" }));
    fireEvent.click(screen.getByRole("button", { name: "New Folder" }));
    let dialog = screen.getByRole("dialog", { name: "New folder" });
    fireEvent.change(within(dialog).getByLabelText("Folder name"), { target: { value: "DB" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create folder" }));
    expect(within(dialog).getByRole("alert").textContent).toContain("already exists");
    fireEvent.change(within(dialog).getByLabelText("Folder name"), { target: { value: "Staging" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useAppStore.getState().definedGroups.has("Prod/Staging")).toBe(true);
    expect(screen.getByRole("heading", { name: "This folder is empty" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Open folder Prod/Staging" }).getAttribute("aria-current")).toBe("page");
  });

  it("renames a folder through its menu and keeps a failed edit open", async () => {
    const move = vi.fn().mockRejectedValueOnce(new Error("Folder changed; refresh first")).mockResolvedValueOnce(undefined);
    useAppStore.setState({ moveHostFolder: move });
    render(<HostDashboard onConnect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for folder Prod" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename folder" }));
    const dialog = screen.getByRole("dialog", { name: "Rename folder" });
    fireEvent.change(within(dialog).getByLabelText("Folder name"), { target: { value: "Production" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await screen.findByText("Folder changed; refresh first");
    expect((within(dialog).getByLabelText("Folder name") as HTMLInputElement).value).toBe("Production");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(move).toHaveBeenLastCalledWith("Prod", "Production");
  });

  it("excludes descendants from a folder move and requires confirmation for subtree deletion", () => {
    render(<HostDashboard onConnect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for folder Prod" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move folder" }));
    const dialog = screen.getByRole("dialog", { name: "Move folder" });
    const destinations = within(dialog).getByLabelText("Parent folder") as HTMLSelectElement;
    expect([...destinations.options].map(option => option.value)).toEqual(["", "Empty", "Local"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for folder Prod" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete folder and hosts…" }));
    expect(useAppStore.getState().confirmDialog?.message).toContain("all its subfolders and 2 saved host(s)");
    expect(useAppStore.getState().hosts).toHaveLength(4);
  });
});
