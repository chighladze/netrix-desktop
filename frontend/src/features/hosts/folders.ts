import { getParentPath, isValidGroupPath, normalizeGroupPath } from "../../utils/groupUtils";

export const inFolder = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
export const relocateFolder = (path: string, source: string, destination: string) => inFolder(path, source) ? destination + path.slice(source.length) : path;

export function validateFolderDestination(source: string | null, destination: string, paths: string[]): string | null {
  if (!isValidGroupPath(destination)) return "Use a folder path of up to 100 characters and 16 levels, without . or ..";
  if (source && inFolder(destination, source)) return "Choose a different location outside this folder.";
  if (paths.includes(destination)) return "A folder with this name already exists here.";
  if (source && paths.some(path => inFolder(path, source) && !isValidGroupPath(relocateFolder(path, source, destination)))) return "The resulting path is too long for a nested folder.";
  return null;
}

export function folderAncestors(path: string): { name: string; path: string }[] {
  return normalizeGroupPath(path).split("/").filter(Boolean).map((name, index, parts) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

export const childFolders = (paths: string[], parent: string | null) => parent === "" ? [] : paths.filter(path => (getParentPath(path) || null) === parent);
