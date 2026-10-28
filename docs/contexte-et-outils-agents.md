# Contexte projet et MCP interne des agents de travail

## Fonctionnement

À chaque échange, un agent de travail reçoit le nom et l’identifiant de son
projet, le dossier actif et uniquement les identifiants/titres des éléments liés
à sa conversation (10 maximum de chaque type). Les listes, compteurs, descriptions
et critères sont consultés via MCP à la demande. Le contexte technique reste
invisible dans le chat, y compris pour les anciens échanges, sans supprimer le
message ou les pièces jointes de l’utilisateur.
Le rattachement explicite détermine le projet, jamais
le chemin Git. Les conversations existantes en bénéficient au prochain échange.

Un véritable serveur MCP natif, `mergeron_internal`, remplace la CLI Python.
Aucune commande terminal ni fichier de requête n’est nécessaire aux outils projet.
Exemples : « Liste les tâches du projet », « Consulte le livrable Présentation »,
« Crée une tâche Préparer la présentation » ou « Crée un livrable Présentation ».

Une création produit un véritable élément métier et son lien. Une tâche est
principale par défaut ; une sous-tâche exige un parent du même gestionnaire.
Les sous-sous-tâches restent interdites. Aucun agent n’est affecté automatiquement,
aucune exécution n’est lancée et aucun gestionnaire manquant n’est créé implicitement.

La consigne exige une demande humaine explicite. Le champ `userRequest` est
journalisé, mais n’est pas une preuve automatique de cette demande : aucune
seconde confirmation humaine n’est ajoutée. Le serveur contrôle les permissions ;
l’agent reste responsable de l’interprétation de la demande.

### Documentation dans l’administration

L’entrée **MCP interne** des réglages globaux ouvre
`/settings?section=internalMcp`. Réservée aux administrateurs, elle présente :

- recherche parmi les huit méthodes ;
- paramètres, types, champs obligatoires et contraintes ;
- schémas JSON complets des entrées et des résultats ;
- exemples d’appels, protocole, limites, erreurs et instructions de sécurité.

Le catalogue provient de `GET /api/internal-mcp/catalog`, généré depuis les mêmes
schémas Zod que ceux enregistrés dans le serveur MCP. Cette route ne permet pas
d’exécuter les outils et ne divulgue ni jeton, ni URL d’exécution, ni donnée de projet.

### Permissions et documents

La confidentialité est respectée dans les listes, compteurs, détails et contexte.
Les gestionnaires internes d’exécution sont exclus. La création requiert les
droits administrateur nécessaires à l’exécution d’un agent et un mode modifiable.
En lecture seule, seuls les outils de consultation fonctionnent.

Exception : `rename_agent` renomme uniquement la conversation appelante, même en
lecture seule du système de fichiers. Paramètres : `title` (1–200 caractères,
sans caractères de contrôle), `requestId` stable et `userRequest` explicite.
Il exige les droits administrateur et une autorisation de tour active. Aucun
identifiant de cible n’est accepté. Le service habituel conserve la protection
contre la suppression et émet la notification native de changement de nom.
L’action `agent_renamed` journalise la personne et l’administrateur réel en cas
de simulation. Une relance identique renvoie le résultat sans nouveau changement.
Le résultat est `{ threadId, name, status: "renamed" }`. Ni fichiers, ni droits,
ni rattachement ne changent. Comme pour les créations, une issue incertaine ne
doit pas être rejouée sous un nouvel identifiant sans vérifier le nom actuel.

Créer un livrable crée sa fiche et son dossier, **pas une version de document**.
Les documents conservés passent toujours par « Enregistrer une nouvelle version »
et le circuit de brouillon isolé existant. Aucun outil projet n’accepte de contenu
de fichier, chemin arbitraire, changement de statut, affectation ou validation.
La protection des documents publiés reste applicable, y compris en accès complet.

Le MCP métier ne dépend ni du client Python ni de l’activation de la protection
documentaire pour consulter/créer des entités. Il ne réactive aucune intégration
externe désactivée : `codex_apps`, Home Assistant et les autres connecteurs restent
soumis aux restrictions par projet. Les conversations simples, non rattachées
comme agents de travail, ne reçoivent pas ce canal.

## Architecture technique

### Contexte et connexion native

`ThreadsService.startTurn()` injecte `ProjectAgentToolsService.context()` avant
`turn/start`. Les données du projet sont marquées non fiables, pas interprétées
comme des instructions.

`ProjectConnectionPolicyService` ajoute `mcp_servers.mergeron_internal` à la
configuration native Codex : `url`, `http_headers`, `enabled`,
`startup_timeout_sec`, `tool_timeout_sec`. La connexion d’une nouvelle conversation
est préparée avant `thread/start`, puis liée à l’identifiant retourné.
La politique est réappliquée aux conversations existantes avant le prochain échange.

`InternalMcpService` utilise le SDK officiel `@modelcontextprotocol/sdk`,
`McpServer` et `StreamableHTTPServerTransport`, en mode stateless avec réponses
JSON. Il écoute sur `127.0.0.1`, sur un port attribué par le système, et accepte
uniquement `POST /mcp`. Méthodes de protocole : `initialize`,
`notifications/initialized`, `ping`, `tools/list`, `tools/call`.
Ce n’est pas une route publique derrière le proxy Mergeron.

### Authentification et durée d’autorisation

Une capacité aléatoire propre à la conversation est fournie à Codex dans
l’en-tête `Authorization`, jamais dans le prompt. L’audit RPC masque cet en-tête.
La configuration native conserve le secret nécessaire à la connexion ; l’index
de recherche du serveur utilise son empreinte SHA-256.

La connexion est stable mais ne suffit pas à exécuter un outil : une autorisation
de tour active est nécessaire. Elle dure au maximum une heure et 100 appels,
et est liée à la personne authentifiée, au projet et à la conversation.
Elle est suspendue à la fin du tour et révoquée lors d’un arrêt, échec,
archivage, fermeture, suppression ou redémarrage du moteur. Un nouvel échange
prépare ses permissions propres. Les continuations suivent les notifications
de cycle de vie authentifiées.

Chaque appel revérifie l’identité actuelle, l’accès au projet/conversation et son
rattachement. Les créations revérifient ces conditions avant commit, notamment
après la préparation asynchrone d’un dossier. L’admission au catalogue protège
les mutations pendant son remplacement. La simulation d’identité conserve
l’administrateur réel dans l’audit.

Le serveur refuse les en-têtes `Origin`, un hôte/adresse non loopback, les jetons
invalides et les corps de plus de 32 Kio. Les arguments sont strictement validés.
Il s’agit d’une connexion locale authentifiée, non d’un service pour le navigateur.

### Contrat des outils

| Outil                | Arguments                                                                                                        | Résultat                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `get_project`        | Aucun                                                                                                            | Projet et gestionnaires accessibles                   |
| `list_tasks`         | `resourceId`, `query`, `offset` facultatifs                                                                      | `items`, `total`, `nextOffset`                        |
| `get_task`           | `id` obligatoire, `resourceId` facultatif                                                                        | Détail de tâche                                       |
| `list_deliverables`  | `resourceId`, `query`, `offset` facultatifs                                                                      | `items`, `total`, `nextOffset`                        |
| `get_deliverable`    | `id` obligatoire, `resourceId` facultatif                                                                        | Détail de livrable accessible                         |
| `create_task`        | `requestId`, `resourceId`, `title`, `userRequest` requis ; `description`, `criteria`, `parentTaskId` facultatifs | `id`, `title`, `resourceId`, `url`, `status: created` |
| `create_deliverable` | Mêmes champs, sans `parentTaskId`                                                                                | Même format de création                               |

Pagination : 50 éléments. Recherche sur le titre, sans distinction de casse.
Limites : titre 200 caractères, description/critères 10 000, justification 2 000,
recherche 200, identifiants 100. `offset` est un entier positif ou nul.
`requestId` accepte lettres, chiffres, tirets et underscores, de 1 à 100 caractères.
Les arguments supplémentaires, notamment `projectId`, sont refusés.

Exemple MCP :

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create_deliverable",
    "arguments": {
      "requestId": "presentation-client-01",
      "resourceId": "identifiant-du-gestionnaire",
      "title": "Présentation client",
      "criteria": "Inclure le planning et les risques",
      "userRequest": "L’utilisateur a demandé de créer ce livrable"
    }
  }
}
```

Une réponse réussie contient `structuredContent` et sa représentation textuelle.
Les erreurs métier retournent `isError: true` avec un code sûr, sans pile ni
secret : `NO_ACTIVE_TURN`, `READ_ONLY`, `RATE_LIMIT` ou refus d’accès/création
non confirmée. Les erreurs de protocole et de schéma sont gérées par le SDK.
Les schémas exhaustifs et les exemples par méthode sont disponibles dans la page
d’administration et dans `src/internal-mcp/internal-mcp-catalog.ts`.

### Services métier, audit et idempotence

`create_task` appelle `ProjectsService.createTask()` ; `create_deliverable` appelle
`DeliverablesService.create()`. Les validations et événements existants restent
en vigueur. Le journal `agent_created` conserve conversation, requête, personne,
justification et administrateur réel en simulation. L’historique des livrables
reste soumis à leur confidentialité.

La migration `0058_project_agent_tools` ajoute `project_agent_tool_requests`.
La clé `(project_id, thread_id, request_id)` est réclamée avant création :

- mêmes paramètres et même personne : résultat précédent, sans doublon ;
- paramètres ou personne différents : conflit ;
- panne après création avant enregistrement du résultat : état non confirmé,
  sans rejeu automatique. Vérifier le gestionnaire avant de recommencer.

Conserver le même `requestId` lors d’une relance. Une coupure ou un délai dépassé
ne prouve pas l’échec ; attendre la confirmation `status: created` avant d’annoncer
le succès. SQLite et le système de fichiers ne forment pas une transaction unique :
une panne peut laisser un élément sans accusé de réception ou un dossier vide
après refus. Les brouillons ne sont pas supprimés.

## Tests et exploitation

```sh
pnpm exec vitest run src/internal-mcp src/project-knowledge \
  src/document-publication src/threads/project-connection-policy.service.spec.ts \
  src/threads/project-connection-runtime.service.spec.ts src/threads/threads.service.spec.ts
cd web
pnpm exec vitest run --project=unit src/components/settings/internal-mcp-settings.spec.tsx \
  src/components/settings/settings-page.spec.tsx src/components/settings/settings-sidebar.spec.tsx
```

Les tests utilisent un vrai client SDK contre le serveur HTTP et couvrent les
sept méthodes sur une base de test, l’égalité des schémas avec la documentation,
les droits retirés, la lecture seule, la révocation, les restrictions réseau et
l’idempotence. Un test démarre le moteur Codex épinglé et vérifie qu’il découvre
les sept outils, sans appel d’inférence. Les tests métier couvrent aussi la panne
après commit.

Après déploiement, vérifier la page d’administration et une conversation existante
d’un projet de test : contexte, consultation, création explicitement demandée,
élément visible et audit. Vérifier le refus d’écriture en lecture seule et le
maintien du versionnement documentaire. Ne pas effectuer ces essais automatiquement
en production.

Références : [configuration MCP native de Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
et [SDK TypeScript MCP](https://ts.sdk.modelcontextprotocol.io/server).
