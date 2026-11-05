interface KeyShapePattern {
  label: string;
  pattern: RegExp;
}

const KEY_SHAPE_PATTERNS: readonly KeyShapePattern[] = [
  {
    label: "private key block",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/u,
  },
  { label: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  {
    label: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/u,
  },
  {
    label: "provider API key",
    pattern:
      /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{20,}\b/u,
  },
  { label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  {
    label: "JSON web token",
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  },
  {
    label: "credential in URL",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu,
  },
  {
    label: "assignment of a value",
    pattern:
      /\b[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*[=:]\s*\S{8,}/iu,
  },
];

const HIGH_ENTROPY_MIN_LENGTH = 32;
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 3.5;

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function hasHighEntropyToken(text: string): boolean {
  for (const token of text.split(/[\s"'`,;()[\]{}<>]+/u)) {
    if (token.length < HIGH_ENTROPY_MIN_LENGTH) continue;
    if (!/^[A-Za-z0-9+/_=.-]+$/u.test(token)) continue;
    if (/^[a-z.-]+$/u.test(token) || token.includes("/")) continue;
    if (
      /[0-9]/u.test(token) &&
      /[A-Za-z]/u.test(token) &&
      shannonEntropy(token) >= HIGH_ENTROPY_MIN_BITS_PER_CHAR
    ) {
      return true;
    }
  }
  return false;
}

export function detectKeyShape(text: string): string | null {
  for (const { label, pattern } of KEY_SHAPE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return hasHighEntropyToken(text) ? "high-entropy token" : null;
}
