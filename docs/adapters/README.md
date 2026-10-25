# Adaptations facultatives aux plateformes hôtes

Le [parcours Docker standard](../installation-portable.md) ne dépend d’aucun NAS
ni panneau d’administration particulier. Ces adaptations ne sont pas chargées
par défaut et ne modifient pas les protections, les réseaux ou les données.

## Unraid

- [Vue d’ensemble et exploitation historique](unraid.md)
- [DockerMan manuel](unraid-dockerman.md)
- [Compose Manager](unraid-compose.md)
- [Formulaire du Manager](../../deployment/docker-man/my-mergeron-manager.xml)
- [Formulaire du Manager Dev](../../deployment/docker-man/my-mergeron-dev-manager.xml)

Pour une pile créée par le Manager, le formulaire active explicitement
`MERGERON_HOST_INTEGRATION=unraid` pour les icônes, liens WebUI et terminaux.
Sans cette valeur, le Manager ne crée aucune métadonnée `net.unraid.*`.
Les dépendances gérées n’ont pas besoin de formulaires individuels.

Le formulaire Dev utilise le logo turquoise avec badge **DEV**, le préfixe
`mergeron-dev`, des chemins Appdata distincts et le canal `edge`. Il laisse
l’installation automatique désactivée : vérifier les chemins avant de l’activer.
Le formulaire standard conserve le logo cuivre de production.

L’icône des dépendances créées par le Manager est choisie automatiquement selon
`MERGERON_STACK_ENVIRONMENT` ; laisser `MERGERON_ICON_URL` vide pour ce choix,
ou fournir une URL personnalisée. Le fichier `.env.dev.example` indique l’icône
Dev explicitement pour que l’adaptateur Compose applique les mêmes métadonnées.
Les icônes des conteneurs déjà présents ne sont pas modifiées en place : mettre
à jour leur configuration par leur propriétaire habituel (DockerMan ou Compose),
sans supprimer les données. Un ancien `MERGERON_ICON_URL` explicite reste prioritaire.

Pour Compose, les métadonnées de cette plateforme sont isolées dans un fichier
additionnel :

```sh
docker compose --env-file deployment/.env \
  -f deployment/compose.yml \
  -f deployment/adapters/unraid/compose.yml config --quiet
```

Utiliser les mêmes options pour `up -d` si Compose est le propriétaire choisi.
Ne pas lancer en parallèle la création par Manager et par Compose.

Les variables historiques `MERGERON_UNRAID_APPDATA_ROOT` du Manager restent
acceptées par le module de compatibilité. Pour Compose, reporter l’ancienne
valeur `UNRAID_APPDATA_ROOT` dans `MERGERON_APPDATA_ROOT` avant de charger le
nouveau fichier générique. Les chemins d’une installation existante ne doivent
pas être remplacés par les nouvelles valeurs d’exemple. Conserver notamment
`MERGERON_PROXY_NETWORK=net_standard` et `/mnt/pool/...` si ce sont les valeurs
réellement utilisées ; aucun renommage réseau ni déplacement n’est automatique.

Les anciens noms de fichiers du dépôt (`Dockerfile.unraid`,
`deployment/compose.unraid.yml`) sont remplacés par `Dockerfile` et
`deployment/compose.yml`. Les fichiers déjà copiés dans Appdata ne changent pas
de nom automatiquement. Adapter vos commandes de build, sans supprimer les
volumes ni les dossiers persistants.
