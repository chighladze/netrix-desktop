import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const profile = process.argv[2] === "debug" ? "debug" : "release";

function detectTargetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) {
    return process.env.TAURI_ENV_TARGET_TRIPLE;
  }

  const verboseVersion = execFileSync("rustc", ["-vV"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  const hostLine = verboseVersion
    .split(/\r?\n/)
    .find((line) => line.startsWith("host: "));

  if (!hostLine) {
    throw new Error("Unable to detect Rust target triple from `rustc -vV`.");
  }

  return hostLine.slice("host: ".length).trim();
}

const targetTriple = detectTargetTriple();
const executableExtension = targetTriple.includes("windows") ? ".exe" : "";
const source = join(
  repoRoot,
  "backend-rs",
  "target",
  ...(profile === "release" ? [targetTriple] : []),
  profile,
  `netrix_backend${executableExtension}`,
);
const destination = join(
  repoRoot,
  "src-tauri",
  "binaries",
  `netrix_backend-${targetTriple}${executableExtension}`,
);

if (!existsSync(source)) {
  throw new Error(
    `Backend sidecar not found at ${source}. Run ` +
      `npm run build:sidecar:${profile} first.`,
  );
}

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);

const sizeMb = (statSync(destination).size / 1024 / 1024).toFixed(1);
console.log(`Prepared sidecar ${destination} (${sizeMb} MB).`);
