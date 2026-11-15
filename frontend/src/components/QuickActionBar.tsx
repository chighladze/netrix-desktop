import { sendQuickAction } from "../terminal/userInput";
import { Popover } from "@headlessui/react";
import React, { useMemo, useState } from "react";
import ReactDOM from "react-dom";
import {
    IoAdd,
    IoChevronBack,
    IoChevronForward,
    IoFunnel,
    IoPencil,
    IoSearch,
    IoTrash
} from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";
import { QuickAction, useAppStore } from "../state/store";
import QuickActionModal from "./QuickActionModal";

interface QuickActionBarProps {
  rounded?: boolean; // control bottom corner rounding for main vs detached window
}

const QuickActionBar: React.FC<QuickActionBarProps> = ({ rounded = true }) => {
  const { quickActions, removeQuickAction, activeTabId } =
    useAppStore(
      useShallow((state) => ({
        quickActions: state.quickActions,
        removeQuickAction: state.removeQuickAction,
        activeTabId: state.activeTabId,
      })),
    );
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAction, setEditingAction] = useState<QuickAction | null>(null);
  
  // Filter State
  const [filterQuery, setFilterQuery] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedColor, setSelectedColor] = useState<string | null>(null);
  
  // Category Search State
  const [categorySearch, setCategorySearch] = useState("");

  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Derived State
  const categories = useMemo(() => {
    const cats = new Set(quickActions.map(a => a.category || "General"));
    return Array.from(cats).sort();
  }, [quickActions]);
  
  const filteredCategories = useMemo(() => {
      if (!categorySearch) return categories;
      return categories.filter(c => c.toLowerCase().includes(categorySearch.toLowerCase()));
  }, [categories, categorySearch]);

  const filteredActions = useMemo(() => {
    return quickActions.filter(action => {
      const matchesQuery = (
        action.label.toLowerCase().includes(filterQuery.toLowerCase()) || 
        action.command.toLowerCase().includes(filterQuery.toLowerCase()) ||
        (action.description && action.description.toLowerCase().includes(filterQuery.toLowerCase()))
      );
      
      const category = action.category || "General";
      const matchesCategory = selectedCategories.length > 0 
        ? selectedCategories.includes(category)
        : true;
        
      const matchesColor = selectedColor ? action.color === selectedColor : true;
      return matchesQuery && matchesCategory && matchesColor;
    });
  }, [quickActions, filterQuery, selectedCategories, selectedColor]);

  const checkScroll = () => {
    if (scrollContainerRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
      setCanScrollLeft(scrollLeft > 0);
      setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 5);
    }
  };

  React.useEffect(() => {
    checkScroll();
    window.addEventListener("resize", checkScroll);
    return () => window.removeEventListener("resize", checkScroll);
  }, [filteredActions]);

  const scroll = (direction: "left" | "right") => {
    if (scrollContainerRef.current) {
      const scrollAmount = 200;
      scrollContainerRef.current.scrollBy({
        left: direction === "left" ? -scrollAmount : scrollAmount,
        behavior: "smooth",
      });
      setTimeout(checkScroll, 300);
    }
  };

  const colors = {
    green: "bg-emerald-500/[0.12] backdrop-blur-md border border-emerald-500/[0.25] text-emerald-400 hover:bg-emerald-500/[0.2] hover:border-emerald-500/[0.4]",
    red: "bg-red-500/[0.12] backdrop-blur-md border border-red-500/[0.25] text-red-400 hover:bg-red-500/[0.2] hover:border-red-500/[0.4]",
    blue: "bg-blue-500/[0.12] backdrop-blur-md border border-blue-500/[0.25] text-blue-400 hover:bg-blue-500/[0.2] hover:border-blue-500/[0.4]",
    yellow: "bg-amber-500/[0.12] backdrop-blur-md border border-amber-500/[0.25] text-amber-400 hover:bg-amber-500/[0.2] hover:border-amber-500/[0.4]",
    purple: "bg-purple-500/[0.12] backdrop-blur-md border border-purple-500/[0.25] text-purple-400 hover:bg-purple-500/[0.2] hover:border-purple-500/[0.4]",
    gray: "bg-gray-500/[0.12] backdrop-blur-md border border-gray-500/[0.25] text-gray-400 hover:bg-gray-500/[0.2] hover:border-gray-500/[0.4]",
  };
  
  // Color hex map for the filter UI
  const colorHexMap: Record<string, string> = {
    green: "#10b981", 
    red: "#ef4444", 
    blue: "#3b82f6", 
    yellow: "#f59e0b", 
    purple: "#8b5cf6", 
    gray: "#6b7280"
  };

  const handleActionClick = (action: QuickAction) => {
    if (!activeTabId) return;
    sendQuickAction(activeTabId, action.command);
  };

  const openAddModal = () => {
    setEditingAction(null);
    setIsModalOpen(true);
  };

  const openEditModal = (action: QuickAction) => {
    setEditingAction(action);
    setIsModalOpen(true);
  };

  // Helper so popover renders on top of everything
  const PortalPanel = ({ children }: { children: React.ReactNode }) => {
    return ReactDOM.createPortal(
      children,
      document.body
    );
  };

  return (
    <>
      <div
        role="group"
        aria-label="Quick actions"
        className={`h-[34px] bg-[var(--terminal-chrome-bg)] border-t border-[var(--terminal-chrome-border)] flex items-center shrink-0 z-30 relative group ${
          rounded ? "last:rounded-b-[var(--workspace-radius)]" : ""
        }`}
      >
        <Popover className="h-full">
            {({ open }) => (
              <>
                <Popover.Button 
                  className={`relative h-full w-10 shrink-0 flex items-center justify-center border-r border-[var(--terminal-chrome-border)] hover:bg-white/5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-300 ${
                     (filterQuery || selectedCategories.length > 0 || selectedColor) ? "text-primary shadow-[inset_0_-2px_0_0_rgba(var(--color-primary),1)]" : "text-gray-400 hover:text-white"
                  }`}
                  title="Filter & Search"
                >
                  <IoFunnel size={14} className={open ? "text-primary" : ""} />
                  {(filterQuery || selectedCategories.length > 0 || selectedColor) && (
                    <div className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-primary rounded-full" />
                  )}
                </Popover.Button>
                
                {/* Use Portal to break out of overflow:hidden containers */}
                {open && (
                  <PortalPanel>
                      <Popover.Panel static className="fixed bottom-14 left-4 z-[9999] w-72 origin-bottom-left rounded-xl bg-[#0f1115]/95 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/50 focus:outline-none p-0 overflow-hidden ring-1 ring-white/5">
                        
                        {/* Header */}
                        <div className="px-4 py-3 border-b border-white/5 bg-white/5 flex items-center justify-between">
                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Filters</span>
                            {(filterQuery || selectedCategories.length > 0 || selectedColor) && (
                                <button 
                                    onClick={() => {
                                        setFilterQuery("");
                                        setSelectedCategories([]);
                                        setSelectedColor(null);
                                    }}
                                    className="text-[10px] text-primary hover:text-primary-light transition-colors font-medium"
                                >
                                    RESET ALL
                                </button>
                            )}
                        </div>

                        <div className="p-4 space-y-5">
                            {/* Search Input */}
                            <div className="space-y-2">
                                <label className="text-xs text-gray-500 font-medium ml-1">Search</label>
                                <div className="relative group">
                                    <IoSearch className="absolute left-3 top-2.5 text-gray-500 group-focus-within:text-primary transition-colors" />
                                    <input 
                                      type="text" 
                                      placeholder="Filter by name or command..." 
                                      className="w-full bg-black/40 border border-white/10 rounded-lg py-2 pl-9 pr-3 text-sm text-gray-200 focus:border-primary/50 focus:ring-1 focus:ring-primary/50 focus:outline-none transition-all placeholder:text-gray-600"
                                      value={filterQuery}
                                      onChange={(e) => setFilterQuery(e.target.value)}
                                      autoFocus
                                    />
                                </div>
                            </div>
                            
                            {/* Filter by Color */}
                            <div className="space-y-2">
                                <label className="text-xs text-gray-500 font-medium ml-1">Colors</label>
                                <div className="flex flex-wrap gap-3 p-1">
                                    {Object.entries(colors).map(([name, classes]) => {
                                        const hex = colorHexMap[name];
                                        const isSelected = selectedColor === name;
                                        
                                        return (
                                            <button
                                                key={name}
                                                onClick={() => setSelectedColor(isSelected ? null : name)}
                                                className={`w-6 h-6 rounded-full shadow-sm transition-all duration-200 flex items-center justify-center ${isSelected ? 'ring-2 ring-offset-2 ring-offset-[#0f1115] scale-110' : 'hover:scale-110 opacity-70 hover:opacity-100'}`}
                                                style={{ backgroundColor: hex, '--tw-ring-color': hex } as React.CSSProperties}
                                                title={`Filter by ${name}`}
                                            >
                                                {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white shadow-sm" />}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Categories */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <label className="text-xs text-gray-500 font-medium ml-1">Device Type / Category</label>
                                    {categories.length > 5 && (
                                       <div className="relative">
                                           <input 
                                                type="text" 
                                                placeholder="Find category..." 
                                                className="bg-transparent border-b border-gray-700 text-[10px] text-white focus:border-primary focus:outline-none w-24 placeholder-gray-600 pb-0.5"
                                                value={categorySearch}
                                                onChange={(e) => setCategorySearch(e.target.value)}
                                           />
                                       </div>
                                    )}
                                </div>
                                <div className="max-h-40 overflow-y-auto custom-scrollbar pr-1 grid grid-cols-1 gap-1">
                                    <button
                                      onClick={() => setSelectedCategories([])}
                                      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all duration-200 flex items-center justify-between group ${
                                          selectedCategories.length === 0
                                          ? 'bg-primary/10 text-primary ring-1 ring-primary/20' 
                                          : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
                                      }`}
                                    >
                                      <span>All Categories</span>
                                      {selectedCategories.length === 0 && <div className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_5px_rgba(var(--color-primary),0.8)]" />}
                                    </button>
                                    
                                    {filteredCategories.map(cat => {
                                        const isSelected = selectedCategories.includes(cat);
                                        return (
                                           <button
                                             key={cat}
                                             onClick={() => {
                                                 setSelectedCategories(prev => 
                                                     prev.includes(cat) 
                                                     ? prev.filter(c => c !== cat)
                                                     : [...prev, cat]
                                                 );
                                             }}
                                             className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all duration-200 flex items-center justify-between group ${
                                                 isSelected 
                                                 ? 'bg-primary/10 text-primary ring-1 ring-primary/20' 
                                                 : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
                                             }`}
                                           >
                                             <span>{cat}</span>
                                             {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_5px_rgba(var(--color-primary),0.8)]" />}
                                           </button>
                                        );
                                    })}
                                    
                                    {filteredCategories.length === 0 && (
                                        <div className="text-center py-2 text-xs text-gray-500 italic">
                                            No categories match
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                      </Popover.Panel>
                  </PortalPanel>
                )}
              </>
            )}
        </Popover>

        {/* Scroll Left Button */}
        {canScrollLeft && (
           <button
             onClick={() => scroll("left")}
             aria-label="Scroll quick actions left"
             className="absolute left-10 top-0 bottom-0 w-6 flex items-center justify-center bg-gradient-to-r from-[var(--terminal-chrome-bg)] to-transparent z-10 text-gray-400 hover:text-white"
           >
             <IoChevronBack size={16} />
           </button>
        )}

        <div 
          ref={scrollContainerRef}
          onScroll={checkScroll}
          className="min-w-0 flex-1 flex items-center px-2 gap-1.5 overflow-x-auto no-scrollbar scroll-smooth"
        >
          <button
            onClick={openAddModal}
            className="h-6 w-6 rounded flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors border border-dashed border-slate-600/60 hover:border-slate-400 shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"
            title="Add Quick Action"
          >
            <IoAdd size={16} />
          </button>

          {filteredActions.length === 0 && (
             <span className="text-xs text-gray-600 italic">No actions found</span>
          )}

          {filteredActions.map((action) => (
            <div
              key={action.id}
              className="relative group shrink-0"
              onContextMenu={(e) => {
                e.preventDefault();
                openEditModal(action);
              }}
            >
              <button
                onClick={() => handleActionClick(action)}
                className={`h-6 px-2.5 rounded text-[11px] font-medium transition-colors flex items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 ${
                  colors[action.color] || colors.gray
                }`}
                title={`${action.command}\n${action.description || ""}\n(Right-click to edit)`}
              >
                <span>{action.label}</span>
                {/* Category Badge (mini) if not filtered by category specifically? Maybe too cluttered. */}
              </button>
              
              {/* Edit/Delete Overlay */}
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 hidden group-hover:flex bg-gray-800 rounded-md border border-gray-700 shadow-xl overflow-hidden z-20">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openEditModal(action);
                  }}
                  className="p-1.5 text-gray-400 hover:text-white hover:bg-white/10"
                >
                  <IoPencil size={12} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm("Are you sure?")) {
                      removeQuickAction(action.id);
                    }
                  }}
                  className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-white/10"
                >
                  <IoTrash size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Scroll Right Button */}
        {canScrollRight && (
           <button
             onClick={() => scroll("right")}
             aria-label="Scroll quick actions right"
             className="absolute right-0 top-0 bottom-0 w-6 flex items-center justify-center bg-gradient-to-l from-[var(--terminal-chrome-bg)] to-transparent z-10 text-gray-400 hover:text-white"
           >
             <IoChevronForward size={16} />
           </button>
        )}
      </div>

      <QuickActionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        editingAction={editingAction}
      />
    </>
  );
};

export default QuickActionBar;
