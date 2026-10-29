# Prévisualisations des projets et synchronisation des agents

Chaque agent de travail peut lancer une instance de test de son projet et l’ouvrir
directement sur `https://<identifiant>.preview.hugotlab.fr`. L’instance utilise les
fichiers actuels de sa copie de travail, y compris les changements non commités.
Elle ne publie aucun port Docker sur l’hôte et ne partage ni base de production,
ni connexion Codex, ni jeton Git, ni dossier personnel de Mergeron.

Le service reste désactivé par défaut. Il convient aux projets capables de
démarrer dans une image Linux autorisée, avec un port HTTP principal. Le profil
du projet définit ses commandes et ses services ; aucun lancement n’est codé
spécialement pour le dépôt Mergeron.

## Configurer le domaine et le proxy une seule fois

Dans la zone DNS active de `hugotlab.fr`, créer un CNAME dont le sous-domaine est
`*.preview` et la cible le nom public du reverse proxy, par exemple
`mergeron-dev.hugotlab.fr.` si ce nom mène déjà à ce proxy. Le CNAME ne change
pas l’adresse visible dans le navigateur et ne configure pas le routage HTTP.

Le reverse proxy doit ensuite accepter `*.preview.hugotlab.fr` et transmettre
les requêtes à l’ingress Mergeron sur son port interne 8080, en conservant
`Host` et les mises à niveau WebSocket. Utiliser un certificat couvrant
`*.preview.hugotlab.fr` ; un certificat limité à `*.hugotlab.fr` ne couvre pas
ces noms. Avec Let’s Encrypt, le certificat wildcard utilise DNS-01. Limiter
les droits du jeton DNS à la validation du certificat et ne jamais le transmettre
aux agents ou aux instances de test.

Les modèles nginx fournis dans `deployment/config/` contiennent un serveur
distinct pour les hôtes des aperçus, qui joint le port interne 8173 de
l’application. Il n’injecte pas le jeton serveur ni l’identité de Mergeron.
Le port 8173 ne doit pas être publié sur l’hôte.

Sur une installation existante, le Manager préserve les fichiers de configuration
persistants. Reporter uniquement le nouveau bloc de prévisualisation dans le
modèle nginx existant et ajouter `MERGERON_PREVIEW_DOMAIN` à son `envsubst`,
en conservant les personnalisations d’authentification. Le backend refuse de
servir l’interface Mergeron sous un hôte de prévisualisation si l’ancien ingress
lui transmet encore ces requêtes.

Il n’existe pas de route `/preview/<id>` sur l’origine Mergeron. Le bouton
« Ouvrir l’aperçu » ouvre directement l’origine de l’instance. Une courte étape
d’autorisation se déroule sur cette même origine, retire le jeton à usage unique
de l’adresse, puis affiche la page du projet.

## Activer le service et autoriser les images

Définir dans le Manager et l’application :

```dotenv
MERGERON_PREVIEWS_ENABLED=true
MERGERON_PREVIEW_DOMAIN=preview.hugotlab.fr
```

L’application doit également disposer de son `MERGERON_PUBLIC_URL` HTTPS
canonique. Le compose et l’installateur transmettent ces deux réglages aux
nouvelles instances. Une installation déjà présente doit être recréée avec ces
variables pour les appliquer ; un simple changement du profil d’un projet
n’active pas le service sur le serveur.

Dans le Manager uniquement, renseigner `MERGERON_PREVIEW_IMAGES` avec un objet
JSON de runtimes autorisés. Chaque image doit être épinglée par digest, disponible
localement et adaptée à une exécution non privilégiée avec un système racine en
lecture seule. Exemple de structure, dont les digests doivent être remplacés :

```json
{
  "node": {
    "image": "registre.example/node-sdk@sha256:<digest_de_64_caracteres>",
    "description": "Node avec les outils du projet"
  },
  "python": {
    "image": "registre.example/python-sdk@sha256:<digest_de_64_caracteres>",
    "description": "Python"
  }
}
```

Le processus principal utilise l’UID et le GID 11002. Un service associé peut
déclarer un autre `user` non root et des répertoires `tmpfs` approuvés dans le
catalogue, par exemple `user: "999:999"` et `tmpfs: ["/var/lib/postgresql"]`.
Le profil de projet choisit une entrée de ce catalogue, jamais une image,
un montage hôte, une capacité Linux ou un réseau Docker arbitraire.

Docker 28 ou plus récent est requis pour les ponts internes en mode `isolated`.
Un pont simplement `internal` conserve une adresse de passerelle sur l’hôte et
ne remplace pas cette protection. Le Manager refuse de se rabattre sur ce mode.

## Définir le profil du projet

Dans les paramètres du projet, ouvrir « Environnement de test ». Un
administrateur définit le runtime, le sous-dossier relatif, les commandes
d’installation et de compilation, la commande de démarrage, le port interne,
la page initiale et le mode de synchronisation.

Pour un projet Vite, le lancement peut être
`npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`, avec le port 5173 dans
le profil. Le Manager ajoute uniquement le nom exact de l’instance aux hôtes
autorisés par Vite. Ne pas désactiver globalement `allowedHosts` ou CORS.
Le proxy prend en charge les WebSockets sur le même port HTTPS public.

Pour un serveur Python statique, une commande telle que
`python3 -m http.server 8000 --bind 0.0.0.0` utilise le port 8000.
Les autres technologies utilisent leur propre image SDK et leurs commandes.
Une compilation nécessitant Docker ou des privilèges supplémentaires reste
hors de ce premier profil : le socket du Manager n’est pas exposé au runtime.

Les variables et les services associés sont configurés sous forme JSON. Les
valeurs sont chiffrées au repos avec la clé de connexion de Mergeron et liées
au projet. Après enregistrement, `[stored]` permet de conserver une valeur sans
l’afficher. Ne renseigner que des comptes et des données de test. La détection
de fichiers sensibles ne peut pas reconnaître un secret arbitraire écrit dans
le code source.

## Utiliser et actualiser un aperçu

Le bouton en forme de fiole, dans la barre des vues de l’agent, permet de
démarrer, ouvrir, synchroniser, recréer ou arrêter l’instance et de consulter
ses journaux. Le lancement et l’administration des profils sont réservés aux
administrateurs ; les membres autorisés du projet peuvent consulter l’aperçu.

Les sources sont vérifiées toutes les deux secondes pendant l’exécution.
Un transfert n’a lieu que si leur empreinte change. Les fichiers identiques
ne sont pas réécrits ; les ajouts, modifications et suppressions sont appliqués
dans la copie de test, sans écriture en retour vers le dossier de l’agent.

- `hot` conserve le processus. Le serveur de développement du projet applique
  son rechargement à chaud, si disponible.
- `restart` relance le processus après la synchronisation et réexécute ses
  commandes. Pour un serveur sans rechargement de page, actualiser le navigateur.
- `manual` attend le bouton « Synchroniser maintenant » ou l’opération MCP
  correspondante.

Un changement de dépendances signale qu’une recréation peut être nécessaire.
Un changement de profil ou de dossier de travail suspend la synchronisation
automatique jusqu’à la recréation. Le contrôle d’accès du propriétaire du
lancement est réévalué avant les transferts automatiques.

Les outils MCP `project_preview_read` et `project_preview_manage` utilisent le
projet et l’agent liés au bail de la conversation. Ils n’acceptent pas de commande,
d’image ni de secret dans leurs arguments. La gestion requiert un échange
autorisé en écriture et une demande utilisateur ; elle ne contourne pas les
permissions d’une session en lecture seule.

## Isolation et limites

Deux instances peuvent être actives simultanément sur une installation. Chaque
instance dispose de son propre réseau privé sans adresse de pont sur l’hôte,
de son volume source temporaire plafonné à 1 Gio, de ses limites CPU, mémoire
et processus, et de services de test temporaires. L’expiration est de 60 minutes
par défaut, configurable entre 5 et 240 minutes. Arrêter ou recréer une instance
supprime ses données temporaires, jamais les sources, les livrables, leurs
versions ou les sauvegardes du Manager.

L’export accepte jusqu’à 50 Mio de fichiers réguliers, 16 Mio par fichier et
15 000 entrées. Il refuse les liens symboliques, liens physiques et fichiers
spéciaux. Les dossiers Git, caches, dépendances, sorties de compilation et
fichiers sensibles usuels sont exclus. Les parcours de synchronisation utilisent
des descripteurs de dossiers sans suivi de liens, y compris si l’application de
test essaie de remplacer un dossier par un lien pendant son exécution.

Le runtime n’a pas de réseau sortant direct. Un proxy dédié autorise des domaines
publics approuvés, vérifie et épingle leurs adresses DNS et refuse les réseaux
privés. `MERGERON_PREVIEW_ALLOWED_DOMAINS`, côté Manager, permet de définir cette
liste ; les valeurs par défaut couvrent npm, PyPI et les téléchargements GitHub.
Les téléchargements ne doivent pas nécessiter d’identifiants de production.

L’accès navigateur utilise une autorisation de lancement à usage unique de
60 secondes puis un cookie HTTPS personnel limité à l’hôte, valable au plus
30 minutes et jamais au-delà de la durée de l’instance. Les droits du projet
sont vérifiés sur chaque requête et régulièrement sur les WebSockets ouverts.
Connaître l’URL n’autorise pas à lire le site : ouvrir l’aperçu depuis Mergeron
pour obtenir une nouvelle autorisation.

Avec le service activé, les cookies de session, de flux OIDC et d’usurpation
administrative de Mergeron utilisent le préfixe `__Host-`. Une reconnexion est
nécessaire pour les anciennes sessions. L’origine canonique est exigée pour
les requêtes de navigateur modifiantes et les connexions WebSocket authentifiées.

Les cookies serveur d’une application de test sont renommés et limités à son
hôte avant stockage, puis retrouvent leur nom en amont. Aucun cookie de domaine
parent, d’authentification Mergeron ou du gateway n’est transmis au projet.
Une application lisant directement `document.cookie` doit tenir compte de cette
isolation ; les sessions serveur HttpOnly restent utilisables.

## Vérifications automatisées

Les tests unitaires couvrent les contrats de profils, le chiffrement et les
droits, l’export filtré, les autorisations du gateway, la synchronisation et la
suppression d’objets étiquetés. Les tests de navigateur vérifient séparément
l’interface et sa disposition sur ordinateur et mobile.

`scripts/smoke-test-agent-previews.sh` réserve la validation complète du Manager
à un runner GitHub éphémère : deux projets Node et Python, une mise à jour sans
recréation, les WebSockets, le refus du réseau privé, les liens malveillants et
le contrôle d’accès. Le contrôleur de ce test utilise le socket du runner isolé,
jamais celui d’Unraid, de Dev ou de production. Les runtimes testés ne le montent
pas. Le service de prévisualisation normal demeure désactivé tant que sa
configuration serveur n’a pas été appliquée.
