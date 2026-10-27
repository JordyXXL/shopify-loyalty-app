/** @type {import('@types/eslint').Linter.BaseConfig} */
module.exports = {
  root: true,
  extends: [
    "@remix-run/eslint-config",
    "@remix-run/eslint-config/node",
    "@remix-run/eslint-config/jest-testing-library",
    "prettier",
  ],
  globals: {
    shopify: "readonly"
  },
  // The tests run on vitest (jest-compatible API); eslint-plugin-jest from the Remix preset needs a version to load its rules.
  settings: {
    jest: { version: 29 },
  },
};
