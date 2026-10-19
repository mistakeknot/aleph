import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "bb-app",
      include: ["test/**/*.test.{mjs,ts}"],
    }),
  },
});
