# Choisir le propriétaire de l’installation

La pile comprend trois dépendances applicatives et un Manager local. Elle ne
nécessite aucun panneau d’administration de NAS. Choisir un seul propriétaire
pour créer les conteneurs et leurs réseaux ; les données ne changent pas de
format selon ce choix.

| Sujet                          | Manager                                                      | Docker Compose                                                                                 |
| ------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Création des dépendances       | Le Manager crée les ressources manquantes de son manifeste   | Compose crée les services déclarés                                                             |
| Premier démarrage              | `MERGERON_INSTALL_ENABLED=true`, puis `false` après contrôle | `docker compose up -d`, installation Manager désactivée                                        |
| Réseaux privés                 | Créés et vérifiés par le Manager                             | Déclarés dans `deployment/compose.yml`                                                         |
| Réseau du proxy HTTPS          | Réseau externe explicitement choisi et préexistant           | Même contrat                                                                                   |
| Source de configuration        | Variables et montages du conteneur Manager                   | Fichier Compose et `.env` privés                                                               |
| Mise à jour applicative        | Interface, plan et confirmation                              | Choisir l’image puis recréer avec Compose, ou gestion transactionnelle après adoption conforme |
| Données persistantes           | Dossiers hôtes explicitement montés                          | Mêmes dossiers hôtes                                                                           |
| Adaptations aux panneaux hôtes | Facultatives, désactivées par défaut                         | Surcharge de labels facultative                                                                |

Voir [l’installation Docker](installation-docker.md) pour les commandes et
[le contrat portable](installation-portable.md) pour le proxy et l’authentification.
Les [adaptations facultatives](adapters/README.md) ne sont pas des prérequis.

Ne pas faire créer simultanément les dépendances par Compose et le Manager.
Si Compose reste la source de vérité, reporter aussi toute image installée par
le Manager dans son fichier d’environnement avant une future recréation Compose.

Pour migrer, sauvegarder les données et noter les images, montages, noms,
réseaux et le propriétaire courant. Ne pas lancer une deuxième pile sur les
mêmes dossiers. Ne pas utiliser `down -v`, déplacer les données ou effacer
`adoption.json` pour contourner une dérive. Une migration de propriétaire ou
de noms doit être préparée séparément ; changer un exemple documentaire ne
constitue pas une migration automatique.
