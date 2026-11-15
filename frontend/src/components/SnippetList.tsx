import React, { useEffect, useState } from "react";
import {
    IoAdd,
    IoCodeSlash,
    IoCopy,
    IoPencil,
    IoSearch,
    IoTrash,
} from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";
import { fetchJsonOrThrow, getApiBase } from "../api";
import { Snippet, useAppStore } from "../state/store";
import { copyTextWithAutoClear } from "../utils/clipboard";
import SnippetFormModal from "./SnippetFormModal";

const SnippetList: React.FC = () => {
  const { snippets, setSnippets, activeTabId, terminalInstances, addToast, showConfirm } =
    useAppStore(
      useShallow((state) => ({
        snippets: state.snippets,
        setSnippets: state.setSnippets,
        activeTabId: state.activeTabId,
        terminalInstances: state.terminalInstances,
        addToast: state.addToast,
        showConfirm: state.showConfirm,
      })),
    );
  const [apiBase, setApiBase] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  useEffect(() => {
    getApiBase().then(setApiBase);
  }, []);

  const fetchSnippets = async () => {
    if (!apiBase) return;
    try {
      const data = await fetchJsonOrThrow<Snippet[]>(`${apiBase}/snippets`);
      setSnippets(data);
    } catch (err) {
      console.error("Failed to fetch snippets:", err);
    }
  };

  useEffect(() => {
    if (apiBase) fetchSnippets();
  }, [apiBase]);

  const handleAdd = () => {
    setEditingSnippet(null);
    setIsFormOpen(true);
  };

  const handleEdit = (snippet: Snippet) => {
    setEditingSnippet(snippet);
    setIsFormOpen(true);
  };

  const handleDeleteClick = (snippet: Snippet) => {
     showConfirm({
      title: "Delete Snippet",
      message: "Are you sure you want to delete this snippet?",
      confirmText: "Delete",
      type: "danger",
      onConfirm: async () => {
        if (!apiBase) return;
        try {
          await fetchJsonOrThrow<void>(`${apiBase}/snippets/${snippet.id}`, {
            method: "DELETE",
          });
          addToast("Snippet deleted", "success");
          await fetchSnippets();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Failed to delete snippet";
          addToast(message, "error");
        }
      },
    });
  };

  const handleCopy = async (snippet: Snippet) => {
    try {
      await copyTextWithAutoClear(snippet.template);
      addToast("Snippet copied to clipboard", "info");
    } catch {
      addToast("Failed to copy snippet", "error");
    }
  };

  const filteredSnippets = snippets.filter(
    (s) =>
      s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.template.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div className="ui-focus p-4 h-full overflow-y-auto scrollbar-thin bg-[#0b1118]">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-base font-semibold text-white mb-1">
            Snippets
          </h1>
          <p className="text-xs text-slate-400">
            Manage your reusable command templates
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative group min-w-0 flex-1 sm:min-w-[220px]">
            <IoSearch
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 group-focus-within:text-primary transition-colors"
              size={18}
            />
            <input
              type="text"
              placeholder="Search snippets..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="ui-input pl-10"
            />
          </div>

          <button
            onClick={handleAdd}
            className="ui-button ui-button-primary"
          >
            <IoAdd size={20} />
            <span>New Snippet</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,270px),1fr))] gap-3">
        {filteredSnippets.map((snippet) => (
          <div
            key={snippet.id}
            className="ui-card group p-4 transition-colors hover:border-sky-300/30 flex min-w-0 flex-col relative overflow-hidden"
          >
            <div className="flex justify-between items-start mb-3">
              <div className="p-2.5 bg-background-midnight rounded-lg text-primary group-hover:text-white group-hover:bg-gradient-primary transition-all">
                <IoCodeSlash size={22} />
              </div>
              <div className="flex gap-1">
                <button
                  aria-label={`Edit ${snippet.title}`}
                  onClick={() => handleEdit(snippet)}
                  className="p-2 text-gray-500 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                >
                  <IoPencil size={16} />
                </button>
                <button
                  aria-label={`Delete ${snippet.title}`}
                  onClick={() => handleDeleteClick(snippet)}
                  className="p-2 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                >
                  <IoTrash size={16} />
                </button>
              </div>
            </div>

            <h3
              className="font-bold text-white mb-2 truncate"
              title={snippet.title}
            >
              {snippet.title}
            </h3>

            <div className="bg-black/30 rounded-lg p-3 mb-4 flex-1 overflow-hidden relative">
              <code className="text-xs font-mono text-slate-400 whitespace-pre-wrap break-words line-clamp-3">
                {snippet.template}
              </code>
              <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent pointer-events-none" />
            </div>

            <button
              onClick={() => handleCopy(snippet)}
              className="w-full py-2.5 flex items-center justify-center gap-2 border border-gray-700 hover:border-primary text-gray-400 hover:text-white hover:bg-primary/10 rounded-lg transition-all text-sm font-medium group"
            >
              <IoCopy size={16} />
              <span>Copy command</span>
            </button>
          </div>
        ))}

        {filteredSnippets.length === 0 && (
          <div className="col-span-full flex min-h-[330px] flex-col items-center justify-center rounded-card border border-dashed border-white/[0.09] bg-white/[0.018] p-8 text-center">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-card border border-primary/15 bg-primary/[0.07] text-primary/70">
              <IoCodeSlash size={27} />
            </div>
            <h2 className="text-lg font-semibold text-gray-200">
              {snippets.length === 0 ? "Build your command library" : "No matching snippets"}
            </h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-gray-500">
              {snippets.length === 0
                ? "Save the commands you use repeatedly, then copy or run them without searching through old terminal history."
                : `Nothing matches “${searchQuery}”. Try a broader search or clear the filter.`}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              {snippets.length === 0 ? (
                <button
                  type="button"
                  onClick={handleAdd}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-primary/25 bg-primary/10 px-4 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
                >
                  <IoAdd size={17} />
                  Create First Snippet
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="h-10 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-xs font-semibold text-gray-300 transition-colors hover:bg-white/[0.08] hover:text-white"
                >
                  Clear Search
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <SnippetFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSave={() => {
          fetchSnippets();
          addToast("Snippet saved successfully", "success");
        }}
        snippetToEdit={editingSnippet}
        apiBase={apiBase}
      />
    </div>
  );
};

export default SnippetList;
