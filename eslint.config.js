import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  {
    ignores: [".data/*"],
  },
  js.configs.recommended,
  eslintConfigPrettier,
  {
    files: ["examples/**/*.js"],
    languageOptions: {
      globals: {
        console: "readonly",
        document: "readonly",
        fetch: "readonly",
        navigator: "readonly",
        window: "readonly",
      },
    },
  },
];
