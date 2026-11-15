import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
    IoAdd,
    IoContractOutline,
    IoExpandOutline,
    IoFolder,
    IoFolderOpenOutline,
    IoMoveOutline,
    IoPencil,
    IoTrash,
} from "react-icons/io5";

interface GroupContextMenuProps {
  x: number;
  y: number;
  groupPath: string;
  groupName: string;
  onClose: () => void;
  onAddSubgroup: () => void;
  onRename?: () => void;
  onMove?: () => void;
  onOpen?: () => void;
  onAddHost?: () => void;
  onDelete: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

const GroupContextMenu: React.FC<GroupContextMenuProps> = ({
  x,
  y,
  groupPath,
  groupName,
  onClose,
  onAddSubgroup,
  onRename,
  onMove,
  onOpen,
  onAddHost,
  onDelete,
  onExpandAll,
  onCollapseAll,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (rect) setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    const previous = document.activeElement;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (document.activeElement === document.body && previous instanceof HTMLElement) previous.focus(); };
  }, [groupPath]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  const menuItems = [
    ...(onOpen ? [{ icon: IoFolderOpenOutline, label: "Open folder", onClick: () => { onOpen(); onClose(); }, color: "text-gray-300 hover:bg-white/5" }] : []),
    ...(onAddHost ? [{ icon: IoAdd, label: "New host here", onClick: () => { onAddHost(); onClose(); }, color: "text-gray-300 hover:bg-white/5" }] : []),
    {
      icon: IoAdd,
      label: "New subfolder",
      onClick: () => {
        onAddSubgroup();
        onClose();
      },
      color: "text-primary hover:bg-primary/10",
    },
    ...(onRename ? [{
      icon: IoPencil,
      label: "Rename folder",
      onClick: () => {
        onRename();
        onClose();
      },
      color: "text-blue-400 hover:bg-blue-500/10",
    }] : []),
    ...(onMove ? [{ icon: IoMoveOutline, label: "Move folder", onClick: () => { onMove(); onClose(); }, color: "text-gray-300 hover:bg-white/5" }] : []),
    {
      icon: IoExpandOutline,
      label: "Expand branch",
      onClick: () => {
        onExpandAll();
        onClose();
      },
      color: "text-gray-400 hover:bg-white/5",
    },
    {
      icon: IoContractOutline,
      label: "Collapse branch",
      onClick: () => {
        onCollapseAll();
        onClose();
      },
      color: "text-gray-400 hover:bg-white/5",
    },
    {
      divider: true,
    },
    {
      icon: IoTrash,
      label: "Delete folder and hosts…",
      onClick: () => {
        onDelete();
        onClose();
      },
      color: "text-red-400 hover:bg-red-500/10",
    },
  ];

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Actions for folder ${groupName}`}
      onKeyDown={(event) => {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        let next: number | undefined;
        if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
        if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = buttons.length - 1;
        if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
        if (event.key === "Tab") onClose();
      }}
      className="fixed z-[100] w-60 max-w-[calc(100vw-16px)] bg-[#101923] border border-white/10 rounded-lg shadow-2xl overflow-hidden"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        maxHeight: "calc(100vh - 16px)",
        overflowY: "auto",
      }}
    >
      {/* Header */}
      <div className="px-3 py-2 bg-gradient-to-r from-primary/[0.08] to-transparent border-b border-white/[0.04]">
        <div className="flex items-center gap-2">
          <IoFolder className="text-primary/70" size={12} />
          <span className="text-[11px] font-medium text-gray-400 truncate">{groupName}</span>
        </div>
      </div>

      {/* Menu Items */}
      <div className="py-0.5">
        {menuItems.map((item, index) => {
          if (item.divider) {
            return (
              <div key={`divider-${index}`} className="my-0.5 border-t border-white/[0.04]" />
            );
          }

          const Icon = item.icon!;
          return (
            <button
              key={index}
              role="menuitem"
              tabIndex={-1}
              onClick={item.onClick}
              className={`w-full px-3 py-1.5 flex items-center gap-2 transition-all duration-150 ${item.color}`}
            >
              <Icon size={13} />
              <span className="text-[12px] font-medium">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>, document.body
  );
};

export default GroupContextMenu;
