# Versions et publications de Mergeron

## Politique de version

Mergeron reste en version majeure `0` pendant sa phase actuelle. Une version
stable respecte strictement `0.x.y` :

- `x` augmente pour une évolution fonctionnelle ou un changement incompatible ;
- `y` augmente pour une correction compatible ;
- les versions `1.x.y` et les préversions sont refusées par la validation CI.

Les versions de `package.json` et `web/package.json` doivent toujours être
identiques. La version initiale de cette politique est `0.1.0`.

### Choisir `x` ou `y` avec un flux uniquement basé sur les PR

Les PR de développement ordinaires ne changent pas nécessairement la version.
Quand un ensemble de PR est prêt à être publié, une dernière PR de préparation
met à jour les deux `package.json` :

- augmenter `x` et remettre `y` à zéro pour une nouvelle fonctionnalité ou un
  changement de comportement, par exemple `0.1.3` vers `0.2.0` ;
- conserver `x` et augmenter `y` pour une correction compatible, par exemple
  `0.2.0` vers `0.2.1`.

Après fusion de cette PR, le tag Git reprend exactement la version choisie,
par exemple `v0.2.1`. Plusieurs PR peuvent ainsi être regroupées dans une seule
publication.

## Canaux et tags Docker

| Source                  | Canal   | Tags publiés                             |
| ----------------------- | ------- | ---------------------------------------- |
| envoi validé sur `main` | continu | `edge`, `sha-<commit>`                   |
| tag Git validé `v0.x.y` | stable  | `latest`, `0.x.y`, `0.x`, `sha-<commit>` |

Le tag `latest` désigne donc uniquement la dernière version stable. Une image
précise doit être déployée avec `0.x.y` ou `sha-<commit>` pour garantir un
retour arrière reproductible.

Chaque image contient `/app/build-info.json` avec :

- la version Mergeron ;
- le commit Git complet ;
- la date UTC de construction ;
- le canal `edge` ou `stable`.

Les mêmes informations sont disponibles dans les labels OCI de l’image.
Chaque GitHub Release contient également `mergeron-release.json`, un manifeste
lisible par la plateforme avec la version, le commit, le nom de l’image, son
digest immuable et la date de publication.

## Consultation depuis Mergeron

L’onglet **Version actuelle** des réglages du serveur distingue la version
installée, sa révision et son canal des images disponibles dans le registre.
Le Manager vérifie l’application, le navigateur Mergeron, Ingress et Squid,
et détecte séparément sa propre image. Les versions des logiciels fournisseurs
sont affichées lorsqu’elles peuvent être vérifiées. Une erreur de consultation
reste un état inconnu et n’est jamais interprétée comme un composant à jour.

Le bouton d’actualisation relance la détection. Les actions de mise à jour
préparent un plan soumis à confirmation, puis sont exécutées par le Manager.
Le Manager lui-même doit être mis à jour sur l’hôte lorsque la console l’exige.
La publication d’une image ou d’une GitHub Release ne modifie pas une
installation existante.

Le **Journal des mises à jour** conserve les versions de départ et d’arrivée,
l’auteur connu de l’opération, ses dates et ses événements consultables.
Les améliorations affichées correspondent aux révisions effectivement
installées. L’onglet **Restauration** regroupe la stratégie de sauvegarde,
la rétention et les points de restauration disponibles. Voir
[le guide du Manager](mergeron-manager.md) et
[la sauvegarde et la restauration](sauvegarde-restauration.md).

## Préparer une publication

1. choisir la prochaine version `0.x.y` ;
2. mettre à jour les versions des deux `package.json` dans une PR ;
3. faire valider et fusionner cette PR dans `main` ;
4. attendre la réussite complète de la construction `main` ;
5. créer et pousser le tag `v0.x.y` sur ce commit de `main`.

Exemple :

```bash
git switch main
git pull --ff-only
git tag -a v0.2.0 -m "Mergeron 0.2.0"
git push origin v0.2.0
```

Le workflow refuse un tag qui ne correspond pas exactement aux versions des
deux paquets ou dont la version majeure n’est pas `0`.

## Validation et publication

Les PR et les merges sur `main` conservent la suite complète des tests de
source. Les commits testés ne sont pas identiques : une PR est vérifiée avec
sa base de fusion, puis le commit réellement intégré sur `main` est validé.

Pour un tag stable, le workflow peut réutiliser cette dernière validation de
source au lieu de relancer une troisième fois le backend, le frontend et les
deux séries Chromium/WebKit. Cette optimisation exige simultanément :

- le **même SHA complet**, dans le même dépôt et le même workflow de publication ;
- un lancement `push` sur `main`, jamais une PR, un fork, un autre tag ou un
  déclenchement manuel ;
- la plus récente invocation de ce commit sur `main`, achevée avec succès,
  démarrée depuis moins de 24 heures ;
- une tentative identifiée, avec chacun des jobs source, leurs agrégateurs,
  les constructions, le runtime CLI et les promotions attendues réussis ;
- une seconde vérification que cette tentative n’a pas changé pendant la
  lecture des preuves.

Un job obligatoire `quality-gate` bloque toutes les promotions en l’absence
soit de cette preuve, soit d’une nouvelle suite complète réussie. Si GitHub est
indisponible, si les permissions API sont insuffisantes, si les métadonnées sont
inattendues ou si un job est absent, annulé, ignoré ou en échec, la suite complète
est relancée. Les décisions et le numéro de lancement/tentative réutilisés sont
visibles dans le résumé du workflow. Une erreur du mécanisme lui-même bloque
la publication : elle ne vaut jamais validation.

Les images stables sont **toujours reconstruites et contrôlées** pour leur canal
et leurs métadonnées propres : scans de vulnérabilités actualisés, démarrage,
Office, SSH/Git, protections documentaires, paire Application/Manager et
sandbox CLI. Provenance, SBOM et compensation de promotion restent actifs.
Une image `edge` n’est pas simplement rebaptisée `stable`. Tous les composants
doivent être promus avant la création de la GitHub Release.

La GitHub Release est ensuite créée avec les notes générées depuis toutes les
PR fusionnées depuis la version précédente. `.github/release.yml` regroupe ces
changements en incompatibilités, nouveautés, corrections, sécurité,
documentation et autres changements. Le manifeste `mergeron-release.json` est
joint à la Release après la promotion du digest vérifié.

Les labels de PR améliorent la qualité des notes, mais une PR sans label reste
présente dans la catégorie « Autres changements ».

## Échec et reprise

Si la validation ou la construction échoue, aucun tag Docker stable et aucune
GitHub Release ne sont publiés. Corriger la cause sur `main`, augmenter la
version de correction, puis créer un nouveau tag correspondant. Un tag publié
ne doit jamais être déplacé ou réutilisé, même après un échec de construction.

Une fois une version stable publiée, ne jamais déplacer ni réutiliser son tag.
Publier une nouvelle correction `0.x.(y+1)`.
