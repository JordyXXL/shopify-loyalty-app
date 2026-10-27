// Tests only (npm test). A separate config so the Remix plugin of vite.config.js is not loaded for them.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
  },
});
