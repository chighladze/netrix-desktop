import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store";
import { sampleEdges, sampleMap, sampleNodes } from "../features/network-map/testFixtures";
import type { MapEdge, MapNode } from "../features/network-map/types";
import NetworkMap from "./NetworkMap";

const request = vi.hoisted(() => vi.fn());
vi.mock("../api", async (original) => ({ ...(await original<object>()), getApiBase: async () => "http://127.0.0.1:1", fetchJsonOrThrow: request }));
let nodes: MapNode[], edges: MapEdge[], failNextWrite: boolean, sequence: number;
const writes = () => request.mock.calls.filter(([, init]) => init?.method && init.method !== "GET" && !String(init?.url).endsWith("/ping")).filter(([url]) => !String(url).endsWith("/ping"));
const chooseNode = (name: string) => fireEvent.keyDown(screen.getByRole("button", { name: `Select device ${name}` }), { key: "Enter" });
const chooseEdge = (name: string) => fireEvent.keyDown(screen.getByRole("button", { name: `Select connection ${name}` }), { key: "Enter" });

beforeEach(() => {
  nodes = structuredClone(sampleNodes); edges = structuredClone(sampleEdges); failNextWrite = false; sequence = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  localStorage.clear();
  useAppStore.setState({ ...useAppStore.getInitialState(), hosts: [], networkMapOpenIds: [sampleMap.id], networkMapActiveId: sampleMap.id, networkMapInitialized: true, networkMapViewStates: {}, addToast: vi.fn() }, true);
  request.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/ping")) return { core: { reachable: true }, wifi: { reachable: false } };
    const method = init.method || "GET";
    if (method !== "GET" && failNextWrite) { failNextWrite = false; throw new Error("Test save failure"); }
    if (url.endsWith("/maps")) return [sampleMap, { ...sampleMap, id: "other", name: "Lab" }];
    if (url.endsWith(`/maps/${sampleMap.id}`)) return { nodes: structuredClone(nodes), edges: structuredClone(edges) };
    if (url.endsWith("/maps/other")) return { nodes: [], edges: [] };
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (method === "POST" && url.endsWith("/nodes")) { const node = { ...body, id: `restored-${++sequence}` }; nodes.push(node); return node; }
    if (method === "POST" && url.endsWith("/edges")) { const edge = { ...body, id: `restored-${++sequence}` }; edges.push(edge); return edge; }
    const nodeId = url.match(/\/nodes\/([^/]+)/)?.[1], edgeId = url.match(/\/edges\/([^/]+)/)?.[1];
    if (nodeId) {
      if (method === "DELETE") { nodes = nodes.filter(node => node.id !== nodeId); edges = edges.filter(edge => edge.source_node_id !== nodeId && edge.target_node_id !== nodeId); return; }
      nodes = nodes.map(node => node.id === nodeId ? { ...node, ...body } : node); return nodes.find(node => node.id === nodeId);
    }
    if (edgeId) {
      if (method === "DELETE") { edges = edges.filter(edge => edge.id !== edgeId); return; }
      // Match the existing update API: null fields are treated as omitted.
      const patch = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null));
      edges = edges.map(edge => edge.id === edgeId ? { ...edge, ...patch } : edge); return edges.find(edge => edge.id === edgeId);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

async function mountMap() { render(<NetworkMap />); await screen.findByRole("button", { name: "Select device Core Switch" }); }

describe("NetMap workspace", () => {
  it("does not save selection clicks and saves a completed drag once outside the canvas", async () => {
    await mountMap();
    const svg = screen.getByLabelText("Network topology canvas");
    Object.defineProperty(svg, "createSVGPoint", { value: () => ({ x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } }) });
    Object.defineProperty(svg, "getScreenCTM", { value: () => ({ inverse: () => ({}) }) });
    const node = screen.getByRole("button", { name: "Select device Core Switch" });
    fireEvent.mouseDown(node, { button: 0, clientX: 450, clientY: 440 });
    fireEvent.mouseUp(window);
    expect(writes()).toHaveLength(0);
    fireEvent.mouseDown(node, { button: 0, clientX: 450, clientY: 440 });
    fireEvent.mouseMove(svg, { clientX: 490, clientY: 460 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][0]).toMatch(/\/nodes\/core\/position$/);
    expect(JSON.parse(String(writes()[0][1].body))).toEqual({ x: 470, y: 440 });
    fireEvent.mouseUp(window);
    expect(writes()).toHaveLength(1);
  });
  it("consumes the canvas wheel event and pans without a backend write", async () => {
    await mountMap();
    const svg = screen.getByLabelText("Network topology canvas"), before = svg.getAttribute("viewBox");
    const wheel = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    fireEvent(svg, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(svg.getAttribute("viewBox")).not.toBe(before);
    expect(writes()).toHaveLength(0);
  });
  it("persists clearing a link label and resetting its route through the current API", async () => {
    edges[1].waypoints = '[{"x":700,"y":400}]';
    await mountMap(); chooseEdge("Core uplink");
    fireEvent.change(screen.getByLabelText("Label", { exact: true }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset line route" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByText("Changes saved")).toBeDefined());
    expect(JSON.parse(String(writes()[0][1].body))).toEqual({ label: "", waypoints: "[]" });
    expect(edges.find(edge => edge.id === "uplink")).toMatchObject({ label: "", waypoints: "[]" });
    fireEvent.click(screen.getByRole("button", { name: "More map actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reload map" }));
    await waitFor(() => expect((screen.getByLabelText("Label", { exact: true }) as HTMLInputElement).value).toBe(""));
    expect((screen.getByRole("button", { name: "Reset line route" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("closes the accessible add-device dialog without creating a device", async () => {
    await mountMap();
    fireEvent.click(screen.getByRole("button", { name: "Add device" }));
    const dialog = within(screen.getByRole("dialog", { name: "Add device" }));
    expect(dialog.getByRole("textbox", { name: "Search saved hosts" })).toBeDefined();
    fireEvent.click(dialog.getByRole("button", { name: "Close add device" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes()).toHaveLength(0);
  });
  it("finds devices by multiple terms and focuses results from the keyboard", async () => {
    await mountMap();
    const input = screen.getByRole("textbox", { name: "Find map devices" });
    fireEvent.change(input, { target: { value: "production 192.0.2.10" } });
    const explorer = within(screen.getByRole("complementary", { name: "Map devices" }));
    expect(explorer.getByText("1 of 6")).toBeDefined();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Core Switch" })).toBeDefined();
    expect(writes()).toHaveLength(0);
  });
  it("keeps connection drafts across selection and saves one precise patch", async () => {
    await mountMap(); chooseEdge("Core uplink");
    fireEvent.change(screen.getByLabelText("Label", { exact: true }), { target: { value: "New uplink" } });
    expect(writes()).toHaveLength(0);
    chooseNode("Core Switch"); chooseEdge("Core uplink");
    expect((screen.getByLabelText("Label", { exact: true }) as HTMLInputElement).value).toBe("New uplink");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByText("Changes saved")).toBeDefined());
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1].body))).toEqual({ label: "New uplink" });
    expect(edges.find(edge => edge.id === "uplink")?.connection_properties).toBe(sampleEdges[1].connection_properties);
  });
  it("keeps edited connection fields after a failed save and supports retry", async () => {
    await mountMap(); chooseEdge("Core uplink");
    fireEvent.change(screen.getByLabelText("Allowed VLANs"), { target: { value: "20,30,40" } });
    failNextWrite = true;
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect((screen.getByLabelText("Allowed VLANs") as HTMLInputElement).value).toBe("20,30,40");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(JSON.parse(edges.find(edge => edge.id === "uplink")!.connection_properties!).vlans).toBe("20,30,40");
  });
  it("cancels device appearance without writing and retains input on save failure", async () => {
    await mountMap(); chooseNode("Core Switch");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    let dialog = within(screen.getByRole("dialog", { name: "Edit device" }));
    fireEvent.click(dialog.getByRole("button", { name: "Use color #ef4444" }));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    dialog = within(screen.getByRole("dialog", { name: "Edit device" }));
    fireEvent.change(dialog.getByLabelText("Device name"), { target: { value: "Renamed switch" } });
    failNextWrite = true;
    fireEvent.click(dialog.getByRole("button", { name: "Save device" }));
    await screen.findByRole("alert");
    expect((dialog.getByLabelText("Device name") as HTMLInputElement).value).toBe("Renamed switch");
  });
  it("restores a deleted device with all four links and their metadata", async () => {
    await mountMap(); chooseNode("Core Switch");
    fireEvent.click(screen.getByRole("button", { name: "Remove device from map" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Select device Core Switch" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Undo deletion" }));
    await waitFor(() => expect(edges).toHaveLength(5));
    expect(await screen.findByRole("button", { name: "Select device Core Switch" })).toBeDefined();
    const restored = nodes.find(node => node.label === "Core Switch")!;
    expect(restored.id).not.toBe("core");
    expect(edges.filter(edge => edge.source_node_id === restored.id || edge.target_node_id === restored.id)).toHaveLength(4);
    expect(edges.find(edge => edge.label === "Core uplink")).toMatchObject({ ports_count: 2, connection_type: "trunk", connection_properties: sampleEdges[1].connection_properties });
  });
  it("deletes the currently selected edge using the keyboard and scopes undo to its map", async () => {
    await mountMap(); chooseEdge("Core uplink");
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(edges.some(edge => edge.id === "uplink")).toBe(false));
    expect((screen.getByRole("button", { name: "Undo deletion" }) as HTMLButtonElement).disabled).toBe(false);
    act(() => useAppStore.setState({ networkMapActiveId: "other" }));
    await screen.findByRole("heading", { name: "Build your network map" });
    expect((screen.getByRole("button", { name: "Undo deletion" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(writes().filter(([, init]) => init.method === "POST")).toHaveLength(0);
  });
  it("does not delete a selected device while editing its name", async () => {
    await mountMap(); chooseNode("Core Switch"); fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.keyDown(screen.getByLabelText("Device name"), { key: "Delete" });
    expect(writes()).toHaveLength(0);
  });
});
