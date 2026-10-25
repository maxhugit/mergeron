# Déploiement Docker

Ce dossier contient les définitions reproductibles des trois conteneurs
applicatifs de Mergeron et du Manager local chargé de leur installation sûre.

Lire d’abord [l’installation portable](../docs/installation-portable.md).
Le fichier `compose.yml` fonctionne avec Docker Compose sur Linux ;
aucune métadonnée de panneau d’administration n’y est ajoutée. Adapter les chemins dans
`.env.example` (ou `.env.dev.example` pour une recette séparée).

Les intégrations aux interfaces hôtes sont des
[adaptations facultatives](../docs/adapters/README.md), désactivées par défaut.
Le Manager crée lui-même ses dépendances lorsqu’il est le propriétaire choisi.

Les deux modes déploient la même architecture et utilisent les mêmes données,
mais ne doivent pas être lancés simultanément. Leur comparaison, leurs sources
de configuration et la procédure de migration sont détaillées dans
[`docs/choisir-mode-installation.md`](../docs/choisir-mode-installation.md).

La documentation complète commence dans
[`docs/README.md`](../docs/README.md). La procédure pas à pas se trouve dans
[la procédure Docker](../docs/installation-docker.md).

Les secrets et les données persistantes ne sont volontairement pas versionnés.
Le Manager crée les éléments manquants lorsque `MERGERON_INSTALL_ENABLED=true`,
mais ne remplace jamais un fichier ou un dossier existant. Le réseau externe
sélectionné par `MERGERON_PROXY_NETWORK` doit être créé au préalable
(`mergeron-proxy` par défaut). Aucun nom de réseau personnel n’est imposé.

Traefik n’est qu’un exemple de reverse proxy. Le modèle `nginx.conf.template`
conserve le contrôle Authentik historique ; `nginx.native.conf.template`
utilise les sessions Mergeron/OIDC sans Authentik. La sélection du Manager
(`MERGERON_AUTH_MODE`) ne remplace jamais un modèle déjà présent. Compose
sélectionne explicitement son modèle via `MERGERON_NGINX_TEMPLATE`.
