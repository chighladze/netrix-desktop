import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DraggableHostCard from "./DraggableHostCard";
vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: { role: "button", tabIndex: 0 },
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    isDragging: false,
  }),
}));
const host = {
  id: 1,
  revision: 0,
  name: "server",
  hostname: "example.test",
  username: "user",
  port: 22,
  connection_type: "ssh" as const,
};
describe("host card activation", () => {
  it("allows a click after small pointer movement and suppresses a completed drag", () => {
    const onClick = vi.fn();
    render(<DraggableHostCard host={host} viewMode="grid" onClick={onClick} />);
    const card = screen.getByRole("button", { name: "Connect to server" });
    const pointer = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: 10 } });
      fireEvent(card, event);
    };
    pointer("pointerdown", 10);
    pointer("pointermove", 12);
    pointer("pointerup", 12);
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);
    pointer("pointerdown", 10);
    pointer("pointermove", 30);
    pointer("pointerup", 30);
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});
