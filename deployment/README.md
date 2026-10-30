# Fichiers de déploiement Mergeron

Commencer par [Installer Mergeron](../docs/installation.md).
**Le Manager est le seul parcours d’installation pris en charge.**
Il crée lui-même les dépendances ; aucun déploiement Compose parallèle ou
formulaire individuel de dépendance n’est nécessaire.

- [manager.env.example](manager.env.example) : paramètres à copier hors du dépôt.
- [Référence des variables](../docs/variables-manager.md) : rôle, défaut et effet.
- `config/` : modèles livrés dans l’image du Manager.
- `docker-man/` et `adapters/` : adaptations facultatives à un panneau hôte.

Les définitions Compose restent des ressources techniques du dépôt et des
vérifications automatisées, pas une seconde procédure d’installation utilisateur.
Le développement du code suit [Contribuer](../CONTRIBUTING.md).

Le proxy HTTPS et le SSO facultatif sont indépendants des produits choisis.
Les secrets, configurations privées et données persistantes ne sont jamais
à enregistrer dans ce dépôt.
