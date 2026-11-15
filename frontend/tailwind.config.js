/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      borderRadius: {
        dialog: "var(--radius-dialog)",
        card: "var(--radius-card)",
        control: "var(--radius-control)",
      },
      colors: {
        primary: {
          DEFAULT: "#0070f3",
          light: "#3291ff",
          dark: "#0048ab",
          50: "#e6f2ff",
          100: "#cce4ff",
          200: "#99c9ff",
          300: "#66adff",
          400: "#3392ff",
          500: "#0070f3",
          600: "#0062d1",
          700: "#0048ab",
          800: "#00357d",
          900: "#00214f",
        },
        secondary: {
          DEFAULT: "#10b981",
          light: "#34d399",
          dark: "#047857",
          50: "#ecfdf5",
          100: "#d1fae5",
          200: "#a7f3d0",
          300: "#6ee7b7",
          400: "#34d399",
          500: "#10b981",
          600: "#059669",
          700: "#047857",
          800: "#065f46",
          900: "#064e3b",
        },
        background: {
          light: "#f8f9fb",
          dark: "#1f2937",
          midnight: "#0d1117",
          darker: "#010409",
        },
        foreground: {
          light: "#1f2937",
          dark: "#f8f9fb",
          muted: "#6b7280",
        },
        success: "#10b981",
        warning: "#f59e0b",
        error: "#ef4444",
      },
      backgroundImage: {
        "gradient-primary": "linear-gradient(135deg, #0070f3 0%, #0048ab 100%)",
        "gradient-secondary":
          "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
        "gradient-success": "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
        "gradient-dark": "linear-gradient(135deg, #1f2937 0%, #0d1117 100%)",
        "gradient-glow":
          "radial-gradient(circle at center, rgba(0, 112, 243, 0.15) 0%, transparent 70%)",
      },
      boxShadow: {
        glow: "0 0 20px rgba(0, 112, 243, 0.3)",
        "glow-lg": "0 0 40px rgba(0, 112, 243, 0.4)",
        "glow-primary": "0 0 20px rgba(0, 112, 243, 0.5)",
        "glow-secondary": "0 0 20px rgba(16, 185, 129, 0.5)",
        "inner-glow": "inset 0 0 20px rgba(0, 112, 243, 0.2)",
        "shadow-pulse": "0 0 12px rgba(16, 185, 129, 0.6)",
      },
      animation: {
        "fade-in": "fadeIn 0.3s ease-out",
        "slide-in-up": "slideInUp 0.4s ease-out",
        "slide-in-right": "slideInRight 0.3s ease-out",
        "pulse-slow": "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "pulse-fast": "pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        glow: "glow 2s ease-in-out infinite",
        "spin-slow": "spin 3s linear infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideInUp: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideInRight: {
          "0%": { opacity: "0", transform: "translateX(-10px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        glow: {
          "0%, 100%": { boxShadow: "0 0 20px rgba(0, 112, 243, 0.3)" },
          "50%": { boxShadow: "0 0 40px rgba(0, 112, 243, 0.5)" },
        },
      },
      backdropBlur: {
        xs: "2px",
      },
    },
  },
  plugins: [],
};
