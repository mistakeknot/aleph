import { fileURLToPath } from "node:url";
import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
export default defineWorkspaceTestConfig({
  test: {
    projects: sharedWorkerProjects({
      name: "@bb/rig",
      pkgDir: fileURLToPath(new URL(".", import.meta.url)),
      include: ["test/**/*.test.ts"],
    }),
  },
});
