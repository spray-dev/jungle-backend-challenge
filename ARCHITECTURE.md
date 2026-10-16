# Processamento de BET — etapa atual

`ProcessBetService.execute(transactionId)` processa uma `WagerTransaction` BET
já persistida. Retorna a transação com seu estado final. Segue o padrão do
`ApplyWalletDebitService`: coordenação na aplicação, regras monetárias no domínio
e adapters MikroORM implementando as portas de persistência.

## Transação e concorrência

Cada tentativa abre uma transação PostgreSQL com um EntityManager novo. Os três
repositories recebem o mesmo manager transacional. O fluxo é:

1. Ler a BET; se terminal, retornar seu estado persistido sem novo débito.
2. Ler a wallet e validar jogador, moeda, valor e saldo.
3. Debitar pelo domínio e atualizar a wallet condicionando à versão lida.
4. Inserir o ledger com os saldos antes/depois retornados pelo domínio.
5. Marcar a BET como PROCESSED e atualizar condicionando ao status PENDING.
6. Confirmar tudo junto; qualquer erro reverte todas as gravações da tentativa.

Os repositories lançam `ConcurrencyConflictError` quando o update condicionado
não altera uma linha. O serviço repete a transação completa, no máximo cinco
tentativas, relendo o estado. Não reutiliza objetos de uma tentativa revertida.
Após esgotar o limite, propaga o erro para o futuro chamador reagendar a operação.
Erros de infraestrutura também são propagados; não viram rejeições de negócio.
O serviço recusa uma transação externa, pois precisa controlar seu próprio commit
e rollback. Não há lock global nem garantia baseada em memória.

Exemplo: duas BETs de 80.00 lendo saldo 100.00/version 1. Uma grava 20.00/version 2.
A outra perde o update por versão, faz rollback e relê 20.00. Na nova tentativa,
registra REJECTED/INSUFFICIENT_FUNDS sem ledger.

## Rejeições

- `INSUFFICIENT_FUNDS`: saldo insuficiente.
- `CURRENCY_MISMATCH`: moeda da BET diferente da wallet.
- `PLAYER_MISMATCH`: jogador da BET diferente do titular da wallet.
- `INVALID_AMOUNT`: BET sem valor estritamente positivo. A wallet continua
  aceitando movimento zero como no-op; este caso de uso rejeita BET zero.

Rejeições persistem apenas status/código da BET. Não alteram saldo nem versão e
não geram ledger. Tipos diferentes de BET, IDs ausentes e estados não terminais
diferentes de PENDING são erros de chamada neste serviço.

## Verificação e limites desta etapa

`bun test` inclui PostgreSQL real conforme `src/mikro-orm.config.ts`; o container
deve estar ativo e as migrations existentes aplicadas. Os testes usam fixtures
com IDs próprios e removem apenas seus dados. A barreira no teste de concorrência
garante que duas tentativas leiam a mesma versão, exercitando o conflito real.
Há cobertura de 50 chamadas paralelas da mesma BET, wallets independentes,
rejeições, limite de retries e falhas injetadas após gravações reais do ledger
e do status. Também verificar com `bun run typecheck` e `bun run build`.

O escopo é processamento de BET existente, sem endpoint/worker SQS, inbox ou
outbox. A deduplicação aqui é por ID interno persistido; admissão por idempotency
key e conflito de payload continuam fora deste caso de uso. O retorno contém a
WagerTransaction, sem DTO de saldo histórico; os saldos originais ficam no ledger.
O serviço antigo de débito permanece como exercício de atomicidade e não deve
ser usado para processar BET em produção, pois não coordena o status da aposta.

Os testes concorrentes usam conexões independentes no mesmo processo; ainda não
comprovam o cenário completo de três processos, crash/ack ou reinício. As fixtures
partem de saldo 100.00 e reconciliam saldo inicial menos débitos; abertura com
ledger próprio é uma etapa separada. Não foram adicionadas migrations nesta
etapa: unicidade por wallet/transação e imutabilidade do ledger no schema ainda
precisam ser concluídas para cumprir todos os requisitos do desafio.
