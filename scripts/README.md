# Construction vérification et maintenance

Ce répertoire rassemble les commandes de construction, les contrôles de livraison
et les outils de maintenance de Mergeron. Certains sont exécutés par la CI ou dans
les images ; d’autres demandent une intervention explicite de l’administrateur.

## Familles de commandes

- `build-*`, `package-*`, `promote-*` et `release-version.*` préparent les
  composants et contrôlent leur publication.
- `check-*`, `audit-*`, `verify-*` et leurs tests vérifient le contenu du dépôt
  et les évaluations de sécurité.
- `benchmark-project-dashboard.mjs` compare le calcul du tableau de bord à un
  commit local sur des données synthétiques, sans démarrer de service.
- `smoke-test-*` et `test-*` valident des fonctions réelles dans des fixtures
  contrôlées. Les scripts de conteneurs nettoient uniquement leurs propres ressources.
- `environment-check.*` et `visual-check.*` vérifient le contexte d’exécution
  et le rendu web des agents.
- `preview/` prépare une copie de test du vrai projet Mergeron, avec données et
  configuration distinctes de l’installation utilisée au quotidien.
- Les outils de configuration, de provisionnement et de migration sont réservés
  à une opération d’administration identifiée.

Ne pas exécuter tous les scripts en bloc : certains construisent des images,
installent un CLI, modifient une configuration ou contactent un service externe.
Les essais natifs avec accès externe sont réservés à la CI isolée. Les secrets,
captures privées et sorties contenant des données de compte restent hors de Git.

Voir [Contribuer](../CONTRIBUTING.md),
[Environnement des agents](../docs/environnement-agents.md) et
[Versions et publications](../docs/publications.md).
