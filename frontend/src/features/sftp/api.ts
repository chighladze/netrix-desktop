import { authenticatedFetch, fetchJsonOrThrow, getApiBase, getApiErrorMessage } from "../../api";
import type { SavedHostDto } from "../../types/host";

/** Secret-free binding between a cached listing and the profile which produced it. */
export const sftpTargetKey = (host: SavedHostDto) =>
  JSON.stringify([
    host.hostname,
    host.port,
    host.username ?? null,
    host.connection_type,
    host.credential_id ?? null,
    host.jump_host_id ?? null,
  ]);

export interface TransferJob {
  id: string;
  host_id: number;
  kind: "upload" | "download";
  path: string;
  status:
    | "queued"
    | "connecting"
    | "running"
    | "finalizing"
    | "committing"
    | "cancelling"
    | "completed"
    | "cancelled"
    | "failed";
  bytes_done: number;
  bytes_total: number | null;
  error: string | null;
  warning?: string | null;
}

export const isTransferFinished = (job: TransferJob) =>
  job.status === "completed" || job.status === "failed" || job.status === "cancelled";

export async function sftpRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return fetchJsonOrThrow<T>(`${await getApiBase()}/sftp${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    signal,
  });
}

export function createTransfer(
  hostId: number,
  kind: TransferJob["kind"],
  path: string,
  signal: AbortSignal,
  bytesTotal?: number,
  overwrite = false,
) {
  return sftpRequest<TransferJob>(
    `/hosts/${hostId}/transfers`,
    {
      kind,
      path,
      bytes_total: bytesTotal,
      overwrite,
      ...(overwrite ? { confirmation: "OVERWRITE" } : {}),
    },
    signal,
  );
}

export const cancelTransfer = (id: string) =>
  sftpRequest<TransferJob>(`/transfers/${encodeURIComponent(id)}/cancel`, {});
export const getTransfer = (id: string) =>
  sftpRequest<TransferJob>(`/transfers/${encodeURIComponent(id)}`);

export async function disconnectSftp(hostId: number) {
  const response = await authenticatedFetch(
    `${await getApiBase()}/sftp/hosts/${hostId}/disconnect`,
    {
      method: "POST",
    },
  );
  if (!response.ok) throw new Error(await getApiErrorMessage(response, "SFTP disconnect failed"));
}

/** The body can end after a worker failure. Completion comes from the job, not EOF alone. */
export async function requireCompletedTransfer(id: string) {
  const job = await getTransfer(id);
  if (job.status !== "completed") throw new Error(job.error || `Transfer ${job.status}`);
  return job;
}

export async function mutateFile(
  hostId: number,
  body: {
    action: "mkdir" | "rename" | "delete" | "chmod";
    path: string;
    destination?: string;
    permissions?: string;
    confirmation?: string;
  },
) {
  const response = await authenticatedFetch(
    `${await getApiBase()}/sftp/hosts/${hostId}/operations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw new Error(await getApiErrorMessage(response, "File operation failed"));
}

export interface DirectoryHistory {
  paths: string[];
  index: number;
}
export function visitDirectory(
  previous: DirectoryHistory | undefined,
  path: string,
  index?: number,
): DirectoryHistory {
  if (previous && index !== undefined && previous.paths[index] === path)
    return { ...previous, index };
  if (previous?.paths[previous.index] === path) return previous;
  const paths = [...(previous?.paths.slice(0, previous.index + 1) || []), path].slice(-100);
  return { paths, index: paths.length - 1 };
}

export function validateFileName(name: string) {
  if (!name || name === "." || name === ".." || /[\/\0]/.test(name))
    throw new Error("Enter a file name without / or NUL characters");
  return name;
}
