# Processamento financeiro de wagers

Domínio independente de Nest/ORM, portas de persistência e adapters MikroORM.
Money usa Decimal e strings decimais; PostgreSQL usa numeric(18,2).
Nenhuma operação financeira usa ponto flutuante.

## Admissão e idempotência

AcceptWagerService admite BET, WIN, LOSS, REFUND e ROLLBACK. OPENING continua
proibido na entrada externa, incluindo SQS. AcceptBetService e ProcessBetService
preservam seus contratos exclusivos de BET. REFUND/ROLLBACK exigem referência
externa não vazia; a referência opcional de WIN continua preservada sem resolução.

Admissão e processamento diretos são etapas separadas. Uma interrupção entre elas
deixa PENDING recuperável pelo mesmo pedido; não há worker genérico de PENDING.
HandleWagerMessageService combina admissão, processamento, Inbox e Outbox na mesma
transação SQL. O adapter SQS confirma a mensagem somente depois desse commit.

Constraints de (provider_id, idempotency_key) e (provider_id, external_transaction_id)
arbitram a identidade em todas as instâncias. Mesmo payload retorna o registro
original; divergência de identidade ou hash é IDEMPOTENCY_CONFLICT. A Inbox possui
identidade própria (consumer_name, message_id) e hash de transporte separado.

Novos hashes são SHA-256 (UTF-8, hexadecimal minúsculo) de canonicalJson sobre:
providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind,
money normalizado e referenceExternalTransactionId quando presente.
Objetos têm chaves ordenadas lexicalmente em UTF-16, recursivamente, inclusive
chaves numéricas. Arrays preservam ordem; primitivas usam JSON.stringify;
números não finitos são rejeitados. Headers, idempotency key e metadados de
transporte não entram no hash. Leitura de hashes antigos de ordem fixa permanece
compatível apenas quando a referência armazenada também corresponde; sem backfill.

## Reversões

A referência é buscada por providerId + referenceExternalTransactionId, nunca
pelo ID interno fornecido externamente. Ela deve estar PROCESSED, pertencer ao
mesmo provider/player/wallet/currency/round e ter valor exatamente igual.
gameId é preservado no payload, mas não é requisito adicional de correspondência.

- REFUND só referencia BET e credita o valor integral.
- ROLLBACK referencia BET, WIN ou REFUND e inverte sua direção.
- Reversão de WIN/REFUND que exceda o saldo é REJECTED/REVERSAL_WOULD_OVERDRAW.
- Referência incompatível ou terminal REJECTED/FAILED é REJECTED/INVALID_REFERENCE.
- Referência estruturalmente compatível em PENDING/PENDING_REFERENCE aguarda no
  mesmo retry limitado da referência ausente, sem lock sobre a referência.
  Ao esgotar, existente pendente gera REFERENCE_NOT_READY; ausente gera REFERENCE_NOT_FOUND.
  Não há espera recursiva: os kinds permitidos formam o grafo acíclico
  ROLLBACK -> REFUND -> BET, ou ROLLBACK -> BET/WIN. Self-reference é inválida;
  referências opcionais de BET/WIN não criam dependências de processamento.
- Referência em outro provider não é resolvida: fica pendente no namespace pedido.
- Uma segunda reversão do mesmo kind é REJECTED/REFERENCE_ALREADY_REVERSED.
  REFUND e ROLLBACK podem cada um reverter a mesma BET uma vez, conforme contrato.
  A rejeição de uma tentativa não consome o direito de outra operação válida.

Rejeições não alteram wallet/versão nem criam ledger. Saldo observado é persistido
com a decisão; replay mantém o resultado original mesmo depois de novos movimentos.
Estados PROCESSED, REJECTED e FAILED são terminais no domínio. PENDING pode passar
a PROCESSED, REJECTED ou PENDING_REFERENCE. PENDING_REFERENCE pode permanecer
pendente, ser processado ou rejeitado pelo worker. FAILED permanece disponível no
domínio; falhas técnicas do worker provocam rollback e reagendamento por item.

## Concorrência e atomicidade

Cada tentativa usa um EntityManager novo e uma transação PostgreSQL completa.
Wallet mantém update condicionado à versão; ConcurrencyConflictError provoca
até cinco tentativas com releitura completa. Wallets diferentes não usam lock global.

Reversões travam sua própria linha antes da leitura, inclusive replays. Referências
válidas PROCESSED são travadas com FOR NO KEY UPDATE antes de verificar uma reversão
anterior do mesmo kind. Esse lock é compatível com KEY SHARE de foreign keys.
Não se trava referência pendente, evitando ciclos entre operações dependentes.
O índice único parcial wager_processed_reversal_unique sobre
(reference_transaction_id, kind), para reversões PROCESSED, é a proteção final
contra duplicação, inclusive via SQL direto. A wallet ainda usa optimistic locking
para disputar saldo com BET/WIN e com reversões de outras referências.

Status, saldo, ledger, tentativa/agendamento e evento são confirmados ou revertidos
juntos; Inbox participa quando a chamada vem da fila. Eventos de reversão são
enfileirados pelo processador, inclusive em chamadas diretas e retries. BET/WIN/LOSS
mantêm a emissão no handler de mensagem. OutboxPublisherService publica depois
do commit, com claim SKIP LOCKED e backoff; publicação continua at-least-once.
Nenhum WalletBalanceChanged foi acrescentado.

## PENDING_REFERENCE persistente

Na primeira ausência ou referência compatível ainda pendente: status PENDING_REFERENCE, reference_attempts = 0 e
reference_next_attempt_at = agora + 1 segundo; um WagerTransactionPendingReference
é persistido na Outbox, sem tocar wallet ou ledger. Redelivery e processamento
direto retornam a pendência sem repetir evento, antecipar execução ou contar tentativa.

RetryPendingReferenceService reclama uma linha vencida por transação com
FOR UPDATE SKIP LOCKED. Mantém o lock até commit/rollback, sem lease em memória.
São cinco reconsultas após o processamento inicial: esperas de 1, 2, 4, 8 e 16
segundos (aproximadamente 31 segundos até esgotar, acrescidos do polling/carga).
A função de backoff tem teto de 60 segundos. Referência presente na quinta
reconsulta ainda pode ser processada; se ausente, REJECTED/REFERENCE_NOT_FOUND
e um WagerTransactionRejected. Sucesso gera WagerTransactionProcessed.
Somente a entrada em pendência gera evento pendente; reconsultas não o repetem.

Falha técnica reverte contador, agendamento, status e todos os efeitos financeiros.
Após rollback, uma transação independente posterga somente reference_next_attempt_at:
5 segundos para erro técnico/transitório/desconhecido, 60 segundos para overflow
determinístico SQLSTATE 22003 (categoria permanent_operation). A escolha conservadora
é manter a operação recuperável, sem rejeitar nem consumir reference_attempts.
O timestamp existente serve como próxima elegibilidade; não há contador técnico novo
nem migration. Logs estruturados registram categoria, código e ID interno, sem payload.
Erro permanente exige investigação/correção operacional e pode continuar reagendando;
não é convertido em REFERENCE_NOT_FOUND. A recuperação condicional não sobrescreve
sucesso ou reagendamento concorrente. A rodada exclui IDs já tentados mesmo se o
reagendamento falhar; o retorno conta itens visitados, incluindo falhas isoladas.
Indisponibilidade total do banco pode impedir claim/reagendamento: o worker registra
o erro e tenta na próxima rodada. Processo morto perde o lock ao encerrar a conexão;
não há claim permanente a recuperar.
O PendingReferenceWorker registrado no AppModule faz polling a cada segundo,
até dez operações por rodada, sem sobreposição local, e aguarda trabalho ativo
no shutdown. Várias instâncias dividem as linhas disponíveis pelo banco.

## Migrations e garantias do banco

Migration20261017020000 é manual e reversível. Adiciona contador (CHECK 0..5),
data da próxima tentativa, índice parcial de vencimento e índice único de reversão.
CHECK exige referência interna para reversões PROCESSED. Pendências anteriores
ganham agendamento imediato. Duplicidades preexistentes fazem o up falhar
atomicamente; não há limpeza automática de dados financeiros.

Preserva todas as constraints anteriores: wallet não negativa, unicidade de
player/moeda, precisão/aritmética do ledger, UNIQUE(wallet_id, transaction_id),
FK composta transaction/wallet e trigger que proíbe UPDATE/DELETE/TRUNCATE do ledger
(SQLSTATE 55000). Nenhum generator foi usado; o snapshot antigo não é atualizado
artificialmente. Migrations futuras devem preservar SQL manual não representado
integralmente no metadata do ORM.

Down remove apenas as novas colunas/checks/índices, preservando ledger e wagers.
Perde o histórico de tentativas e a garantia nova de reversão única; interromper
workers e coordenar a versão da aplicação antes de reverter. O up posterior
reagenda pendências a partir de zero. Em produção, separar o usuário de aplicação
do proprietário do schema para impedir remoção administrativa das proteções.

## Verificação e limites

Com PostgreSQL e LocalStack do Compose ativos: bun run typecheck, bun run build,
bun test e git diff --check. O CLI de migrations usa dist: build precede
bun run db:migration:up. Testes usam bancos aleatórios wagering_test_* e filas
temporárias, sem modificar dados de desenvolvimento ou desativar triggers.

Reversões são testadas com ledger completo (wallet inicialmente zero e WIN de
funding), replay, overdraw, validações, fora de ordem via SQS, retry após nova
conexão, exaustão, concorrência entre três instâncias ORM independentes, SKIP LOCKED,
rollback externo e SQL direto contra constraints. A suíte antiga continua coberta;
as duas expectativas de REFUND/ROLLBACK não suportados agora verificam referência
obrigatória. Os testes de concorrência entre instâncias ORM rodam no mesmo processo;
não simulam kill real do processo durante uma reversão.

A janela de retry é curta para demonstração; operação real deve ajustar política
e monitorar REFERENCE_NOT_FOUND. Na etapa anterior, nenhuma API HTTP completa, abertura com ledger
OPENING, reconciliação pública ou WalletBalanceChanged foi implementada nesta etapa.
O publisher e o consumidor SQS existentes continuam acionados pelos seus serviços;
apenas o worker de referências foi conectado ao ciclo de vida Nest nesta alteração.

## Entrega HTTP mínima

POST /wallets grava Wallet.open (version 1), OPENING processada, exatamente um
CREDIT de zero ao saldo inicial e WagerTransactionProcessed na mesma transação.
O saldo inicial deve ser positivo. Não chama wallet.credit após Wallet.open.
Nenhuma migration foi necessária; unicidade player/moeda usa a constraint existente.

A entrada HTTP chama acceptWagerInTransaction e processWagerInTransaction, os
mesmos componentes usados pelo handler SQS, na mesma transação com Outbox.
Não cria Inbox fictícia para HTTP. Conflitos otimistas reiniciam toda a transação,
com novo EntityManager, até cinco tentativas. BET/WIN/LOSS emitem no adapter HTTP;
reversões continuam emitindo no processador existente. Replay retorna o saldo
observado persistido na decisão, mesmo que a wallet tenha mudado depois.

Ledger usa keyset (created_at, id), preserva microssegundos do PostgreSQL no cursor
base64url e vincula o cursor à wallet. O cursor é opaco, não assinado. Cada página
é uma consulta independente: não representa snapshot congelado entre requests;
novos commits com timestamps anteriores ao cursor podem exigir reiniciar a leitura.
Reconciliação usa uma única instrução SQL e um snapshot consistente para saldo e
soma CREDIT menos DEBIT. Difference = stored minus calculated, usando Decimal.
Não há autocorreção. Consultas por UUID inexistente retornam 404; formato inválido 400.

Readiness consulta PostgreSQL e ListQueues no SQS, sem criar recursos. Confirma
alcançabilidade, não configuração de filas/DLQ nem execução do consumer/publisher.
PendingReferenceWorker permanece automático; consumer e publisher ainda requerem
acionamento explícito e são exercitados pelos testes de integração.

Autenticação foi omitida por timebox. O ponto de integração é o boundary HTTP dos
controllers: adicionar guard Nest validando assinatura JWKS, issuer, audience e
expiração de access tokens OIDC de IdP externo (Keycloak/Zitadel), vinculando o
providerId ao principal e autorizando acesso às wallets. Health fica público;
SQS continua canal interno, protegido por IAM. Não há guard nem IdP implementado.
