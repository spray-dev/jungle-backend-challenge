# Bootstrap

Esta etapa contém somente NestJS, TypeScript estrito e liveness HTTP.
O enunciado original está em README.md.

## Requisito

Bun 1.4.3 (1.x). Se acabou de instalar Bun, reabra o terminal do VS Code.

## Comandos na raiz do repositório

```sh
bun install --frozen-lockfile
bun run typecheck
bun run start:dev
```

O servidor usa a porta 3000 por padrão. PORT permite alterar a porta.
GET http://localhost:3000/health/live retorna HTTP 200 com {"status":"ok"}.
Encerre com Ctrl+C.

Para compilar e executar a versão compilada:

```sh
bun run build
bun run start
```

`bun run test` está reservado para os testes que serão escritos com `bun:test`.
Ainda não existem testes de domínio nesta etapa.

## Estrutura

- src/main.ts: inicialização HTTP e encerramento do Nest.
- src/app.module.ts: módulo raiz e registro do controller.
- src/health.controller.ts: verifica somente que o processo responde.
- tsconfig.json: verificação estrita e compilação para dist/.
- package.json e bun.lock: comandos e dependências reproduzíveis.

O Nest usa common/core, o adaptador platform-express, reflect-metadata e rxjs.
TypeScript e @types/bun são ferramentas de desenvolvimento.
decimal.js está preparado para a futura implementação de Money.

## Limite desta etapa

Money, wallets, ledger, banco, ORM, SQS, readiness e regras financeiras ainda
não estão implementados. O endpoint live não declara que essas dependências
estão prontas. A próxima etapa é revisar a estrutura e estudar Money.
