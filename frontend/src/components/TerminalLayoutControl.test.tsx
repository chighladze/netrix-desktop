import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TerminalLayout } from "../features/workspace/panes";
import TerminalLayoutControl from "./TerminalLayoutControl";

function Selector() {
  const [value, setValue] = useState<TerminalLayout>("single");
  return <TerminalLayoutControl value={value} onChange={setValue} />;
}

describe("terminal layout control", () => {
  it("exposes one selected layout and one keyboard stop", () => {
    render(<Selector />);
    expect(screen.getByRole("radiogroup", { name: "Terminal layout" })).toBeTruthy();
    const options = screen.getAllByRole("radio");
    expect(options.map((option) => option.tabIndex)).toEqual([0, -1, -1, -1]);
    fireEvent.click(screen.getByRole("radio", { name: "Stacked" }));
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false"]);
    expect(options.map((option) => option.tabIndex)).toEqual([-1, -1, 0, -1]);
  });

  it("selects and focuses with wrapping arrows, Home and End", () => {
    render(<Selector />);
    const options = screen.getAllByRole("radio");
    fireEvent.keyDown(options[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(options[3]);
    expect(options[3].getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(options[3], { key: "ArrowRight" });
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1], { key: "End" });
    expect(document.activeElement).toBe(options[3]);
    fireEvent.keyDown(options[3], { key: "Home" });
    expect(document.activeElement).toBe(options[0]);
  });

  it("does not activate disabled choices", () => {
    const onChange = vi.fn();
    render(<TerminalLayoutControl value="single" onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole("radio", { name: "Stacked" }));
    fireEvent.keyDown(screen.getByRole("radio", { name: "Single" }), { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
