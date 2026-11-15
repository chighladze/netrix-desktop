import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectionBitStream from "./ConnectionBitStream";

const originalAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");

function mockSweep(progress = .25, iteration = 0) {
  const animation = Object.assign(new EventTarget(), {
    animationName: "connection-light-sweep",
    currentTime: 6000 * (iteration + progress),
    effect: {
      getComputedTiming: () => ({ duration: 6000, progress, currentIteration: iteration }),
      updateTiming: vi.fn(),
    },
    updatePlaybackRate: vi.fn(),
    finish: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "getAnimations", { configurable: true, value: () => [animation] });
  return animation;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalAnimations) Object.defineProperty(HTMLElement.prototype, "getAnimations", originalAnimations);
  else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
});

describe("connection electricity geometry lifecycle", () => {
  it("renews only between running passes and preserves geometry/timing on resize", () => {
    let visibleBits = 48, resize = () => {};
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    const index = (element: HTMLElement) => Number(element.dataset.bitIndex);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(720);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.bitIndex === undefined ? 44 : 22; });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return index(this) < visibleBits ? 10 : 0; });
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) { return index(this) * 12 + Math.floor(index(this) / 8) * 24; });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(20);
    const view = render(<ConnectionBitStream running complete={false} />);
    const signal = view.container.firstElementChild!;
    const geometry = () => [...view.container.querySelectorAll(".connection-arc-core")].map(path => path.getAttribute("d"));
    const variants = () => [...view.container.querySelectorAll(".connection-hop")].map(group => group.getAttribute("data-variant"));
    const octets = (lit = false) => [...view.container.querySelectorAll(`.connection-octets${lit ? ".connection-octets-lit" : ":not(.connection-octets-lit)"} .connection-byte`)].map(byte => byte.textContent);
    // jsdom lacks AnimationEvent; React 18 registers the WebKit fallback there.
    const eventName = "AnimationEvent" in window ? "animationiteration" : "webkitAnimationIteration";
    const iteration = () => fireEvent(signal, Object.assign(new Event(eventName, { bubbles: true }), { animationName: "connection-light-sweep" }));
    const first = geometry(), firstVariants = variants();
    const firstOctets = octets();
    const firstBit = view.container.querySelector(".connection-bit");
    expect(octets(true)).toEqual(firstOctets);
    const duration = (signal as HTMLElement).style.animationDuration;
    act(resize);
    expect(geometry()).toEqual(first);
    expect(octets()).toEqual(firstOctets);
    act(iteration);
    expect(geometry().every((path, i) => path !== first[i])).toBe(true);
    expect(variants().every((variant, i) => variant !== firstVariants[i])).toBe(true);
    expect(octets().every((octet, i) => octet !== firstOctets[i])).toBe(true);
    expect(octets(true)).toEqual(octets());
    expect(view.container.querySelector(".connection-bit")).toBe(firstBit);
    expect((signal as HTMLElement).style.animationDuration).toBe(duration);
    visibleBits = 32;
    act(resize);
    act(iteration);
    const narrow = geometry().slice(0, 31);
    const narrowOctets = octets();
    visibleBits = 48;
    act(resize);
    expect(geometry().slice(0, 31)).toEqual(narrow);
    expect(geometry().every(Boolean)).toBe(true);
    expect(octets()).toEqual(narrowOctets);
    expect(octets(true)).toEqual(narrowOctets);
    view.rerender(<ConnectionBitStream running={false} complete={false} />);
    const stopped = geometry();
    act(iteration);
    expect(geometry()).toEqual(stopped);
    expect(octets()).toEqual(narrowOctets);
    view.rerender(<ConnectionBitStream running={false} complete />);
    act(iteration);
    expect(geometry()).toEqual(stopped);
    expect(octets()).toEqual(narrowOctets);
  });
});

describe("connection electricity completion", () => {
  it.each([[0, 0], [.45, 3], [.95, 1]])("finishes the current pass at %s without restarting it", (progress, iteration) => {
    const sweep = mockSweep(progress, iteration);
    const onComplete = vi.fn();
    const view = render(<ConnectionBitStream running complete={false} onComplete={onComplete} />);
    const position = sweep.currentTime;
    view.rerender(<ConnectionBitStream running={false} complete onComplete={onComplete} />);
    expect(sweep.currentTime).toBe(position);
    expect(sweep.effect.updateTiming).toHaveBeenCalledWith({ iterations: iteration + 1, fill: "forwards" });
    expect(sweep.updatePlaybackRate.mock.calls[0][0]).toBeGreaterThan(1);
    expect(onComplete).not.toHaveBeenCalled();
    act(() => sweep.dispatchEvent(new Event("finish")));
    expect(onComplete).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(2000));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("bounds the wait when the webview stops delivering animation events", () => {
    const sweep = mockSweep(0);
    const onComplete = vi.fn();
    render(<ConnectionBitStream running={false} complete onComplete={onComplete} />);
    act(() => vi.advanceTimersByTime(650));
    expect(onComplete).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(120));
    expect(sweep.finish).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("cancels a stale completion after failure and allows a new attempt", () => {
    const sweep = mockSweep();
    const onComplete = vi.fn();
    const view = render(<ConnectionBitStream running={false} complete onComplete={onComplete} />);
    view.rerender(<ConnectionBitStream running={false} complete={false} onComplete={onComplete} />);
    act(() => { sweep.dispatchEvent(new Event("finish")); vi.advanceTimersByTime(2000); });
    expect(onComplete).not.toHaveBeenCalled();
    expect(sweep.updatePlaybackRate).toHaveBeenLastCalledWith(1);
    view.rerender(<ConnectionBitStream running complete={false} onComplete={onComplete} />);
    view.rerender(<ConnectionBitStream running={false} complete onComplete={onComplete} />);
    act(() => sweep.dispatchEvent(new Event("finish")));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("does not delay reduced motion or an unavailable animation", () => {
    mockSweep();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const onComplete = vi.fn();
    const view = render(<ConnectionBitStream running={false} complete onComplete={onComplete} />);
    expect(onComplete).toHaveBeenCalledOnce();
    view.unmount();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    Object.defineProperty(HTMLElement.prototype, "getAnimations", { configurable: true, value: () => [] });
    render(<ConnectionBitStream running={false} complete onComplete={onComplete} />);
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up the pending finish when the tab closes", () => {
    const sweep = mockSweep();
    const onComplete = vi.fn();
    const view = render(<ConnectionBitStream running={false} complete onComplete={onComplete} />);
    view.unmount();
    act(() => { sweep.dispatchEvent(new Event("finish")); vi.advanceTimersByTime(2000); });
    expect(onComplete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
