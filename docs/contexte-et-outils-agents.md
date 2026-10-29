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

- recherche parmi les méthodes métier, Git et navigateur local ;
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

## Connexions du projet et utilisation de Git

Les agents découvrent les connexions configurées dans **leur projet** avec
`list_project_connections` (`query` et `offset` facultatifs, pages de 50).
Le résultat indique le nom, le protocole, l’activation, l’état, le mode d’accès,
la présence d’un secret et les copies appartenant à cet agent. Il ne contient
ni identifiants d’authentification, ni adresse de serveur, ni diagnostic brut.
Un nom de connexion ou un fichier distant reste une donnée non fiable : ce
n’est jamais une autorisation d’action.

`read_project_git` accepte un `connectionId` découvert et une opération :

- `branches`, `files` (`path` relatif, `ref` immuable facultatifs),
  `pull_requests` et `checks` (`number` obligatoire) consultent GitHub avec
  les identifiants conservés côté serveur ;
- `local_status`, `local_diff` (`path` obligatoire) et `local_commits`
  inspectent un `copyId` appartenant à l’agent, associé à cette connexion.
- `local_staged_diff` inspecte l’index figé et renvoie son empreinte. Omettre
  `path` pour vérifier **tout** ce qui sera commité. `local_diff` montre les fichiers
  de travail, qui peuvent différer du contenu préparé.

Les autres protocoles (SSH/SFTP/FTP/FTPS) sont visibles dans l’inventaire,
mais ce canal ne fournit pas d’exécution SSH arbitraire ni de transfert.
Les consultations distantes actuelles utilisent le fournisseur GitHub ;
un autre hébergeur peut être indiqué comme non pris en charge.

Sur demande humaine explicite, `publish_project_git` permet :

- `push` : publier le commit observé de la branche courante vers la connexion
  HTTPS configurée, sans forçage ; les changements non commités ne sont pas inclus ;
- `create_pull_request` : créer une PR GitHub **après** publication du même
  commit, avec `base`, `title` et `draft` obligatoires, `description` facultative.
  Une PR correspondante déjà ouverte est renvoyée sans second POST.

`prepare_project_git` complète ce circuit **sans rendre `.git` modifiable dans
le terminal**. Il exige les mêmes droits administrateur, tour modifiable,
connexion/copie en écriture et attribution à l’agent :

- `create_branch` crée une nouvelle branche au HEAD observé et la sélectionne.
  La copie doit être propre ; aucun stash, reset, écrasement ni changement de
  base automatique n’est effectué. Avec des modifications existantes, il faut
  décider explicitement de leur traitement, pas les effacer pour créer la branche.
- `stage_review` prévisualise les `paths` sélectionnés et fournit un
  `reviewFingerprint`. `stage` exige cette même empreinte et ces mêmes fichiers.
  Les liens symboliques, chemins dangereux, conflits et fichiers trop volumineux
  restent refusés. Aucun `git add .` implicite.
- `unstage` retire les chemins sélectionnés de l’index sans supprimer les fichiers.
- `commit` enregistre l’index figé, sans hooks ni signature, au nom de la personne
  connectée. Les champs d’identité fournis par l’agent ne sont pas acceptés.

Chaque appel utilise un `requestId` stable, `userRequest`, `expectedBranch`,
`expectedHead` et `fingerprint` issus de `local_status`. Relire l’état après
chaque mutation ; vérifier `local_staged_diff` sans filtre et l’ensemble des fichiers préparés avant
le commit. Les résultats de prévisualisation sont des données non fiables.
Une requête incertaine doit être inspectée, pas rejouée sous un nouvel identifiant.
Le verrou n’admet que l’agent appelant pendant son outil : tout autre agent actif,
nouveau tour ou écriture Git concurrente reste exclu. Les mutations locales de
l’interface conservent leur barrière stricte habituelle.

Avant publication, consulter `local_status` puis fournir `expectedBranch`,
`expectedHead` et `fingerprint` exactement observés, ainsi que `connectionId`,
`copyId`, un `requestId` stable et `userRequest` expliquant la demande humaine.
Ce texte est journalisé, pas accepté comme preuve automatique de consentement.
Le serveur exige un tour modifiable, un administrateur hors simulation, une
connexion/copie en lecture-écriture et une copie propre à l’agent. Il revérifie
les droits et l’état avant l’envoi. Il n’extrait jamais les secrets dans le prompt.

Les publications utilisent le circuit sécurisé existant : configuration Git
temporaire isolée pour le push, SHA immuable, TLS vérifié, redirections refusées
et API GitHub fixe pour les PR. L’outil de publication n’effectue aucun stage,
commit, checkout, merge ou changement de fichier local. Le verrou conserve l’exclusion des autres
agents actifs et bloque de nouveaux tours pendant la publication ; seul le tour
appelant est admis pour cette opération distante. Les mutations Git locales de
l’interface gardent leur barrière stricte habituelle.

Une connexion désactivée ou révoquée ne peut pas être utilisée. La simulation
d’identité ne peut pas publier. Une capacité affichée n’autorise jamais à
publier sans demande humaine. Un résultat incertain (`GIT_OUTCOME_UNKNOWN`)
peut correspondre à une publication réussie : consulter le distant, ne pas
relancer automatiquement sous un nouveau `requestId`. Une relance identique
renvoie le résultat confirmé, sans second envoi. Les demandes et publications
sont enregistrées dans le journal du projet.

Le catalogue natif et **Paramètres → MCP interne** décrivent les mêmes outils
et schémas. La consigne de découverte est incluse dans le contexte du projet
au prochain échange, y compris pour les agents existants. Le délai MCP est
de 180 secondes pour couvrir un push réseau borné à 120 secondes.

## Profil de test et précontrôle de l’environnement

Les caches, le précontrôle et les outils MCP sont communs à **tous les agents de
travail de tous les projets**, sans exception codée pour un identifiant d’agent.
Dans Paramètres → Sécurité, « Profil de test des nouveaux agents de projet » est
un réglage global, activé par défaut. Lors de la création d’un nouvel agent sur
un emplacement modifiable, il propose workspace-write et le réseau filtré si le
moteur confirme les contraintes administrées. Un emplacement en lecture seule,
un choix explicite de permissions ou un profil nommé restent prioritaires.
Les limites de dossiers temporaires et autres réglages workspace-write hérités
sont conservés. La désactivation globale ne réécrit pas les conversations déjà
créées ; aucun agent existant n’est silencieusement promu et aucune ancienne
copie du projet n’est écrasée pour mettre son packageManager à jour.

Le panneau Git de droite lit l’état réel de la copie attribuée à l’agent : fichiers
modifiés, nouveaux ou supprimés, préparés **et** non préparés. Il ne prétend pas
attribuer à un auteur une écriture qui n’a pas encore été commitée : les écritures
manuelles dans la même copie apparaissent aussi. « Modifications » ouvre le bon
diff pour chaque groupe (fichier de travail ou index). Le compteur porte sur les
fichiers distincts, y compris ceux partiellement préparés. Une veille de la copie
indépendante de l’onglet Fichiers, les notifications de l’agent et le retour de la
connexion actualisent les données locales, regroupées par petites fenêtres ; le
rafraîchissement périodique reste un secours. Rien n’est préparé, commité, fetché
ou publié automatiquement. Chaque agent continue de voir sa propre copie.

Dans les permissions de la conversation, « Tests du projet » permet un choix
explicite du réseau pour le prochain message, **uniquement en workspace-write**.
Il conserve les racines d’écriture et la politique d’approbation observées.
Il ne modifie ni les autres conversations, ni les fichiers de la copie, ni les
protections des livrables et de Git ; aucun accès Docker ou mode privilégié.
La désactivation du réseau reste possible. Les processus déjà lancés ne sont
pas re-sandboxés : arrêter les serveurs de test avant de fermer leur session.

Le bouton reste indisponible si le moteur ne confirme pas un proxy administré
avec une liste de destinations bornée et sans sockets Unix ni accès privé large.
Les variables HTTP_PROXY/HTTPS_PROXY ne suffisent pas. Les contraintes livrées
dans `/etc/codex/requirements.toml` sont immuables dans l’image ; elles ne donnent
pas elles-mêmes le droit réseau à une conversation. Un moteur ancien qui ne
rapporte pas ces exigences n’est pas présenté comme compatible. Les outils MCP
et le trafic du serveur gardent leurs autorisations distinctes.

Exécuter `mergeron-environment-check --cwd <copie> --visual --json` **dans le
terminal de l’agent**. Un contrôle dans le conteneur hors session ne démontre pas
les droits du tour. Le précontrôle distingue la disponibilité de npm/Corepack/pnpm,
les variables et droits des caches, puis la version épinglée dans package.json
réellement disponible hors réseau. Une ancienne copie demandant pnpm 10.18.3
n’est pas automatiquement réécrite parce que l’image fournit 10.34.9. Aucun
téléchargement, script du projet, changement de version ou `--no-sandbox` ne sert
de contournement. Les échecs Chromium sont séparés entre installation absente et
refus de sandbox lorsque le diagnostic permet de les identifier.

La CI utilise `smoke-test-agent-profile.sh` dans un conteneur sans réseau,
compte ni données utilisateur : le CLI épinglé est extrait du builder et monté
en lecture seule, jamais ajouté à l’image de production. Le test traverse le
lanceur de caches, l’isolation documentaire externe puis `command/exec` de Core,
sans créer de conversation ni demander d’inférence. Il exige la confirmation des
règles administrées, l’écoute loopback, Chromium sandboxé et le refus par le proxy
d’un domaine non autorisé. Un échec doit bloquer la livraison, pas activer un
contournement.

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

Les tests utilisent un vrai client SDK contre le serveur HTTP et couvrent
les méthodes métier et Git sur une base de test, l’égalité des schémas avec la documentation,
les droits retirés, la lecture seule, la révocation, les restrictions réseau et
l’idempotence. Un test démarre le moteur Codex épinglé et vérifie qu’il découvre
les outils enregistrés, sans appel d’inférence. Les tests métier couvrent aussi la panne
après commit.

Après déploiement, vérifier la page d’administration et une conversation existante
d’un projet de test : contexte, consultation, création explicitement demandée,
élément visible et audit. Vérifier le refus d’écriture en lecture seule et le
maintien du versionnement documentaire. Ne pas effectuer ces essais automatiquement
en production.

Références : [configuration MCP native de Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
et [SDK TypeScript MCP](https://ts.sdk.modelcontextprotocol.io/server).
