# Audit de neutralité du déploiement

## Parcours standard

| Zone                  | Contrat vérifié                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Checks de publication | Nom de workflow « Build and publish Mergeron images »                                       |
| Image officielle      | Un seul `Dockerfile` canonique durci ; Manager dans `Dockerfile.manager`                    |
| Build et caches CI    | Références aux fichiers génériques et au dépôt GHCR Mergeron                                |
| Déploiement           | `deployment/compose.yml`, sans labels d’un panneau hôte                                     |
| Manager               | Trois réseaux privés ; réseau externe configurable ; intégration hôte désactivée par défaut |
| Stockage              | Chemins Linux paramétrables, aucune dépendance au nom d’un pool                             |
| Interface             | Configuration serveur, sans déduire le système hôte d’une clé externe                       |
| Documentation         | Installation Docker standard ; adaptations isolées dans `docs/adapters/`                    |

`scripts/test_deployment_portability.py` vérifie les noms des workflows, les
fichiers canoniques, les documents génériques et l’absence de référence à un
produit hôte dans le code d’exécution ou les traductions. Le contrôle est
exécuté dans le pipeline de qualité pour les PR et les fusions.
Les tests du Manager vérifient également l’absence de labels hôtes par défaut
et leur activation uniquement par une intégration explicite.

## Références conservées intentionnellement

- Adaptateurs, métadonnées facultatives, XML et procédures propres aux panneaux
  hôtes : uniquement dans [les adaptations](adapters/README.md).
- Ancien nom de variable d’environnement : accepté dans le module d’intégration
  pour ne pas changer un montage existant.
- Ancien dépôt d’image : reconnu dans le manifeste pour la compatibilité
  d’adoption, jamais utilisé comme publication ou cache CI.
- Tests de migration : références historiques explicites pour vérifier cette
  compatibilité, pas des valeurs imposées aux installations neuves.

Le nom des checks **déjà exécutés** reste dans l’historique de la plateforme Git.
Le nouveau nom s’applique aux exécutions utilisant le workflow corrigé ; aucun
historique distant n’est supprimé ou réécrit.

## Limites et sécurité

L’image officielle cible Linux amd64 et un noyau permettant le sandbox non
privilégié. Cet audit ne constitue ni une publication ARM ni une recette réelle
sur tous les NAS et tous les reverse proxys. Les guides indiquent les paramètres
à choisir et la recette à exécuter avant exposition.

Aucun renommage automatique de réseau, déplacement de données, effacement
d’adoption ou changement de fournisseur d’identité n’est effectué. Les fichiers
privés existants restent conservés. Les [règles de migration](migration-mergeron.md)
priment sur les nouvelles valeurs d’exemple.
