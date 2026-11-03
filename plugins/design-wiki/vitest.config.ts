import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "bb-plugin-bb--design-wiki",
      include: ["**/*.test.{ts,tsx}"],
    }),
  },
});
