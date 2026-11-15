import React, { useEffect } from "react";
import { IoTrash } from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";

import { SavedHostDto, useAppStore } from "../state/store";

const HostList: React.FC = () => {
  const { hosts, fetchHosts, setSelectedHost, showConfirm, addToast } = useAppStore(
    useShallow((state) => ({
      hosts: state.hosts,
      fetchHosts: state.fetchHosts,
      setSelectedHost: state.setSelectedHost,
      showConfirm: state.showConfirm,
      addToast: state.addToast,
    })),
  );
  useEffect(() => {
    void fetchHosts().catch(error => addToast(error instanceof Error ? error.message : "Failed to load hosts", "error"));
  }, [fetchHosts, addToast]);

  const handleDelete = (host: SavedHostDto) => {
    showConfirm({
      title: "Delete Host",
      message: `Are you sure you want to delete ${host.name}? This action cannot be undone.`,
      confirmText: "Delete",
      type: "danger",
      onConfirm: async () => {
        try {
          await useAppStore.getState().deleteHost(host.id);

          addToast(`Host ${host.name} deleted`, "success");
          const { selectedHost } = useAppStore.getState();
          if (selectedHost && selectedHost.id === host.id) {
            setSelectedHost(null);
          }
        } catch (err) {
          console.error("Delete error:", err);
          addToast(err instanceof Error ? err.message : "Error deleting host", "error");
        }
      },
    });
  };

  const handleSelect = (host: SavedHostDto) => {
    setSelectedHost(host);
  };

  return (
    <div className="p-4 overflow-y-auto h-full">
      <h2 className="text-xl font-semibold mb-4">Hosts</h2>
      {hosts.map((host) => (
        <div
          key={host.id}
          className="group relative p-3 my-2 rounded-md bg-background-dark hover:bg-primary-dark cursor-pointer transition-colors"
          onClick={() => handleSelect(host)}
        >
          <div className="flex justify-between items-start">
            <div>
              <p className="font-medium">{host.name}</p>
              <p className="text-sm text-foreground-muted">
                {host.username}@{host.hostname}:{host.port}
              </p>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(host);
              }}
              className="opacity-0 group-hover:opacity-100 p-2 text-gray-400 hover:text-red-500 hover:bg-white/10 rounded transition-all"
              title="Delete Host"
            >
              <IoTrash size={16} />
            </button>
          </div>
        </div>
      ))}
      {hosts.length === 0 && (
        <p className="text-sm text-foreground-muted">No hosts configured.</p>
      )}
    </div>
  );
};

export default HostList;
