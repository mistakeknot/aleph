import { fileURLToPath } from "node:url";
import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
export default defineWorkspaceTestConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: sharedWorkerProjects({
      name: "bb-plugin-rig-manager",
      pkgDir: fileURLToPath(new URL(".", import.meta.url)),
      include: ["*.test.{ts,tsx}"],
    }),
  },
});
