# Historique des versions dans le guide

La page **Documentation de Mergeron → Historique des versions** (`/help#guide/version-history`) affiche une frise verticale des tags publiés, du plus récent au plus ancien, avec leur date de publication UTC, un résumé fonctionnel en français ou anglais et un lien vers les notes GitHub. Elle ne lance pas de requête GitHub en arrière-plan et n’envoie aucune information d’installation.

Les articles du guide décrivent le code embarqué dans l’installation. L’historique décrit uniquement les versions taguées : une fonctionnalité fusionnée après le dernier tag ne doit pas apparaître dans son résumé. La version réellement installée se consulte dans **Serveur → Version actuelle**.

## Maintenir la frise lors d’une publication

1. Vérifier le tag et la date de publication dans les Releases GitHub, puis examiner les changements depuis le tag précédent.
2. Ajouter une entrée en tête de `web/src/components/guide/version-history.json` avec `tag`, `date` (`AAAA-MM-JJ`, UTC) et `highlights.fr` / `highlights.en`. Résumer les améliorations majeures en langage utilisateur ; ne pas recopier toute la liste des commits.
3. Mettre à jour les articles concernés dans `manual.fr.json` et `manual.en.json`, avec les mêmes identifiants et liens. Retirer les anciennes consignes devenues fausses, en particulier celles qui pourraient conduire à une opération destructive.
4. Lancer les tests du contenu et de la route d’aide, les tests navigateur de la frise, la validation des catalogues et les budgets frontend. Vérifier visuellement le rendu mobile et ordinateur.

Les données sont versionnées avec l’application : elles restent consultables sans accès GitHub. Le lien externe est construit uniquement pour un tag du catalogue embarqué. La recherche du guide indexe également les tags et résumés de la frise. Cette page n’est pas un inventaire de déploiement ni une commande de mise à jour.
