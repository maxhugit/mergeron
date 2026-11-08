# Livrables dans Git

Le mode **Livrables Git** est optionnel et désactivé par défaut. Un administrateur
peut l’activer dans **Projet → Espaces de travail → Livrables Git**, après avoir
créé une copie Git partagée, accessible en écriture et non réservée à un agent.
Les livrables et leurs historiques Mergeron continuent de fonctionner sans Git.

## Activer et reconnaître

1. Sélectionner le gestionnaire de livrables, la copie et un dossier relatif
   (par défaut `livrables`). Une copie déjà liée ne peut pas être remplacée
   implicitement par une autre : ses bases de comparaison restent attachées
   au dépôt et au dossier d’origine.
2. Activer le commutateur et **Prévisualiser les changements**. Cette lecture
   ne crée aucun document, fichier, commit ou réglage actif.
3. Examiner les imports, exports, exclusions et conflits. Puis **Confirmer et
   synchroniser** pour activer le mode et effectuer le transfert.

À l’ouverture d’une copie dans l’explorateur Sources/Git, Mergeron recherche
automatiquement les manifestes et signale les livrables reconnus. **Examiner les
livrables Git** ouvre la même interface. L’import reste explicite. Le changement
d’état de la copie après une synchronisation Git déclenche une nouvelle lecture.

L’index `.mergeron-deliverables.json`, à la racine du dépôt, indique le dossier
choisi. Il permet de retrouver aussi un emplacement personnalisé lors du chargement
sur une autre installation. Il faut le committer avec les manifestes et documents.
Un index inconnu, invalide ou pointant hors du dépôt est refusé.

Pour un dépôt sans métadonnées, cocher la conversion des sous-dossiers sans
`livrable.json`. Chaque sous-dossier contenant des fichiers directs devient une
proposition de livrable. Les dossiers imbriqués, fichiers cachés et liens
symboliques ne sont pas adoptés récursivement. Le manifeste est écrit seulement
après confirmation. L’utilisateur choisit ainsi le périmètre par le dossier cible.

## Format portable

```text
.mergeron-deliverables.json
livrables/
  cadrage/
    livrable.json
    cadrage.md
```

```json
{
  "format": "mergeron-deliverable",
  "version": 1,
  "id": "cadrage-stable",
  "title": "Cadrage",
  "description": "Décisions retenues",
  "labels": ["Spécifications"],
  "documents": [
    {
      "id": "document-stable",
      "path": "cadrage.md",
      "labels": ["Spécifications"]
    }
  ]
}
```

Les identifiants portables restent stables en cas de renommage. Sur une autre
installation, ils sont rattachés à de nouveaux identifiants locaux sans collision
avec d’autres projets. Le manifeste ne contient aucun chemin absolu, compte,
identifiant d’agent, secret, droit d’accès local ou état de validation. Un document
importé crée un historique local ; les validations ne sont jamais importées comme
si elles avaient été réalisées sur cette installation.

## Versions, conflits et reprise

- Un enregistrement de version, une modification de titre ou d’étiquettes
  programme un export des **instantanés enregistrés**, pas des brouillons.
  L’export attend que le verrou des opérations Git autorise l’écriture ; si un
  agent travaille encore, il réessaie de manière espacée. Aucun commit ou push
  automatique n’est réalisé, même si le dépôt distant est configuré.
- Un import utilise l’enregistrement versionné habituel. Il conserve les versions
  précédentes et l’identité du document, y compris lors d’un renommage.
- Les SHA-256 de la dernière synchronisation permettent une comparaison à trois
  états. Une modification des deux côtés bloque l’application. Les métadonnées
  concurrentes sont également signalées, sans fusion textuelle implicite.
- Un plan est lié à une empreinte : s’il est devenu périmé, il faut le recalculer.
  Chaque écriture vérifie aussi son fichier cible. Un fichier non reconnu n’est
  pas écrasé. Les imports interrompus conservent leurs correspondances pour être
  repris sans dupliquer les documents déjà enregistrés.
- Une suppression dans Git ou dans Mergeron constitue un conflit nécessitant
  une décision explicite ; elle ne supprime pas l’autre exemplaire. Un livrable
  finalisé ou archivé ne reçoit pas de modification entrante.

Les dernières erreurs et la date de synchronisation sont affichées dans le
réglage. Les synchronisations abouties sont inscrites dans l’activité du projet.
Après un redémarrage, les fichiers, correspondances et erreurs sont conservés ;
une opération automatique interrompue peut être relancée par une prévisualisation
et une confirmation. La désactivation conserve les fichiers et les historiques.

## Confidentialité et limites

Les livrables à accès restreint sont exclus par défaut. Leur inclusion doit être
explicitement cochée. Les droits Mergeron ne suivent pas le fichier dans Git.
Décocher un livrable ne retire pas les copies ni les commits déjà publiés.

Cette première version refuse les transferts de fichiers de plus de **10 Mo**.
La publication/récupération Git LFS requiert une intégration distincte des
commandes Git sécurisées : elle n’est pas exécutée automatiquement par ce mode.
Un pointeur LFS sans contenu n’est jamais enregistré comme document. Les gros
MP4 restent donc dans les livrables Mergeron tant que ce transfert est bloqué.

L’inspection est bornée : 100 livrables, 500 documents par manifeste, 256 Kio
par manifeste, 100 Mio par lecture et 64 Mio cumulés par plan. Le format est
strict ; chemins sortants, doublons d’identité, liens symboliques, liens physiques
de fichiers et versions de format inconnues sont refusés. Aucun script du dépôt
n’est exécuté pour interpréter un manifeste.
