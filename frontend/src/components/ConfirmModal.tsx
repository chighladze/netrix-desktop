import React from "react";
import {
    IoAlertCircle,
    IoCheckmarkCircle,
    IoHelpCircle,
} from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../state/store";

const ConfirmModal: React.FC = () => {
  const { confirmDialog, hideConfirm } = useAppStore(
    useShallow((state) => ({
      confirmDialog: state.confirmDialog,
      hideConfirm: state.hideConfirm,
    })),
  );
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const cancelButtonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!confirmDialog) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = requestAnimationFrame(() => cancelButtonRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        hideConfirm();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [confirmDialog, hideConfirm]);

  if (!confirmDialog) return null;

  const {
    title,
    message,
    onConfirm,
    confirmText = "Confirm",
    cancelText = "Cancel",
    type = "warning",
  } = confirmDialog;

  const handleConfirm = () => {
    onConfirm();
    hideConfirm();
  };

  const getIcon = () => {
    switch (type) {
      case "danger":
        return <IoAlertCircle className="text-red-400" size={24} />;
      case "info":
        return <IoCheckmarkCircle className="text-sky-300" size={24} />;
      default:
        return <IoHelpCircle className="text-amber-300" size={24} />;
    }
  };

  const getButtonClass = () => {
    switch (type) {
      case "danger":
        return "ui-button-danger";
      case "info":
        return "ui-button-primary";
      default:
        return "ui-button-warning";
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop with blur */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-md animate-fade-in"
        onClick={hideConfirm}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
        className="ui-dialog relative w-full max-w-sm p-5 animate-fade-in"
      >
        <div className="flex flex-col items-start">
          <div className="mb-3 rounded-card border border-white/10 bg-white/5 p-2" aria-hidden="true">{getIcon()}</div>

          <h2 id="confirm-dialog-title" className="ui-dialog-title mb-2">{title}</h2>
          <p id="confirm-dialog-description" className="mb-5 break-words text-sm leading-6 text-slate-400">
            {message}
          </p>

          <div className="flex w-full flex-wrap justify-end gap-2">
            <button
              ref={cancelButtonRef}
              type="button"
              onClick={hideConfirm}
              className="ui-button"
            >
              {cancelText}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className={`ui-button ${getButtonClass()}`}
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfirmModal;
