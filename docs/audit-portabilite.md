# Indépendance de l’environnement

Le parcours utilisateur est [l’installation par le Manager](installation.md).
Il exige Docker Linux amd64 et un noyau compatible avec le bac à sable, mais
aucun NAS, panneau d’administration, proxy HTTPS ou fournisseur SSO particulier.

| Sujet        | Contrat                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| Installation | Le Manager crée les dépendances ; aucune seconde procédure utilisateur Compose.      |
| Stockage     | Racine et dossiers accessibles aux projets configurables, sans nom de pool imposé.   |
| Entrée       | Proxy HTTPS au choix, raccordé à l’ingress sur 8080 par un réseau externe explicite. |
| Identité     | Compte local par défaut ; SSO OIDC facultatif sans fournisseur imposé.               |
| Hôte         | Métadonnées de panneau désactivées par défaut, isolées dans les adaptations.         |
| Sécurité     | Socket Docker réservé au Manager, stockage persistant et contrôles de santé.         |
| Options      | Navigateur distant et environnements de test activés explicitement.                  |

Les limites réelles figurent dans la [référence des variables](variables-manager.md).
Les tests du Manager contrôlent notamment l’absence de métadonnées hôtes par
défaut, l’isolation développement/production et les montages persistants.

L’indépendance de l’hôte ne constitue ni une publication ARM ni une validation
réelle sur toutes les distributions, tous les noyaux et tous les proxys.
Exécuter la [recette réseau et authentification](installation-portable.md#recette-avant-exposition)
sur l’hôte retenu. Aucun exemple ne déplace les données ni ne modifie
automatiquement votre proxy ou votre fournisseur d’identité.
