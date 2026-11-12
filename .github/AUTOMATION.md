# Automatisation GitHub

Retour à la [présentation générale de Mergeron](../README.md).

Ce répertoire organise la validation des changements, la publication des images
et le recueil des demandes des utilisateurs. Il permet de vérifier une modification
avant sa fusion et de publier des composants identifiables par leur révision.

## Contenu

- `workflows/quality.yml` exécute les contrôles de code, tests et constructions isolées.
  Le backend, le frontend et la suite Chromium/WebKit sont validés en parallèle ;
  tous les fichiers de tests navigateur sont découverts automatiquement et répartis
  en deux shards, chacun conservant Chromium et WebKit. Leur couverture exacte
  est vérifiée avec le séquenceur Vitest installé.
- `workflows/docker-publish.yml` construit, vérifie et promeut les images de
  l’application, du Manager et du navigateur, ainsi que les publications associées.
  Pour un tag du même SHA récemment publié sur `main`, un contrôle de preuve
  peut réutiliser les tests source ; sinon la suite complète est exécutée.
  Les images stables et leurs protections sont toujours vérifiées de nouveau.
- `workflows/cleanup-ghcr.yml` applique la politique de conservation du registre.
- `ISSUE_TEMPLATE/`, le [modèle de pull request](PULL_REQUEST_TEMPLATE.md) et `release.yml` structurent les
  demandes, les revues et les notes de version.

La publication d’une image n’est pas une mise à jour d’une installation existante.
Ne jamais remplacer un contrôle en échec par sa désactivation. Les permissions,
versions épinglées et séparations entre caches de PR et de `main` sont des protections.

Voir [Versions et publications](../docs/publications.md) et
[Contribuer](../CONTRIBUTING.md). Les mesures et protections sont détaillées dans
[Performance et stabilité du code](../docs/performance-et-stabilite.md).

Les jobs qui vérifient le sandbox natif imbriqué (image Application et CLI,
avant fusion et pendant la publication) utilisent explicitement `ubuntu-24.04`.
Le changement d'hôte derrière `ubuntu-latest` ne doit pas modifier implicitement
les conditions de validation de Bubblewrap et des espaces de noms utilisateur.
Une migration de cette base nécessite de vérifier de nouveau ces mêmes tests ;
les protections Docker, les assertions et les scans restent obligatoires.
