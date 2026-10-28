# Vérification visuelle dans l’environnement des agents

L’image Mergeron contient `playwright-core` (version exacte du verrou npm), ses
bibliothèques Debian 13 et le Chromium headless correspondant. La commande
`mergeron-visual-check` fonctionne depuis n’importe quel dossier de travail.
Elle utilise le paquet de l’application, pas un `npx` susceptible de télécharger
une autre version. Aucun `apt install` ni téléchargement de navigateur n’est
nécessaire au démarrage d’un agent.

## Consigne commune et paramétrage

Par défaut, Mergeron transmet automatiquement aux agents de travail une consigne
de vérification du **vrai site**, en ordinateur et mobile, suivie de l’ouverture
et de l’examen réel des deux captures. Le test autonome ne remplace pas ce
contrôle. L’agent doit signaler les blocages, ne pas contourner les permissions
et distinguer dans son compte rendu les assertions exécutées de l’examen visuel.

Un administrateur peut consulter et modifier ce texte dans **Paramètres → Codex
→ Instructions → Consignes communes aux agents**, même sans compte Codex
connecté. Le bouton d’enregistrement de cette section est indépendant de celui
des paramètres natifs Codex. La restauration du texte par défaut prépare un
brouillon à enregistrer ; un texte vide désactive explicitement ces consignes.
La limite est de 12 000 caractères. Ne pas y placer de secrets : le texte est
transmis à tous les agents de travail de cette instance.

Le réglage `general.agentInstructions` est conservé dans la base de paramètres
persistante, sans changer les fichiers `AGENTS.md`, les consignes des projets ou
les permissions. Il est relu à chaque nouvel échange, y compris pour les agents
déjà créés ; un échange en cours n’est pas modifié et aucun redémarrage n’est
nécessaire. Les conversations simples ne sont pas des agents de travail. Cette
consigne n’est pas une garantie technique d’exécution : si l’outil, le serveur,
les droits ou la consultation des images ne sont pas disponibles, l’agent doit
le dire au lieu de prétendre avoir vérifié le rendu.

## Validation autonome

Dans le conteneur de l’agent, avec son utilisateur habituel :

```sh
mergeron-visual-check --smoke --output /workspaces/visual-smoke
```

Le test sert une petite page HTML sur une adresse loopback et un port libre,
vérifie le titre visible puis produit :

- `desktop.png` : fenêtre 1440 × 900, capture de toute la page ;
- `mobile.png` : émulation Chromium Pixel 7 (412 × 839), capture de toute la page ;
- `report.json` : versions, URL sans paramètres sensibles, dimensions et tailles.

Le code de sortie n’est zéro que si les deux pages répondent correctement, si
l’élément attendu est visible et si les deux fichiers PNG ont réellement été créés.
La capture ne démontre pas à elle seule l’absence de défaut visuel : l’agent doit
ensuite ouvrir les deux images et examiner le résultat.

## Vérifier un site de travail

Exemple Vite, après installation des dépendances du site :

```sh
cd /workspaces/mon-site
mergeron-visual-check \
  --start 'pnpm dev --host 127.0.0.1 --port 4173 --strictPort' \
  --url http://127.0.0.1:4173 \
  --selector 'h1' --text 'Bienvenue' \
  --output artifacts/visual-check
```

Adapter le sélecteur et le texte à un vrai élément de la fonctionnalité testée.
La commande démarre le serveur, attend une réponse HTTP réussie (60 secondes
maximum, réglable avec `--timeout`), visite la page dans les deux formats puis
arrête le serveur et ses descendants, même en cas d’échec. `server.log` conserve
sa sortie pour diagnostiquer un démarrage raté. Si le serveur existe déjà,
omettre `--start`. `--cwd` permet de choisir le dossier de travail du serveur.

Les captures sont dans le dossier de travail de l’agent ; les joindre au rapport
ou au chat si nécessaire. Elles peuvent contenir des données confidentielles.
Ne pas publier automatiquement les captures ni le journal du serveur.

## Réseau et proxy

`127.0.0.1` convient lorsque le serveur et Chromium tournent dans le **même
conteneur**, ce qui est le cas avec `--start`. La commande reprend `HTTPS_PROXY`
(ou `HTTP_PROXY`) et `NO_PROXY`, y compris leurs variantes minuscules. Les tests
locaux n’ont pas besoin de sortir sur Internet.

Si le site tourne dans **un autre conteneur**, utiliser un réseau Docker commun
autorisé et son nom de service, par exemple `http://site-preview:4173`. Le site
doit écouter sur `0.0.0.0`, pas seulement sur son propre loopback. Ajouter
`site-preview` à `NO_PROXY` pour ne pas envoyer cette requête locale au proxy
public. Ne pas publier de port ni joindre le réseau de production pour cela.
Un hôte de développement se joint par une passerelle explicitement configurée,
pas par `localhost`.

Le proxy applicatif DEV peut refuser `cdn.playwright.dev` : ce n’est pas un
problème à l’exécution, les binaires sont déjà dans l’image. Lors de la
**construction**, le CLI télécharge la version correspondante par HTTPS via le
réseau autorisé du constructeur. Si ce constructeur utilise un proxy filtrant,
autoriser précisément les domaines des téléchargements Playwright et leurs
redirections. Ne pas désactiver TLS ni transmettre des identifiants de proxy
dans des arguments Docker persistants. Les bibliothèques viennent des dépôts
Debian configurés par l’image.

## Persistance et sécurité

`Dockerfile` installe les bibliothèques en tant que root pendant la construction,
puis copie les navigateurs dans `/opt/mergeron-playwright`. Ce chemin est dans
l’image, **hors du volume `/home/codex`** : une ancienne installation persistante
ne masque donc pas le navigateur d’une nouvelle version. Le paquet et Chromium
sont toujours mis à jour ensemble. Recréer le conteneur depuis cette image
conserve la capacité de test, et les résultats placés dans `/workspaces` restent
sur le volume de travail.

Chromium fonctionne avec le sandbox activé sous Linux et l’UID 11002, sans
`--privileged`, `SYS_ADMIN`, `--no-sandbox`, TLS ignoré ni IPC de l’hôte. Le profil
seccomp fourni autorise les namespaces nécessaires ; une installation qui les
interdit échoue explicitement, sans repli moins sécurisé. La commande est prévue
pour les sites de travail de confiance : pour visiter des pages non fiables,
utiliser le service Browser isolé, qui reste distinct.

Sur une pile DEV existante, déployer d’abord le Manager de cette version : lors
de la mise à jour vers une image portant le label `io.mergeron.agent-visual-testing=1`,
il ajoute seulement l’autorisation seccomp `chroot` nécessaire au sandbox. Il
préserve les autres restrictions, refuse un profil incompatible et garde le
profil initial pour le retour arrière. Cette migration automatique ne s’applique
ni à la production, ni aux autres conteneurs, ni aux anciennes images. Pour une
nouvelle installation Compose, le profil fourni contient déjà cette autorisation.

Validation de l’image avec les protections Docker et sans accès réseau externe :

```sh
bash scripts/smoke-test-visual-image.sh mergeron:candidate artifacts/visual-image
node --test scripts/visual-check.test.mjs
```

Le test d’image vérifie aussi la vraie page `/login` de Mergeron : il démarre le
serveur compilé, avec une base SQLite temporaire et sans identifiants réels,
attend l’URL et vérifie le formulaire visible dans les deux formats. Les preuves
sont regroupées dans `local/` et `mergeron/`. Il ne monte aucune donnée du serveur
actif et supprime uniquement le conteneur et le volume de test qu’il a créés.

Références : [navigateurs Playwright](https://playwright.dev/docs/browsers),
[Docker](https://playwright.dev/docs/docker),
[captures](https://playwright.dev/docs/screenshots).
