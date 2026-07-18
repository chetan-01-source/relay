/** Bootstrap: build the mock and listen. Standalone dev/test service (see Dockerfile). */
import { buildMockLlm } from './app.js';

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  buildMockLlm()
    .listen({ port, host: '0.0.0.0' })
    .then(() => console.error(`[mockllm] listening on :${port} (openai + anthropic wire)`))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
