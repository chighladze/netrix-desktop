import { Dialog, DialogPanel, DialogTitle, Description } from "@headlessui/react";
import React, { useEffect, useId, useRef, useState } from "react";
import { IoClose, IoFlash, IoTrash } from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";
import { QuickAction, useAppStore } from "../state/store";

interface QuickActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingAction?: QuickAction | null;
}

const colors: { label: string; value: QuickAction["color"]; hex: string; style: string }[] = [
  { label: "Green", value: "green", hex: "#10b981", style: "text-emerald-400" },
  { label: "Red", value: "red", hex: "#ef4444", style: "text-red-400" },
  { label: "Blue", value: "blue", hex: "#3b82f6", style: "text-blue-400" },
  { label: "Yellow", value: "yellow", hex: "#f59e0b", style: "text-amber-400" },
  { label: "Purple", value: "purple", hex: "#8b5cf6", style: "text-purple-400" },
  { label: "Gray", value: "gray", hex: "#6b7280", style: "text-gray-400" },
];

const QuickActionModal: React.FC<QuickActionModalProps> = ({
  isOpen,
  onClose,
  editingAction,
}) => {
  const { addQuickAction, updateQuickAction, removeQuickAction } = useAppStore(
    useShallow((state) => ({
      addQuickAction: state.addQuickAction,
      updateQuickAction: state.updateQuickAction,
      removeQuickAction: state.removeQuickAction,
    })),
  );
  const formId = useId();
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");
  const [color, setColor] = useState<QuickAction["color"]>("green");
  const [category, setCategory] = useState("General");
  const [description, setDescription] = useState("");

  const [isDeleting, setIsDeleting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    if (editingAction) {
      setLabel(editingAction.label);
      setCommand(editingAction.command);
      setColor(editingAction.color);
      setCategory(editingAction.category || "General");
      setDescription(editingAction.description || "");
    } else {
      setLabel("");
      setCommand("");
      setColor("green");
      setCategory("General");
      setDescription("");
    }
    setIsDeleting(false); // Reset delete state when modal opens/changes
    pendingRef.current = false;
    setPending(false);
    setError(null);
    revision.current += 1;
    return () => { revision.current += 1; };
  }, [editingAction, isOpen]);

  const perform = async (operation: () => Promise<boolean>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const current = revision.current;
    try {
      const saved = await operation();
      if (current !== revision.current) return;
      if (saved) onClose();
      else setError("The operation failed. Your draft is still here; please try again.");
    } catch {
      if (current === revision.current) setError("The operation failed. Your draft is still here; please try again.");
    } finally {
      if (current === revision.current) { pendingRef.current = false; setPending(false); }
    }
  };
  const close = () => { if (!pendingRef.current) onClose(); };
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label || !command) return;

    void perform(() => editingAction
      ? updateQuickAction(editingAction.id, { label, command, color, category, description })
      : addQuickAction({ label, command, color, category, description }));
  };

  const handleDelete = () => {
      if (editingAction) {
          void perform(() => removeQuickAction(editingAction.id));
      }
  };

  const selectedColor = colors.find((c) => c.value === color) || colors[0];

  if (!isOpen) return null;
  return (
    <Dialog open onClose={close} className="relative z-[100]">
      <div className="fixed inset-0 bg-black/65 backdrop-blur-sm" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="ui-dialog flex w-full max-w-lg flex-col overflow-hidden">
          <header className="ui-dialog-header">
            <span className="ui-dialog-icon">{isDeleting ? <IoTrash size={18} /> : <IoFlash size={18} />}</span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="ui-dialog-title">{isDeleting ? "Delete quick action" : editingAction ? "Edit quick action" : "New quick action"}</DialogTitle>
              <Description className="ui-dialog-description">{isDeleting ? "This action cannot be undone." : "A reusable command for the terminal action bar."}</Description>
            </div>
            <button type="button" disabled={pending} aria-label="Close quick action editor" onClick={close} className="ui-icon-button"><IoClose size={19} /></button>
          </header>
          {error && <p role="alert" className="px-5 pt-3 text-sm text-rose-300">{error}</p>}
          {isDeleting ? <>
            <p className="ui-dialog-body text-sm leading-6 text-slate-300">Delete <strong className="break-words text-white">{label}</strong> from your quick actions?</p>
            <footer className="ui-dialog-footer">
              <button type="button" disabled={pending} onClick={() => setIsDeleting(false)} className="ui-button">Cancel</button>
              <button type="button" disabled={pending} onClick={handleDelete} className="ui-button ui-button-danger">{pending ? "Deleting…" : "Delete action"}</button>
            </footer>
          </> : <>
            <form id={formId} onSubmit={handleSubmit} className="ui-dialog-body space-y-4">
              <fieldset disabled={pending} className="space-y-4">
              <div>
                <label htmlFor={`${formId}-command`} className="ui-label">Send string</label>
                <textarea id={`${formId}-command`} autoFocus required value={command} onChange={e => setCommand(e.target.value)}
                  className="ui-input resize-y font-mono" rows={3} spellCheck={false} placeholder="e.g. show ip int brief\n" />
              </div>
              <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2">
                <div>
                  <label htmlFor={`${formId}-label`} className="ui-label">Label <span className="float-right text-[10px] text-slate-500">{label.length}/15</span></label>
                  <input id={`${formId}-label`} required maxLength={15} value={label} onChange={e => setLabel(e.target.value)} className="ui-input" placeholder="My action" />
                </div>
                <div>
                  <label htmlFor={`${formId}-category`} className="ui-label">Category <span className="float-right text-[10px] text-slate-500">{category.length}/20</span></label>
                  <input id={`${formId}-category`} maxLength={20} value={category} onChange={e => setCategory(e.target.value)} className="ui-input" placeholder="e.g. General" />
                </div>
              </div>
              <div>
                <label htmlFor={`${formId}-description`} className="ui-label">Description <span className="font-normal text-slate-500">(optional)</span></label>
                <input id={`${formId}-description`} maxLength={100} value={description} onChange={e => setDescription(e.target.value)} className="ui-input" placeholder="Shown when hovering over the action" />
              </div>
              <div>
                <label htmlFor={`${formId}-color`} className="ui-label">Button color</label>
                <div className="flex items-center gap-3">
                  <select id={`${formId}-color`} value={color} onChange={e => setColor(e.target.value as QuickAction["color"])} className="ui-input">
                    {colors.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <span aria-hidden="true" className="h-7 w-7 shrink-0 rounded-control border border-white/20" style={{ backgroundColor: selectedColor.hex }} />
                </div>
              </div>
              <details className="rounded-control border border-white/[0.07] bg-black/10 p-3 text-xs text-slate-400">
                <summary className="cursor-pointer text-slate-300">Special characters</summary>
                <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px]">
                  <span>\r — carriage return</span><span>\n — newline</span><span>\t — tab</span>
                  <span>\b — backspace</span><span>\e — escape</span><span>\\ — backslash</span>
                </div>
              </details>
              </fieldset>
            </form>
            <footer className="ui-dialog-footer">
              {editingAction ? <button type="button" disabled={pending} onClick={() => setIsDeleting(true)} className="ui-button mr-auto border-transparent bg-transparent text-rose-300"><IoTrash size={15} />Delete</button>
                : <button type="button" disabled={pending} onClick={() => { setLabel(""); setCommand(""); setColor("green"); setCategory("General"); setDescription(""); }} className="ui-button mr-auto border-transparent bg-transparent">Clear</button>}
              <button type="button" disabled={pending} onClick={close} className="ui-button">Cancel</button>
              <button type="submit" form={formId} disabled={pending || !label || !command} className="ui-button ui-button-primary">{pending ? "Saving…" : editingAction ? "Save changes" : "Create action"}</button>
            </footer>
          </>}
        </DialogPanel>
      </div>
    </Dialog>
  );
};

export default QuickActionModal;
