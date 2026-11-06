import { openParentChannel } from "../ipc/framed-child.js";
import { runWriterChild } from "./child.js";
import { WRITER_STORE_DIR_ENV, openWriterStore } from "./store.js";

const dir = process.env[WRITER_STORE_DIR_ENV];
if (dir === undefined || dir === "") process.exit(2);
const channel = openParentChannel();
channel.output.on("error", () => process.exit(0));
const store = openWriterStore(dir);
runWriterChild(channel, store).then(
  (code) => {
    store.close();
    process.exit(code);
  },
  () => process.exit(1),
);
