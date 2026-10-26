import { access } from "node:fs/promises";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { getCurrentBranch, runGit } from "bb-environment-provider-host/git";
import { githubPrStatusHostContract } from "./contract.js";
import {
  getPullRequestForCurrentBranch,
  getPullRequestByUrl,
  runPullRequestActionForCurrentBranch,
} from "./host/git-host.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export default experimental_defineHostEntry({
  contract: githubPrStatusHostContract,
  handlers: {
    async view({ path, url, refresh }) {
      if (!(await pathExists(path))) {
        return {
          outcome: "unavailable" as const,
          message: `Workspace path no longer exists: ${path}`,
        };
      }
      if (url !== null) return getPullRequestByUrl(url, path);
      const localBranch = await getCurrentBranch(path);
      if (!localBranch) return { outcome: "none" as const };
      return getPullRequestForCurrentBranch({
        cwd: path,
        localBranch,
        refresh,
      });
    },
    async upstream({ path }) {
      const [result, branchName] = await Promise.all([
        runGit(["rev-parse", "--verify", "@{u}"], {
          cwd: path,
          allowFailure: true,
        }),
        getCurrentBranch(path),
      ]);
      return {
        oid: result.exitCode === 0 ? result.stdout.trim() : null,
        branchName: branchName ?? null,
      };
    },
    async act({ path, action }) {
      const localBranch = await getCurrentBranch(path);
      if (!localBranch) {
        return {
          ok: false as const,
          message: "Cannot update pull request from a detached workspace",
        };
      }
      return runPullRequestActionForCurrentBranch({
        cwd: path,
        localBranch,
        action,
      });
    },
  },
});
