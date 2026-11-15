import React, { useEffect, useState } from "react";
import { IoCheckmark, IoClose, IoFolder } from "react-icons/io5";
import { isValidGroupPath } from "../utils/groupUtils";

interface CreateSubgroupModalProps {
  isOpen: boolean;
  parentGroupPath: string;
  parentGroupName: string;
  onClose: () => void;
  onCreate: (subgroupName: string) => Promise<void>;
}

const CreateSubgroupModal: React.FC<CreateSubgroupModalProps> = ({
  isOpen,
  parentGroupPath,
  parentGroupName,
  onClose,
  onCreate,
}) => {
  const [subgroupName, setSubgroupName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSubgroupName("");
      setError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCreate = async () => {
    const trimmedName = subgroupName.trim();
    
    if (!trimmedName) {
      setError("Subgroup name cannot be empty");
      return;
    }

    // Validate name (no slashes, special chars)
    if (trimmedName.includes("/") || !isValidGroupPath(trimmedName)) {
      setError("Enter one group name without /, control characters, . or ..");
      return;
    }

    const fullPath = parentGroupPath
      ? `${parentGroupPath}/${trimmedName}`
      : trimmedName;

    if (!isValidGroupPath(fullPath)) {
      setError("Invalid group path");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      await onCreate(trimmedName);
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to create subgroup");
    } finally {
      setIsCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isCreating) {
      handleCreate();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9998] animate-fade-in"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
        <div className="ui-dialog max-w-md w-full animate-scale-in">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800/50">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <IoFolder className="text-primary" size={20} />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {parentGroupPath ? "Create Subgroup" : "Create Group"}
                </h2>
                <p className="text-xs text-gray-500">
                  in <span className="text-primary">{parentGroupName}</span>
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 transition-colors"
            >
              <IoClose size={20} />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-4">
            {/* Path Preview */}
            <div className="p-3 bg-background-dark/50 rounded-lg border border-gray-800/50">
              <p className="text-xs text-gray-500 mb-1">Full path:</p>
              <p className="text-sm text-gray-300 font-mono">
                {parentGroupPath || "Root"}
                {subgroupName.trim() && (
                  <>
                    <span className="text-gray-600"> / </span>
                    <span className="text-primary">{subgroupName.trim()}</span>
                  </>
                )}
              </p>
            </div>

            {/* Input */}
            <div>
              <label htmlFor="host-group-name" className="block text-sm font-medium text-gray-400 mb-2">
                Group name
              </label>
              <input
                type="text"
                id="host-group-name"
                value={subgroupName}
                onChange={(e) => setSubgroupName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="e.g., London, Web Servers, Testing"
                autoFocus
                className="w-full px-4 py-3 bg-background-dark border border-gray-800 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all"
              />
              {error && (
                <p className="mt-2 text-sm text-red-400 flex items-center gap-2">
                  <span className="w-1 h-1 bg-red-400 rounded-full" />
                  {error}
                </p>
              )}
            </div>

            {/* Guidelines */}
            <div className="p-3 bg-blue-500/5 border border-blue-500/20 rounded-lg">
              <p className="text-xs text-blue-400 font-medium mb-1">
                Guidelines:
              </p>
              <ul className="text-xs text-gray-400 space-y-1">
                <li>• Use letters, numbers, spaces, hyphens, or underscores</li>
                <li>• Keep names short and descriptive</li>
                <li>• Example: "Europe", "Production Servers"</li>
              </ul>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-800/50">
            <button
              onClick={onClose}
              disabled={isCreating}
              className="px-4 py-2.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-all disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={isCreating || !subgroupName.trim()}
              className="px-5 py-2.5 rounded-lg bg-primary/[0.12] backdrop-blur-md border border-primary/[0.25] text-primary font-medium hover:bg-primary/[0.2] hover:border-primary/[0.4] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center gap-2"
            >
              {isCreating ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Creating...</span>
                </>
              ) : (
                <>
                  <IoCheckmark size={18} />
                  <span>{parentGroupPath ? "Create Subgroup" : "Create Group"}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default CreateSubgroupModal;
