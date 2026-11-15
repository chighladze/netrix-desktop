import { describe, expect, it } from "vitest";
import { selectPanes } from "./panes";
describe("workspace panes", () => {
  it("preserves mounted panes when focus moves and replaces one pane for an outside tab", () => {
    expect(selectPanes(["a", "b"], ["a", "b", "c"], "b", 2)).toEqual(["a", "b"]);
    expect(selectPanes(["a", "b"], ["a", "b", "c"], "c", 2)).toEqual(["a", "c"]);
  });
  it("removes closed and duplicated panes and fills available slots", () => {
    expect(selectPanes(["gone", "a", "a"], ["a", "b", "c"], "b", 4)).toEqual(["a", "b", "c"]);
  });
  it("fills free panes in tab order when returning from the connection picker", () => {
    expect(selectPanes([], ["existing", "new"], "new", 4)).toEqual(["existing", "new"]);
    expect(selectPanes([], ["a", "b", "c"], "c", 2)).toEqual(["a", "c"]);
    expect(selectPanes([], ["a", "b", "c"], "c", 1)).toEqual(["c"]);
  });
});
