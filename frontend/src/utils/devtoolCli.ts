/**
 * Core engine for intercepting and executing `devtool` CLI commands locally.
 * This runs directly in the browser through the Utilities local runner.
 */

import { formatJson } from "../features/utilities/json";

type DevtoolCommandContext = {
  args: string[];
  flags: Record<string, string | boolean>;
  rawCommand: string;
};

function secureRandomIndex(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) return 0;
  const bucketSize = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= bucketSize);
  return value[0] % maxExclusive;
}

function secureRandomString(length: number, charset: string): string {
  const targetLength = Math.max(1, Math.floor(length));
  let output = "";
  for (let i = 0; i < targetLength; i++) output += charset[secureRandomIndex(charset.length)];
  return output;
}

export async function executeDevtoolCommand(input: string): Promise<string> {
  const trimmed = input.trim();
  if (input.length > 65536) return "Error: DevTool input exceeds 64 KiB.";
  if (!trimmed.startsWith("devtool ")) {
    return "";
  }

  // Very basic parser: extract command, positional args, and flags
  const tokens = parseTokens(trimmed.substring("devtool ".length));
  if (tokens.length === 0) {
    return "\x1b[31mError: No command provided.\x1b[0m\r\nUsage: devtool <command> [args...]";
  }

  const commandName = tokens[0];
  const args: string[] = [];
  const flags: Record<string, string | boolean> = Object.create(null);

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      const parts = token.substring(2).split("=");
      const key = parts[0];
      if (parts.length > 1) {
        flags[key] = parts[1];
      } else {
        // Look ahead for value
        if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
          flags[key] = tokens[i + 1];
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (token.startsWith("-")) {
      flags[token.substring(1)] = true;
    } else {
      args.push(token);
    }
  }

  const ctx: DevtoolCommandContext = { args, flags, rawCommand: trimmed };
  const handler = Object.prototype.hasOwnProperty.call(COMMAND_REGISTRY, commandName) ? COMMAND_REGISTRY[commandName] : undefined;

  if (!handler) {
    return `\x1b[31mError: Unknown command '${commandName}'\x1b[0m\r\nType 'devtool help' for a list of available commands.`;
  }

  try {
    const result = await handler(ctx);
    return result;
  } catch (err: any) {
    return `\x1b[31mError executing ${commandName}: ${err.message || err}\x1b[0m`;
  }
}

// Simple regex-based token parser to handle quotes
function parseTokens(str: string): string[] {
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  const tokens: string[] = [];
  let match;
  while ((match = regex.exec(str)) !== null) {
    tokens.push(match[1] || match[2] || match[0]);
  }
  return tokens;
}

// ─── Command Implementations ──────────────────────────────────────────────────

const COMMAND_REGISTRY: Record<string, (ctx: DevtoolCommandContext) => Promise<string> | string> = {
  "help": () => {
    const cmds = Object.keys(COMMAND_REGISTRY).sort().join("\r\n  ");
    return `\x1b[36mNetrix DevTool CLI\x1b[0m\r\nAvailable commands:\r\n  ${cmds}\r\n`;
  },

  // DATA & FORMATTERS
  "json:format": (ctx) => {
    const input = ctx.args[0];
    if (!input) return "\x1b[31mUsage: devtool json:format '{\"key\": \"value\"}'\x1b[0m";
    try {
      const formatted = formatJson(input);
      return `\x1b[32mFormatted JSON:\x1b[0m\r\n${formatted.replace(/\n/g, "\r\n")}`;
    } catch (e: any) {
      return `\x1b[31mInvalid JSON: ${e.message}\x1b[0m`;
    }
  },

  "json:minify": (ctx) => {
    const input = ctx.args[0];
    if (!input) return "\x1b[31mUsage: devtool json:minify '{\"key\": \"value\"}'\x1b[0m";
    try {
      return formatJson(input, null);
    } catch (e: any) {
      return `\x1b[31mInvalid JSON: ${e.message}\x1b[0m`;
    }
  },

  "json:validate": (ctx) => {
    const input = ctx.args[0];
    if (!input) return "\x1b[31mUsage: devtool json:validate '{\"key\": \"value\"}'\x1b[0m";
    try {
      JSON.parse(input);
      return `\x1b[32m✓ JSON is valid\x1b[0m`;
    } catch (e: any) {
      return `\x1b[31m✖ Invalid JSON: ${e.message}\x1b[0m`;
    }
  },

  "json:repair": (ctx) => {
    let input = ctx.args[0];
    if (!input) return "\x1b[31mUsage: devtool json:repair \"{key: 'value',}\"\x1b[0m";
    try {
      // Very basic naive repair: replace single quotes with double quotes, remove trailing commas
      let repaired = input
        .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":') // Quote unquoted keys
        .replace(/'/g, '"') // Replace single quotes with double quotes
        .replace(/,\s*([}\]])/g, "$1"); // Remove trailing commas
      
      return `\x1b[32mRepaired JSON:\x1b[0m\r\n${formatJson(repaired).replace(/\n/g, "\r\n")}`;
    } catch (e: any) {
      return `\x1b[31mRepair failed: ${e.message}\x1b[0m`;
    }
  },

  // ENCODING & DECODING
  "base64:encode": (ctx) => {
    const input = ctx.args[0];
    if (!input) return "\x1b[31mUsage: devtool base64:encode <text>\x1b[0m";
    return btoa(unescape(encodeURIComponent(input)));
  },

  "base64:decode": (ctx) => {
    const input = ctx.args[0];
    if (!input) return "\x1b[31mUsage: devtool base64:decode <base64>\x1b[0m";
    try {
      return decodeURIComponent(escape(atob(input)));
    } catch {
      return "\x1b[31mInvalid base64 string\x1b[0m";
    }
  },

  "url:encode": (ctx) => {
    if (!ctx.args[0]) return "\x1b[31mUsage: devtool url:encode <text>\x1b[0m";
    return encodeURIComponent(ctx.args[0]);
  },

  "url:decode": (ctx) => {
    if (!ctx.args[0]) return "\x1b[31mUsage: devtool url:decode <url>\x1b[0m";
    return decodeURIComponent(ctx.args[0]);
  },

  // SECURITY & AUTH
  "uuid:v4": (ctx) => {
    const value = ctx.flags["count"] ?? "1";
    const count = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(count) || count < 1 || count > 1000) return "\x1b[31mUUID count must be an integer between 1 and 1000.\x1b[0m";
    let out = [];
    for (let i = 0; i < count; i++) {
      out.push(crypto.randomUUID());
    }
    return out.join("\r\n");
  },

  "hash": async (ctx) => {
    const algo = (String(ctx.flags["algo"] || "sha256")).toUpperCase();
    const input = ctx.args[0];
    if (!input) return "\x1b[31mUsage: devtool hash --algo sha256 <text>\x1b[0m";
    
    try {
      const validAlgos = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"];
      const normAlgo = validAlgos.find(a => a.replace("-", "") === algo.replace("-", "")) || "SHA-256";
      const msgUint8 = new TextEncoder().encode(input);
      const hashBuffer = await crypto.subtle.digest(normAlgo, msgUint8);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      return `${normAlgo}: ${hashHex}`;
    } catch (e: any) {
      return `\x1b[31mHash error: ${e.message}\x1b[0m`;
    }
  },

  "jwt:decode": (ctx) => {
    const token = ctx.args[0];
    if (!token) return "\x1b[31mUsage: devtool jwt:decode <token>\x1b[0m";
    try {
      const parts = token.split('.');
      if (parts.length < 2) throw new Error("Invalid JWT format");
      const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      
      let out = `\x1b[36mHeader:\x1b[0m\r\n${JSON.stringify(header, null, 2).replace(/\n/g, "\r\n")}\r\n`;
      out += `\x1b[36mPayload:\x1b[0m\r\n${JSON.stringify(payload, null, 2).replace(/\n/g, "\r\n")}`;
      return out;
    } catch (e: any) {
      return `\x1b[31mFailed to decode JWT: ${e.message}\x1b[0m`;
    }
  },

  // TEXT & PRODUCTIVITY
  "text:stats": (ctx) => {
    const text = ctx.args[0];
    if (!text) return "\x1b[31mUsage: devtool text:stats <text>\x1b[0m";
    const chars = text.length;
    const words = text.split(/\s+/).filter(w => w.length > 0).length;
    const lines = text.split(/\r\n|\r|\n/).length;
    const bytes = new Blob([text]).size;
    return `\x1b[36mText Stats:\x1b[0m\r\nChars: ${chars}\r\nWords: ${words}\r\nLines: ${lines}\r\nBytes: ${bytes}`;
  },

  "string:length": (ctx) => {
    const text = ctx.args[0];
    if (!text) return "\x1b[31mUsage: devtool string:length <text>\x1b[0m";
    return `Length: ${text.length} characters\r\nBytes (UTF-8): ${new Blob([text]).size}`;
  },

  "text:case": (ctx) => {
    const to = String(ctx.flags["to"] || "lower").toLowerCase();
    const text = ctx.args[0];
    if (!text) return "\x1b[31mUsage: devtool text:case --to <format> <text>\x1b[0m\r\nFormats: lower, upper, camel, pascal, snake, kebab";
    
    switch (to) {
      case "lower": return text.toLowerCase();
      case "upper": return text.toUpperCase();
      case "snake": return text.replace(/\W+/g, " ").split(/ |\B(?=[A-Z])/).map(word => word.toLowerCase()).join('_');
      case "kebab": return text.replace(/\W+/g, " ").split(/ |\B(?=[A-Z])/).map(word => word.toLowerCase()).join('-');
      case "camel": return text.replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) => index === 0 ? word.toLowerCase() : word.toUpperCase()).replace(/\s+/g, '');
      case "pascal": return text.replace(/(?:^\w|[A-Z]|\b\w)/g, (word) => word.toUpperCase()).replace(/\s+/g, '');
      default: return `\x1b[31mUnknown format '${to}'\x1b[0m`;
    }
  },

  "text:slug": (ctx) => {
    const text = ctx.args[0];
    if (!text) return "\x1b[31mUsage: devtool text:slug <text>\x1b[0m";
    return text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
  },

  "lines:sort": (ctx) => {
    const text = ctx.args[0];
    if (!text) return "\x1b[31mUsage: devtool lines:sort <text>\x1b[0m";
    return text.split(/\r\n|\r|\n/).sort().join('\r\n');
  },

  "lines:reverse": (ctx) => {
    const text = ctx.args[0];
    if (!text) return "\x1b[31mUsage: devtool lines:reverse <text>\x1b[0m";
    return text.split(/\r\n|\r|\n/).reverse().join('\r\n');
  },

  "lines:unique": (ctx) => {
    const text = ctx.args[0];
    if (!text) return "\x1b[31mUsage: devtool lines:unique <text>\x1b[0m";
    const lines = text.split(/\r\n|\r|\n/);
    return Array.from(new Set(lines)).join('\r\n');
  },

  "password:generate": (ctx) => {
    const requestedLength = parseInt(String(ctx.flags["length"] || "16"), 10) || 16;
    const length = Math.min(Math.max(requestedLength, 4), 128);
    const includeSymbols = ctx.flags["symbols"] !== false && ctx.flags["symbols"] !== "false";
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" + (includeSymbols ? "!@#$%^&*()_+~`|}{[]:;?><,./-=" : "");
    return secureRandomString(length, charset);
  },

  "mac:format": (ctx) => {
    const mac = ctx.args[0];
    const style = String(ctx.flags["style"] || "colon").toLowerCase();
    if (!mac) return "\x1b[31mUsage: devtool mac:format --style <colon|dash|cisco|bare> <mac>\x1b[0m";
    
    const clean = mac.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
    if (clean.length !== 12) return "\x1b[31mInvalid MAC address length\x1b[0m";
    
    switch (style) {
      case "dash": return clean.match(/.{1,2}/g)?.join('-') || clean;
      case "cisco": return clean.match(/.{1,4}/g)?.join('.') || clean;
      case "bare": return clean.toLowerCase();
      case "colon":
      default: return clean.match(/.{1,2}/g)?.join(':') || clean;
    }
  }
};
