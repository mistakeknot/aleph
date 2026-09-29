export type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string },
) => Promise<CommandResult>;
export type VerificationResult = {
  failures: string[];
  teamIdentifier: string | undefined;
};
export function verifyAlephApp(options: {
  appPath: string;
  expectedEntitlementKeys: string[];
  runner: CommandRunner;
}): Promise<VerificationResult>;
export function verifyAlephDmg(options: {
  dmgPath: string;
  runner: CommandRunner;
}): Promise<VerificationResult>;
export function verifyAlephZip(options: {
  expectedEntitlementKeys: string[];
  extractDirectory: string;
  runner: CommandRunner;
  zipPath: string;
}): Promise<VerificationResult>;
export function createCommandRunner(
  env?: Record<string, string | undefined>,
): CommandRunner;
export function readEntitlementKeys(plistText: string): string[];
export function unpublishableNameFailure(path: string): string[];
export function findUnpublishableMarker(appPath: string): Promise<string[]>;
