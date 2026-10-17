# Credential redaction: what it catches and what it does not (mk-3aoo)

Code: `packages/domain/src/provider-env-redaction.ts`,
`secret-variants.ts`, `vendor-token-patterns.ts`.

Three layers, strongest first:

1. **Known secrets** (exact match, Aho-Corasick, linear). Values found under
   secret-named keys, env names or containers are collected, expanded into
   encoded variants (raw, percent/form/lowercase/every-byte, base64 standard
   and URL-safe at all three alignments plus padded, JSON once/twice/ASCII
   `\uXXXX`, shell backslash/`'...'`/`"..."`, hex) and matched in the original
   text before any heuristic runs. Secrets under 8 characters are not
   registered or expanded; a secret over 64 KiB, or an index over 4 Mi
   characters in total, fails closed (every non-structural string in that
   payload is replaced).
2. **Vendored prefixed token patterns** for secrets we do not hold (gitleaks
   default rules, MIT, plus Tailscale `tskey-`). Fixed prefix or fixed
   structure only; no entropy scanning, no keyword-only rules.
3. **Shape heuristics** (flags, assignments, headers, JSON pairs, bearer, URL
   userinfo and parameters). Best effort; the shell-quoting heuristics are
   frozen (mk ruling q181): they are not extended further.

## Not caught (residual risk)

- Secrets we do not hold, in a format with no vendored prefix, whose context
  is not a recognised flag, assignment, header, JSON key, URL parameter or
  bearer form.
- Split, truncated or oddly encoded echoes of a secret: a secret broken by
  quotes or other characters (`prefix"x"SUFFIX`), cut in the middle, wrapped
  across lines, ROT/XOR/compressed, double-base64, ANSI-C `$'...'` quoting,
  `\xNN` escapes, partial hex/base64 shorter than the 8-character floor, or
  case-changed encodings other than those listed. Only literal variants are
  matched.
- The known-secret layer only knows secrets present in the same payload (a
  secret-named key or env entry in that event). An echo in an event that
  carries no copy of the secret is only seen by layers 2 and 3.
- Variants shorter than 8 characters are dropped (false-positive floor), and
  short secrets (< 8) are not matched at all.
- Private-key matching consumes the PEM body up to 16 KiB and the END line;
  a key split across events or with non-base64 text inside is partly left.

## Round-10 repro shapes (known-secret layer, synthetic secrets)

| Repro                                                                    | Known secret                      | Caught by known-secret layer?                                                                                            |
| ------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| P2-1 quote continuation, `Cookie: prefix'TAIL` and `--token=prefix'TAIL` | `prefixTAIL` (shell-concatenated) | **No.** The text holds `prefix` and `TAIL` separately; no literal string equals the secret. Layer 3 still leaves `TAIL`. |
| P2-2 marker prefix, `TOKEN=[redacted]'TAIL'`                             | `TAIL`                            | Yes (literal).                                                                                                           |
| P2-3 escaped delimiter, `--token=prefix\ TAIL`, `TOKEN=prefix\,TAIL`     | `prefix TAIL`, `prefix,TAIL`      | Yes, since variant expansion (shell backslash form); **no** before it.                                                   |
| P2-4 URL userinfo, quote-split `https://user:prefix' TAIL'@host`         | `prefix TAIL`                     | **No.** The quote splits the secret.                                                                                     |
| P2-4 URL userinfo, fully quoted `'https://user:prefix TAIL@host'`        | `prefix TAIL`                     | Yes (literal).                                                                                                           |

When the secret is NOT known (the usual case for a credential typed into a
command by someone else), P2-1, P2-2, P2-3 and P2-4 remain open: they depend on
the frozen layer-3 heuristics, which still leave the tail of those forms.
