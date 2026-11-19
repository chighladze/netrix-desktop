import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AboutModal from "../../components/AboutModal";
import Settings from "../../components/Settings";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn(),
}));

const url = "https://t.me/netrix_console";
const communityLink = () => screen.getByRole("link", { name: "Join Our Telegram Community" });

beforeEach(() => {
  vi.stubGlobal("isTauri", true);
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["About", <AboutModal isOpen onClose={() => {}} />],
  ["Settings", <Settings />],
] as const)("opens the community through the desktop shell from %s", (_, view) => {
  render(view);
  const link = communityLink();
  expect(link.getAttribute("href")).toBe(url);
  expect(fireEvent.click(link)).toBe(false);
  expect(invoke).toHaveBeenCalledWith("open_telegram_community");
});

it("keeps normal browser navigation in the web preview", () => {
  vi.stubGlobal("isTauri", false);
  render(<AboutModal isOpen onClose={() => {}} />);
  const link = communityLink();
  expect(link.getAttribute("href")).toBe(url);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(fireEvent.click(link)).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
});

it("shows the address when opening fails and clears the message on retry", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Browser unavailable"));
  render(<AboutModal isOpen onClose={() => {}} />);
  fireEvent.click(communityLink());
  expect((await screen.findByRole("alert")).textContent).toContain(url);
  fireEvent.click(communityLink());
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(invoke).toHaveBeenCalledTimes(2);
});
