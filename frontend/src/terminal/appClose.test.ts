import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ windows: vi.fn(), state: { terminalTabs: [] as Array<{id: string; isConnected: boolean}>, tabStatuses: {}, terminalTransfers: {}, settings: { security: { confirmBeforeDisconnect: false }, window: { confirmCloseMultipleTabs: false } }, showConfirm: vi.fn(), addToast: vi.fn() } }));
vi.mock("@tauri-apps/api/window", () => ({ getAllWindows: mocks.windows }));
vi.mock("../state/store", () => ({ useAppStore: { getState: () => mocks.state } }));
import { requestApplicationClose } from "./appClose";
describe("all application close paths", () => {
  beforeEach(() => { mocks.windows.mockResolvedValue([{ label: "main" }]); mocks.state.terminalTabs = []; });
  it("confirms detached sessions even when the main window has no tabs", async () => {
    mocks.windows.mockResolvedValue([{ label: "main" }, { label: "detached-terminal" }]);
    const quit = vi.fn(async () => {});
    await requestApplicationClose(quit);
    expect(quit).not.toHaveBeenCalled();
    expect(mocks.state.showConfirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("1 detached terminal window"), onConfirm: quit }));
  });
  it("keeps the app open if detached windows cannot be checked", async () => {
    mocks.windows.mockRejectedValue(new Error("IPC unavailable"));
    const quit = vi.fn(async () => {});
    await requestApplicationClose(quit);
    expect(quit).not.toHaveBeenCalled(); expect(mocks.state.addToast).toHaveBeenCalled();
  });
  it("can close an idle app without a prompt", async () => {
    const quit = vi.fn(async () => {}); await requestApplicationClose(quit); expect(quit).toHaveBeenCalledOnce();
  });
});
