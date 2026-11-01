# Évolution de la base de données

Ce répertoire permet à une installation Mergeron de retrouver ses projets,
conversations, droits et documents après une évolution du logiciel. Il décrit
comment faire évoluer la structure SQLite sans repartir d’une base vide.

## Contenu

- Les fichiers SQL numérotés sont les migrations successives.
- `meta/` conserve le journal et les instantanés nécessaires aux outils Drizzle.
- Le schéma courant est défini dans [src/database/schema.ts](../src/database/schema.ts).

Une ancienne migration reste nécessaire pour mettre à niveau une ancienne
installation et pour créer les bases utilisées par les tests. Ne pas la supprimer
ou la réécrire parce que sa date est ancienne ; ajouter une nouvelle migration.
La base réelle et ses sauvegardes vivent hors du dépôt et ne doivent pas être commitées.

Voir [Sauvegarde et restauration](../docs/sauvegarde-restauration.md).
