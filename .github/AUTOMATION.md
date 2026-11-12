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

Les jobs de l’image applicative et de validation CLI sont épinglés sur le runner
GitHub `ubuntu-24.04`, en PR comme en publication. Ils vérifient des espaces de noms
Bubblewrap imbriqués : un changement de politique AppArmor de `ubuntu-latest`
(Ubuntu 26.04) a bloqué ces sondes. Ce choix de runner conserve les tests, les
profils, les montages protégés et les restrictions du conteneur ; il ne désactive
aucune protection sur l’hôte ou dans l’image publiée. Une migration du runner doit
valider ces sondes avant de changer cette référence.

Les tests du Manager exécutés avant publication utilisent la même version précise
de Node 22 que la validation source, conformément à son image Node 22. La version
de Node préinstallée sur le runner n’est pas un contrat de runtime : Node 24 a
notamment révélé une différence de précision des horodatages dans les tests de
restauration. Les assertions de sauvegarde restent intégrales ; aucun arrondi ni
tolérance supplémentaire ne remplace ce choix explicite de runtime.

Voir [Versions et publications](../docs/publications.md) et
[Contribuer](../CONTRIBUTING.md). Les mesures et protections sont détaillées dans
[Performance et stabilité du code](../docs/performance-et-stabilite.md).
