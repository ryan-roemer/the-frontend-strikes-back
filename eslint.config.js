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
        process: "readonly",
        fetch: "readonly",
      },
    },
  },
];
