# Jungle — Distributed Wagering Processor

API financeira demonstrável em NestJS + Bun + PostgreSQL/MikroORM, com SQS via MiniStack.
Domínio separado de transporte e persistência; HTTP e SQS reutilizam a mesma admissão
idempotente e processamento transacional. Decisões detalhadas, hashes, constraints e
reversões estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Executar localmente

Requisitos: Bun >= 1.4.3 e < 2, Docker com Compose; portas 3000, 5433 e 4566 livres.
Execute na raiz do repositório:

```sh
docker compose up -d
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run db:migration:up
bun run sqs:provision
# Configure as URLs impressas no .env antes de iniciar os workers.
bun run start
```

Aguarde PostgreSQL ficar healthy antes da migration (`docker compose ps`). O CLI usa
`dist`, portanto **build vem antes de migration**. Para desenvolvimento: `bun run start:dev`.
O Compose sobe PostgreSQL 16 e MiniStack. Execute `bun run sqs:provision` para criar
idempotentemente `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e
`wager-events.fifo`, usando o SDK (sem AWS CLI). A entrada tem visibility de 60s e
redrive para DLQ após 5 recebimentos. O script pode ser executado novamente.
Copie as duas linhas de URLs impressas para `.env`:

```dotenv
WAGER_SQS_QUEUE_URL=http://localhost:4566/000000000000/wager-transactions.fifo
WAGER_SQS_EVENTS_QUEUE_URL=http://localhost:4566/000000000000/wager-events.fifo
```

Esses são exemplos do MiniStack padrão; use as URLs efetivamente retornadas.
Sem a URL correspondente, cada worker fica desativado com aviso `worker_disabled`.
A API HTTP continua disponível, e eventos permanecem na Outbox até ativar o publisher.
URL configurada mas indisponível causa retry no worker e falha em readiness, sem encerrar HTTP.

Defaults locais estão em [.env.example](.env.example). Não é necessário criar `.env`
para o Compose padrão. Para personalizar, copie o exemplo para `.env` (Bun carrega-o)
ou exporte as variáveis. Não reutilize as credenciais de demonstração em produção.

| Variável | Default local | Uso |
|---|---|---|
| PORT | 3000 | HTTP |
| WAGER_DB_HOST | localhost | PostgreSQL |
| WAGER_DB_PORT | 5433 | Porta exposta pelo Compose |
| WAGER_DB_USER | wagering | Usuário PostgreSQL |
| WAGER_DB_PASSWORD | wagering_dev | Senha de demonstração |
| WAGER_DB_NAME | wagering | Banco da aplicação |
| SQS_ENDPOINT | http://localhost:4566 | Endpoint SQS de runtime, provisioning e readiness |
| WAGER_SQS_QUEUE_URL | vazio | Fila de entrada; vazio desativa consumer |
| WAGER_SQS_EVENTS_QUEUE_URL | vazio | Fila de eventos; vazio desativa publisher |
| AWS_REGION | us-east-1 | Região SQS |
| AWS_ACCESS_KEY_ID | test | Credencial local MiniStack |
| AWS_SECRET_ACCESS_KEY | test | Credencial local MiniStack |

O Compose usa suas próprias credenciais locais fixas; mudar variáveis da aplicação
não altera usuários ou volumes já existentes do PostgreSQL. Testes criam bancos
`wagering_test_*`; o usuário de teste precisa de permissão CREATEDB.

## API HTTP

Valores monetários são objetos `{ "amount": "25.00", "currency": "BRL" }`.
Amount deve ser string decimal não negativa, com exatamente duas casas e no máximo
16 dígitos inteiros. IDs de wallet/transação são UUIDs; demais identidades são strings
não vazias, até 255 caracteres. OPENING é exclusivamente interno.

| Método | Rota | Resultado |
|---|---|---|
| POST | /wallets | 201, abertura atômica com initialBalance > 0 |
| GET | /wallets/:id | Saldo e versão |
| GET | /wallets/:id/ledger?limit=50&cursor=... | Ledger paginado |
| GET | /wallets/:id/reconciliation | Comparação de saldo e ledger |
| POST | /wallets/:walletId/reconciliation | Alias oficial; 200, mesma consulta sem mutação |
| POST | /wagering/transactions | Processamento síncrono/idempotente |
| GET | /wagering/transactions/:id | Decisão persistida |
| GET | /wagering/transactions/provider/:providerId/external/:externalTransactionId | Busca pela identidade externa |
| GET | /providers/:providerId/wagering/transactions/:externalTransactionId | Alias oficial da busca externa |
| GET | /health/live | Processo vivo |
| GET | /health/ready | PostgreSQL + SQS alcançáveis |

### Demonstração executável em PowerShell

```powershell
$base = 'http://localhost:3000'
$player = [guid]::NewGuid().ToString()
$wallet = Invoke-RestMethod -Method Post -Uri "$base/wallets" -ContentType 'application/json' -Body (@{
    playerId = $player
    initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json)
$wallet

$key = [guid]::NewGuid().ToString()
$body = @{
    providerId = 'provider-demo'; externalTransactionId = $key
    playerId = $player; walletId = $wallet.id
    roundId = 'round-1'; gameId = 'game-1'; kind = 'BET'
    money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json
$headers = @{ 'Idempotency-Key' = $key }
$wager = Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -Headers $headers -ContentType 'application/json' -Body $body
$wager
# Repetição idêntica: mesmo transactionId e balance, idempotentReplay = true.
Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -Headers $headers -ContentType 'application/json' -Body $body
Invoke-RestMethod "$base/wallets/$($wallet.id)"
Invoke-RestMethod "$base/wallets/$($wallet.id)/ledger?limit=50"
Invoke-RestMethod "$base/wagering/transactions/$($wager.transactionId)"
Invoke-RestMethod "$base/wagering/transactions/provider/provider-demo/external/$key"
Invoke-RestMethod "$base/wallets/$($wallet.id)/reconciliation"
Invoke-RestMethod "$base/health/ready"
```

Exemplo de resposta do wager (campos principais):

```json
{"transactionId":"<uuid>","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}
```

Reconciliação depois do BET:

```json
{"walletId":"<uuid>","storedBalance":{"amount":"75.00","currency":"BRL"},"calculatedBalance":{"amount":"75.00","currency":"BRL"},"difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":2}
```

`difference = storedBalance - calculatedBalance`. Reconciliação nunca corrige dados.
Ledger retorna `{ items: [...], nextCursor: string | null }`; devolva nextCursor como
cursor na próxima consulta. Limite 1..100; ordenação `(created_at, id)`, cursor base64url
vinculado à wallet, com precisão de microssegundos. Não é assinado e não congela
snapshot entre páginas; commits tardios podem exigir nova leitura desde o início.

Wager aceita BET/WIN/LOSS/REFUND/ROLLBACK. REFUND e ROLLBACK exigem
`referenceExternalTransactionId`, mesma identidade de provider/player/wallet/round,
moeda e valor da referência. REFUND referencia BET; ROLLBACK referencia BET/WIN/REFUND.
LOSS não movimenta saldo. Idempotency-Key vem exclusivamente do header.

| HTTP | Significado |
|---|---|
| 200 | Wager processado ou replay; consultas bem-sucedidas |
| 201 | Wallet aberta com version 1, OPENING + um CREDIT |
| 202 | PENDING_REFERENCE (ou PENDING); consultar novamente |
| 400 | Payload/header/cursor/UUID inválido; OPENING externo proibido |
| 404 | Wallet/transação inexistente |
| 409 | WALLET_ALREADY_EXISTS ou IDEMPOTENCY_CONFLICT |
| 422 | REJECTED com failureCode persistido, por exemplo INSUFFICIENT_FUNDS |
| 503 | Falha de infraestrutura/conflitos esgotados; retry com a mesma chave |

Replay retorna a decisão e saldo observado originais, não o saldo atual da wallet.
Operação antes pendente pode evoluir após o worker encontrar a referência.
Readiness retorna `ready` ou 503 `not_ready`, com flags `postgres` e `sqs`.
Usa SELECT 1 e GetQueueAttributes para cada URL configurada; sem URLs, usa ListQueues.
Não cria recursos e não verifica a configuração de redrive/DLQ em readiness.

## Testes e SQS/MiniStack

Com a infraestrutura ativa:

```sh
bun run typecheck
bun run build
bun test
git diff --check
```

Integrações usam PostgreSQL e MiniStack reais, bancos/filas temporários e migrations,
sem remover proteção do ledger. Os testes SQS usam localhost:4566 e credenciais test.
Para demonstrar consumer, ACK, retry/DLQ e publisher isoladamente:

```sh
bun test src/infrastructure/messaging/wager-sqs-consumer.integration.test.ts
bun test src/infrastructure/messaging/sqs-integration-event.publisher.integration.test.ts
bun test src/application/services/outbox-publisher.service.integration.test.ts
bun test src/http/http.integration.test.ts
```

Os testes provisionam as próprias filas FIFO e redrive policy e fazem limpeza.
Com URLs configuradas, **WagerSqsWorker e OutboxPublisherWorker iniciam automaticamente**
em `bun run start`, junto ao PendingReferenceWorker. O consumer faz long polling de 1s,
com 100ms entre iterações; o publisher publica lotes de até 10, com 1s entre iterações.
Cada loop agenda somente depois da conclusão anterior, sem sobreposição local. As
garantias entre instâncias continuam no PostgreSQL (Inbox/idempotência e SKIP LOCKED).
Falhas geram logs estruturados mínimos, sem corpo financeiro; falhas de publicação
mantêm o backoff persistido da Outbox. A publicação continua at-least-once.

SIGTERM/SIGINT acionam hooks do Nest: os workers cancelam timers, aguardam a iteração
ativa e só depois fecham seus clientes SQS. Requisições SDK têm timeouts e retries
limitados; o shutdown aguarda também o trabalho de banco ativo. Não há teste de kill real.

WalletBalanceChanged é persistido na mesma transação de OPENING/BET/WIN/REFUND/ROLLBACK,
com walletId, transactionId, direction, money, balanceBefore, balanceAfter e walletVersion.
LOSS, rejeição e replay não geram outro evento de saldo. O evento de decisão existente
continua sendo emitido separadamente. Nenhuma migration foi necessária.

## Garantias e tradeoffs

- Money/Decimal e numeric(18,2); dinheiro não passa por JS number.
- Abertura: wallet + OPENING processada + um CREDIT + Outbox no mesmo commit.
- Optimistic locking por wallet e retry com transação/EntityManager novos; sem lock global.
- Ledger imutável, constraints de não negatividade e unicidade no PostgreSQL.
- Idempotência persistente por provider/chave e provider/identidade externa; hash
  SHA-256 de JSON canônico de campos de negócio, explicado em ARCHITECTURE.md.
- Entrada HTTP compartilha admissão/processamento com SQS; Inbox persistente é da
  entrada SQS, ACK após commit; Outbox permite publicação at-least-once posterior.
- Reversões integrais, proteção contra dupla reversão e PENDING_REFERENCE persistente.
- Worker de referência usa SKIP LOCKED; retries 1/2/4/8/16 segundos, depois rejeição
  por referência ausente. Falha técnica faz rollback/reagendamento, sem consumir tentativa de referência.

## Limitações deliberadas

Autenticação omitida por timebox. Integração proposta: IdP externo OIDC, guard Nest
nos controllers validando JWT/JWKS/issuer/audience, providerId vinculado ao principal
e autorização por wallet; health público e SQS interno protegido por IAM. Nenhum
IdP/guard foi implementado. Não exponha esta demonstração sem essa camada.

Também ficam pendentes: envelope completo eventId/eventType/aggregateId/correlationId/causationId
(o contrato de entrada/saída mantém messageId/type/version/occurredAt/data), métricas e logs estruturados abrangentes,
alertas automáticos de reconciliação, teste com três processos reais e kill depois
do commit/antes do ACK. A concorrência existente usa conexões/instâncias ORM reais
no mesmo processo. A janela de referência (~31s + polling) é curta para produção.
Overflow do saldo no numeric(18,2) causa rollback e erro técnico; não há taxonomia
HTTP específica para esse limite. Não há frontend. Nenhuma migration foi gerada
para esta entrega HTTP; todas as proteções financeiras existentes foram preservadas.

Operações/comparações entre moedas diferentes são inválidas; Money.equals lança erro de currency mismatch, assim como add/subtract/isLessThan.
Isso diverge da regra geral de conflito de moeda do enunciado para equals; preservado nesta entrega sem alteração de domínio.
