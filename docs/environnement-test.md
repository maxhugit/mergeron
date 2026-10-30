# Environnement de test par agent

Les scripts `scripts/preview/` démarrent le vrai backend Nest/Fastify et le frontend
Vite avec rechargement à chaud. Chaque agent utilise son propre dossier de données.
Les scripts ne lancent pas Docker, ne publient pas de port et ne modifient pas les
permissions, le proxy ou la politique réseau. La durée de vie et les volumes sont
définis par l’administrateur dans Mergeron.

## Préparer et lancer

Depuis la racine du dépôt, avec Node et Corepack disponibles :

```sh
mergeron-environment-check --cwd "$PWD" --visual --json
node scripts/preview/prepare.mjs install
node scripts/preview/prepare.mjs build
node scripts/preview/start.mjs
```

Les mêmes commandes existent sous les noms `pnpm preview:install`,
`pnpm preview:build` et `pnpm preview:start`. `pnpm preview:init` initialise les
données sans démarrer les serveurs. `pnpm test:preview` vérifie l’isolation, la
connexion réelle par cookie, le proxy API, le canal HMR et l’arrêt des processus ;
il nécessite les dépendances des deux projets et un backend compilé.

L’installation utilise exclusivement `pnpm@10.34.9`, les deux lockfiles avec
`--frozen-lockfile` et les caches du contexte d’exécution. Si `PNPM_HOME` est fourni,
les shims Corepack y sont activés. Les en-têtes `/usr/local/include/node` sont utilisés
pour les modules natifs lorsqu’ils sont disponibles. Tout échec interrompt la
préparation. Aucune compilation de production du frontend n’est nécessaire : Vite
sert les sources. Le build prépare aussi les extensions navigateur.

Par défaut, l’interface écoute sur `http://127.0.0.1:3000` et Nest sur le port 3001.
Vite transmet `/api` et `/socket.io` vers Nest. SIGINT/SIGTERM ferme Vite et arrête
le backend ; si le backend quitte inopinément, le lanceur ferme également Vite.

## Données et connexion

Le dossier par défaut est `artifacts/preview-state` (ignoré par Git). Utiliser un
dossier vide, ou un dossier marqué par ce lanceur : un dossier existant non reconnu
est refusé. Le lanceur n’efface jamais de données. Ce dossier contient SQLite,
CODEX_HOME, la configuration d’authentification, le HOME de test, les workspaces et
les logs. Les secrets applicatifs et comptes IA du processus appelant ne sont pas
transmis au backend. Le transport IA est explicitement désactivé : une fixture
JSON-RPC rejette l’initialisation sans fermer le pipe. Aucune réponse de modèle ou
de compte réussie n’est simulée et aucun appel ChatGPT n’est nécessaire au lancement.
Les fonctions IA ne sont donc pas validées par cet environnement d’interface.

Un administrateur local `maxime` est créé au premier démarrage. Sans mot de passe
fourni, un mot de passe aléatoire est écrit dans `admin-credentials.json` sous le
dossier de données, avec les permissions 0600 ; il n’est pas affiché dans les logs.
Pour choisir un autre identifiant ou un mot de passe de test, fournir
`PREVIEW_ADMIN_USERNAME` et `PREVIEW_ADMIN_PASSWORD` au processus (12 caractères
minimum). Ne pas enregistrer ces valeurs dans les sources, une recette partagée,
une commande versionnée ou un exemple de documentation. Utiliser le mécanisme
d’injection de valeurs de test autorisé par l’exécuteur.

Le hash Argon2 est produit directement par la bibliothèque puis vérifié, sans
capture de sortie terminal. Un compte déjà présent est conservé : changer la
variable de mot de passe ne réinitialise pas ce compte. Pour repartir de zéro,
choisir un nouveau dossier jetable ou recréer l’instance via Mergeron.

Utiliser la connexion locale par nom d’utilisateur et mot de passe. La passerelle
d’aperçu filtre `Authorization` mais transmet les cookies applicatifs isolés.
La clé de service interne est aléatoire, n’est jamais imprimée et ne sert pas à la
connexion du navigateur. Ne pas copier les comptes, secrets ou données de Dev ou
de production dans ce dossier.

## Recette de prévisualisation Mergeron

Préparer la recette par les outils MCP officiels avec les révisions observées :

| Champ      | Valeur                                     |
| ---------- | ------------------------------------------ |
| runtime    | `node`                                     |
| directory  | `.`                                        |
| install    | `node scripts/preview/prepare.mjs install` |
| build      | `node scripts/preview/prepare.mjs build`   |
| start      | `node scripts/preview/start.mjs`           |
| port       | `3000`                                     |
| path       | `/help`                                    |
| updateMode | `hot`                                      |

Variables non secrètes de la recette :

| Variable                 | Usage                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `PREVIEW_DATA_DIR=/data` | Volume jetable isolé du projet                                                                   |
| `PREVIEW_HOST=0.0.0.0`   | Écoute accessible à la passerelle dans le runtime autorisé                                       |
| `PREVIEW_ALLOWED_HOSTS`  | Hôtes ou suffixes DNS autorisés, séparés par virgules ; jamais `*`                               |
| `PREVIEW_PUBLIC_URL`     | Origine HTTPS de l’aperçu, sans chemin ni identifiants ; configure HMR en WSS sur le port public |
| `PREVIEW_HMR_HTTPS=true` | HMR en WSS sur le port 443 lorsque le nom public n’est connu qu’après le lancement               |
| `PREVIEW_PORT`           | Port Vite, 3000 par défaut                                                                       |
| `PREVIEW_BACKEND_PORT`   | Port Nest, 3001 par défaut                                                                       |

Quand l’URL n’est pas connue avant le lancement, un suffixe d’hôte approuvé peut
être fourni dans `PREVIEW_ALLOWED_HOSTS`, avec `PREVIEW_HMR_HTTPS=true`.

Synchroniser les modifications avec `project_preview_manage sync` (ou la
synchronisation automatique gérée par Mergeron). Vite les détecte dans sa copie
du workspace. Une modification des dépendances ou du backend peut nécessiter une
reconstruction/recréation ; HMR concerne ici le frontend. `refresh` et `stop`
suppriment les données temporaires. Ne partager l’URL qu’après `preview.ready=true`.
Vérifier aussi une connexion locale suivie d’un appel API protégé : HTTP 200 sur
`/help` ne valide pas l’authentification.

Pour une modification d’interface, lancer `mergeron-visual-check` avec l’URL et un
sélecteur réel, conserver les résultats sous `artifacts/visual-check`, puis ouvrir
et examiner les captures desktop et mobile. Le contrôle local ne valide pas à lui
seul le runtime distant, la session de la passerelle ou son canal WebSocket.

## Durée de disponibilité

Les nouveaux profils utilisent **5 heures** par défaut. Le menu propose 1 h,
3 h, 5 h, 10 h, 24 h et **Jamais**. Les durées explicites des anciens profils
restent conservées.

Dans la fenêtre de l’environnement, sélectionner une durée puis **Appliquer la
durée** modifie l’instance en cours sans la recréer ni effacer ses données. Le
délai repart de l’application du changement. **Jamais** désactive son arrêt
automatique ; l’arrêt manuel reste possible.

Le connecteur MCP expose la même action aux agents dans un tour administrateur
autorisé : `project_preview_manage` avec `operation: "lifetime"`, un `requestId`
stable et `lifetimeMinutes` parmi `60`, `180`, `300`, `600`, `1440` ou `null`
pour **Jamais**. `start` et `refresh` acceptent également cette valeur. La durée
de l’environnement et la durée des sessions d’accès restent indépendantes.

Cette évolution doit être déployée conjointement dans l’application et dans son
gestionnaire d’environnements ; modifier uniquement la recette du projet ne
met pas à jour les outils MCP de l’instance qui héberge Mergeron.
