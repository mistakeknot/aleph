export interface ElectronBuilderConfigSources {
  ledgerPath?: string;
  packageJsonPath?: string;
}

export function resolveElectronBuilderConfig(
  baseConfig: unknown,
  env: NodeJS.ProcessEnv,
  sources?: ElectronBuilderConfigSources,
): { config: unknown; releaseChannel: string; signingPlan: unknown };
