import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SftpDirectoryEntry } from "../../state/store";
import FileList from "./FileList";

const entries: SftpDirectoryEntry[] = [
  { name: "file10.txt", path: "/file10.txt", entry_type: "file", size: 100 },
  { name: ".env", path: "/.env", entry_type: "file", size: 8 },
  { name: "archive", path: "/archive", entry_type: "directory" },
  { name: "file2.txt", path: "/file2.txt", entry_type: "file", size: 200 },
];

function Fixture({ onOpen = vi.fn() }: { onOpen?: (entry: SftpDirectoryEntry) => void }) {
  const [selected, setSelected] = useState<SftpDirectoryEntry | null>(null);
  return <FileList label="Remote files" locationKey="/" entries={entries} status="ready" selected={selected}
    onSelect={setSelected} onOpen={onOpen} onRetry={vi.fn()} />;
}

const rowNames = () => within(screen.getByRole("list", { name: "Remote files" })).getAllByRole("button").map((button) => button.getAttribute("aria-label"));

function MultiFixture() {
  const [selection, setSelection] = useState<SftpDirectoryEntry[]>([]);
  return <FileList label="Remote files" locationKey="/" entries={entries} status="ready" selected={selection.length === 1 ? selection[0] : null}
    selection={selection} onSelectionChange={setSelection} onSelect={(entry) => setSelection(entry ? [entry] : [])} onOpen={vi.fn()} onRetry={vi.fn()} />;
}
const chosenNames = () => within(screen.getByRole("list", { name: "Remote files" })).getAllByRole("button", { pressed: true }).map((button) => button.getAttribute("aria-label"));

describe("File listing interactions", () => {
  it("toggles Ctrl/Command selections without focus clearing the previously selected files", () => {
    render(<MultiFixture />);
    fireEvent.click(screen.getByRole("button", { name: "file2.txt" }));
    fireEvent.focus(screen.getByRole("button", { name: "file10.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "file10.txt" }), { ctrlKey: true });
    expect(chosenNames()).toEqual(["file2.txt", "file10.txt"]);
    expect(screen.getByText("2 selected")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "file2.txt" }), { metaKey: true });
    expect(chosenNames()).toEqual(["file10.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "file2.txt" }));
    expect(chosenNames()).toEqual(["file2.txt"]);
  });
  it("selects ranges in visible sort order and removes filtered-out files from selection", () => {
    render(<MultiFixture />);
    fireEvent.click(screen.getByRole("button", { name: "file2.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "file10.txt" }), { shiftKey: true });
    expect(chosenNames()).toEqual(["file2.txt", "file10.txt"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "file10.txt" }), { key: "a", ctrlKey: true });
    expect(chosenNames()).toEqual(["archive", "file2.txt", "file10.txt"]);
    fireEvent.change(screen.getByLabelText("Search remote files"), { target: { value: "file2" } });
    expect(chosenNames()).toEqual(["file2.txt"]);
  });
  it("moves Ctrl-arrow focus independently and toggles the focused file with Ctrl-Space", () => {
    render(<MultiFixture />);
    fireEvent.click(screen.getByRole("button", { name: "file2.txt" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "file2.txt" }), { key: "ArrowDown", ctrlKey: true });
    expect(chosenNames()).toEqual(["file2.txt"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "file10.txt" }));
    fireEvent.keyDown(document.activeElement!, { key: " ", ctrlKey: true });
    expect(chosenNames()).toEqual(["file2.txt", "file10.txt"]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
  });
  it("sorts names naturally, keeps folders first in both directions and reveals dotfiles", () => {
    render(<Fixture />);
    expect(rowNames()).toEqual(["archive", "file2.txt", "file10.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort remote files by size" }));
    expect(rowNames()).toEqual(["archive", "file10.txt", "file2.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort remote files by size" }));
    expect(rowNames()).toEqual(["archive", "file2.txt", "file10.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Show hidden remote files" }));
    expect(rowNames()).toContain(".env");
    fireEvent.change(screen.getByLabelText("Search remote files"), { target: { value: "FILE2" } });
    expect(rowNames()).toEqual(["file2.txt"]);
  });

  it("moves keyboard focus and opens the focused item with Enter", () => {
    const open = vi.fn();
    render(<Fixture onOpen={open} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "archive" }), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "file2.txt" }));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(open).toHaveBeenCalledWith(entries[3]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "file10.txt" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.getByRole("button", { name: "file10.txt" }).getAttribute("aria-pressed")).toBe("false");
  });
});
