import React, { useEffect, useMemo, useRef, useState } from "react";
import {
    IoCheckmark,
    IoChevronForward,
    IoCopy,
    IoRefresh,
    IoSearchOutline,
    IoSwapHorizontal,
    IoTime,
    IoWarning,
} from "react-icons/io5";
import {
    LuBinary,
    LuBraces,
    LuCalendarClock,
    LuCode,
    LuFileCode,
    LuGlobe,
    LuHash,
    LuLink2,
    LuNetwork,
    LuPalette,
    LuServer,
    LuShield,
    LuSparkles,
    LuTimer,
} from "react-icons/lu";
import { toolInteger, useNetworkTool } from "../features/utilities/useNetworkTool";
import { parseCron, cronMatches } from "../features/utilities/cron";
import { ipToLong, longToIp } from "../features/utilities/ipv4";
import DevtoolRunner from "../features/utilities/DevtoolRunner";
import { formatSql } from "../features/utilities/sql";
import { formatJson } from "../features/utilities/json";
import { copyTextWithAutoClear } from "../utils/clipboard";

/* ─── helpers ─────────────────────────────────────────── */

const STORAGE_ACTIVE_CATEGORY = "netrix.utilities.activeCategory";

const copy = async (text: string): Promise<boolean> => {
  try {
    await copyTextWithAutoClear(text);
    return true;
  } catch {
    return false;
  }
};

const isTextInputTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
};

const normalizeBase64Input = (value: string) => {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const remainder = normalized.length % 4;
  if (remainder === 0) return normalized;
  return normalized + "=".repeat(4 - remainder);
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string) => {
  const binary = atob(normalizeBase64Input(value));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const textToBase64 = (value: string) => bytesToBase64(new TextEncoder().encode(value));

const base64ToText = (value: string) => new TextDecoder().decode(base64ToBytes(value));

const decodeJwtPart = (value: string) => JSON.parse(base64ToText(value));

const secureRandomIndex = (maxExclusive: number) => {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) return 0;
  const bucketSize = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= bucketSize);
  return value[0] % maxExclusive;
};

const secureRandomString = (length: number, charset: string) => {
  const targetLength = Math.max(1, Math.floor(length));
  let output = "";
  for (let i = 0; i < targetLength; i++) output += charset[secureRandomIndex(charset.length)];
  return output;
};

const quoteIfNeeded = (value: string) => (/\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);

const escapePosixArg = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;

const escapePowerShellArg = (value: string) => `'${value.replace(/'/g, "''")}'`;

const escapeCmdArg = (value: string) => value.replace(/([()%!^"<>&|])/g, "^$1");

const joinShellParts = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

const CopyBtn: React.FC<{ text: string; size?: number; label?: string }> = ({ text, size = 14, label = "Copy" }) => {
  const [ok, setOk] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleCopy = async () => {
    const success = await copy(text);
    if (success) {
      setOk(true);
      window.setTimeout(() => setOk(false), 1200);
      return;
    }
    setFailed(true);
    window.setTimeout(() => setFailed(false), 1200);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1.5 rounded-control bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
      title={failed ? "Clipboard unavailable" : label}
      aria-label={label}
      disabled={!text}
    >
      {ok ? <IoCheckmark size={size} className="text-emerald-400" /> : <IoCopy size={size} className={failed ? "text-amber-400" : ""} />}
    </button>
  );
};

const ToolCard: React.FC<{
  title: string;
  icon: React.ReactNode;

  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, icon, actions, children }) => (
  <div className="ui-card min-w-0 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
      <div className="flex items-center gap-2 text-white font-semibold">{icon}{title}</div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
    {children}
  </div>
);

const CodeArea: React.FC<{
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  rows?: number;
  borderColor?: string;
}> = ({ value, onChange, readOnly, rows = 6, borderColor = "border-white/10" }) => (
  <textarea
    value={value}
    onChange={onChange ? (e) => onChange(e.target.value) : undefined}
    readOnly={readOnly}
    rows={rows}
    spellCheck={false}
    className={`w-full bg-black/40 border ${borderColor} rounded-control text-xs text-white font-mono p-3 focus:outline-none focus:border-primary/40 resize-y`}
  />
);

/* ─── Category config ─────────────────────────────────── */

type UtilCategory = "formatters" | "encoders" | "network" | "cron" | "converters" | "terminal" | "text";

const CATEGORIES: { id: UtilCategory; label: string; icon: React.ComponentType<{ size?: number; className?: string }>; description: string }[] = [
  { id: "formatters", label: "Formatters", icon: LuBraces, description: "JSON, XML, HTML, SQL" },
  { id: "text",       label: "Text Tools", icon: LuFileCode, description: "Case converter, Line sorting, Slugs" },
  { id: "encoders",   label: "Encoders",   icon: LuShield, description: "Base64, URL, JWT, Hashes" },
  { id: "network",    label: "Network",    icon: LuNetwork, description: "Subnet, IP, Ports, Scanner, TLS" },
  { id: "cron",       label: "Cron",       icon: LuCalendarClock, description: "Cron expression helper" },
  { id: "converters", label: "Converters", icon: LuBinary, description: "Timestamps, Numbers, Colors" },
  { id: "terminal",   label: "Terminal Kit", icon: LuCode, description: "SSH, escaping, log triage commands" },
];

const ALL_TOOLS = [
  { id: "devtool-runner", name: "Local DevTool Runner", category: "terminal", keywords: "devtool local cli text tools uuid password hash" },
  { id: "json-formatter", name: "JSON Formatter", category: "formatters", keywords: "json format pretty stringify" },
  { id: "xml-formatter", name: "XML Formatter", category: "formatters", keywords: "xml format pretty" },
  { id: "html-formatter", name: "HTML Formatter", category: "formatters", keywords: "html format escape unescape" },
  { id: "sql-formatter", name: "SQL Formatter", category: "formatters", keywords: "sql format pretty" },
  { id: "text-case", name: "Text Case Converter", category: "text", keywords: "text case camel pascal snake kebab lower upper" },
  { id: "list-tool", name: "List & Lines Tool", category: "text", keywords: "list lines sort reverse deduplicate unique" },
  { id: "slug-gen", name: "URL Slug Generator", category: "text", keywords: "slug url generator seo string text" },
  { id: "base64", name: "Base64 Encoder/Decoder", category: "encoders", keywords: "base64 encode decode" },
  { id: "url-encode", name: "URL Encode/Decode", category: "encoders", keywords: "url encode decode uri" },
  { id: "jwt-decoder", name: "JWT Decoder", category: "encoders", keywords: "jwt token decode header payload" },
  { id: "hash-gen", name: "Hash Generator", category: "encoders", keywords: "hash md5 sha1 sha256 sha512" },
  { id: "password-gen", name: "Password Generator", category: "encoders", keywords: "password generator random secure string" },
  { id: "subnet-calc", name: "Subnet Calculator", category: "network", keywords: "subnet ip cidr network broadcast mask" },
  { id: "ip-converter", name: "IP Converter", category: "network", keywords: "ip convert decimal hex binary ipv6" },
  { id: "port-ref", name: "Port Reference", category: "network", keywords: "port reference list tcp udp" },
  { id: "tcp-scanner", name: "TCP Port Scanner", category: "network", keywords: "tcp port scanner check open" },
  { id: "tls-inspector", name: "TLS Inspector", category: "network", keywords: "tls ssl certificate inspect expiry days" },
  { id: "mac-formatter", name: "MAC Formatter", category: "network", keywords: "mac address format cisco dash colon bare" },
  { id: "cron-parser", name: "Cron Parser", category: "cron", keywords: "cron schedule parse expression time" },
  { id: "timestamp", name: "Unix Timestamp", category: "converters", keywords: "unix timestamp date convert time" },
  { id: "number-base", name: "Number Base Converter", category: "converters", keywords: "number base hex decimal binary octal" },
  { id: "color", name: "Color Converter", category: "converters", keywords: "color hex rgb hsl convert" },
  { id: "byte-converter", name: "Byte Converter", category: "converters", keywords: "byte megabyte gigabyte convert size" },
  { id: "shell-escape", name: "Shell Escape Studio", category: "terminal", keywords: "shell escape bash powershell cmd string" },
];

const JsonFormatter: React.FC = () => {
  const [input, setInput] = useState('{\n  "name": "netrix",\n  "version": 1,\n  "features": ["ssh","snippets"]\n}');
  const [output, setOutput] = useState("");
  const [indent, setIndent] = useState(2);

  const prettify = () => {
    try { setOutput(formatJson(input, indent === 1 ? "\t" : " ".repeat(indent))); } catch (error) { setOutput(error instanceof Error ? error.message : "Invalid JSON"); }
  };
  const compact = () => {
    try { setOutput(formatJson(input, null)); } catch (error) { setOutput(error instanceof Error ? error.message : "Invalid JSON"); }
  };
  const validate = () => {
    try { JSON.parse(input); setOutput("✓ Valid JSON"); } catch (e: any) { setOutput(`⚠ ${e.message}`); }
  };

  return (
    <ToolCard
      title="JSON Formatter"
      icon={<LuBraces className="text-primary" size={18} />}
      actions={
        <>
          <select
            value={indent}
            onChange={(e) => setIndent(Number(e.target.value))}
            className="text-xs bg-black/40 border border-white/10 rounded-control px-2 py-1 text-gray-300 outline-none"
          >
            <option value={2}>2 spaces</option>
            <option value={4}>4 spaces</option>
            <option value={1}>Tab</option>
          </select>
          <button onClick={prettify} className="text-xs px-3 py-1.5 rounded-control bg-primary/15 text-primary hover:bg-primary/25 transition font-medium">Pretty</button>
          <button onClick={compact} className="text-xs px-3 py-1.5 rounded-control bg-white/10 text-gray-200 hover:bg-white/15 transition font-medium">Compact</button>
          <button onClick={validate} className="text-xs px-3 py-1.5 rounded-control bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 transition font-medium">Validate</button>
        </>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Input</div><CodeArea value={input} onChange={setInput} rows={12} /></div>
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-between">Output <CopyBtn text={output} /></div><CodeArea value={output} readOnly borderColor="border-primary/20" rows={12} /></div>
      </div>
    </ToolCard>
  );
};

const XmlFormatter: React.FC = () => {
  const [input, setInput] = useState('<root><server name="gw1"><ip>10.0.0.1</ip><port>22</port></server></root>');
  const [output, setOutput] = useState("");

  const prettify = () => {
    try {
      let depth = 0;
      const lines: string[] = [];
      const xml = input.replace(/>\s*</g, "><").trim();
      const tokens = xml.match(/<[^>]+>|[^<]+/g) || [];
      for (const token of tokens) {
        if (token.startsWith("</")) {
          depth--;
          lines.push("  ".repeat(Math.max(0, depth)) + token);
        } else if (token.startsWith("<") && token.endsWith("/>")) {
          lines.push("  ".repeat(depth) + token);
        } else if (token.startsWith("<")) {
          lines.push("  ".repeat(depth) + token);
          if (!token.startsWith("<?") && !token.startsWith("<!")) depth++;
        } else {
          const t = token.trim();
          if (t) {
            if (lines.length > 0) {
              lines[lines.length - 1] += t;
              depth--;
            } else {
              lines.push(t);
            }
          }
        }
      }
      setOutput(lines.join("\n"));
    } catch {
      setOutput("⚠ Could not format XML");
    }
  };

  const compact = () => {
    setOutput(input.replace(/>\s+</g, "><").replace(/\n\s*/g, "").trim());
  };

  return (
    <ToolCard
      title="XML Formatter"
      icon={<LuFileCode className="text-orange-300" size={18} />}
      actions={
        <>
          <button onClick={prettify} className="text-xs px-3 py-1.5 rounded-control bg-orange-500/15 text-orange-200 hover:bg-orange-500/25 transition font-medium">Pretty</button>
          <button onClick={compact} className="text-xs px-3 py-1.5 rounded-control bg-white/10 text-gray-200 hover:bg-white/15 transition font-medium">Compact</button>
        </>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Input</div><CodeArea value={input} onChange={setInput} rows={10} /></div>
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-between">Output <CopyBtn text={output} /></div><CodeArea value={output} readOnly borderColor="border-orange-400/20" rows={10} /></div>
      </div>
    </ToolCard>
  );
};

const HtmlFormatter: React.FC = () => {
  const [input, setInput] = useState('<div class="container"><h1>Hello</h1><p>World</p><ul><li>A</li><li>B</li></ul></div>');
  const [output, setOutput] = useState("");

  const prettify = () => {
    try {
      let depth = 0;
      const lines: string[] = [];
      const html = input.replace(/>\s*</g, "><").trim();
      const tokens = html.match(/<[^>]+>|[^<]+/g) || [];
      const inline = new Set(["br", "hr", "img", "input", "meta", "link"]);
      for (const token of tokens) {
        if (token.startsWith("</")) {
          depth--;
          lines.push("  ".repeat(Math.max(0, depth)) + token);
        } else if (token.startsWith("<")) {
          const tagMatch = token.match(/^<(\w+)/);
          const tagName = tagMatch ? tagMatch[1].toLowerCase() : "";
          lines.push("  ".repeat(depth) + token);
          if (!token.endsWith("/>") && !inline.has(tagName) && !token.startsWith("<!") && !token.startsWith("<?")) {
            depth++;
          }
        } else {
          const t = token.trim();
          if (t) {
            if (lines.length > 0) {
              lines[lines.length - 1] += t;
              depth--;
            } else {
              lines.push(t);
            }
          }
        }
      }
      setOutput(lines.join("\n"));
    } catch {
      setOutput("⚠ Could not format HTML");
    }
  };

  const doEscape = () => {
    setOutput(input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"));
  };
  const doUnescape = () => {
    setOutput(input.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'"));
  };

  return (
    <ToolCard
      title="HTML Formatter"
      icon={<LuCode className="text-rose-300" size={18} />}
      actions={
        <>
          <button onClick={prettify} className="text-xs px-3 py-1.5 rounded-control bg-rose-500/15 text-rose-200 hover:bg-rose-500/25 transition font-medium">Pretty</button>
          <button onClick={doEscape} className="text-xs px-3 py-1.5 rounded-control bg-white/10 text-gray-200 hover:bg-white/15 transition font-medium">Escape</button>
          <button onClick={doUnescape} className="text-xs px-3 py-1.5 rounded-control bg-white/10 text-gray-200 hover:bg-white/15 transition font-medium">Unescape</button>
        </>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Input</div><CodeArea value={input} onChange={setInput} rows={10} /></div>
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-between">Output <CopyBtn text={output} /></div><CodeArea value={output} readOnly borderColor="border-rose-400/20" rows={10} /></div>
      </div>
    </ToolCard>
  );
};

const SqlFormatter: React.FC = () => {
  const [input, setInput] = useState("SELECT u.id, u.name, h.ip FROM users u JOIN hosts h ON u.id = h.user_id WHERE h.port = 22 ORDER BY u.name;");
  const [output, setOutput] = useState("");

  const prettify = () => {
    try { setOutput(formatSql(input)); }
    catch (error) { setOutput(`Could not format SQL: ${error instanceof Error ? error.message : "Unsupported input"}`); }
  };

  return (
    <ToolCard
      title="SQL Formatter"
      icon={<LuServer className="text-violet-300" size={18} />}
      actions={
        <button onClick={prettify} className="text-xs px-3 py-1.5 rounded-control bg-violet-500/15 text-violet-200 hover:bg-violet-500/25 transition font-medium">Format</button>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Input</div><CodeArea value={input} onChange={setInput} rows={8} /></div>
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-between">Output <CopyBtn text={output} /></div><CodeArea value={output} readOnly borderColor="border-violet-400/20" rows={8} /></div>
      </div>
    </ToolCard>
  );
};

const FormattersPage: React.FC = () => (
  <div className="space-y-6">
    <JsonFormatter />
    <XmlFormatter />
    <HtmlFormatter />
    <SqlFormatter />
  </div>
);

/* ═══════════════════════════════════════════════════════
   PAGE: TEXT TOOLS
   ═══════════════════════════════════════════════════════ */

const TextCaseTool: React.FC = () => {
  const [input, setInput] = useState("hello world from netrix");
  const [output, setOutput] = useState("");
  const [format, setFormat] = useState("camel");

  useEffect(() => {
    let result = input;
    switch (format) {
      case "lower": result = input.toLowerCase(); break;
      case "upper": result = input.toUpperCase(); break;
      case "snake": result = input.replace(/\W+/g, " ").split(/ |\B(?=[A-Z])/).map(w => w.toLowerCase()).join('_'); break;
      case "kebab": result = input.replace(/\W+/g, " ").split(/ |\B(?=[A-Z])/).map(w => w.toLowerCase()).join('-'); break;
      case "camel": result = input.replace(/(?:^\w|[A-Z]|\b\w)/g, (w, i) => i === 0 ? w.toLowerCase() : w.toUpperCase()).replace(/\s+/g, ''); break;
      case "pascal": result = input.replace(/(?:^\w|[A-Z]|\b\w)/g, w => w.toUpperCase()).replace(/\s+/g, ''); break;
    }
    setOutput(result);
  }, [input, format]);

  return (
    <ToolCard title="Text Case Converter" icon={<LuFileCode className="text-teal-400" size={18} />}>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div>
          <div className="flex gap-2 items-center mb-1">
            <span className="text-[10px] uppercase tracking-wide text-gray-500">Input</span>
            <select value={format} onChange={(e) => setFormat(e.target.value)} className="bg-black/40 border border-white/10 rounded px-2 py-0.5 text-xs text-gray-300 outline-none">
              <option value="camel">camelCase</option>
              <option value="pascal">PascalCase</option>
              <option value="snake">snake_case</option>
              <option value="kebab">kebab-case</option>
              <option value="upper">UPPERCASE</option>
              <option value="lower">lowercase</option>
            </select>
          </div>
          <CodeArea value={input} onChange={setInput} rows={5} />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-between">Output <CopyBtn text={output} /></div>
          <CodeArea value={output} readOnly borderColor="border-teal-400/20" rows={5} />
        </div>
      </div>
    </ToolCard>
  );
};

const ListTool: React.FC = () => {
  const [input, setInput] = useState("banana\r\napple\r\ncherry\r\napple");
  const [output, setOutput] = useState("");

  const processLines = (action: "sort" | "reverse" | "unique") => {
    let lines = input.split(/\r\n|\r|\n/);
    if (action === "sort") lines.sort();
    if (action === "reverse") lines.reverse();
    if (action === "unique") lines = Array.from(new Set(lines));
    setOutput(lines.join("\n"));
  };

  return (
    <ToolCard
      title="List & Lines Tool"
      icon={<LuFileCode className="text-indigo-400" size={18} />}
      actions={
        <>
          <button onClick={() => processLines("sort")} className="text-xs px-3 py-1.5 rounded-control bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 transition">Sort</button>
          <button onClick={() => processLines("reverse")} className="text-xs px-3 py-1.5 rounded-control bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 transition">Reverse</button>
          <button onClick={() => processLines("unique")} className="text-xs px-3 py-1.5 rounded-control bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 transition">Unique</button>
        </>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Lines Input</div><CodeArea value={input} onChange={setInput} rows={8} /></div>
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-between">Output <CopyBtn text={output} /></div><CodeArea value={output} readOnly borderColor="border-indigo-400/20" rows={8} /></div>
      </div>
    </ToolCard>
  );
};

const SlugTool: React.FC = () => {
  const [input, setInput] = useState("Netrix: The Ultimate SSH & Developer Tool!");
  const output = input.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');

  return (
    <ToolCard title="URL Slug Generator" icon={<LuLink2 className="text-sky-400" size={18} />}>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Input Text</div><CodeArea value={input} onChange={setInput} rows={3} /></div>
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-between">Slug <CopyBtn text={output} /></div><CodeArea value={output} readOnly borderColor="border-sky-400/20" rows={3} /></div>
      </div>
    </ToolCard>
  );
};

const TextToolsPage: React.FC = () => (
  <div className="space-y-6">
    <TextCaseTool />
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <SlugTool />
    </div>
    <ListTool />
  </div>
);

/* ═══════════════════════════════════════════════════════
   PAGE: ENCODERS
   ═══════════════════════════════════════════════════════ */

const PasswordGeneratorTool: React.FC = () => {
  const [length, setLength] = useState(16);
  const [symbols, setSymbols] = useState(true);
  const [output, setOutput] = useState("");

  const generate = () => {
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" + (symbols ? "!@#$%^&*()_+~`|}{[]:;?><,./-=" : "");
    setOutput(secureRandomString(Math.min(Math.max(length, 4), 128), charset));
  };

  useEffect(() => generate(), [length, symbols]);

  return (
    <ToolCard title="Password Generator" icon={<LuShield className="text-fuchsia-400" size={18} />}>
      <div className="flex gap-4 items-center mb-3">
        <label className="flex items-center gap-2 text-sm text-gray-300">
          Length: <input type="number" min={4} max={128} value={length} onChange={(e) => setLength(Number(e.target.value))} className="w-16 bg-black/40 border border-white/10 rounded px-2 py-1 outline-none" />
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={symbols} onChange={(e) => setSymbols(e.target.checked)} className="rounded border-white/10 bg-black/40 text-primary" /> Symbols
        </label>
        <button onClick={generate} className="text-xs px-3 py-1.5 rounded-control bg-fuchsia-500/15 text-fuchsia-200 hover:bg-fuchsia-500/25 transition">Regenerate</button>
      </div>
      <div className="flex items-center gap-2">
         <input readOnly value={output} className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-fuchsia-300 font-mono outline-none" />
         <CopyBtn text={output} />
      </div>
    </ToolCard>
  );
};

const Base64Tool: React.FC = () => {
  const [input, setInput] = useState("netrix: SSH terminal manager");
  const [output, setOutput] = useState("");

  return (
    <ToolCard
      title="Base64"
      icon={<LuHash className="text-amber-300" size={18} />}
      actions={
        <>
          <button onClick={() => { try { setOutput(textToBase64(input)); } catch { setOutput("⚠ Encoding error"); } }} className="text-xs px-3 py-1.5 rounded-control bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 transition font-medium">Encode</button>
          <button onClick={() => { try { setOutput(base64ToText(input)); } catch { setOutput("⚠ Decoding error"); } }} className="text-xs px-3 py-1.5 rounded-control bg-white/10 text-gray-200 hover:bg-white/15 transition font-medium">Decode</button>
        </>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Input</div><CodeArea value={input} onChange={setInput} rows={4} /></div>
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-between">Result <CopyBtn text={output} /></div><CodeArea value={output} readOnly borderColor="border-amber-400/20" rows={4} /></div>
      </div>
    </ToolCard>
  );
};

const UrlEncodeTool: React.FC = () => {
  const [input, setInput] = useState("https://example.com?q=netrix&lang=ru&tag=ssh client");
  const [output, setOutput] = useState("");

  return (
    <ToolCard
      title="URL Encode / Decode"
      icon={<LuLink2 className="text-cyan-300" size={18} />}
      actions={
        <>
          <button onClick={() => setOutput(encodeURIComponent(input))} className="text-xs px-3 py-1.5 rounded-control bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25 transition font-medium">Encode</button>
          <button onClick={() => { try { setOutput(decodeURIComponent(input)); } catch { setOutput("⚠ Decode error"); } }} className="text-xs px-3 py-1.5 rounded-control bg-white/10 text-gray-200 hover:bg-white/15 transition font-medium">Decode</button>
        </>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Input</div><CodeArea value={input} onChange={setInput} rows={3} /></div>
        <div><div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-between">Result <CopyBtn text={output} /></div><CodeArea value={output} readOnly borderColor="border-cyan-400/20" rows={3} /></div>
      </div>
    </ToolCard>
  );
};

const JwtDecoderTool: React.FC = () => {
  const [input, setInput] = useState("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ik5ldHJpeCBVc2VyIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
  const [output, setOutput] = useState("");

  const decode = () => {
    try {
      const parts = input.split(".");
      if (parts.length < 2) { setOutput("⚠ Not a valid JWT (need at least 2 parts)"); return; }
      const header = decodeJwtPart(parts[0]);
      const payload = decodeJwtPart(parts[1]);
      const lines = [
        "── Header ──",
        JSON.stringify(header, null, 2),
        "",
        "── Payload ──",
        JSON.stringify(payload, null, 2),
      ];
      if (payload.iat) lines.push("", `Issued: ${new Date(payload.iat * 1000).toISOString()}`);
      if (payload.exp) {
        const expDate = new Date(payload.exp * 1000);
        lines.push(`Expires: ${expDate.toISOString()} (${expDate < new Date() ? "EXPIRED" : "valid"})`);
      }
      setOutput(lines.join("\n"));
    } catch {
      setOutput("⚠ Failed to decode JWT");
    }
  };

  return (
    <ToolCard
      title="JWT Decoder"
      icon={<LuShield className="text-emerald-300" size={18} />}
      actions={
        <button onClick={decode} className="text-xs px-3 py-1.5 rounded-control bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 transition font-medium">Decode</button>
      }
    >
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">JWT Token</div>
        <CodeArea value={input} onChange={setInput} rows={3} />
        {output && <div className="flex items-start justify-between gap-2"><CodeArea value={output} readOnly borderColor="border-emerald-400/20" rows={10} /><CopyBtn text={output} /></div>}
      </div>
    </ToolCard>
  );
};

const HashGeneratorTool: React.FC = () => {
  const [input, setInput] = useState("netrix");
  const [hashes, setHashes] = useState<Record<string, string>>({});

  const generate = async () => {
    const enc = new TextEncoder().encode(input);
    const results: Record<string, string> = {};
    for (const algo of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) {
      try {
        const buf = await crypto.subtle.digest(algo, enc);
        results[algo] = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
      } catch {
        results[algo] = "Not supported";
      }
    }
    setHashes(results);
  };

  return (
    <ToolCard
      title="Hash Generator"
      icon={<LuHash className="text-rose-300" size={18} />}
      actions={
        <button onClick={generate} className="text-xs px-3 py-1.5 rounded-control bg-rose-500/15 text-rose-200 hover:bg-rose-500/25 transition font-medium">Generate</button>
      }
    >
      <CodeArea value={input} onChange={setInput} rows={2} />
      {Object.keys(hashes).length > 0 && (
        <div className="mt-3 space-y-2">
          {Object.entries(hashes).map(([algo, hash]) => (
            <div key={algo} className="flex items-center gap-3 bg-black/30 border border-white/5 rounded-control p-2.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500 w-16 shrink-0">{algo}</span>
              <code className="text-xs text-gray-300 font-mono truncate flex-1">{hash}</code>
              <CopyBtn text={hash} />
            </div>
          ))}
        </div>
      )}
    </ToolCard>
  );
};

const EncodersPage: React.FC = () => (
  <div className="space-y-6">
    <PasswordGeneratorTool />
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <Base64Tool />
      <UrlEncodeTool />
    </div>
    <JwtDecoderTool />
    <HashGeneratorTool />
  </div>
);

/* ═══════════════════════════════════════════════════════
   PAGE: NETWORK
   ═══════════════════════════════════════════════════════ */

const SubnetCalculatorTool: React.FC = () => {
  const [cidr, setCidr] = useState("192.168.1.0/24");
  const [result, setResult] = useState<Record<string, string>>({});

  const calc = () => {
    const m = cidr.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (!m) { setResult({ Error: "Enter valid CIDR, e.g. 10.0.0.0/24" }); return; }
    const ip = ipToLong(m[1]);
    const prefix = parseInt(m[2]);
    if (ip < 0 || prefix < 0 || prefix > 32) { setResult({ Error: "Invalid IP or prefix" }); return; }
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const network = (ip & mask) >>> 0;
    const broadcast = (network | ~mask) >>> 0;
    const hostCount = prefix >= 31 ? (prefix === 32 ? 1 : 2) : (broadcast - network - 1);
    const firstHost = prefix >= 31 ? network : network + 1;
    const lastHost = prefix >= 31 ? broadcast : broadcast - 1;
    const wildcardMask = (~mask) >>> 0;
    setResult({
      "Network":      longToIp(network),
      "Broadcast":    longToIp(broadcast),
      "Subnet Mask":  longToIp(mask),
      "Wildcard":     longToIp(wildcardMask),
      "First Host":   longToIp(firstHost),
      "Last Host":    longToIp(lastHost),
      "Total Hosts":  hostCount.toLocaleString(),
      "CIDR":         `/${prefix}`,
      "IP Class":     ip < 0x80000000 ? "A" : ip < 0xC0000000 ? "B" : ip < 0xE0000000 ? "C" : ip < 0xF0000000 ? "D" : "E",
      "Private":      ((ip >= ipToLong("10.0.0.0") && ip <= ipToLong("10.255.255.255")) || (ip >= ipToLong("172.16.0.0") && ip <= ipToLong("172.31.255.255")) || (ip >= ipToLong("192.168.0.0") && ip <= ipToLong("192.168.255.255"))) ? "Yes (RFC 1918)" : "No",
    });
  };

  return (
    <ToolCard
      title="Subnet Calculator"
      icon={<LuNetwork className="text-cyan-300" size={18} />}
      actions={
        <button onClick={calc} className="text-xs px-3 py-1.5 rounded-control bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25 transition font-medium">Calculate</button>
      }
    >
      <div className="flex gap-3 mb-3">
        <input
          value={cidr}
          onChange={(e) => setCidr(e.target.value)}
          className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-sm text-white font-mono outline-none focus:border-cyan-400/40"
          placeholder="192.168.1.0/24"
        />
      </div>
      {Object.keys(result).length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {Object.entries(result).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between bg-black/30 border border-white/5 rounded-control p-2.5">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">{k}</span>
              <div className="flex items-center gap-2"><code className="text-xs text-white font-mono">{v}</code><CopyBtn text={v} /></div>
            </div>
          ))}
        </div>
      )}
    </ToolCard>
  );
};

const IpConverterTool: React.FC = () => {
  const [ip, setIp] = useState("192.168.1.1");
  const [result, setResult] = useState<Record<string, string>>({});

  const convert = () => {
    const long = ipToLong(ip);
    if (long < 0) { setResult({ Error: "Invalid IPv4 address" }); return; }
    const parts = ip.split(".").map(Number);
    setResult({
      "Decimal (Long)": long.toString(),
      "Hexadecimal": "0x" + long.toString(16).toUpperCase().padStart(8, "0"),
      "Binary": parts.map(p => p.toString(2).padStart(8, "0")).join("."),
      "Octal": parts.map(p => "0" + p.toString(8)).join("."),
      "Mapped IPv6": `::ffff:${parts[0].toString(16)}${parts[1].toString(16).padStart(2, "0")}:${parts[2].toString(16)}${parts[3].toString(16).padStart(2, "0")}`,
    });
  };

  return (
    <ToolCard
      title="IP Converter"
      icon={<LuGlobe className="text-emerald-300" size={18} />}
      actions={
        <button onClick={convert} className="text-xs px-3 py-1.5 rounded-control bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 transition font-medium">Convert</button>
      }
    >
      <input
        value={ip}
        onChange={(e) => setIp(e.target.value)}
        className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-sm text-white font-mono outline-none focus:border-emerald-400/40 mb-3"
        placeholder="192.168.1.1"
      />
      {Object.keys(result).length > 0 && (
        <div className="space-y-2">
          {Object.entries(result).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between bg-black/30 border border-white/5 rounded-control p-2.5">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">{k}</span>
              <div className="flex items-center gap-2"><code className="text-xs text-white font-mono">{v}</code><CopyBtn text={v} /></div>
            </div>
          ))}
        </div>
      )}
    </ToolCard>
  );
};

const COMMON_PORTS: [number, string, string][] = [
  [20, "FTP Data", "TCP"], [21, "FTP Control", "TCP"], [22, "SSH", "TCP"], [23, "Telnet", "TCP"],
  [25, "SMTP", "TCP"], [53, "DNS", "TCP/UDP"], [67, "DHCP Server", "UDP"], [68, "DHCP Client", "UDP"],
  [69, "TFTP", "UDP"], [80, "HTTP", "TCP"], [110, "POP3", "TCP"], [123, "NTP", "UDP"],
  [143, "IMAP", "TCP"], [161, "SNMP", "UDP"], [162, "SNMP Trap", "UDP"], [179, "BGP", "TCP"],
  [389, "LDAP", "TCP"], [443, "HTTPS", "TCP"], [445, "SMB", "TCP"], [465, "SMTPS", "TCP"],
  [514, "Syslog", "UDP"], [587, "SMTP (Sub)", "TCP"], [636, "LDAPS", "TCP"], [993, "IMAPS", "TCP"],
  [995, "POP3S", "TCP"], [1433, "MSSQL", "TCP"], [1521, "Oracle", "TCP"], [2222, "SSH Alt", "TCP"],
  [3306, "MySQL", "TCP"], [3389, "RDP", "TCP"], [5432, "PostgreSQL", "TCP"], [5900, "VNC", "TCP"],
  [6379, "Redis", "TCP"], [8080, "HTTP Alt", "TCP"], [8443, "HTTPS Alt", "TCP"], [9200, "Elasticsearch", "TCP"],
  [27017, "MongoDB", "TCP"],
];

const PortReferenceTool: React.FC = () => {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    return COMMON_PORTS.filter(([port, name, proto]) =>
      port.toString().includes(q) || name.toLowerCase().includes(q) || proto.toLowerCase().includes(q)
    );
  }, [filter]);

  return (
    <ToolCard title="Port Reference" icon={<LuServer className="text-violet-300" size={18} />}>
      <div className="mb-3 rounded-xl border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-xs text-violet-100/90">
        <span className="font-semibold">What is this:</span> quick reference table of common network ports and services.
        Search by port number, service name, or protocol (example: <span className="font-mono">22</span>, <span className="font-mono">ssh</span>, <span className="font-mono">udp</span>).
      </div>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-sm text-white font-mono outline-none focus:border-violet-400/40 mb-3"
        placeholder="Search ports... (22, SSH, TCP)"
      />
      <div className="max-h-[340px] overflow-auto rounded-xl border border-white/5">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#0d1018] z-10">
            <tr className="text-gray-500 uppercase tracking-wider text-[10px]">
              <th className="text-left p-2.5">Port</th><th className="text-left p-2.5">Service</th><th className="text-left p-2.5">Protocol</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(([port, name, proto]) => (
              <tr key={port} className="border-t border-white/5 hover:bg-white/5 transition">
                <td className="p-2.5 text-primary font-mono font-bold">{port}</td>
                <td className="p-2.5 text-gray-200">{name}</td>
                <td className="p-2.5"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${proto === "TCP" ? "bg-cyan-500/15 text-cyan-300" : proto === "UDP" ? "bg-amber-500/15 text-amber-300" : "bg-violet-500/15 text-violet-300"}`}>{proto}</span></td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={3} className="p-4 text-center text-xs text-gray-500">
                  No matching ports. Try searching by number (e.g. 443) or service name (e.g. dns).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </ToolCard>
  );
};

const PORT_RISK_NOTES: Record<number, { level: "High" | "Medium"; note: string }> = {
  21: { level: "High", note: "FTP is plaintext. Prefer SFTP/FTPS." },
  23: { level: "High", note: "Telnet is plaintext and should be disabled." },
  445: { level: "High", note: "SMB exposure should be tightly restricted." },
  3389: { level: "High", note: "RDP is a frequent brute-force target." },
  5900: { level: "High", note: "VNC should not be public." },
  6379: { level: "High", note: "Redis often leaks data when exposed." },
  9200: { level: "High", note: "Elasticsearch can expose indices/data." },
  27017: { level: "High", note: "MongoDB should be private and authenticated." },
  3306: { level: "Medium", note: "MySQL is typically internal-only." },
  5432: { level: "Medium", note: "PostgreSQL is typically internal-only." },
  1433: { level: "Medium", note: "MSSQL should stay behind restricted access." },
};

type TcpScanOpenPort = {
  port: number;
  latency_ms: number;
  service?: string | null;
};

type TcpScanResult = {
  target: string;
  resolved_ip: string;
  scanned_ports: number;
  duration_ms: number;
  open_ports: TcpScanOpenPort[];
  note: string;
};

const TcpPortScannerTool: React.FC = () => {
  const [target, setTarget] = useState("127.0.0.1");
  const [ports, setPorts] = useState("22,80,443");
  const [timeoutMs, setTimeoutMs] = useState("450");
  const [concurrency, setConcurrency] = useState("128");
  const { result, error, loading, run, reset } = useNetworkTool<TcpScanResult>();
  const scan = () => run("/network-tools/scan/tcp", () => ({
    target: target.trim(), ports: ports.trim(),
    timeout_ms: toolInteger(timeoutMs, 50, 30000, "Timeout"),
    concurrency: toolInteger(concurrency, 1, 256, "Concurrency"),
  }));

  return (
    <ToolCard
      title="TCP Port Scanner"
      icon={<IoWarning className="text-amber-300" size={18} />}
      actions={
        <>
        {loading && <button onClick={reset} className="text-xs text-gray-300">Stop waiting</button>}
        <button
          onClick={scan}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-control bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Scanning..." : "Scan"}
        </button>
        </>
      }
    >
      <div className="mb-3 rounded-xl border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90">
        Authorized testing only. Up to 1024 ports and 60 seconds per scan. Stopping waiting does not guarantee server cancellation.
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1.6fr_120px_120px] gap-3 mb-3">
        <input aria-label="Scan target" value={target} onChange={(e) => { reset(); setTarget(e.target.value); }} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-amber-400/40" placeholder="Target host or IP" />
        <input aria-label="Scan ports" value={ports} onChange={(e) => { reset(); setPorts(e.target.value); }} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-amber-400/40" placeholder="22,80,443,8000-8100" />
        <input aria-label="Scan timeout in milliseconds" type="number" min={50} max={30000} step={1} value={timeoutMs} onChange={(e) => { reset(); setTimeoutMs(e.target.value); }} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-amber-400/40" placeholder="Timeout ms" />
        <input aria-label="Scan concurrency" type="number" min={1} max={256} step={1} value={concurrency} onChange={(e) => { reset(); setConcurrency(e.target.value); }} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-amber-400/40" placeholder="Concurrency" />
      </div>

      {error && <div role="alert" className="text-sm text-rose-300 mb-2">{error}</div>}
      {result && (
        <div className="space-y-2">
          <div className="text-xs text-gray-300">
            Target: <span className="font-mono text-white">{result.target}</span>
            {"  "}({result.resolved_ip}){"  "}|
            {"  "}Scanned: <span className="font-mono">{result.scanned_ports}</span>
            {"  "}|
            {"  "}Open: <span className="font-mono text-amber-300">{result.open_ports.length}</span>
            {"  "}|
            {"  "}Duration: <span className="font-mono">{result.duration_ms}ms</span>
          </div>
          {result.open_ports.length === 0 ? (
            <div className="text-xs text-emerald-300">No open TCP ports found in selected range.</div>
          ) : (
            <div className="space-y-2">
              {result.open_ports.map((portInfo) => {
                const ref = COMMON_PORTS.find(([port]) => port === portInfo.port);
                const risk = PORT_RISK_NOTES[portInfo.port];
                const level = risk?.level ?? (portInfo.port < 1024 ? "Medium" : "Low");
                const note = risk?.note ?? (portInfo.port < 1024 ? "System port - verify expected exposure." : "Validate if external exposure is intended.");
                return (
                  <div key={portInfo.port} className="rounded-control border border-white/5 bg-black/30 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs text-white">
                        <span className="font-mono text-primary font-bold">{portInfo.port}</span>
                        {"  "}
                        <span className="text-gray-300">{portInfo.service || ref?.[1] || "Unknown service"}</span>
                        {"  "}
                        <span className="text-gray-500">({ref?.[2] || "TCP"})</span>
                        {"  "}
                        <span className="text-gray-500">latency ~{portInfo.latency_ms}ms</span>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        level === "High"
                          ? "bg-rose-500/15 text-rose-300"
                          : level === "Medium"
                            ? "bg-amber-500/15 text-amber-300"
                            : "bg-emerald-500/15 text-emerald-300"
                      }`}>
                        {level}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-400 mt-1">{note}</div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="text-[11px] text-gray-500">{result.note}</div>
          <div className="text-[11px] text-gray-500">TCP connection checks only. Service names and exposure notes are hints based on port numbers.</div>
        </div>
      )}
    </ToolCard>
  );
};

type TlsInspectResult = {
  target: string;
  port: number;
  resolved_ip: string;
  server_name: string;
  tls_version: string;
  cipher: string;
  subject: string;
  issuer: string;
  not_before: string;
  not_after: string;
  days_remaining: number;
  san: string[];
};

const TlsInspectorTool: React.FC = () => {
  const [target, setTarget] = useState("example.com");
  const [port, setPort] = useState("443");
  const [serverName, setServerName] = useState("");
  const { result, error, loading, run, reset } = useNetworkTool<TlsInspectResult>();
  const inspect = () => run("/network-tools/tls/inspect", () => ({
    target: target.trim(), port: toolInteger(port, 1, 65535, "Port"),
    server_name: serverName.trim() || undefined,
  }));

  return (
    <ToolCard
      title="TLS Certificate Inspector"
      icon={<LuShield className="text-cyan-300" size={18} />}
      actions={
        <>
        {loading && <button onClick={reset} className="text-xs text-gray-300">Stop waiting</button>}
        <button
          onClick={inspect}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-control bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Inspecting..." : "Inspect"}
        </button>
        </>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-[1.5fr_120px_1fr] gap-3 mb-3">
        <input aria-label="TLS target" value={target} onChange={(e) => { reset(); setTarget(e.target.value); }} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-cyan-400/40" placeholder="example.com" />
        <input aria-label="TLS port" type="number" min={1} max={65535} step={1} value={port} onChange={(e) => { reset(); setPort(e.target.value); }} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-cyan-400/40" placeholder="443" />
        <input aria-label="TLS verified server name" value={serverName} onChange={(e) => { reset(); setServerName(e.target.value); }} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-cyan-400/40" placeholder="SNI override (optional)" />
      </div>

      <p className="mb-3 text-xs text-gray-400">Validates certificate chain and server name against public CA roots. Self-signed, expired or mismatched certificates return an error.</p>
      {error && <div role="alert" className="text-sm text-rose-300 mb-2">{error}</div>}
      {result && (
        <div className="space-y-2">
          <div className="text-xs text-gray-300">Target: {result.target}:{result.port} ({result.resolved_ip}) — verified name: {result.server_name}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="rounded-control border border-white/5 bg-black/30 px-3 py-2 text-xs text-gray-300">TLS: <span className="font-mono text-white">{result.tls_version}</span></div>
            <div className="rounded-control border border-white/5 bg-black/30 px-3 py-2 text-xs text-gray-300">Cipher: <span className="font-mono text-white">{result.cipher}</span></div>
            <div className="rounded-control border border-white/5 bg-black/30 px-3 py-2 text-xs text-gray-300">Subject: <span className="font-mono text-white break-all">{result.subject || "n/a"}</span></div>
            <div className="rounded-control border border-white/5 bg-black/30 px-3 py-2 text-xs text-gray-300">Issuer: <span className="font-mono text-white break-all">{result.issuer || "n/a"}</span></div>
          </div>
          <div className="rounded-control border border-white/5 bg-black/30 px-3 py-2 text-xs text-gray-300">
            Validity: <span className="font-mono text-white">{result.not_before}</span> → <span className="font-mono text-white">{result.not_after}</span>
            {"  "}|
            {"  "}Days left:
            <span className={`font-mono ml-1 ${result.days_remaining < 0 ? "text-rose-300" : result.days_remaining < 30 ? "text-amber-300" : "text-emerald-300"}`}>
              {result.days_remaining}
            </span>
          </div>
          {result.san.length > 0 && (
            <div className="rounded-control border border-white/5 bg-black/30 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">SAN</div>
              <div className="flex flex-wrap gap-1.5">
                {result.san.slice(0, 40).map((name) => (
                  <span key={name} className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[11px] text-gray-200 font-mono">{name}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </ToolCard>
  );
};

const MacFormatterTool: React.FC = () => {
  const [input, setInput] = useState("AA:BB:CC:DD:EE:FF");
  const [style, setStyle] = useState("colon");
  const [output, setOutput] = useState("");

  useEffect(() => {
    const clean = input.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
    if (clean.length !== 12) {
      setOutput("Invalid MAC length");
      return;
    }
    let res = clean;
    if (style === "dash") res = clean.match(/.{1,2}/g)?.join('-') || clean;
    if (style === "cisco") res = clean.match(/.{1,4}/g)?.join('.') || clean;
    if (style === "bare") res = clean.toLowerCase();
    if (style === "colon") res = clean.match(/.{1,2}/g)?.join(':') || clean;
    setOutput(res);
  }, [input, style]);

  return (
    <ToolCard title="MAC Formatter" icon={<LuNetwork className="text-orange-400" size={18} />}>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mb-2">
        <div>
          <div className="flex gap-2 items-center mb-1">
            <span className="text-[10px] uppercase tracking-wide text-gray-500">Input</span>
            <select value={style} onChange={(e) => setStyle(e.target.value)} className="bg-black/40 border border-white/10 rounded px-2 py-0.5 text-xs text-gray-300 outline-none">
              <option value="colon">Colon (AA:BB)</option>
              <option value="dash">Dash (AA-BB)</option>
              <option value="cisco">Cisco (AABB.CCDD)</option>
              <option value="bare">Bare (aabbcc)</option>
            </select>
          </div>
          <input value={input} onChange={(e) => setInput(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-orange-400/40" />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-between">Output <CopyBtn text={output} /></div>
          <input value={output} readOnly className="w-full bg-black/40 border border-orange-400/20 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none" />
        </div>
      </div>
    </ToolCard>
  );
};

const NetworkPage: React.FC = () => (
  <div className="space-y-6">
    <TcpPortScannerTool />
    <TlsInspectorTool />
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <SubnetCalculatorTool />
      <div className="space-y-6">
        <IpConverterTool />
        <MacFormatterTool />
      </div>
    </div>
    <PortReferenceTool />
  </div>
);

/* ═══════════════════════════════════════════════════════
   PAGE: CRON
   ═══════════════════════════════════════════════════════ */

const pad = (n: number) => n.toString().padStart(2, "0");
const fieldNames = ["minute", "hour", "day of month", "month", "day of week"];
const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const dowNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const describeField = (field: string, name: string, names?: string[]) => {
  if (field === "*" || field === "?") return `${name}: any`;
  return `${name}: ${field.split(",").map(p => {
    if (p.includes("/")) { const [r, s] = p.split("/"); return r === "*" ? `every ${s}` : `${r} / ${s}`; }
    if (p.includes("-")) return p;
    const n = parseInt(p, 10);
    if (names && !isNaN(n)) return names[n - (name === "day of week" ? 0 : 1)] || p;
    return p;
  }).join(", ")}`;
};

const PRESETS = [
  { label: "Every minute", cron: "* * * * *" },
  { label: "Every 5 min", cron: "*/5 * * * *" },
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily midnight", cron: "0 0 * * *" },
  { label: "Daily 3 AM", cron: "0 3 * * *" },
  { label: "Weekly Sun", cron: "0 0 * * 0" },
  { label: "Monthly 1st", cron: "0 0 1 * *" },
];

const CronPage: React.FC = () => {
  const [cron, setCron] = useState("*/5 * * * *");

  const cronResult = useMemo(() => {
    const parsed = parseCron(cron);
    const parts = cron.split(/\s+/);
    const desc = fieldNames.map((n, i) => describeField(parts[i] || "*", n, i === 3 ? monthNames : i === 4 ? dowNames : undefined)).join("  •  ");
    if (parsed.error) return { description: desc, times: [] as string[], error: parsed.error };
    let cursor = new Date(); cursor.setSeconds(0, 0); cursor = new Date(cursor.getTime() + 60000);
    const times: string[] = [];
    for (let i = 0; i < 6000 && times.length < 8; i++) {
      if (cronMatches(cursor, parsed)) {
        times.push(`${cursor.getFullYear()}-${pad(cursor.getMonth()+1)}-${pad(cursor.getDate())} ${pad(cursor.getHours())}:${pad(cursor.getMinutes())}`);
      }
      cursor = new Date(cursor.getTime() + 60000);
    }
    return { description: desc, times, error: times.length === 0 ? "No matching times in ~100 hours" : undefined };
  }, [cron]);

  return (
    <div className="space-y-6">
      <ToolCard
        title="Cron Expression Helper"
        icon={<LuCalendarClock className="text-cyan-300" size={18} />}
        actions={
          <button onClick={() => setCron("*/5 * * * *")} className="text-xs px-3 py-1.5 rounded-control border border-white/10 text-gray-400 hover:text-white hover:border-primary/40 hover:bg-primary/10 transition">Reset</button>
        }
      >
        <div className="bg-black/40 border border-white/10 rounded-xl p-3 flex items-center gap-3 mb-4">
          <LuCode className="text-primary shrink-0" />
          <input value={cron} onChange={(e) => setCron(e.target.value)} className="flex-1 bg-transparent outline-none text-white font-mono text-sm placeholder-gray-600" placeholder="*/5 * * * *" />
          <CopyBtn text={cron} />
        </div>

        {/* Field labels */}
        <div className="grid grid-cols-5 gap-2 mb-4 text-center">
          {fieldNames.map((n, i) => {
            const val = cron.split(/\s+/)[i] || "*";
            return (
              <div key={n} className="bg-black/30 border border-white/5 rounded-xl p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{n}</div>
                <div className="text-sm font-mono text-primary font-bold">{val}</div>
              </div>
            );
          })}
        </div>

        {/* Description */}
        <div className="flex items-start gap-2 mb-4">
          <IoTime className="text-primary mt-0.5 shrink-0" />
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Description</div>
            <div className="text-sm text-white/90 leading-relaxed">{cronResult.description}</div>
          </div>
        </div>

        {/* Next runs */}
        <div className="flex items-start gap-2">
          {cronResult.error ? <IoWarning className="text-amber-400 mt-0.5 shrink-0" /> : <IoTime className="text-emerald-400 mt-0.5 shrink-0" />}
          <div className="flex-1">
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Next runs — local time, next 100 hours</div>
            {cronResult.error ? (
              <div className="text-amber-300 text-sm mt-1">{cronResult.error}</div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1">
                {cronResult.times.map(t => (
                  <div key={t} className="px-3 py-2 rounded-control bg-white/5 border border-white/10 font-mono text-xs text-white flex items-center justify-between">
                    <span>{t}</span><CopyBtn text={t} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </ToolCard>

      {/* Presets & Cheatsheet */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <ToolCard title="Quick Presets" icon={<LuSparkles className="text-amber-300" size={18} />}>
          <div className="grid grid-cols-2 gap-2">
            {PRESETS.map(p => (
              <button key={p.cron} onClick={() => setCron(p.cron)} className={`text-left px-3 py-2.5 rounded-xl border transition ${cron === p.cron ? "border-primary/40 bg-primary/10 text-white" : "border-white/5 bg-white/[0.02] text-gray-400 hover:bg-white/5 hover:text-white"}`}>
                <div className="text-xs font-medium">{p.label}</div>
                <div className="text-[10px] font-mono text-gray-500 mt-0.5">{p.cron}</div>
              </button>
            ))}
          </div>
        </ToolCard>
        <ToolCard title="Syntax Reference" icon={<IoRefresh className="text-primary" size={18} />}>
          <div className="space-y-2">
            {[
              ["*", "Any value"],
              ["*/n", "Every n units"],
              ["a-b", "Range from a to b"],
              ["a,b,c", "Specific values"],
              ["a-b/n", "Range with step"],
            ].map(([sym, desc]) => (
              <div key={sym} className="flex items-center gap-3 px-3 py-2 rounded-control bg-black/30 border border-white/5">
                <code className="text-primary font-mono text-sm font-bold w-16">{sym}</code>
                <span className="text-xs text-gray-300">{desc}</span>
              </div>
            ))}
            <div className="mt-3 text-[10px] text-gray-500 leading-relaxed">
              Fields: minute (0-59) • hour (0-23) • day of month (1-31) • month (1-12) • day of week (0-6, 0=Sun)
            </div>
          </div>
        </ToolCard>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════
   PAGE: CONVERTERS
   ═══════════════════════════════════════════════════════ */

const UnixTimestampTool: React.FC = () => {
  const [ts, setTs] = useState(Math.floor(Date.now() / 1000).toString());
  const [dateStr, setDateStr] = useState("");
  const [result, setResult] = useState("");

  const tsToDate = () => {
    const n = Number(ts);
    if (isNaN(n)) { setResult("⚠ Invalid timestamp"); return; }
    const d = n > 1e12 ? new Date(n) : new Date(n * 1000);
    setResult([
      `UTC:   ${d.toUTCString()}`,
      `Local: ${d.toLocaleString()}`,
      `ISO:   ${d.toISOString()}`,
      `Unix:  ${Math.floor(d.getTime() / 1000)}`,
      `ms:    ${d.getTime()}`,
    ].join("\n"));
  };

  const dateToTs = () => {
    const d = new Date(dateStr || new Date().toISOString());
    if (isNaN(d.getTime())) { setResult("⚠ Invalid date string"); return; }
    setResult([
      `Unix (s):  ${Math.floor(d.getTime() / 1000)}`,
      `Unix (ms): ${d.getTime()}`,
      `ISO:       ${d.toISOString()}`,
    ].join("\n"));
  };

  const now = () => {
    const n = Math.floor(Date.now() / 1000);
    setTs(n.toString());
    const d = new Date();
    setResult(`Now: ${n}\n${d.toISOString()}\n${d.toLocaleString()}`);
  };

  return (
    <ToolCard
      title="Unix Timestamp"
      icon={<LuTimer className="text-cyan-300" size={18} />}
      actions={
        <button onClick={now} className="text-xs px-3 py-1.5 rounded-control bg-primary/15 text-primary hover:bg-primary/25 transition font-medium">Now</button>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Timestamp → Date</div>
          <div className="flex gap-2">
            <input value={ts} onChange={(e) => setTs(e.target.value)} className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-cyan-400/40" placeholder="1700000000" />
            <button onClick={tsToDate} className="text-xs px-3 rounded-control bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25 transition shrink-0"><IoSwapHorizontal size={16} /></button>
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Date → Timestamp</div>
          <div className="flex gap-2">
            <input value={dateStr} onChange={(e) => setDateStr(e.target.value)} className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-cyan-400/40" placeholder="2026-01-15T12:00:00Z" />
            <button onClick={dateToTs} className="text-xs px-3 rounded-control bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25 transition shrink-0"><IoSwapHorizontal size={16} /></button>
          </div>
        </div>
      </div>
      {result && <div className="flex items-start justify-between gap-2"><CodeArea value={result} readOnly borderColor="border-cyan-400/20" rows={4} /><CopyBtn text={result} /></div>}
    </ToolCard>
  );
};

const NumberBaseTool: React.FC = () => {
  const [input, setInput] = useState("255");
  const [base, setBase] = useState<number>(10);
  const [result, setResult] = useState<Record<string, string>>({});

  const convert = () => {
    const value = input.trim();
    const patterns: Record<number, RegExp> = {
      2: /^[+-]?[01]+$/,
      8: /^[+-]?[0-7]+$/,
      10: /^[+-]?\d+$/,
      16: /^[+-]?[0-9a-fA-F]+$/,
    };
    const pattern = patterns[base];
    if (!pattern || !pattern.test(value)) {
      setResult({ Error: "Invalid number for selected base" });
      return;
    }
    const n = parseInt(value, base);
    if (!Number.isFinite(n)) {
      setResult({ Error: "Could not parse number" });
      return;
    }
    setResult({
      "Decimal (10)": n.toString(10),
      "Binary (2)": n.toString(2),
      "Octal (8)": "0o" + n.toString(8),
      "Hex (16)": "0x" + n.toString(16).toUpperCase(),
      "Base36": n.toString(36),
    });
  };

  return (
    <ToolCard
      title="Number Base Converter"
      icon={<LuBinary className="text-emerald-300" size={18} />}
      actions={
        <button onClick={convert} className="text-xs px-3 py-1.5 rounded-control bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 transition font-medium">Convert</button>
      }
    >
      <div className="flex gap-3 mb-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-sm text-white font-mono outline-none focus:border-emerald-400/40" placeholder="255" />
        <select value={base} onChange={(e) => setBase(Number(e.target.value))} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-gray-300 outline-none">
          <option value={2}>Binary (2)</option>
          <option value={8}>Octal (8)</option>
          <option value={10}>Decimal (10)</option>
          <option value={16}>Hex (16)</option>
        </select>
      </div>
      {Object.keys(result).length > 0 && (
        <div className="space-y-2">
          {Object.entries(result).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between bg-black/30 border border-white/5 rounded-control p-2.5">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">{k}</span>
              <div className="flex items-center gap-2"><code className="text-xs text-white font-mono">{v}</code><CopyBtn text={v} /></div>
            </div>
          ))}
        </div>
      )}
    </ToolCard>
  );
};

const ColorConverterTool: React.FC = () => {
  const [hex, setHex] = useState("#4F46E5");
  const result = useMemo(() => {
    const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
    if (!m) return null;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    const r1 = r / 255, g1 = g / 255, b1 = b / 255;
    const max = Math.max(r1, g1, b1), min = Math.min(r1, g1, b1);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r1) h = ((g1 - b1) / d + (g1 < b1 ? 6 : 0)) / 6;
      else if (max === g1) h = ((b1 - r1) / d + 2) / 6;
      else h = ((r1 - g1) / d + 4) / 6;
    }
    return {
      HEX: `#${m[1].toUpperCase()}`,
      RGB: `rgb(${r}, ${g}, ${b})`,
      HSL: `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`,
      "CSS var": `--color: ${r} ${g} ${b};`,
    };
  }, [hex]);

  return (
    <ToolCard title="Color Converter" icon={<LuPalette className="text-rose-300" size={18} />}>
      <div className="flex items-center gap-3 mb-3">
        <input type="color" value={hex.startsWith("#") ? hex : `#${hex}`} onChange={(e) => setHex(e.target.value)} className="w-10 h-10 rounded-control border border-white/10 cursor-pointer bg-transparent" />
        <input value={hex} onChange={(e) => setHex(e.target.value)} className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-sm text-white font-mono outline-none focus:border-rose-400/40" placeholder="#4F46E5" />
        <div className="w-20 h-10 rounded-xl border border-white/10" style={{ backgroundColor: hex.startsWith("#") ? hex : `#${hex}` }} />
      </div>
      {result && (
        <div className="space-y-2">
          {Object.entries(result).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between bg-black/30 border border-white/5 rounded-control p-2.5">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">{k}</span>
              <div className="flex items-center gap-2"><code className="text-xs text-white font-mono">{v}</code><CopyBtn text={v} /></div>
            </div>
          ))}
        </div>
      )}
    </ToolCard>
  );
};

const ByteConverterTool: React.FC = () => {
  const [value, setValue] = useState("1024");
  const [unit, setUnit] = useState("MB");
  const result = useMemo(() => {
    const n = parseFloat(value);
    if (isNaN(n)) return null;
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const idx = units.indexOf(unit);
    if (idx < 0) return null;
    const bytes = n * Math.pow(1024, idx);
    const r: Record<string, string> = {};
    for (const u of units) {
      const ui = units.indexOf(u);
      const val = bytes / Math.pow(1024, ui);
      r[u] = val >= 1 ? val.toLocaleString(undefined, { maximumFractionDigits: 4 }) : val.toExponential(2);
    }
    r["Bits"] = (bytes * 8).toLocaleString();
    return r;
  }, [value, unit]);

  return (
    <ToolCard title="Byte Converter" icon={<LuBinary className="text-amber-300" size={18} />}>
      <div className="flex gap-3 mb-3">
        <input value={value} onChange={(e) => setValue(e.target.value)} className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-2 text-sm text-white font-mono outline-none focus:border-amber-400/40" placeholder="1024" />
        <select value={unit} onChange={(e) => setUnit(e.target.value)} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-gray-300 outline-none">
          {["B", "KB", "MB", "GB", "TB", "PB"].map(u => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
      {result && (
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(result).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between bg-black/30 border border-white/5 rounded-control p-2.5">
              <span className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">{k}</span>
              <div className="flex items-center gap-2"><code className="text-xs text-white font-mono">{v}</code><CopyBtn text={v} /></div>
            </div>
          ))}
        </div>
      )}
    </ToolCard>
  );
};

const ConvertersPage: React.FC = () => (
  <div className="space-y-6">
    <UnixTimestampTool />
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <NumberBaseTool />
      <ColorConverterTool />
    </div>
    <ByteConverterTool />
  </div>
);

/* ═══════════════════════════════════════════════════════
   PAGE: TERMINAL KIT
   ═══════════════════════════════════════════════════════ */

const ShellEscapeStudio: React.FC = () => {
  const [input, setInput] = useState("sudo systemctl restart nginx && tail -f /var/log/nginx/error.log");

  const escaped = useMemo(() => {
    return {
      "POSIX (bash/zsh)":
        escapePosixArg(input),
      "PowerShell":
        escapePowerShellArg(input),
      "Windows CMD":
        escapeCmdArg(input),
      "JSON string":
        JSON.stringify(input),
      ".env safe value":
        quoteIfNeeded(input),
    };
  }, [input]);

  return (
    <ToolCard
      title="Shell Escape Studio"
      icon={<LuCode className="text-cyan-300" size={18} />}
    >
      <div className="mb-3 rounded-xl border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100/90">
        Convert free text into shell-safe arguments for different terminals. Useful when pasting tokens, JSON, paths or commands with spaces/special chars.
      </div>
      <CodeArea value={input} onChange={setInput} rows={4} />
      <div className="space-y-2 mt-3">
        {Object.entries(escaped).map(([name, value]) => (
          <div key={name} className="flex items-center justify-between gap-3 rounded-control border border-white/5 bg-black/30 px-3 py-2">
            <span className="text-[10px] uppercase tracking-wide text-gray-500 w-36 shrink-0">{name}</span>
            <code className="text-xs text-white font-mono break-all">{value}</code>
            <CopyBtn text={value} />
          </div>
        ))}
      </div>
    </ToolCard>
  );
};

const SshCommandBuilderTool: React.FC = () => {
  const [host, setHost] = useState("10.0.0.10");
  const [user, setUser] = useState("admin");
  const [port, setPort] = useState("22");
  const [identityFile, setIdentityFile] = useState("~/.ssh/id_ed25519");
  const [proxyJump, setProxyJump] = useState("");
  const [remoteCommand, setRemoteCommand] = useState("sudo journalctl -u nginx -n 200 --no-pager");
  const [localPath, setLocalPath] = useState("./backup.tar.gz");
  const [remotePath, setRemotePath] = useState("/tmp/backup.tar.gz");

  const commandSet = useMemo(() => {
    const trimmedHost = host.trim();
    if (!trimmedHost) return null;

    const trimmedPort = port.trim();
    const target = `${(user.trim() || "root")}@${trimmedHost}`;
    const targetArg = escapePosixArg(target);
    const sshFlags = joinShellParts(
      trimmedPort && trimmedPort !== "22" ? `-p ${escapePosixArg(trimmedPort)}` : "",
      identityFile.trim() ? `-i ${escapePosixArg(identityFile.trim())}` : "",
      proxyJump.trim() ? `-J ${escapePosixArg(proxyJump.trim())}` : "",
    );

    const sshBase = joinShellParts("ssh", sshFlags, targetArg);
    const sshRun = remoteCommand.trim() ? `${sshBase} ${escapePosixArg(remoteCommand.trim())}` : sshBase;

    const scpFlags = joinShellParts(
      trimmedPort && trimmedPort !== "22" ? `-P ${escapePosixArg(trimmedPort)}` : "",
      identityFile.trim() ? `-i ${escapePosixArg(identityFile.trim())}` : "",
      proxyJump.trim() ? `-o ${escapePosixArg(`ProxyJump=${proxyJump.trim()}`)}` : "",
    );

    const scp = joinShellParts(
      "scp",
      scpFlags,
      escapePosixArg(localPath.trim() || "./file.txt"),
      escapePosixArg(`${target}:${remotePath.trim() || "~/file.txt"}`),
    );
    const rsync = joinShellParts(
      "rsync -avz",
      "-e",
      escapePosixArg(joinShellParts("ssh", sshFlags)),
      escapePosixArg(localPath.trim() || "./dir/"),
      escapePosixArg(`${target}:${remotePath.trim() || "~/dir/"}`),
    );

    const sshConfigLines = [
      "Host netrix-target",
      `  HostName ${trimmedHost}`,
      `  User ${user.trim() || "root"}`,
      trimmedPort ? `  Port ${trimmedPort}` : "",
      identityFile.trim() ? `  IdentityFile ${identityFile.trim()}` : "",
      proxyJump.trim() ? `  ProxyJump ${proxyJump.trim()}` : "",
    ].filter(Boolean).join("\n");

    return {
      "SSH connect": sshBase,
      "SSH run command": sshRun,
      "SCP upload": scp,
      "Rsync sync": rsync,
      "~/.ssh/config block": sshConfigLines,
    };
  }, [host, user, port, identityFile, proxyJump, remoteCommand, localPath, remotePath]);

  return (
    <ToolCard
      title="SSH Command Builder"
      icon={<LuServer className="text-emerald-300" size={18} />}
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mb-3">
        <input value={host} onChange={(e) => setHost(e.target.value)} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-emerald-400/40" placeholder="Host or IP" />
        <input value={user} onChange={(e) => setUser(e.target.value)} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-emerald-400/40" placeholder="User" />
        <input value={port} onChange={(e) => setPort(e.target.value)} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-emerald-400/40" placeholder="Port" />
        <input value={identityFile} onChange={(e) => setIdentityFile(e.target.value)} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-emerald-400/40" placeholder="Identity file" />
        <input value={proxyJump} onChange={(e) => setProxyJump(e.target.value)} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-emerald-400/40 xl:col-span-2" placeholder="ProxyJump (optional): bastion@10.0.0.2" />
        <input value={localPath} onChange={(e) => setLocalPath(e.target.value)} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-emerald-400/40" placeholder="Local path" />
        <input value={remotePath} onChange={(e) => setRemotePath(e.target.value)} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-emerald-400/40" placeholder="Remote path" />
      </div>
      <CodeArea value={remoteCommand} onChange={setRemoteCommand} rows={2} />
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mt-1 mb-3">Remote command (for ssh run command)</div>
      {!commandSet ? (
        <div className="text-sm text-amber-300">Enter host to generate commands.</div>
      ) : (
        <div className="space-y-2">
          {Object.entries(commandSet).map(([name, value]) => (
            <div key={name} className="rounded-xl border border-white/5 bg-black/30 p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-[10px] uppercase tracking-wide text-gray-500">{name}</span>
                <CopyBtn text={value} />
              </div>
              <CodeArea value={value} readOnly rows={name === "~/.ssh/config block" ? 6 : 2} borderColor="border-emerald-400/20" />
            </div>
          ))}
        </div>
      )}
    </ToolCard>
  );
};

const LogCommandBuilderTool: React.FC = () => {
  const [query, setQuery] = useState("error");
  const [path, setPath] = useState("/var/log/syslog");
  const [context, setContext] = useState("2");
  const [ignoreCase, setIgnoreCase] = useState(true);
  const [fixedString, setFixedString] = useState(true);

  const commandSet = useMemo(() => {
    const safeQuery = query.trim() || "error";
    const safePath = path.trim() || "/var/log/syslog";
    const c = Number.isFinite(Number(context)) ? Math.max(0, Math.min(20, Number(context))) : 2;
    const iFlag = ignoreCase ? "-i " : "";
    const fixedRg = fixedString ? "-F " : "";
    const fixedGrep = fixedString ? "-F " : "";
    const escaped = escapePosixArg(safeQuery);
    const safePathQuoted = escapePosixArg(safePath);

    return {
      "ripgrep (fast local search)": joinShellParts("rg -n", iFlag.trim(), fixedRg.trim(), "-C", String(c), "--", escaped, safePathQuoted),
      "grep fallback": joinShellParts("grep -n", iFlag.trim(), fixedGrep.trim(), "-C", String(c), "--", escaped, safePathQuoted),
      "tail live + rg": joinShellParts("tail -f", safePathQuoted, "|", "rg --line-buffered", iFlag.trim(), fixedRg.trim(), "--", escaped),
      "journalctl live + rg": joinShellParts("journalctl -f -n 200", "|", "rg --line-buffered", iFlag.trim(), fixedRg.trim(), "--", escaped),
    };
  }, [query, path, context, ignoreCase, fixedString]);

  return (
    <ToolCard
      title="Log Command Builder"
      icon={<LuFileCode className="text-violet-300" size={18} />}
    >
      <div className="mb-3 rounded-xl border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-xs text-violet-100/90">
        Generate battle-tested one-liners for incident triage. Paste query and path, then copy the exact command you need in terminal.
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr_120px] gap-3 mb-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-violet-400/40" placeholder="Search query" />
        <input value={path} onChange={(e) => setPath(e.target.value)} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-violet-400/40" placeholder="/var/log/syslog" />
        <input value={context} onChange={(e) => setContext(e.target.value)} className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white font-mono outline-none focus:border-violet-400/40" placeholder="Context" />
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <label className="flex items-center gap-2 text-xs text-gray-300">
          <input type="checkbox" checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)} className="rounded border-white/20 bg-black/40" />
          Ignore case
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-300">
          <input type="checkbox" checked={fixedString} onChange={(e) => setFixedString(e.target.checked)} className="rounded border-white/20 bg-black/40" />
          Fixed string (no regex)
        </label>
      </div>
      <div className="space-y-2">
        {Object.entries(commandSet).map(([name, value]) => (
          <div key={name} className="rounded-xl border border-white/5 bg-black/30 p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-wide text-gray-500">{name}</span>
              <CopyBtn text={value} />
            </div>
            <CodeArea value={value} readOnly rows={2} borderColor="border-violet-400/20" />
          </div>
        ))}
      </div>
    </ToolCard>
  );
};

const TerminalKitPage: React.FC = () => (
  <div className="space-y-6">
    <div className="rounded-card border border-primary/20 bg-primary/10 px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-primary/80 font-bold">Power User Notes</div>
      <div className="text-xs text-gray-200 mt-1">
        Use <span className="font-mono">Ctrl/Cmd + K</span> for quick category search and <span className="font-mono">[</span> / <span className="font-mono">]</span> to switch categories without mouse.
      </div>
    </div>
    <DevtoolRunner />
    <ShellEscapeStudio />
    <SshCommandBuilderTool />
    <LogCommandBuilderTool />
  </div>
);

/* ═══════════════════════════════════════════════════════
   MAIN LAYOUT
   ═══════════════════════════════════════════════════════ */

const UtilitiesHub: React.FC = () => {
  const [active, setActive] = useState<UtilCategory>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_ACTIVE_CATEGORY) as UtilCategory | null;
      if (stored && CATEGORIES.some((category) => category.id === stored)) return stored;
    } catch {}
    return "formatters";
  });
  const [categoryFilter, setCategoryFilter] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const registerSearchInput = (node: HTMLInputElement | null) => {
    if (node) searchInputRef.current = node;
  };

  const filteredCategories = useMemo(() => {
    const q = categoryFilter.trim().toLowerCase();
    if (!q) return CATEGORIES;
    return CATEGORIES.filter((c) =>
      `${c.label} ${c.description}`.toLowerCase().includes(q),
    );
  }, [categoryFilter]);

  const cat = CATEGORIES.find(c => c.id === active) ?? CATEGORIES[0];
  const CatIcon = cat.icon;

  useEffect(() => {
    if (contentScrollRef.current) {
      contentScrollRef.current.scrollTo({ top: 0, behavior: "auto" });
    }
    setMobileNavOpen(false);
    try {
      localStorage.setItem(STORAGE_ACTIVE_CATEGORY, active);
    } catch {}
  }, [active]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (window.innerWidth < 1024) setMobileNavOpen(true);
        window.setTimeout(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }, 0);
        return;
      }

      if (event.key === "Escape") {
        setMobileNavOpen(false);
        if (categoryFilter) setCategoryFilter("");
        return;
      }

      if (isTextInputTarget(event.target)) return;
      if (event.key !== "[" && event.key !== "]") return;
      const currentIndex = CATEGORIES.findIndex((category) => category.id === active);
      if (currentIndex < 0) return;
      const delta = event.key === "]" ? 1 : -1;
      const nextIndex = (currentIndex + delta + CATEGORIES.length) % CATEGORIES.length;
      setActive(CATEGORIES[nextIndex].id);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, categoryFilter]);

  const searchedTools = useMemo(() => {
    const q = categoryFilter.trim().toLowerCase();
    if (!q) return [];
    return ALL_TOOLS.filter(t => t.name.toLowerCase().includes(q) || t.keywords.includes(q));
  }, [categoryFilter]);

  const renderPage = () => {
    switch (active) {
      case "formatters": return <FormattersPage />;
      case "text":       return <TextToolsPage />;
      case "encoders":   return <EncodersPage />;
      case "network":    return <NetworkPage />;
      case "cron":       return <CronPage />;
      case "converters": return <ConvertersPage />;
      case "terminal":   return <TerminalKitPage />;
      default:           return <FormattersPage />;
    }
  };

  const renderCategoryButton = (category: typeof CATEGORIES[number]) => {
    const Icon = category.icon;
    const isActive = active === category.id;
    return (
      <button
        key={category.id}
        onClick={() => setActive(category.id)}
        className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-all group ${
          isActive
            ? "bg-primary/10 text-white border border-primary/20 shadow-[0_0_20px_-5px_rgba(var(--color-primary-rgb),0.15)]"
            : "text-gray-500 hover:text-gray-200 hover:bg-white/5 border border-transparent"
        }`}
      >
        <Icon size={18} className={isActive ? "text-primary" : "text-gray-600 group-hover:text-gray-400"} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">{category.label}</div>
          <div className="text-[10px] text-gray-600 truncate">{category.description}</div>
        </div>
        {isActive && <IoChevronForward size={14} className="text-primary/50" />}
      </button>
    );
  };

  return (
    <div className="tools-workspace ui-focus flex h-full min-h-0 w-full overflow-hidden bg-[#0b1118] flex-col lg:flex-row">
      <div className="lg:hidden border-b border-white/5 bg-[#09090f] px-3 py-3">
        <button
          onClick={() => setMobileNavOpen((prev) => !prev)}
          className="w-full flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-left"
        >
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-primary/70 font-bold">Utilities</div>
            <div className="text-sm text-white font-semibold">{cat.label}</div>
          </div>
          <IoChevronForward
            size={16}
            className={`text-primary/70 transition-transform ${mobileNavOpen ? "rotate-90" : ""}`}
          />
        </button>
        {mobileNavOpen && (
          <div className="pt-3 space-y-2">
            <input
              ref={registerSearchInput}
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              placeholder="Find category... (Ctrl/Cmd+K)"
              className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-primary/40"
            />
            <nav className="max-h-[280px] overflow-auto space-y-1 pr-1">
              {filteredCategories.length > 0 ? (
                filteredCategories.map(renderCategoryButton)
              ) : (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3 text-xs text-gray-400 flex items-center justify-between gap-2">
                  <span>No categories matched your query.</span>
                  <button onClick={() => setCategoryFilter("")} className="text-[10px] px-2 py-1 rounded-control border border-white/10 hover:border-primary/40 hover:bg-primary/10 text-gray-300">
                    Clear
                  </button>
                </div>
              )}
            </nav>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div className="hidden lg:flex w-[224px] shrink-0 bg-[#0e1721] border-r border-white/5 flex-col min-h-0">
        <div className="p-5 border-b border-white/5">
          <p className="text-[10px] uppercase tracking-[0.3em] text-primary/70 font-black">Utilities</p>
          <h2 className="text-lg font-bold text-white mt-1">Tool Box</h2>
          <p className="text-[10px] text-gray-500 mt-2">Shortcut: Ctrl/Cmd+K search, [ and ] switch category</p>
        </div>
        <div className="p-3 border-b border-white/5 relative">
          <IoSearchOutline className="absolute left-6 top-1/2 -translate-y-1/2 text-gray-500" size={14} />
          <input
            ref={registerSearchInput}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            placeholder="Search all tools..."
            className="w-full bg-black/40 border border-white/10 rounded-xl pl-9 pr-3 py-2 text-xs text-white outline-none focus:border-primary/40 transition-colors"
          />
        </div>
        <nav className="flex-1 overflow-auto p-3 space-y-1 min-h-0">
          {categoryFilter.trim() !== "" ? (
            searchedTools.length > 0 ? (
              <div className="space-y-1">
                <div className="px-3 py-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider">Search Results</div>
                {searchedTools.map(t => {
                  const catMatch = CATEGORIES.find(c => c.id === t.category);
                  const Icon = catMatch?.icon || LuSparkles;
                  return (
                    <button
                      key={t.id}
                      onClick={() => { setActive(t.category as UtilCategory); setCategoryFilter(""); }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all group hover:bg-primary/10 border border-transparent hover:border-primary/20"
                    >
                      <Icon size={14} className="text-primary/70 group-hover:text-primary" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-gray-300 group-hover:text-white truncate">{t.name}</div>
                        <div className="text-[9px] text-gray-600 truncate">{catMatch?.label}</div>
                      </div>
                      <IoChevronForward size={12} className="text-primary/40" />
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3 text-xs text-gray-400 text-center">
                No tools matched.
              </div>
            )
          ) : (
            filteredCategories.length > 0 ? (
              filteredCategories.map(renderCategoryButton)
            ) : null
          )}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 relative">
        <div ref={contentScrollRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden">
        <div className="p-4 lg:p-5 pb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              <CatIcon size={20} className="text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white">{cat.label}</h1>
              <p className="text-xs text-gray-500">{cat.description}</p>
            </div>
          </div>
          {renderPage()}
        </div>
        </div>
      </div>
    </div>
  );
};

export default UtilitiesHub;
