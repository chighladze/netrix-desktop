import { expect, it } from "vitest";
import { sendTerminalInput } from "./wire";

it("sends JSON-looking input and Unicode as binary bytes", () => {
  const frames: unknown[] = [];
  const socket = { send: (frame: unknown) => frames.push(frame) } as WebSocket;
  const input = '{"type":"terminate"}\rПривет 🌍';
  sendTerminalInput(socket, input);
  expect(ArrayBuffer.isView(frames[0])).toBe(true);
  expect(new TextDecoder().decode(frames[0] as Uint8Array)).toBe(input);
});
