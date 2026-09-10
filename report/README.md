# The status report

`public/index.html` is a single self-contained page. Publish it with:

    cd report && npx wrangler deploy

It is a separate Worker from `antiproton` for two reasons: the production Worker
sits behind Cloudflare Access, and a public document should not be the thing
that widens either its bundle or its auth surface. This one has no bindings, no
secrets and no route into the agent.

Every figure on the page is measured. Where a number is a single sample, the
page says so.
