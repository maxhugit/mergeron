# Services applicatifs Mergeron

Ce répertoire contient le serveur qui permet aux utilisateurs de travailler
ensemble sur leurs projets, conversations, tâches et livrables. Il applique les
droits, conserve les données et relie l’interface aux moteurs et services autorisés.

## Domaines fonctionnels

- `auth/`, `settings/`, `account/` et `database/` gèrent l’identité, les réglages,
  les comptes techniques et les données persistantes.
- `projects/`, `project-knowledge/`, `deliverables/` et `document-publication/`
  organisent les projets, la connaissance commune et les documents versionnés.
- `threads/`, `chat/`, `simple-chat/`, `codex/`, `pending-approvals/` et
  `agent-monitors/` pilotent les conversations, agents, décisions et suivis.
- `files/`, `active-folders/`, `terminal/`, `browser/` et `previews/` donnent
  accès aux outils de travail et environnements autorisés.
- `internal-mcp/`, `mcp-servers/`, `apps/`, `plugins/`, `skills/` et `models/`
  exposent les capacités et intégrations disponibles.
- `preview/` concerne les réponses et aperçus de fichiers ; `previews/` gère
  les environnements de test. Ces deux fonctions ne sont pas interchangeables.
- `logs/`, `push/`, `turn-errors/`, `turn-diff/` et `token-usage/` fournissent
  le diagnostic, les notifications et les informations d’exécution.

`main.ts` démarre NestJS/Fastify et `app.module.ts` assemble les services. Les
tests sont placés près du code. `codex/codex-schema/` est généré depuis le CLI
épinglé : ne pas le modifier manuellement. Les migrations appartiennent à
[drizzle/](../drizzle/README.md), les fichiers utilisateurs restent hors du dépôt.

Voir [Architecture](../docs/architecture.md) et [Contribuer](../CONTRIBUTING.md).
