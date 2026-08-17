// Minimal ESLint flat config for Gene Structure Explorer.
// Catches exactly the class of bug that broke the app twice: undeclared
// variables under "use strict", unused leftovers, and accidental globals.
//
// Setup:
//   npm install --save-dev eslint
// Run:
//   npx eslint app.js
export default [
  {
    files: ["app.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script", // matches the plain <script> (not type="module") this file is loaded as
      globals: {
        // Browser globals
        window: "readonly",
        document: "readonly",
        console: "readonly",
        fetch: "readonly",
        localStorage: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        AbortController: "readonly",
        DOMException: "readonly",
        Blob: "readonly",
        URL: "readonly",
        // Third-party libraries loaded via <script> tags
        $3Dmol: "readonly",
        Ideogram: "readonly"
      }
    },
    rules: {
      // This is the rule that would have caught the `currentIdeogram` bug
      // immediately: assigning to a variable that was never declared.
      "no-undef": "error",
      "no-unused-vars": ["warn", { args: "none" }],
      "no-var": "warn",
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"]
    }
  }
];
