import { useCallback, useRef } from "react";
import { authenticatedFetch, getApiBase, getApiErrorMessage } from "../../api";
import { cancelTransfer, createTransfer, requireCompletedTransfer } from "./api";
import { withSftpSaveAccess } from "./saveAccess";
import type { FileDialogOptions } from "./useFileDialog";

interface Entry {
  name: string;
  path: string;
  entry_type: string;
  size?: number | null;
}
interface WritableFile {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface SaveWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
  }) => Promise<{ createWritable(): Promise<WritableFile> }>;
  showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<SaveDirectory>;
}
interface SaveDirectory {
  getFileHandle(name: string, options?: { create: boolean }): Promise<{ createWritable(): Promise<WritableFile> }>;
}
interface Options {
  hostId: number | undefined;
  remotePath: string;
  entries: Entry[];
  ask: (options: FileDialogOptions) => Promise<string | null>;
  track: (hostId: number) => AbortController;
  release: (hostId: number, controller: AbortController) => void;
  busy: (action: "download" | "upload" | null) => void;
  toast: (message: string, type: "success" | "error" | "info") => void;
  reload: (path: string) => Promise<void>;
}

const aborted = () => new DOMException("Transfer cancelled", "AbortError");
const join = (parent: string, name: string) =>
  parent === "/" ? `/${name}` : `${parent.replace(/\/+$/, "")}/${name}`;

/** Cancels the actual backend job as well as the browser request. */
function linkCancellation(id: string, signal: AbortSignal) {
  const cancel = () => {
    void cancelTransfer(id).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  return () => signal.removeEventListener("abort", cancel);
}

export function useTransfers(options: Options) {
  const { hostId, remotePath, entries, ask, track, release, busy, toast, reload } = options;
  const downloading = useRef(false);

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      if (hostId === undefined) return;
      const selected = Array.from(files);
      if (!selected.length) return;
      const controller = track(hostId);
      busy("upload");
      let completed = 0;
      try {
        for (const file of selected) {
          if (controller.signal.aborted) throw aborted();
          if (file.size > 128 * 1024 * 1024)
            throw new Error(`${file.name} exceeds the 128 MiB upload limit`);
          const path = join(remotePath, file.name);
          const exists = entries.find((entry) => entry.name === file.name);
          if (exists && exists.entry_type !== "file")
            throw new Error(`${file.name} is not a regular file and cannot be replaced`);
          let overwrite = false;
          if (exists) {
            const answer = await ask({
              title: "Replace remote file?",
              description: path,
              confirmLabel: "Replace file",
              destructive: true,
            });
            if (answer === null || controller.signal.aborted) throw aborted();
            overwrite = true;
          }
          const job = await createTransfer(
            hostId,
            "upload",
            path,
            controller.signal,
            file.size,
            overwrite,
          );
          const unlink = linkCancellation(job.id, controller.signal);
          try {
            const response = await authenticatedFetch(
              `${await getApiBase()}/sftp/hosts/${hostId}/upload?${new URLSearchParams({ path, transfer_id: job.id })}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: file,
                signal: controller.signal,
              },
            );
            if (!response.ok) throw new Error(await getApiErrorMessage(response, "Upload failed"));
            await requireCompletedTransfer(job.id);
            completed += 1;
          } catch (error) {
            await cancelTransfer(job.id).catch(() => {});
            throw error;
          } finally {
            unlink();
          }
        }
        toast(`Uploaded ${completed} file${completed === 1 ? "" : "s"}`, "success");
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          toast(
            `${completed ? `${completed} file(s) completed. ` : ""}${error instanceof Error ? error.message : "Upload failed"}`,
            "error",
          );
        }
      } finally {
        release(hostId, controller);
        busy(null);
        if (!controller.signal.aborted) await reload(remotePath);
      }
    },
    [hostId, remotePath, entries, ask, track, release, busy, toast, reload],
  );

  const downloadMany = useCallback(
    async (items: Entry[]) => {
      const selected = [...new Map(items.map((entry) => [entry.path, entry])).values()];
      if (hostId === undefined || !selected.length || downloading.current) return;
      if (selected.some((entry) => entry.entry_type === "directory")) {
        toast("Select files only; folder downloads are not supported", "info"); return;
      }
      downloading.current = true;
      const controller = track(hostId);
      busy("download");
      let completed = 0;
      try {
        const save = window as unknown as SaveWindow;
        const pickFolder = save.showDirectoryPicker?.bind(window);
        const pickFile = save.showSaveFilePicker?.bind(window);
        // Open the picker from the initial click. Repeated save pickers would
        // lose browser user activation after the first asynchronous transfer.
        const directory = selected.length > 1 && pickFolder
          ? await withSftpSaveAccess(() => pickFolder({ mode: "readwrite" }), {
              ask, download: { files: selected, destination: "folder" }, signal: controller.signal,
            })
          : null;
        const usedNames = new Set<string>();
        for (const entry of selected) {
          if (controller.signal.aborted) throw aborted();
          const safeName = entry.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().replace(/[. ]+$/, "") || "download";
          let filename = safeName;
          const extension = safeName.lastIndexOf(".");
          for (let suffix = 2; usedNames.has(filename.toLocaleLowerCase()); suffix++) {
            filename = extension > 0 ? `${safeName.slice(0, extension)} (${suffix})${safeName.slice(extension)}` : `${safeName} (${suffix})`;
          }
          usedNames.add(filename.toLocaleLowerCase());
          let writable: WritableFile | null = null;
          let jobId: string | null = null;
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let unlink = () => {};
          try {
            if (directory) {
              let exists = false;
              try { await directory.getFileHandle(filename); exists = true; }
              catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
              if (exists) {
                const answer = await ask({ title: "Replace local file?", description: filename, confirmLabel: "Replace file", destructive: true, signal: controller.signal });
                if (answer === null) throw aborted();
              }
              if (controller.signal.aborted) throw aborted();
              writable = await (await directory.getFileHandle(filename, { create: true })).createWritable();
            } else if (selected.length === 1 && pickFile) {
              writable = await withSftpSaveAccess(async () => {
                const handle = await pickFile({ suggestedName: filename });
                if (controller.signal.aborted) throw aborted();
                return handle.createWritable();
              }, { ask, download: { files: selected, destination: "file" }, signal: controller.signal });
            }
            if (controller.signal.aborted) throw aborted();
            const job = await createTransfer(hostId, "download", entry.path, controller.signal);
            jobId = job.id;
            unlink = linkCancellation(job.id, controller.signal);
            if (controller.signal.aborted) throw aborted();
            const response = await authenticatedFetch(
              `${await getApiBase()}/sftp/hosts/${hostId}/download?${new URLSearchParams({ path: entry.path, transfer_id: job.id })}`,
              { signal: controller.signal },
            );
            if (!response.ok) throw new Error(await getApiErrorMessage(response, "Download failed"));
            let blob: Blob | null = null;
            if (writable && response.body) {
              reader = response.body.getReader();
              while (true) {
                if (controller.signal.aborted) throw aborted();
                const { done, value } = await reader.read();
                if (done) break;
                await writable.write(value);
              }
            } else blob = await response.blob();
            const finished = await requireCompletedTransfer(job.id);
            if (controller.signal.aborted) throw aborted();
            if (writable) {
              if (blob) await writable.write(new Uint8Array(await blob.arrayBuffer()));
              await writable.close();
            } else if (blob) {
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url; anchor.download = filename;
              document.body.appendChild(anchor); anchor.click(); anchor.remove();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
            completed += 1;
            if (finished?.warning) toast(`${filename}: ${finished.warning}`, "info");
          } catch (error) {
            await reader?.cancel().catch(() => {});
            await writable?.abort().catch(() => {});
            if (jobId) await cancelTransfer(jobId).catch(() => {});
            throw error;
          } finally { reader?.releaseLock(); unlink(); }
        }
        toast(selected.length === 1 ? `Downloaded ${selected[0].name}` : `Downloaded ${completed} files`, "success");
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          toast(`${completed ? `${completed} of ${selected.length} files downloaded. ` : ""}${error instanceof Error ? error.message : "Download failed"}`, "error");
        } else if (completed && !controller.signal.aborted) toast(`${completed} of ${selected.length} files downloaded; remaining downloads cancelled`, "info");
      } finally {
        release(hostId, controller);
        busy(null);
        downloading.current = false;
      }
    },
    [hostId, ask, track, release, busy, toast],
  );
  const download = useCallback((entry: Entry | null) => downloadMany(entry ? [entry] : []), [downloadMany]);

  return { uploadFiles, download, downloadMany };
}
