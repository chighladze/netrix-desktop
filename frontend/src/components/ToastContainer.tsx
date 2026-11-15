import React from "react";
import {
  IoAlertCircle,
  IoCheckmarkCircle,
  IoClose,
  IoInformationCircle,
} from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../state/store";

const ToastContainer: React.FC = () => {
  const { toasts, removeToast } = useAppStore(
    useShallow((state) => ({
      toasts: state.toasts,
      removeToast: state.removeToast,
    })),
  );

  return (
    <div
      className="fixed bottom-6 right-6 z-[200] flex flex-col gap-3 pointer-events-none"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.type === "error" ? "alert" : "status"}
          className={`
            pointer-events-auto min-w-[300px] max-w-sm rounded-xl shadow-2xl border p-4 flex items-start gap-4 animate-slide-in-right glass-panel
            ${toast.type === "success" ? "bg-background-dark/90 border-green-500/30" : ""}
            ${toast.type === "error" ? "bg-background-dark/90 border-red-500/30" : ""}
            ${toast.type === "info" ? "bg-background-dark/90 border-blue-500/30" : ""}
          `}
        >
          <div className="mt-0.5">
            {toast.type === "success" && (
              <IoCheckmarkCircle className="text-green-500" size={22} />
            )}
            {toast.type === "error" && (
              <IoAlertCircle className="text-red-500" size={22} />
            )}
            {toast.type === "info" && (
              <IoInformationCircle className="text-blue-500" size={22} />
            )}
          </div>

          <div className="flex-1">
            <h4
              className={`text-sm font-bold mb-0.5
              ${toast.type === "success" ? "text-green-100" : ""}
              ${toast.type === "error" ? "text-red-100" : ""}
              ${toast.type === "info" ? "text-blue-100" : ""}
            `}
            >
              {toast.type === "success" && "Success"}
              {toast.type === "error" && "Error"}
              {toast.type === "info" && "Information"}
            </h4>
            <p className="text-sm text-gray-400 leading-snug">
              {toast.message}
            </p>
          </div>

          <button
            type="button"
            onClick={() => removeToast(toast.id)}
            aria-label="Dismiss notification"
            className="text-gray-500 hover:text-white transition-colors p-1"
          >
            <IoClose size={18} />
          </button>
        </div>
      ))}
    </div>
  );
};

export default ToastContainer;
