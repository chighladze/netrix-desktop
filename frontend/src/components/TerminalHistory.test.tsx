import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "xterm";
import TerminalHistory from "./TerminalHistory";
import { createHistorySections, groupHistorySections, historyOffsetToLine, readHistoryPreview } from "../terminal/historySections";

let terminal: Terminal;
let viewport: HTMLDivElement;

async function mount(scrollback: number) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  viewport = document.createElement("div");
  viewport.id = "test-terminal";
  document.body.append(viewport);
  const { Terminal } = await import("xterm");
  terminal = new Terminal({ cols: 40, rows: 4, scrollback, allowProposedApi: true, convertEol: true });
  terminal.open(viewport);
  render(<TerminalHistory terminal={terminal} viewportId={viewport.id} enabled />);
}

const write = (output: string) => act(() => new Promise<void>((resolve) => terminal.write(output, resolve)));
const lines = (count: number) => Array.from({ length: count }, (_, i) => `Output ${i + 1}\n`).join("");
const rail = () => screen.findByRole("scrollbar", { name: "Terminal output history" });

afterEach(async () => {
  // xterm schedules viewport synchronization one frame after RIS/clear.
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  cleanup();
  terminal?.dispose();
  viewport?.remove();
  vi.unstubAllGlobals();
});

describe("terminal output history", () => {
  it("binds marks to echoed commands, previews the hovered mark, and jumps without sending input", async () => {
    await mount(200);
    const send = vi.fn();
    const input = terminal.onData(send);
    await write(Array.from({ length: 12 }, (_, i) => `user@server:~$ task-${i + 1}\n${lines(5)}`).join(""));
    const scrollbar = await rail();
    const marks = () => [...scrollbar.querySelectorAll<HTMLElement>(".terminal-history-tick")];
    expect(marks()).toHaveLength(12);
    vi.spyOn(scrollbar, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 244, left: 500, right: 540, width: 40, height: 144, x: 500, y: 100, toJSON() {} });
    scrollbar.setPointerCapture = vi.fn();
    // Mark 5 is centered 45px below the 12px scale padding.
    fireEvent.pointerMove(scrollbar, { pointerId: 1, isPrimary: true, clientX: 530, clientY: 157 });
    const preview = await screen.findByRole("tooltip");
    expect(preview.textContent).toContain("user@server:~$ task-5");
    expect(preview.textContent).toContain("Output 1");
    expect(preview.textContent).toContain("Lines 25–30");
    expect(Number(marks()[4].style.getPropertyValue("--history-tick-scale"))).toBeGreaterThan(Number(marks()[3].style.getPropertyValue("--history-tick-scale")));
    expect(Number(marks()[3].style.getPropertyValue("--history-tick-scale"))).toBeGreaterThan(Number(marks()[2].style.getPropertyValue("--history-tick-scale")));
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);

    fireEvent.pointerDown(scrollbar, { pointerId: 1, button: 0, isPrimary: true, clientX: 530, clientY: 157 });
    fireEvent.pointerUp(scrollbar, { pointerId: 1, button: 0, isPrimary: true, clientX: 530, clientY: 157 });
    await waitFor(() => expect(terminal.buffer.active.viewportY).toBe(24));
    expect(send).not.toHaveBeenCalled();
    fireEvent.pointerLeave(scrollbar);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    input.dispose();
  });

  it("keeps command marks aligned after eviction, reflow and clearing", async () => {
    await mount(30);
    const index = createHistorySections(terminal);
    await write(Array.from({ length: 10 }, (_, i) => `user@host:~$ task-${i}\n${lines(4)}`).join(""));
    let state = index.read();
    expect(state.sections.filter((section) => section.commands)).toHaveLength(6);
    for (const section of state.sections.filter((item) => item.commands)) {
      expect(readHistoryPreview(terminal, section).title).toMatch(/^user@host:~\$ task-/);
    }
    await write("user@host:~$ newest\n" + lines(4));
    index.invalidate();
    state = index.read();
    expect(readHistoryPreview(terminal, state.sections[state.sections.length - 1]).title).toContain("newest");
    expect(state.sections.every((section) => section.start >= 0 && section.end < terminal.buffer.active.length)).toBe(true);
    act(() => terminal.resize(30, 4));
    index.invalidate(true);
    for (const section of index.read().sections.filter((item) => item.commands)) {
      expect(readHistoryPreview(terminal, section).title).toMatch(/^user@host:~\$ /);
    }
    await write("\x1bc" + "user@host:~$ fresh\n" + lines(4) + "user@host:~$ next\n" + lines(4));
    index.invalidate();
    state = index.read();
    expect(state.sections.filter((section) => section.commands)).toHaveLength(2);
    expect(readHistoryPreview(terminal, state.sections[0]).title).toContain("fresh");
    index.dispose();
  });

  it("drags through the complete history and cancels a press without jumping", async () => {
    await mount(200);
    await write(Array.from({ length: 8 }, (_, i) => `user@server:~$ task-${i + 1}\n${lines(8)}`).join(""));
    const scrollbar = await rail();
    vi.spyOn(scrollbar, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 204, left: 500, right: 540, width: 40, height: 104, x: 500, y: 100, toJSON() {} });
    scrollbar.setPointerCapture = vi.fn();
    const pointer = { pointerId: 1, button: 0, isPrimary: true, clientX: 530 };
    fireEvent.pointerDown(scrollbar, { ...pointer, clientY: 187 });
    fireEvent.pointerMove(scrollbar, { ...pointer, clientY: 100 });
    await waitFor(() => expect(terminal.buffer.active.viewportY).toBe(0));
    fireEvent.pointerMove(scrollbar, { ...pointer, clientY: 204 });
    fireEvent.pointerUp(scrollbar, { ...pointer, clientY: 204 });
    await waitFor(() => expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY));
    fireEvent.pointerDown(scrollbar, { ...pointer, clientY: 127 });
    fireEvent.pointerCancel(scrollbar, { ...pointer, clientY: 127 });
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
    fireEvent.keyDown(scrollbar, { key: "Home" });
    await waitFor(() => expect(terminal.buffer.active.viewportY).toBe(0));
    fireEvent.keyDown(scrollbar, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("groups dense histories without gaps and keeps long blocks continuously scrollable", async () => {
    await mount(500);
    await write(Array.from({ length: 80 }, (_, i) => `user@host:~$ task-${i}\nresult\n`).join(""));
    const index = createHistorySections(terminal);
    const sections = index.read().sections;
    const grouped = groupHistorySections(sections, 10);
    expect(grouped).toHaveLength(10);
    expect(grouped.reduce((total, item) => total + item.commands, 0)).toBe(80);
    expect(grouped[0].start).toBe(0);
    expect(grouped[grouped.length - 1].end).toBe(terminal.buffer.active.length - 1);
    expect(grouped.slice(1).every((item, i) => item.start === grouped[i].end + 1)).toBe(true);
    expect(historyOffsetToLine(grouped, 0, terminal.buffer.active.baseY)).toBe(0);
    expect(historyOffsetToLine(grouped, 10, terminal.buffer.active.baseY)).toBe(terminal.buffer.active.baseY);
    expect(historyOffsetToLine([{ start: 0, end: 399, commands: 1 }, { start: 400, end: 499, commands: 1 }], .5, 496)).toBe(200);
    index.dispose();
  });

  it("uses output sections for an unstructured log and ignores wrapped prompt-like text", async () => {
    await mount(200);
    await write("x".repeat(40) + "user@host:~$ not a command\n" + lines(60));
    const index = createHistorySections(terminal);
    const sections = index.read().sections;
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((section) => section.commands === 0)).toBe(true);
    expect(sections[0]).toEqual({ start: 0, end: 19, commands: 0 });
    index.dispose();
  });

  it("shows the visible rows, counts appends past the scrollback limit, and returns to the bottom", async () => {
    await mount(6);
    expect(screen.queryByRole("scrollbar")).toBeNull();
    await write(lines(12));
    const scrollbar = await rail();
    expect(scrollbar.getAttribute("aria-valuetext")).toBe("Lines 7–10, 0 lines below");
    fireEvent.keyDown(scrollbar, { key: "PageUp" });
    await waitFor(() => expect(scrollbar.getAttribute("aria-valuetext")).toBe("Lines 4–7, 3 lines below"));
    const firstVisibleLine = () => terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true);
    const reading = firstVisibleLine();

    await write(lines(2));
    await screen.findByRole("button", { name: "To latest, 2 new lines" });
    expect(firstVisibleLine()).toBe(reading);

    // More than the entire saved history can arrive in a single parsed write.
    await write(lines(14));
    const jump = await screen.findByRole("button", { name: "To latest, 16 new lines" });
    fireEvent.click(jump);
    await waitFor(() => expect(screen.queryByRole("button", { name: /To latest/ })).toBeNull());
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
    expect(document.activeElement).toBe(terminal.textarea);

    fireEvent.keyDown(scrollbar, { key: "ArrowUp" });
    await screen.findByRole("button", { name: "To latest" });
    await write("new line\n");
    await screen.findByRole("button", { name: "To latest, 1 new line" });
  });

  it("tracks a single retained history row and hides the controls after clearing history", async () => {
    await mount(1);
    await write(lines(7));
    fireEvent.keyDown(await rail(), { key: "Home" });
    await write(lines(5));
    await screen.findByRole("button", { name: "To latest, 5 new lines" });

    await write("\x1b[3J");
    await waitFor(() => expect(screen.queryByRole("scrollbar")).toBeNull());
    expect(screen.queryByRole("button", { name: /To latest/ })).toBeNull();
  });

  it("keeps reflow out of the count and hides history on the alternate screen", async () => {
    await mount(60);
    await write("A long row with enough text to wrap when the terminal is narrowed.\n".repeat(24));
    fireEvent.keyDown(await rail(), { key: "Home" });
    await write("one more row\n");
    await screen.findByRole("button", { name: "To latest, 1 new line" });

    act(() => terminal.resize(20, 4));
    await waitFor(() => expect(screen.getByRole("scrollbar").getAttribute("aria-valuemax")).toBe(String(terminal.buffer.active.baseY)));
    expect(screen.getByRole("button", { name: "To latest, 1 new line" })).toBeDefined();
    await write("\x1b[?1049h");
    await waitFor(() => expect(screen.queryByRole("scrollbar")).toBeNull());
    await write("\x1b[?1049l");
    await rail();
  });
});
