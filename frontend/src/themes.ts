import { APPEARANCE_COLOR_KEYS, type TerminalAppearance } from "./types/terminalAppearance";

// Shared by the connection screen and the default live terminal surface.
export const DEFAULT_TERMINAL_SURFACE = {
  backgroundColor: "#0b1118",
  backgroundImage: "radial-gradient(ellipse at 80% 28%, #15334133, transparent 55%)",
};

// Professional terminal color themes
export interface TerminalTheme {
  name: string;
  colors: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent?: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

export const terminalThemes: Record<string, TerminalTheme> = {
  default: {
    name: "Default Dark",
    colors: {
      background: DEFAULT_TERMINAL_SURFACE.backgroundColor,
      foreground: "#d1d5db",
      cursor: "#10b981",
      selectionBackground: "rgba(16, 185, 129, 0.3)",
      black: "#0d1117",
      red: "#f85149",
      green: "#56d364",
      yellow: "#e3b341",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#d1d5db",
      brightBlack: "#484f58",
      brightRed: "#ff7b72",
      brightGreen: "#7ee787",
      brightYellow: "#f2cc60",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#ffffff",
    },
  },
  dracula: {
    name: "Dracula",
    colors: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selectionBackground: "rgba(68, 71, 90, 0.5)",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  nord: {
    name: "Nord",
    colors: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      selectionBackground: "rgba(76, 86, 106, 0.5)",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#d08770",
      brightGreen: "#8fbcbb",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  monokai: {
    name: "Monokai Pro",
    colors: {
      background: "#2d2a2e",
      foreground: "#fcfcfa",
      cursor: "#fcfcfa",
      selectionBackground: "rgba(99, 95, 103, 0.5)",
      black: "#403e41",
      red: "#ff6188",
      green: "#a9dc76",
      yellow: "#ffd866",
      blue: "#fc9867",
      magenta: "#ab9df2",
      cyan: "#78dce8",
      white: "#fcfcfa",
      brightBlack: "#727072",
      brightRed: "#ff6188",
      brightGreen: "#a9dc76",
      brightYellow: "#ffd866",
      brightBlue: "#fc9867",
      brightMagenta: "#ab9df2",
      brightCyan: "#78dce8",
      brightWhite: "#ffffff",
    },
  },
  onedark: {
    name: "One Dark Pro",
    colors: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      selectionBackground: "rgba(67, 76, 94, 0.5)",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  solarized: {
    name: "Solarized Dark",
    colors: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#839496",
      selectionBackground: "rgba(7, 54, 66, 0.5)",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  tokyo: {
    name: "Tokyo Night",
    colors: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      selectionBackground: "rgba(40, 47, 68, 0.5)",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  catppuccin: {
    name: "Catppuccin Mocha",
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "rgba(88, 91, 112, 0.5)",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
};

export const normalizeTerminalColor = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) return `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`;
  return null;
};

export const getTerminalTheme = (themeName: string): TerminalTheme =>
  Object.prototype.hasOwnProperty.call(terminalThemes, themeName) ? terminalThemes[themeName] : terminalThemes.default;

export const getTerminalSurface = (themeName: string, backgroundOverride?: string | null) => {
  const theme = getTerminalTheme(themeName);
  const background = normalizeTerminalColor(backgroundOverride);
  return {
    backgroundColor: background || theme.colors.background,
    backgroundImage: !background && theme === terminalThemes.default ? DEFAULT_TERMINAL_SURFACE.backgroundImage : "none",
  };
};

export const getThemeColors = (themeName: string, overrides?: {
  terminal_background?: string | null;
  terminal_foreground?: string | null;
  terminal_appearance?: TerminalAppearance | null;
}) => {
  const theme = getTerminalTheme(themeName);
  const background = normalizeTerminalColor(overrides?.terminal_background);
  const foreground = normalizeTerminalColor(overrides?.terminal_foreground);
  const colors: TerminalTheme["colors"] = {
    ...theme.colors,
    ...(background && { background, cursorAccent: background }),
    ...(foreground && { foreground, cursor: foreground }),
  };
  for (const key of APPEARANCE_COLOR_KEYS) {
    const color = normalizeTerminalColor(overrides?.terminal_appearance?.colors?.[key]);
    if (color) colors[key] = key === "selectionBackground" ? `${color}66` : color;
  }
  return colors;
};

export const getThemesList = (): Array<{ id: string; name: string }> => {
  return Object.entries(terminalThemes).map(([id, theme]) => ({
    id,
    name: theme.name,
  }));
};
