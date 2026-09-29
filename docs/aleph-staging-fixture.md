# Aleph staging fixture origin (R11f)

An unsigned, tailnet-only HTTPS origin on zklw. It holds no key and serves nothing signed.

- Public origin: `https://zklw.tail1c1ab6.ts.net:8443/aleph-staging/` (constants in `scripts/lib/aleph-staging-origin.mjs`; `:3002` belongs to another service).
- Backend: `node scripts/aleph-staging-fixture.mjs` listens on `127.0.0.1:8471`.
- Expose it with `tailscale serve --bg --https=8443 http://127.0.0.1:8471`.

Endpoints under `/aleph-staging/fixture/`:

| Path                                                 | Behavior                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `fixture.zip`, `fixture.json`                        | static bytes                                                               |
| `r/other-host`, `r/http`, `r/2hop`, `r/wrong-prefix` | 302 to a hop the verifier must refuse (`r/2hop` goes through `r/2hop-mid`) |
| `slow`                                               | headers immediately, body after 30 s                                       |
| `oversize`                                           | 256 MiB body with a matching `content-length`                              |
