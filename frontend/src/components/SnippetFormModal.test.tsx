import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { fetchJsonOrThrow } from "../api";
import SnippetFormModal from "./SnippetFormModal";

vi.mock("../api", () => ({ fetchJsonOrThrow: vi.fn() }));
const request = vi.mocked(fetchJsonOrThrow);
beforeEach(() => {
  request.mockReset();
});
const snippet = {
  id: 7,
  title: "Saved command",
  template: "  echo {{ name }}\n",
  variables: { name: "default" },
  host_id: 8,
};

it("patches only edited fields and preserves invisible metadata", async () => {
  request.mockResolvedValue({ ...snippet, title: "Renamed" });
  const onSave = vi.fn();
  render(
    <SnippetFormModal
      isOpen
      onClose={vi.fn()}
      onSave={onSave}
      snippetToEdit={snippet}
      apiBase="http://localhost:8000"
    />,
  );
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Snippet" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(request.mock.calls[0][0]).toBe("http://localhost:8000/snippets/7");
  expect(request.mock.calls[0][1]?.method).toBe("PATCH");
  expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ title: "Renamed" });
});

it("uses the registered create URL and preserves command whitespace", async () => {
  request.mockResolvedValue(snippet);
  render(
    <SnippetFormModal isOpen onClose={vi.fn()} onSave={vi.fn()} apiBase="http://localhost:8000" />,
  );
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: snippet.title } });
  fireEvent.change(screen.getByLabelText("Command Template"), {
    target: { value: snippet.template },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save Snippet" }));
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(request.mock.calls[0][0]).toBe("http://localhost:8000/snippets");
  expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
    title: snippet.title,
    template: snippet.template,
  });
});

it("keeps failed input visible and clears the error when switching snippets", async () => {
  request.mockRejectedValue(new Error("Save rejected"));
  const onClose = vi.fn();
  const props = { isOpen: true, onClose, onSave: vi.fn(), apiBase: "http://localhost:8000" };
  const { rerender } = render(<SnippetFormModal {...props} snippetToEdit={snippet} />);
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Unsaved input" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Snippet" }));
  await screen.findByText("Save rejected");
  expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Unsaved input");
  expect(onClose).not.toHaveBeenCalled();
  rerender(<SnippetFormModal {...props} snippetToEdit={{ ...snippet, id: 8, title: "Another" }} />);
  expect(screen.queryByText("Save rejected")).toBeNull();
});
