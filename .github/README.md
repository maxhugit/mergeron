# Automatisation GitHub

Ce répertoire organise la validation des changements, la publication des images
et le recueil des demandes des utilisateurs. Il permet de vérifier une modification
avant sa fusion et de publier des composants identifiables par leur révision.

## Contenu

- `workflows/quality.yml` exécute les contrôles de code, tests et constructions isolées.
- `workflows/docker-publish.yml` construit, vérifie et promeut les images de
  l’application, du Manager et du navigateur, ainsi que les publications associées.
- `workflows/cleanup-ghcr.yml` applique la politique de conservation du registre.
- `ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md` et `release.yml` structurent les
  demandes, les revues et les notes de version.

La publication d’une image n’est pas une mise à jour d’une installation existante.
Ne jamais remplacer un contrôle en échec par sa désactivation. Les permissions,
versions épinglées et séparations entre caches de PR et de `main` sont des protections.

Voir [Versions et publications](../docs/publications.md) et
[Contribuer](../CONTRIBUTING.md).
