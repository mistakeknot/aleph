# Connect page notes

Legacy connect shares on the bb server host offer an annotation overlay to the
signed-in owner. Comment mode selects an element, saves a page note and shows
numbered author pins. Show all comments includes notes whose element is missing
or whose text changed, marked outdated; those notes do not jump to another
element. The disabled Send to thread checkbox announces that sending arrives
in the next update. There is no thread delivery operation.

Notes live in additive connect plugin KV entries keyed by server port and exact
page URL, including query and fragment. Existing share state is unchanged.
Notes retain selector, text snippet, bounds, viewport, comment and author. Crop
capture is unavailable in an ordinary preview browser; each note records that
reason. Unsharing does not delete notes. Reusing the same port and URL can expose
old notes, which must be checked against the current page.

## Boundaries and exclusions

The legacy gate removes caller-supplied authentication markers and platform
cookies before stamping the owner's verified session marker. Only frames from
the authenticated outbound tunnel reach the annotation interception callbacks.
There is no annotation listener on the preview's loopback port, and the plugin
does not infer authentication from a local HTTP header. The reserved
`/__bb_annotations` endpoint exposes only page-note operations. It requires a
registered share and owner session, validates the page origin and requires
same-origin JSON for mutations. Prototype code shares the preview origin and
can read or edit that preview's notes; it receives no platform credentials or
thread-send capability.

Anonymous, machine and OAuth visitors are excluded. Host-daemon shares do not
install the callbacks. Connect-next FRP shares currently point directly to the
preview port; they bypass the server's assertion-verifying ingress, which rejects
non-null share targets. They remain unchanged until a verified share ingress is
implemented. These routes do not yet have annotation coverage.

Only complete successful UTF-8 HTML with a declared content length up to 1 MiB
is eligible. Compressed, chunked, unknown-length, partial, attachment, oversized
and meta-policy responses pass through unchanged. Existing CSP headers are
preserved. Every applicable script policy must permit the same existing nonce;
otherwise injection is skipped. A policy with no script restriction needs no
additional permission. Sandbox and Trusted Types policies are excluded. Shadow
DOM uses constructed stylesheets; browsers without that support skip the tool.
Rewritten responses remove stale validators and use private, no-store caching.

## Verification

Focused unit and DOM tests cover eligibility, nonce intersection, authorization,
page isolation, note mutations and the disabled send control. Release acceptance
also requires a real gate-to-tunnel fixture, CSP behavior in a browser, legacy
desktop annotation regression checks and independent security review. A local
unit-test pass does not establish those results.
