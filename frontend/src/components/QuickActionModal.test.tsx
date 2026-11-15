import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useAppStore, type QuickAction } from "../state/store";
import QuickActionModal from "./QuickActionModal";
const api = vi.hoisted(() => ({ fetchJsonOrThrow: vi.fn() }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), ...api, getApiBase: async () => "http://127.0.0.1:3210" }));

const add = vi.fn(), update = vi.fn(), remove = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  add.mockResolvedValue(true); update.mockResolvedValue(true); remove.mockResolvedValue(true);
  api.fetchJsonOrThrow.mockReset();
  useAppStore.setState({ addQuickAction: add, updateQuickAction: update, removeQuickAction: remove });
});
const action: QuickAction = { id: "action-1", label: "Inspect", command: "  show version\\r\\n", color: "blue", category: "Network", description: "Device details" };

it("submits the command unchanged from the footer and retains color and category", async () => {
  const close = vi.fn();
  render(<QuickActionModal isOpen onClose={close} />);
  fireEvent.change(screen.getByLabelText("Send string"), { target: { value: action.command } });
  fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: action.label } });
  fireEvent.change(screen.getByLabelText(/^Category/), { target: { value: action.category } });
  fireEvent.change(screen.getByLabelText("Button color"), { target: { value: action.color } });
  fireEvent.click(screen.getByRole("button", { name: "Create action" }));
  expect(add).toHaveBeenCalledWith({ label: action.label, command: action.command, color: action.color, category: action.category, description: "" });
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it("requires explicit deletion and keeps the edited form when deletion is cancelled", async () => {
  render(<QuickActionModal isOpen onClose={vi.fn()} editingAction={action} />);
  fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: "Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect((screen.getByLabelText(/^Label/) as HTMLInputElement).value).toBe("Renamed");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const { id, ...fields } = action;
  expect(update).toHaveBeenCalledWith(id, { ...fields, label: "Renamed" });
  await waitFor(() => expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete action" }));
  expect(remove).toHaveBeenCalledWith(action.id);
  await act(async () => {});
});

it.each(["create", "update", "delete"])("retains the draft and committed actions after %s fails, prevents double submit and permits retry", async (operation) => {
  const initial = useAppStore.getInitialState();
  useAppStore.setState({ addQuickAction: initial.addQuickAction, updateQuickAction: initial.updateQuickAction,
    removeQuickAction: initial.removeQuickAction, quickActions: operation === "create" ? [] : [action] });
  let reject!: (error: Error) => void;
  api.fetchJsonOrThrow.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  const close = vi.fn();
  render(<QuickActionModal isOpen onClose={close} editingAction={operation === "create" ? null : action} />);
  fireEvent.change(screen.getByLabelText("Send string"), { target: { value: "  draft\\r\\n" } });
  fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: "Draft" } });
  if (operation === "delete") fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const name = operation === "create" ? "Create action" : operation === "update" ? "Save changes" : "Delete action";
  const submit = screen.getByRole("button", { name });
  fireEvent.click(submit); fireEvent.click(submit);
  fireEvent.click(screen.getByRole("button", { name: "Close quick action editor" }));
  await waitFor(() => expect(api.fetchJsonOrThrow).toHaveBeenCalledTimes(1));
  expect(close).not.toHaveBeenCalled();
  expect(useAppStore.getState().quickActions).toEqual(operation === "create" ? [] : [action]);
  await act(async () => reject(new Error("Persistence unavailable")));
  expect(screen.getByRole("alert").textContent).toContain("draft is still here");
  expect(close).not.toHaveBeenCalled();
  if (operation === "delete") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect((screen.getByLabelText("Send string") as HTMLTextAreaElement).value).toBe("  draft\\r\\n");
  expect((screen.getByLabelText(/^Label/) as HTMLInputElement).value).toBe("Draft");
  api.fetchJsonOrThrow.mockResolvedValueOnce({});
  if (operation === "delete") fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(api.fetchJsonOrThrow).toHaveBeenCalledTimes(2);
  if (operation === "delete") expect(useAppStore.getState().quickActions).toEqual([]);
  else expect(useAppStore.getState().quickActions[0]).toMatchObject({ label: "Draft", command: "  draft\\r\\n" });
});
