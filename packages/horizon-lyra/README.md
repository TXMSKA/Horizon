# horizon-lyra

Horizon's own integration with the local Lyra service. It was written for Horizon under GPL-3.0-or-later, talks to the service only through its HTTP routes on 127.0.0.1, and contains no Lyra code.

It finds the installed service (starting it when it is not running), registers Horizon as an app once, and exposes chat, Lyra's answer sources, model status, Ollama start and opening Lyra's own app to the browser. Every request carries `Lyra-Protocol: 2`; the service's features are read once per service process, and a request that needs a missing feature is refused with `unsupported` before it is sent. Horizon owns no model, provider or key: Lyra does.

```ts
const { connect } = await import('horizon-lyra');
const client = await connect({ app: { id: 'horizon', name: 'Horizon', kind: 'cosmic' }, tokens });
for await (const event of client.chat({ mode: 'fast', messages: [{ role: 'user', content: 'Hello' }] }, { signal })) { /* ... */ }
```

Failures are `LyraError` instances with a string `code`. Build with `tsc -p packages/horizon-lyra`; tests live in `scripts/horizon-lyra.test.cjs`.
