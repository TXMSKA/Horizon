# horizon-lyra

Horizon's own integration with the local Lyra service. It was written for Horizon under GPL-3.0-or-later, talks to the service only through its HTTP routes on 127.0.0.1, and contains no Lyra code.

It finds the installed service (starting it when it is not running), registers Horizon as an app once, and exposes chat, model status, opening Lyra at Models, and Ollama start to the browser. Status accepts extra modes and optional completion metadata. Models are managed in Lyra.

```ts
const { connect } = await import('horizon-lyra');
const client = await connect({ app: { id: 'horizon', name: 'Horizon', kind: 'cosmic' }, tokens });
for await (const event of client.chat({ mode: 'fast', messages: [{ role: 'user', content: 'Hello' }] }, { signal })) { /* ... */ }
await client.app.open('models');
```

Failures are `LyraError` instances with a string `code`. Build with `tsc -p packages/horizon-lyra`; tests live in `scripts/horizon-lyra.test.cjs`.
