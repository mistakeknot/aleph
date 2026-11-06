import { openParentChannel } from "../ipc/framed-child.js";
import { runParserChild } from "./child.js";

const channel = openParentChannel();
channel.output.on("error", () => process.exit(0));
runParserChild(channel).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
