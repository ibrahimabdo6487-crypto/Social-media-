import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Tajawal", "system-ui", "sans-serif"] },
      colors: {
        ink: { bg: "#0a0e17", card: "#121a2e", line: "#1f2a44" },
      },
    },
  },
  plugins: [],
};
export default config;
