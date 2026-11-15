import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { DownloadDetails, FileDialogOptions } from "./useFileDialog";

interface Options {
  ask: (options: FileDialogOptions) => Promise<string | null>;
  download: DownloadDetails;
  signal: AbortSignal;
}

/** Only the active Files picker can ask Netrix for a one-time WebView2 decision. */
export async function withSftpSaveAccess<T>(pick: () => Promise<T>, { ask, download, signal }: Options): Promise<T> {
  if (!isTauri()) return pick();

  const prompt = new AbortController();
  const cancelled = () => new DOMException("Download cancelled", "AbortError");
  const onRequest = new Channel<null>();
  const finish = (allow: boolean) => invoke("finish_sftp_save_access", { id: onRequest.id, allow }).catch(() => {});
  let declined = false;
  onRequest.onmessage = async () => {
    const answer = await ask({
      title: "Allow local save?",
      description: "Give Netrix write access for this download.",
      confirmLabel: "Allow & download",
      download,
      signal: prompt.signal,
    }).catch(() => null);
    declined = answer === null || prompt.signal.aborted;
    await finish(!declined);
  };
  const cancel = () => {
    prompt.abort();
    void finish(false);
  };

  // Arm immediately before the picker so the original click still supplies user activation.
  const watched = await invoke<boolean>("watch_sftp_save_access", { onRequest }).catch(() => false);
  if (watched) signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw cancelled();
    return await pick();
  } catch (error) {
    if (declined || signal.aborted) throw cancelled();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    prompt.abort();
    onRequest.onmessage = () => {};
    if (watched) await finish(false);
  }
}
