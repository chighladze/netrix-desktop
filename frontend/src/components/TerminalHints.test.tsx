import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store";
import TerminalHints from "./TerminalHints";

afterEach(() => vi.restoreAllMocks());

it("ignores terminal hint shortcuts while another module is active", () => {
  useAppStore.setState({ activeView: "hosts", activeTabId: "tab-1", terminalInstances: {} });
  const toast = vi.spyOn(useAppStore.getState(), "addToast");
  render(<TerminalHints tabId="tab-1" />);
  expect(fireEvent.keyDown(window, { key: "h", ctrlKey: true, shiftKey: true })).toBe(true);
  expect(toast).not.toHaveBeenCalled();

  act(() => useAppStore.getState().setActiveView("terminal"));
  expect(fireEvent.keyDown(window, { key: "h", ctrlKey: true, shiftKey: true })).toBe(false);
  expect(toast).toHaveBeenCalledWith("No hints found on screen", "info");
});

it.each(["input", "textarea", "select"])("does not take the shortcut from a form %s", (tag) => {
  useAppStore.setState({ activeView: "terminal", activeTabId: "tab-1", terminalInstances: {} });
  const toast = vi.spyOn(useAppStore.getState(), "addToast");
  render(<TerminalHints tabId="tab-1" />);
  const field = document.createElement(tag);
  // A class name alone is not proof that an input belongs to this terminal.
  field.className = "xterm-helper-textarea";
  document.body.append(field);
  field.focus();
  expect(fireEvent.keyDown(field, { key: "h", ctrlKey: true, shiftKey: true })).toBe(true);
  expect(toast).not.toHaveBeenCalled();
  field.remove();
});
