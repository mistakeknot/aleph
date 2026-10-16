import { installParentExitWatch } from "./bridge-parent-watch.js";

installParentExitWatch({
  env: process.env,
  kill(signal) {
    process.kill(process.pid, signal);
  },
  stdin: process.stdin,
});

void import("bb-app/dist/bb-app.js");
