# Adaptations facultatives à l’hôte

Le [parcours Manager](../installation.md) ne dépend d’aucun NAS ni panneau
d’administration particulier. Ces adaptations changent uniquement la manière
de configurer ou d’afficher le Manager sur un hôte donné.

## Unraid

Voir [Installer le Manager sur Unraid](unraid.md).
Un seul formulaire suffit ; ne pas créer individuellement ses dépendances.

- [Formulaire Manager](../../deployment/docker-man/my-mergeron-manager.xml).
- [Formulaire Manager de développement](../../deployment/docker-man/my-mergeron-dev-manager.xml).

`MERGERON_HOST_INTEGRATION=unraid` ajoute des icônes, liens et terminaux à
l’interface hôte. Le mode générique reste `none`. Ces métadonnées ne changent
ni les réseaux, ni les données, ni l’authentification.

Le formulaire de développement utilise un préfixe, des chemins et une icône
distincts. Vérifier les paramètres avant d’autoriser l’installation. Laisser
`MERGERON_ICON_URL` vide pour l’icône adaptée à l’environnement.

Les [variables du Manager](../variables-manager.md) restent les mêmes quel que
soit l’outil utilisé pour créer son conteneur.
