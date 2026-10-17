# Processamento de BET — etapa atual

Mantemos domínio independente de Nest/ORM, portas de persistência e adapters
MikroORM. Money usa Decimal e strings decimais; PostgreSQL usa numeric(18,2).

## Admissão e idempotência persistente

`AcceptBetService.execute(command)` admite somente BET e retorna a transação
persistida. O chamador usa seu ID em `ProcessBetService.execute(id)`.
Admissão e processamento são etapas separadas: uma interrupção entre elas deixa
PENDING persistido, recuperável pelo mesmo pedido. Ainda não há worker para isso.

O serviço calcula SHA-256 de campos explícitos em ordem fixa: provider,
externalTransactionId, wallet, player, round, game, kind e Money normalizado.
Não aceita hash do chamador. As constraints existentes de
`(provider_id, idempotency_key)` e `(provider_id, external_transaction_id)`
arbitram inclusive inserções concorrentes, sem cache em memória.
Após violação de unicidade, uma nova leitura verifica ambas as identidades:
mesma transação e mesmo hash retornam o registro original; divergência lança
`IdempotencyConflictError` com código `IDEMPOTENCY_CONFLICT`, sem alterar o original.
Reutilizar externalTransactionId com outra key também é conflito; outro provider
tem namespace independente. Erros de infraestrutura são propagados.
Fixtures e registros antigos com hashes arbitrários não ganham automaticamente
compatibilidade com o hash canônico; novos chamadores devem usar essa admissão.

## Transação e concorrência

Cada tentativa do processador abre uma transação PostgreSQL e EntityManager novo.
Os três repositories recebem o mesmo manager transacional:

1. Ler a BET; se terminal, retornar seu estado persistido sem novo débito.
2. Ler a wallet e validar jogador, moeda, valor e saldo.
3. Debitar pelo domínio e atualizar a wallet condicionando à versão lida.
4. Inserir o ledger com os saldos antes/depois do movimento.
5. Persistir PROCESSED e saldo observado condicionando ao status PENDING.
6. Confirmar tudo junto; falhas revertem todas as gravações da tentativa.

Updates condicionados sem linha afetada lançam `ConcurrencyConflictError`.
O serviço repete a transação completa até cinco tentativas, relendo o estado.
Esgotado o limite, propaga o erro ao chamador. Não há lock global; os serviços
recusam EntityManager já transacional para controlar seus próprios commits.
Duas BETs de 80.00 disputando 100.00 resultam em um débito, saldo 20.00 e uma
rejeição após releitura. Não há publicação de eventos nesta etapa.

## Rejeições e replay

Rejeições usam `INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `PLAYER_MISMATCH`
ou `INVALID_AMOUNT`. Persistem status, código e saldo observado, sem alterar
wallet/versão nem gerar ledger. IDs inexistentes, tipos diferentes de BET e
estados não terminais diferentes de PENDING são erros de chamada.

O retorno continua sendo WagerTransaction, agora com `observedBalance?: Money`.
O saldo e sua moeda são gravados atomicamente com a decisão, inclusive quando
a moeda da BET diverge da wallet. Replay nunca consulta o saldo atual para
compor esse resultado. Ainda não há DTO/endpoint HTTP.
A migration recupera o saldo de BETs PROCESSED antigas pelo ledger. Para terminais
antigas sem histórico suficiente (por exemplo REJECTED), mantém undefined/null;
não inventa um saldo original. Novas decisões deste processador sempre o gravam.

## Garantias de schema e reversibilidade

`Migration20261016180000` acrescenta `UNIQUE(wallet_id, transaction_id)`,
também mapeado na entidade, e um trigger PostgreSQL que rejeita UPDATE, DELETE
e TRUNCATE do ledger com SQLSTATE 55000. INSERT continua permitido. Não há bypass
de teste no trigger. A migration também adiciona saldo/moeda observados com CHECK
de não-negatividade e preenchimento conjunto. Constraints anteriores são preservadas.

O down remove somente essas adições, preservando as linhas do ledger; perde as
colunas de saldo histórico, portanto rejeições não podem ser reconstruídas depois.
Dados duplicados preexistentes fazem o up falhar atomicamente, sem limpeza silenciosa.
Como qualquer trigger, a proteção pode ser removida por um administrador: em
produção, o usuário da aplicação deve ser separado do dono do schema/migrations.
Revisar migrations geradas: checks, FKs e trigger manuais não estão todos no
metadata do ORM e não devem ser removidos automaticamente.

## Verificação e limites

Com PostgreSQL do Compose ativo: `bun run typecheck`, `bun run build`,
`bun run db:migration:up` e `bun test`. O CLI de migrations usa dist, portanto
executar build antes dele. O typecheck usa tsconfig.typecheck.json e inclui testes;
o build de produção exclui testes e src/testing. check-db.ts foi removido.

Cada suíte de integração cria um banco aleatório wagering_test_* no PostgreSQL
configurado, aplica as migrations de src e remove somente seu próprio banco ao
encerrar. Requer permissão CREATEDB; não modifica dados do banco de desenvolvimento
nem desliga o trigger. Interrupção abrupta do runner pode deixar banco temporário.
Há testes de SQL direto para unicidade/imutabilidade, down/up com dados, backfill,
replay após reconexão e outro débito, conflitos concorrentes de payload, 50 admissões
e processamentos paralelos, duas BETs disputando saldo e rollback após falhas reais.

Sem Inbox/Outbox/SQS, API completa, OPENING ou demais operações nesta etapa.
Os testes concorrentes usam conexões no mesmo processo: não comprovam três processos
nem crash/ack. As fixtures reconciliam saldo inicial menos débitos; abertura com
ledger próprio continua separada. ApplyWalletDebitService permanece um exercício
de atomicidade e não deve processar BET em produção, pois não coordena seu status.

### Canonical wager payload hashing

New wagers use SHA-256 (UTF-8, lowercase hex) of `canonicalJson` over an explicit
business allowlist: providerId, externalTransactionId, walletId, playerId,
roundId, gameId, kind, normalized money (amount/currency), and
referenceExternalTransactionId when supplied. Absent references are omitted.
All object keys are sorted lexically (UTF-16), recursively, including objects
inside arrays; array order is preserved. JSON primitives use JSON.stringify
escaping/formatting. Integer-like keys are also emitted in lexical order.
The helper accepts JSON values and rejects non-finite numbers.
Idempotency keys, headers and transport metadata are excluded. Inbox transport
hashing is separate and unchanged.

Existing hashes retain read compatibility with the previous fixed-field-order
algorithm, only when the stored reference also matches the incoming reference.
New writes always use the canonical algorithm; no hash backfill is needed.
WIN references are preserved without resolving or validating their target.
