export const ALEPH_SIGNING_IDENTITY =
  "Developer ID Application: General Systems Ventures LLC (W964996768)";
export const ALEPH_TEAM_ID = "W964996768";
export const ALEPH_BUNDLE_ID = "com.generalsystemsventures.aleph";
export const ALEPH_NOTARY_KEYCHAIN_PROFILE = "aleph-notary";
export const ALEPH_APP_NAME = "Aleph";
export const ALEPH_PUBLISH_REPOSITORY = "mistakeknot/aleph";
export const ALEPH_APPROVAL_NAMESPACE = "aleph-approval";
export const ALEPH_PUBLISH_APPROVAL_ENV = "ALEPH_PUBLISH_APPROVED";

export const FORBIDDEN_TEAM_IDS = ["Z45MLNQK64"];

export const SIGNING_CREDENTIAL_ENV_PATTERN =
  /^(?:CSC_(?!IDENTITY_AUTO_DISCOVERY$).*|APPLE_.*|.*\.p8|ALEPH_SIGN_.*PASSWORD.*)$/u;

export function findCredentialEnvKeys(env) {
  return Object.keys(env).filter(
    (key) =>
      SIGNING_CREDENTIAL_ENV_PATTERN.test(key) &&
      typeof env[key] === "string" &&
      env[key].trim().length > 0,
  );
}

export function assertCredentialFreeBuildEnvironment(env) {
  const credentialKeys = findCredentialEnvKeys(env);
  if (credentialKeys.length > 0) {
    throw new Error(
      `The aleph build runs without signing credentials. Unset: ${credentialKeys.join(", ")}.`,
    );
  }

  const discovery = env.CSC_IDENTITY_AUTO_DISCOVERY?.trim();
  if (
    discovery !== undefined &&
    discovery.length > 0 &&
    discovery !== "false"
  ) {
    throw new Error(
      "The aleph build runs without signing credentials. CSC_IDENTITY_AUTO_DISCOVERY must be unset or false.",
    );
  }
}

export function createSigningRunnerEnvironment(env) {
  const runnerEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"]) {
    if (typeof env[key] === "string") {
      runnerEnv[key] = env[key];
    }
  }
  runnerEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  return runnerEnv;
}
