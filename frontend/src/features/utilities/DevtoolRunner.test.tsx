import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../utils/clipboard", () => ({ copyTextWithAutoClear: vi.fn() }));
import DevtoolRunner from "./DevtoolRunner";
import { executeDevtoolCommand } from "../../utils/devtoolCli";
describe("local DevTool execution", () => {
  it("processes text without a network request or persistent input/output", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    render(<DevtoolRunner />);
    fireEvent.change(screen.getByLabelText("Local DevTool command"), {
      target: { value: 'devtool base64:encode "local-private-input"' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run locally" }));
    expect((await screen.findByLabelText("Local DevTool result")).textContent).toBe(
      btoa("local-private-input"),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear local input" }));
    expect(screen.queryByLabelText("Local DevTool result")).toBeNull();
    expect((screen.getByLabelText("Local DevTool command") as HTMLTextAreaElement).value).toBe("");
  });
  it("bounds UUID work and refuses inherited command names", async () => {
    expect(await executeDevtoolCommand("devtool uuid:v4 --count 1000000000")).toContain(
      "between 1 and 1000",
    );
    expect(await executeDevtoolCommand("devtool uuid:v4 --count 0")).toContain(
      "between 1 and 1000",
    );
    expect(await executeDevtoolCommand("devtool uuid:v4 --count 2.5")).toContain(
      "between 1 and 1000",
    );
    expect((await executeDevtoolCommand("devtool uuid:v4 --count 2")).split("\r\n")).toHaveLength(
      2,
    );
    expect(await executeDevtoolCommand("devtool constructor")).toContain("Unknown command");
    expect(await executeDevtoolCommand("devtool text:stats " + "a".repeat(65536))).toContain(
      "exceeds 64 KiB",
    );
  });
});
