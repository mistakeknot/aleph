import { createStagingFixtureServer } from "./lib/aleph-staging-fixture.mjs";
import { STAGING_BACKEND_PORT } from "./lib/aleph-staging-origin.mjs";

const server = createStagingFixtureServer();
server.listen(STAGING_BACKEND_PORT, "127.0.0.1", () => {
  console.log(
    `aleph staging fixture listening on 127.0.0.1:${STAGING_BACKEND_PORT}`,
  );
});
