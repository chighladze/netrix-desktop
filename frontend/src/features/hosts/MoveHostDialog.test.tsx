import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/store";
import MoveHostDialog from "./MoveHostDialog";

const host = { id: 4, revision: 2, name: "server", hostname: "example.test", port: 22, username: "admin", connection_type: "ssh" as const, group: " / Prod / " };
const move = vi.fn();
beforeEach(() => {
  move.mockReset().mockResolvedValue(undefined);
  useAppStore.setState({ ...useAppStore.getInitialState(), moveHostToGroup: move }, true);
});
describe("Move host dialog", () => {
  it("leaves the host untouched on cancellation and disables its existing group", () => {
    const onClose = vi.fn();
    render(<MoveHostDialog host={host} groups={["Prod", "Lab"]} onClose={onClose} />);
    expect((screen.getByRole("button", { name: "Move host" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Destination folder"), { target: { value: "Lab" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(move).not.toHaveBeenCalled();
  });
  it("moves to Ungrouped only after submission", async () => {
    const onClose = vi.fn();
    render(<MoveHostDialog host={host} groups={["Prod", "Lab"]} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Destination folder"), { target: { value: "" } });
    expect(move).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move host" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(move).toHaveBeenCalledWith(4, null);
  });
  it("keeps a failed destination visible and allows retry", async () => {
    move.mockRejectedValueOnce(new Error("Host changed; retry"));
    const onClose = vi.fn();
    render(<MoveHostDialog host={host} groups={["Prod", "Lab"]} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Destination folder"), { target: { value: "Lab" } });
    fireEvent.click(screen.getByRole("button", { name: "Move host" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Host changed");
    expect((screen.getByLabelText("Destination folder") as HTMLSelectElement).value).toBe("Lab");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move host" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(move).toHaveBeenCalledTimes(2);
  });
});
