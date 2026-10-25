# Choisir le mode d’installation

Le parcours de référence est [l’installation portable](installation-portable.md).
Sur Unraid, privilégier le seul formulaire **Manager** : les dépendances sont
créées par le Manager sans formulaires individuels ni réconciliateur hôte.
La comparaison ci-dessous décrit les deux méthodes manuelles historiques,
toujours disponibles pour les installations qui les utilisent déjà.

La plateforme utilise les mêmes trois conteneurs applicatifs, auxquels s'ajoute
Mergeron Manager, avec les mêmes volumes, secrets et réseaux.
Seul le composant qui crée et met à jour les conteneurs change : les
formulaires Docker natifs d’Unraid, appelés ici **DockerMan**, ou le plugin
**Compose Manager**.

Les deux modes donnent les mêmes fonctions applicatives et le même niveau de
protection lorsque toutes les options sont conservées. Ils ne doivent jamais
être actifs simultanément, car ils utilisent les mêmes noms de conteneurs et les
mêmes données persistantes.

Pour une installation neuve, le Manager peut aussi créer directement les trois
conteneurs et les réseaux privés lorsque `MERGERON_INSTALL_ENABLED=true`. Ce
bootstrap ne doit pas être lancé en parallèle d'une création Compose ou
DockerMan. Une fois le plan appliqué, remettre la variable à `false` conserve
l'observation sans nouvelle création automatique.

## Comparaison

| Sujet                        | Formulaires DockerMan                                                        | Compose Manager                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Recommandation               | Choix par défaut pour l’exploitation quotidienne sur Unraid                  | Choix adapté à une stack gérée comme un ensemble                                                         |
| Dépendance                   | Fonction Docker native d’Unraid                                              | Plugin Compose Manager installé                                                                          |
| Source de configuration      | Quatre modèles XML importés puis enregistrés dans les formulaires Unraid     | `docker-compose.yml` et `images.env` dans l’Appdata                                                      |
| Présentation                 | Quatre conteneurs séparés dans l’onglet **Docker**                           | Une stack dans **Docker > Compose**, avec les quatre conteneurs également identifiables par leurs labels |
| Ordre de démarrage           | Squid, application, puis ingress ; les états de santé doivent être contrôlés | `depends_on` et les contrôles de santé décrivent l’ordre                                                 |
| Réseaux secondaires          | Ajoutés par le réconciliateur hôte après chaque recréation                   | Déclarés directement dans le fichier Compose                                                             |
| Après redémarrage Unraid     | Le réconciliateur doit être relancé avant une future recréation DockerMan    | Compose recrée directement la topologie déclarée                                                         |
| Mise à jour de l’application | **Check for Updates**, puis **Update** sur `mergeron-ui`                     | Modifier ou conserver `MERGERON_APP_IMAGE`, puis **Update Stack**                                        |
| Mise à jour Nginx/Squid      | Indépendante, conteneur par conteneur                                        | Incluse dans la mise à jour de la stack si de nouvelles images sont téléchargées                         |
| Retour arrière               | Remplacer le champ **Repository** par un tag `sha-<commit>`                  | Remplacer `MERGERON_APP_IMAGE` dans `images.env` par ce tag                                              |
| Portabilité                  | Très intégrée à l’interface Unraid                                           | Configuration déclarative plus simple à copier et comparer                                               |

## Architecture commune

Dans les deux modes :

1. `mergeron-squid` démarre sur `mergeron-isolated` et rejoint
   `mergeron-external` pour filtrer les sorties Internet ;
2. `mergeron-ui` démarre sur `mergeron-isolated` et rejoint `mergeron-admin` pour les
   services locaux autorisés ;
3. `mergeron-ingress` démarre sur `mergeron-isolated` et rejoint `mergeron-proxy`
   (nom configurable par `MERGERON_PROXY_NETWORK`) pour être joint par le proxy
   HTTPS choisi. Authentik ne le rejoint que si ce mode est utilisé.
4. `mergeron-manager` ne rejoint aucun réseau, crée uniquement les ressources
   manquantes autorisées, lit l'inventaire Docker et partage son socket Unix
   avec `mergeron-ui`.

Le backend `mergeron` ne publie aucun port sur l’hôte. Les répertoires de
`STATE_ROOT` contiennent les données durables et restent identiques lors d’un
changement de mode. Supprimer un conteneur n’efface pas ces dossiers, mais une
sauvegarde de `state/home` reste obligatoire avant une migration ou une mise à
jour importante.

## Choisir DockerMan

Choisir les formulaires lorsque l’objectif principal est d’utiliser le parcours
habituel d’Unraid : voir chaque conteneur dans l’onglet **Docker**, recevoir les
indications de mise à jour et modifier les paramètres dans les formulaires.

Cette méthode demande un processus hôte supplémentaire, le réconciliateur
réseau. DockerMan ne place qu’un réseau dans la commande de création initiale ;
le réconciliateur rattache donc les trois réseaux secondaires après chaque
création ou mise à jour. Il ne modifie ni les conteneurs étrangers ni la clé USB,
mais son mode `watch` doit être relancé après un redémarrage complet d’Unraid.

Procédure complète :
[Installation avec les formulaires DockerMan](installation-unraid-dockerman.md).

## Choisir Compose Manager

Choisir Compose Manager lorsque la priorité est de conserver la topologie dans
un fichier unique, de gérer les quatre services ensemble et de laisser Compose
créer directement toutes les connexions réseau. Aucun réconciliateur hôte n’est
nécessaire.

`docker-compose.yml` décrit les services et `images.env` contient les chemins,
les images et l’URL publique. Ces deux fichiers deviennent la source de vérité de
la stack. Une modification effectuée uniquement sur un conteneur depuis l’onglet
Docker peut être perdue à la prochaine recréation ; elle doit donc être reportée
dans ces fichiers.

Procédure complète :
[Installation avec Compose Manager](installation-unraid.md).

## Passer d’un mode à l’autre

Le changement de mode ne nécessite pas de convertir la base ou les workspaces :
les deux variantes montent les mêmes chemins. La séquence sûre est :

1. sauvegarder `STATE_ROOT/home` et noter le tag d’image actif ;
2. désactiver l’autostart du mode précédent ;
3. arrêter puis supprimer uniquement ses quatre conteneurs ;
4. conserver intégralement `STATE_ROOT` et les fichiers de configuration ;
5. installer le nouveau mode avec les mêmes chemins et secrets ;
6. vérifier les réseaux, les quatre états de santé et l’accès HTTPS ;
7. tester une conversation, un fichier, OnlyOffice, les MCP et SSH.

Ne jamais lancer une commande de suppression visant le dossier Appdata pendant
cette opération.
