# Caches et contrôle préalable des agents

L’image fournit deux commandes, sans modification des opérations Git ou du
connecteur MCP. Aucun accès Docker, droit supplémentaire, secret ou exception
réseau n’est accordé à l’agent.

## Caches préparés au démarrage

Le processus Core est lancé par `mergeron-agent-environment`, **à l’intérieur**
de la frontière de montage lorsqu’elle est activée. Le lanceur crée un répertoire
privé `mergeron-agent-cache.*` dans le répertoire temporaire, avec des droits
réservés à son utilisateur. Il configure :

| Variable                                        | Usage                                          |
| ----------------------------------------------- | ---------------------------------------------- |
| `XDG_CACHE_HOME`                                | Caches des outils respectant la convention XDG |
| `COREPACK_HOME`                                 | Versions des gestionnaires de paquets          |
| `npm_config_cache`                              | Cache npm                                      |
| `npm_config_store_dir`, `pnpm_config_store_dir` | Même store, compatible avec pnpm 10 et 11      |
| `npm_config_devdir`                             | Cache de compilation node-gyp                  |
| `PNPM_HOME`                                     | Répertoire de travail global pnpm              |

Les agents du même processus Core partagent ces caches ; ce n’est pas un stockage
persistant par agent. Un redémarrage Core prépare un nouveau répertoire.
Avec l’isolation, son `/tmp` privé disparaît avec le namespace. Sans isolation,
les caches temporaires sont récupérés avec le cycle de vie du conteneur.
Ils ne sont ni dans les sources, ni dans les documents ou livrables, ni dans le
stockage de versions. Un manque d’espace reste une erreur à traiter, pas une
raison d’élargir les droits ou de déplacer les caches dans le dépôt.

La version pnpm épinglée (10.34.9, même majeure que le projet) est préchargée
dans `/opt/mergeron-corepack`, hors du
volume personnel et du nettoyage des caches de construction. Le lanceur en fait
une copie accessible en écriture. La version préchargée est utilisable sans
téléchargement ; un projet demandant une autre version peut toujours nécessiter
un accès au registre autorisé. Le lanceur ne désactive ni TLS ni le proxy.

Si les en-têtes du Node exécuté sont installés et de même version,
`npm_config_nodedir` les sélectionne automatiquement. Un chemin explicitement
fourni est conservé, notamment pour une autre cible comme Electron. Cela évite
les téléchargements inutiles d’en-têtes, sans garantir que tous les modules
natifs d’un projet pourront être compilés.

Les installations locales depuis les sources sans ce lanceur conservent leur
comportement existant. La nouvelle image et le redémarrage du processus Core
sont nécessaires pour initialiser les caches ; cela ne change pas la politique
en lecture seule d’une session.

## Contrôle depuis le vrai contexte de l’agent

Avant une installation, compilation ou campagne de tests, dans le terminal de
l’agent et **avec ses permissions habituelles** :

```sh
mergeron-environment-check --cwd /workspaces/mon-projet
```

Le contrôle vérifie une écriture temporaire dans le dossier existant, les caches,
les versions locales de npm/Corepack/pnpm, la disponibilité d’en-têtes Node
compatibles et, si un proxy est configuré, son DNS et son port TCP.
Il appelle aussi réellement `os.networkInterfaces()` : la sonde
`node.network-interfaces` détecte notamment un refus `uv_interface_addresses`,
qui peut empêcher Fastify de démarrer malgré une écoute TCP fonctionnelle.
Il n’exécute aucun script du projet, ne lit aucun jeton Git, n’installe rien et
interdit les téléchargements de gestionnaires pendant les sondes de version.
Ces sondes se déroulent dans un répertoire temporaire hors du projet afin de
ne pas suivre un `packageManager` choisi par ce dernier.

Pour une interface web :

```sh
mergeron-environment-check --cwd /workspaces/mon-projet --visual
```

Cette option ouvre puis ferme un serveur TCP sur loopback et un port libre,
puis démarre Chromium avec son sandbox Linux activé pour afficher une petite
page synthétique. Elle ne publie aucun port et ne crée aucune capture du projet.
Elle ne remplace pas la [vérification visuelle du vrai site](verification-visuelle.md).

Un contrôle réussi dans le serveur Mergeron ou dans le conteneur **ne prouve pas**
qu’il réussira dans le sandbox d’un tour de l’agent. Une erreur `EPERM` ou `EROFS`
doit être signalée et traitée par une autorisation adaptée, pas contournée.
Le contrôle ne s’exécute pas automatiquement côté serveur : les consignes
communes par défaut demandent à l’agent de l’exécuter avant ces travaux. Les
consignes personnalisées de l’administrateur ne sont pas écrasées ; y ajouter
la commande si nécessaire.

Un refus de `networkInterfaces()` par le filtre du CLI n’est pas corrigé par
une fausse liste d’interfaces ou un patch Fastify. Le [runtime Codex géré et
protégé](operations/managed-codex-runtime.md) fournit la capacité ciblée
`netlink-route-query-v1`, avec provenance vérifiée et installation par le
Manager. Les nouvelles sessions doivent utiliser le runtime installé ; vérifier
à nouveau depuis le terminal de l’agent, sans désactiver les autres protections.

La disponibilité directe de npm/Corepack, les droits des caches et la présence
hors réseau de la version `packageManager` du projet sont des résultats distincts.
Un échec du dernier ne signifie pas que npm ou Corepack sont absents.

Le terminal de l’agent et le runtime de [prévisualisation](previsualisations-agents.md)
sont également distincts : un précontrôle vert ne valide pas les images approuvées,
le proxy ou l’installation des dépendances dans cette seconde instance. Pour
créer cet environnement, utiliser les outils MCP dédiés, pas un socket Docker
ou un conteneur privilégié dans le terminal.

## Réseau et résultat

Le DNS et le port du proxy ne prouvent pas qu’un domaine est autorisé. Pour une
URL de confiance nécessaire au travail, on peut ajouter explicitement :

```sh
mergeron-environment-check --url https://registry.npmjs.org/ --json
```

La requête HEAD utilise les variables de proxy et de confiance TLS existantes,
sans suivre les redirections et sans lire de `.curlrc`. Elle distingue les
erreurs DNS, de connexion, de certificat et les refus HTTP. Elle ne valide ni
une authentification applicative, ni toute l’installation des dépendances.
Les identifiants intégrés aux URL sont refusés. Les paramètres d’URL, les
identifiants du proxy, les journaux de Chromium et stderr des outils ne sont
pas reproduits dans le rapport.

La sortie est lisible, ou JSON avec `--json`. Aucun rapport n’est enregistré par
défaut. Les sondes d’écriture sont supprimées et les fichiers existants sont
conservés. Code de sortie `1` si une capacité demandée échoue ; les en-têtes
absents sont un avertissement, car les modules précompilés peuvent suffire.
Un proxy absent est indiqué comme non testé, jamais comme un accès direct validé.

## Régressions

```sh
node --test scripts/environment-check.test.mjs
bash scripts/smoke-test-document-isolation.sh mergeron:candidate
```

Le second test utilise exclusivement des données synthétiques, sans réseau
externe. Il vérifie réellement les caches, pnpm hors ligne, les en-têtes et le
contrôle visuel dans la frontière bwrap, en plus des protections existantes des
documents et données privées. Il ne prouve pas les droits d’un tour Core : il
faut aussi exécuter la commande depuis le terminal de cet agent après déploiement.

Références : [cache Corepack](https://github.com/nodejs/corepack#environment-variables),
[en-têtes node-gyp](https://github.com/nodejs/node-gyp#command-options).
