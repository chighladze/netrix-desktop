import type { SftpDirectoryEntry } from "../../state/store";

export const formatBytes = (value?: number | null): string => {
  if (value === null || value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
};

export const formatDate = (value?: string | null): string => {
  if (!value || Number.isNaN(new Date(value).getTime())) return "—";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
};

export const parentPath = (path: string): string => {
  if (!path || path === "." || path === "/") return path || ".";
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? (path.startsWith("/") ? "/" : ".") : trimmed.slice(0, slash);
};

export const fileNameError = (name: string): string | null =>
  !name || name === "." || name === ".." || /[\/\0]/.test(name)
    ? "Enter a name without / or NUL characters. The names . and .. are reserved."
    : null;

export const permissionError = (value: string): string | null =>
  /^[0-7]{3}$/.test(value) ? null : "Use three digits from 0 to 7, for example 644 or 755.";

/** Convert the server's symbolic mode (or an octal value) to the chmod editor's three digits. */
export function editablePermissions(entry: SftpDirectoryEntry): string {
  const mode = entry.permissions || "";
  if (/^[0-7]{3,6}$/.test(mode)) return mode.slice(-3);
  if (/^[-dlcbps?][rwxstST-]{9}$/.test(mode)) {
    return [1, 4, 7].map((start) =>
      (mode[start] === "r" ? 4 : 0) + (mode[start + 1] === "w" ? 2 : 0)
      + (/[xst]/.test(mode[start + 2]) ? 1 : 0),
    ).join("");
  }
  return entry.entry_type === "directory" ? "755" : "644";
}
