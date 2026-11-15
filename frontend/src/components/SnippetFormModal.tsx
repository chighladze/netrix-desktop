import React, { useEffect, useId, useState } from "react";
import { Dialog, DialogPanel, DialogTitle, Description } from "@headlessui/react";
import { IoClose, IoCodeSlash, IoSave } from "react-icons/io5";
import { fetchJsonOrThrow } from "../api";
import { Snippet } from "../state/store";

interface SnippetFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
  snippetToEdit?: Snippet | null;
  apiBase: string;
}

const SnippetFormModal: React.FC<SnippetFormModalProps> = ({
  isOpen,
  onClose,
  onSave,
  snippetToEdit,
  apiBase,
}) => {
  const formId = useId();
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setError(null);
    if (snippetToEdit) {
      setTitle(snippetToEdit.title);
      setTemplate(snippetToEdit.template);
    } else {
      resetForm();
    }
  }, [snippetToEdit, isOpen]);

  const resetForm = () => {
    setTitle("");
    setTemplate("");
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);

    if (!apiBase) {
      setError("API not ready");
      setLoading(false);
      return;
    }

    const payload = snippetToEdit
      ? {
          ...(title !== snippetToEdit.title ? { title } : {}),
          ...(template !== snippetToEdit.template ? { template } : {}),
        }
      : { title, template };

    try {
      if (snippetToEdit) {
        await fetchJsonOrThrow<Snippet>(`${apiBase}/snippets/${snippetToEdit.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } else {
        await fetchJsonOrThrow<Snippet>(`${apiBase}/snippets`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      }

      onSave();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Dialog open onClose={() => { if (!loading) onClose(); }} className="relative z-[100]">
      <div className="fixed inset-0 bg-black/65 backdrop-blur-sm" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="ui-dialog flex w-full max-w-xl flex-col overflow-hidden">
          <header className="ui-dialog-header">
            <span className="ui-dialog-icon"><IoCodeSlash size={19} /></span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="ui-dialog-title">{snippetToEdit ? "Edit Snippet" : "New Snippet"}</DialogTitle>
              <Description className="ui-dialog-description">Save a reusable command or a sequence of commands.</Description>
            </div>
            <button type="button" onClick={onClose} disabled={loading} aria-label="Close snippet editor" className="ui-icon-button"><IoClose size={19} /></button>
          </header>
          <form id={formId} onSubmit={handleSubmit} className="ui-dialog-body space-y-4">
            {error && <div role="alert" className="ui-alert">{error}</div>}
            <div>
              <label htmlFor={`${formId}-title`} className="ui-label">Title</label>
              <input id={`${formId}-title`} autoFocus type="text" required disabled={loading} className="ui-input"
                value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Update system" />
            </div>
            <div>
              <label htmlFor={`${formId}-template`} className="ui-label">Command Template</label>
              <textarea id={`${formId}-template`} required disabled={loading} spellCheck={false}
                className="ui-input min-h-40 resize-y font-mono text-xs leading-6" rows={8}
                value={template} onChange={e => setTemplate(e.target.value)} placeholder="# Enter your commands here..." />
            </div>
          </form>
          <footer className="ui-dialog-footer">
            <button type="button" onClick={onClose} disabled={loading} className="ui-button">Cancel</button>
            <button type="submit" form={formId} disabled={loading} className="ui-button ui-button-primary">
              {loading ? <><span className="spinner-sm" />Saving…</> : <><IoSave size={15} />Save Snippet</>}
            </button>
          </footer>
        </DialogPanel>
      </div>
    </Dialog>
  );
};

export default SnippetFormModal;
