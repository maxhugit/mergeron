# Suivi HTTP indépendant des mises à jour

Le suivi de mise à jour ne doit pas dépendre du conteneur qui redémarre. Deux
relais HTTP sans accès Docker se placent entre le proxy TLS existant (Traefik)
et l’ingress Mergeron. L’application et le Manager peuvent être remplacés sans
arrêter ces relais. Le proxy TLS externe reste hors de la transaction Mergeron.

## Accès et journal

Un administrateur ouvre une autorisation de suivi depuis l’API protégée
`POST /api/settings/manager/update/monitor`. Le Manager émet un jeton aléatoire
valable six heures ; seul son SHA-256 est conservé dans le répertoire public de
suivi. Le navigateur échange le jeton via `POST /_mergeron-update/session`, sous
contrôle de l’origine HTTPS exacte. Il reçoit un cookie Secure, HttpOnly,
SameSite=Strict limité au chemin `/_mergeron-update`. Les secrets ne passent
jamais dans l’URL ou le stockage local du navigateur.

`GET /_mergeron-update/status` exige ce cookie. Le service ne lit qu’un répertoire
de projections : identifiant d’opération, état, étape et horodatages. Aucun
acteur, chemin de sauvegarde, message Docker ou environnement n’y est copié.
La projection est écrite par renommage atomique à chaque étape de la transaction.
Une coupure du producteur conserve la dernière observation ; elle ne signifie
jamais que l’opération est terminée. La page réessaie avec attente progressive.

Pendant une transaction, les navigations HTML reçoivent une page de maintenance
HTTP 200. Les API fonctionnelles répondent temporairement 503 et Retry-After ;
les écritures ne sont jamais rejouées automatiquement. Les WebSockets applicatifs
peuvent se fermer lors du redémarrage : la continuité concerne l’accès HTTP et
le suivi, pas l’exécution de toutes les fonctions pendant une migration SQLite.

## Installation explicite sur l’hôte

Utiliser une image Manager immuable qui contient ces scripts :

```sh
node manager/scripts/install-update-gateway.mjs \
  --stack=mergeron-dev \
  --hostname=mergeron-dev.example.com \
  --image=ghcr.io/maxhugit/mergeron-manager@sha256:EMPREINTE_VERIFIEE \
  --state-root=/srv/mergeron-dev/state \
  --network=mergeron-proxy \
  --proxy-directory=/srv/traefik/dynamic
```

Les deux conteneurs doivent passer une vraie sonde HTTP avant l’écriture de la
configuration du fournisseur de fichiers Traefik. Chaque relais s’exécute sous
UID 65532, sans capacité Linux, avec système de fichiers en lecture seule,
limites mémoire/processus et un unique montage en lecture seule du répertoire
`manager-state/maintenance`. Il ne reçoit ni socket Docker ni journal privé.
Le nom public doit correspondre à la route TLS déjà autorisée. Le fournisseur de
fichiers doit être activé et le réseau partagé accessible depuis Traefik.

Après validation du routage, activer `MERGERON_UPDATE_MONITOR_ENABLED=true` dans
le Manager. L’interface établit alors la session de suivi avant de lancer une
mise à jour ; un échange échoué empêche son lancement. La fenêtre de suivi
contient une page indépendante et un lien pour l’ouvrir séparément.

Le relais est une nouvelle frontière réseau : le proxy extérieur ne doit pas
être arrêté par une mise à jour Mergeron. Une mise à jour des relais eux-mêmes
nécessite un retrait préalable du routage et une vérification de chaque nouvelle
instance ; ne pas remplacer les deux simultanément. Le script initial ne
constitue pas un mécanisme de remplacement à chaud garanti du proxy TLS externe.

## Remplacement supervisé du Manager

Lorsque le plan global inclut une image Manager immuable, son empreinte est liée
au fingerprint du plan applicatif. Le Manager vérifie son identité, son réseau
`none` et ses montages existants, puis lance un auxiliaire indépendant avant la
transaction. Cet auxiliaire utilise l’image actuellement installée, sans réseau,
avec racine en lecture seule, capacités supprimées et limites de ressources.
Son accès Docker reste réservé à ce processus de remplacement ; les relais HTTP
ne le reçoivent jamais.

Après réussite de la sauvegarde et de la transaction applicative, l’auxiliaire
renomme et arrête l’ancien Manager, puis crée le nouveau avec la spécification
existante : mêmes droits, secrets, montages, limites et réseau. Il attend le
contrôle Docker et une vraie réponse de la sonde Unix. Le conteneur précédent
reste conservé à l’arrêt. Les spécifications privées sont écrites en mode 0600,
avec synchronisation avant renommage du journal de remplacement.

Un échec de santé restaure le Manager précédent. L’état global reste
**intervention nécessaire**, car l’application a pu être mise à jour : cela ne
prétend pas avoir restauré toute la stack. Le retour arrière applicatif isolé
n’est pas proposé pour une opération qui a remplacé le Manager. Une modification
d’identité ou des protections après préparation bloque le remplacement ; aucun
conteneur étranger n’est écrasé. Une reprise de l’auxiliaire reconnaît ses propres
conteneurs par l’identifiant privé de remplacement.
