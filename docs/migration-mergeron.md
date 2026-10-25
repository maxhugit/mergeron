# Migration vers Mergeron

Le dépôt est `maxhugit/mergeron` et l’image officielle est
`ghcr.io/maxhugit/mergeron:latest` (ou un tag immuable `sha-…`).
Renommer un dépôt ne modifie ni les conteneurs déjà créés ni leurs montages.

## Données et configuration

Conserver exactement les chemins hôtes, les secrets et les valeurs de réseau
de l’installation. Les conversations, fichiers et la base ne doivent pas être
déplacés simplement parce qu’un exemple a changé de nom. Sauvegarder avant
toute migration, ne pas utiliser `down -v`, et ne pas lancer deux piles sur les
mêmes dossiers.

Le Dockerfile canonique est maintenant `Dockerfile` : il correspond à l’image
officielle durcie, non privilégiée, avec `HOME=/home/codex`.
Les installations construites historiquement avec une variante utilisant
`/root` doivent préparer une migration explicite de leurs montages avant de
changer de recette de build. Ne pas jeter le volume historique ni le monter
aveuglément sur le nouveau home. Les adaptations et anciens noms de fichiers
sont recensés dans [les adaptations facultatives](adapters/README.md).

## Réseaux et adoption

Renseigner `MERGERON_PROXY_NETWORK` avec le nom du réseau partagé déjà utilisé.
Conserver `MERGERON_STATE_ROOT` / `STATE_ROOT`, `DEPLOY_ROOT` et les montages
actuels. Reporter le dossier accessible aux agents dans `MERGERON_APPDATA_ROOT`.
Ne pas effacer `adoption.json` pour masquer une dérive.

Les anciens dépôts d’image autorisés restent reconnus uniquement pour permettre
l’identification et l’adoption d’une installation historique. Ils ne sont plus
des cibles de publication, des caches de build ou les valeurs par défaut.

## Docker Compose

La définition canonique est `deployment/compose.yml`, sans métadonnées
d’un panneau hôte. Copier et examiner la nouvelle définition avant de
l’appliquer. Garder le même nom de projet Compose et les mêmes chemins
persistants ; examiner `docker compose ... config` avant toute recréation.
Ne pas changer simultanément les noms de services, le propriétaire de la pile,
les chemins et les réseaux sans un plan de migration.

Attendre la publication de l’image souhaitée, vérifier son tag et sa révision,
puis utiliser le parcours du propriétaire choisi. Le Manager propose un plan,
une confirmation et une sauvegarde transactionnelle ; Compose conserve son
fichier d’environnement comme source de vérité. Reporter dans celui-ci toute
image installée par le Manager avant une prochaine recréation Compose.

Les anciennes images et sauvegardes restent disponibles pour un retour arrière.
Le changement de noms de fichiers du dépôt ne déplace pas les configurations
privées déjà installées sur l’hôte.
