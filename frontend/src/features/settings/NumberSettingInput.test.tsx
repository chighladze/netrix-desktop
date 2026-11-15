import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import NumberSettingInput from "./NumberSettingInput";

describe("numeric settings editing", () => {
  it("allows clearing an input without saving an invalid port, then commits a bounded integer", () => {
    const save = vi.fn();
    render(<NumberSettingInput label="SSH port" value={22} min={1} max={65535} onChange={save} />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(save).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(input.value).toBe("22");
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "65536" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(save).toHaveBeenLastCalledWith(65535);
    expect(input.value).toBe("65535");
  });
  it("restores the active value when persistence rejects an edit", () => {
    render(
      <NumberSettingInput label="SSH port" value={22} min={1} max={65535} onChange={() => false} />,
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2222" } });
    fireEvent.blur(input);
    expect(input.value).toBe("22");
  });
});
