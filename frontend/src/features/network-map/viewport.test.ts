import { describe, expect, it } from "vitest";
import { fitBounds, pointInViewport, resizeViewport, topologyBounds, viewportScale, zoomViewport } from "./viewport";
import { mapEdge, mapNode } from "./testFixtures";

describe("map viewport", () => {
  it("keeps scale and screen coordinates stable when docked panels open or close", () => {
    const view = { x: 30, y: -30, w: 1000, h: 850 };
    const before = { width: 1036, height: 548 }, after = { width: 736, height: 548 };
    const next = resizeViewport(view, before, after);
    expect(viewportScale(next, after)).toBeCloseTo(viewportScale(view, before));
    expect(pointInViewport(next, after, { x: 500, y: 300 })).toEqual(pointInViewport(view, before, { x: 500, y: 300 }));
    const expanded = resizeViewport(next, after, before, { x: -244, y: 0 });
    expect(pointInViewport(expanded, before, { x: 744, y: 300 }).x).toBeCloseTo(pointInViewport(next, after, { x: 500, y: 300 }).x);
  });
  it("clamps the actual geometry together with the displayed zoom", () => {
    const size = { width: 1000, height: 500 };
    let view = { x: 0, y: 0, w: 1000, h: 500 };
    for (let i = 0; i < 100; i++) view = zoomViewport(view, size, 1.25);
    expect(viewportScale(view, size)).toBeCloseTo(5);
    expect(zoomViewport(view, size, 1.25)).toEqual(view);
    for (let i = 0; i < 100; i++) view = zoomViewport(view, size, .8);
    expect(viewportScale(view, size)).toBeCloseTo(.1);
    expect(zoomViewport(view, size, .8)).toEqual(view);
  });
  it("holds the cursor anchor stationary while zooming", () => {
    const view = { x: -100, y: 20, w: 1000, h: 500 }, size = { width: 1000, height: 500 }, anchor = { x: 200, y: 220 };
    const next = zoomViewport(view, size, 2, anchor);
    expect((anchor.x - next.x) * viewportScale(next, size)).toBeCloseTo(anchor.x - view.x);
    expect((anchor.y - next.y) * viewportScale(next, size)).toBeCloseTo(anchor.y - view.y);
  });
  it("maps minimap clicks through horizontal and vertical letterboxing", () => {
    const view = { x: 100, y: 200, w: 100, h: 200 };
    expect(pointInViewport(view, { width: 200, height: 200 }, { x: 50, y: 0 })).toEqual({ x: 100, y: 200 });
    expect(pointInViewport({ x: 0, y: 0, w: 200, h: 100 }, { width: 200, height: 200 }, { x: 200, y: 150 })).toEqual({ x: 200, y: 100 });
  });
  it("fits every rendered node and outlying waypoint without distortion", () => {
    const bounds = topologyBounds([mapNode("a", { x: -100, width: 80 }), mapNode("b", { x: 200 })], [mapEdge("link", "a", "b", { waypoints: '[{"x":1000,"y":-400}]' })], 20);
    expect(bounds).toEqual({ x: -120, y: -420, w: 1140, h: 504 });
    const fit = fitBounds(bounds, { width: 600, height: 800 });
    expect(fit.w / fit.h).toBeCloseTo(.75);
    expect(fit.x).toBeLessThanOrEqual(bounds.x);
    expect(fit.y).toBeLessThanOrEqual(bounds.y);
    expect(fit.y + fit.h).toBeGreaterThanOrEqual(bounds.y + bounds.h);
  });
  it("focuses inside the visible canvas when a compact inspector covers its right side", () => {
    const size = { width: 780, height: 548 };
    const view = fitBounds({ x: 200, y: 220, w: 640, h: 440 }, size, 464);
    const center = pointInViewport(view, size, { x: 232, y: 274 });
    expect(center.x).toBeCloseTo(520);
    expect(center.y).toBeCloseTo(440);
    expect(view.w / view.h).toBeCloseTo(size.width / size.height);
  });
});
