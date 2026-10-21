# Aleph

Aleph is a fork of [bb](https://github.com/get-bb/bb), an agentic IDE that runs
coding-agent threads across machines and providers. Aleph keeps bb's package
and command names and adds what long-running coordinator work needs: an
account pool, attempt receipts, and a version scheme that stops an upstream
update from replacing it.

The current build is Aleph <!--fig:aleph-version=0.7.0-->0.7.0 on upstream bb
<!--fig:upstream-version=0.46.1-->0.46.1. See `FORK.md` for

the rules of the fork.

Figures on these pages carry a hidden marker. The test in
`tests/qa/test/wiki-figures.test.ts` reads each marker and compares it with the
repository, so a page that drifts from the code fails the suite. To change a
figure, change the page and the code together.

Start with the [repository layout](repository-layout.md).
