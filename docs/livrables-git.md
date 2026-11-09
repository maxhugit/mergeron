# Livrables dans Git

Le mode **Livrables Git** est optionnel et désactivé par défaut. Un administrateur
peut l’activer dans **Projet → Emplacements et connexions → Livrables Git**,
même sans copie Git locale.
Le projet possède un seul gestionnaire de livrables : il est utilisé automatiquement,
sans liste de sélection. Le réglage ne désigne aucune copie partagée.
Les livrables et leurs historiques Mergeron continuent de fonctionner sans Git.

## Activer et reconnaître

1. Activer le commutateur, choisir le dossier relatif commun (par défaut
   `livrables`) et **Enregistrer le mode Livrables Git**. Ce réglage s’applique
   au projet ; il programme l’export des documents déjà conservés vers les copies
   admissibles. Aucun document n’est importé automatiquement.
2. Les modifications et versions sont enregistrées dans Mergeron, même sans copie
   disponible. L’export attend une copie Git propre à l’agent, prête en écriture.
   Aucun repli vers une copie partagée ou celle d’un autre agent n’est effectué.
   Créer ou affecter une copie permet de reprendre les exports. Sans gestionnaire,
   en créer un d’abord.
3. Dans l’explorateur de la copie concernée, **Examiner les livrables Git** puis
   **Prévisualiser les changements**. Examiner imports, exports, exclusions et
   conflits avant **Confirmer et synchroniser**. La copie est celle de l’explorateur,
   sans sélecteur supplémentaire. Les imports restent toujours explicites.

Les bases de comparaison et les correspondances sont conservées séparément pour
chaque copie. Une synchronisation ne remplace pas celles des autres agents.
Les anciens réglages et fichiers restent conservés ; une ancienne cible partagée
n’est plus utilisée pour les écritures automatiques. Le dossier ne peut pas changer
silencieusement dès qu’une copie possède des correspondances enregistrées.

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

Les nouveaux exports utilisent un nom lisible dérivé du titre (`cadrage-du-site`),
avec un suffixe stable si deux titres produisent le même nom. Le titre exact,
accents compris, reste dans `livrable.json`. Les nouvelles identités de livrables
et documents sont des identités publiques opaques, distinctes des clés locales.
L'import n'a pas besoin de la base d'origine : il lit le titre du manifeste et
crée ses propres identifiants locaux. Sans manifeste, la conversion proposée
utilise le nom du dossier comme titre.

Un changement de titre ne déplace pas automatiquement un dossier déjà associé.
Les anciens dossiers UUID restent reconnus et conservent leur identité. Depuis
**Examiner les livrables Git**, cocher **Proposer des noms de dossiers lisibles**
puis prévisualiser : chaque déplacement apparaît avec son ancien et son nouveau
chemin. La confirmation est liée à la copie, à la branche, au commit et aux
contenus examinés. Une destination occupée, un lien ambigu ou un conflit bloque
l'opération. Le déplacement conserve tout le dossier, y compris les fichiers
inconnus du manifeste, sans ajout à l'index Git ni commit/push. Si l'écriture du
manifeste est interrompue après le déplacement, la même identité portable permet
la reprise sans recréer le livrable. Ce choix de renommage n'est pas enregistré
comme une règle automatique pour les prochaines synchronisations.

Les identifiants portables restent stables en cas de renommage. Sur une autre
installation, ils sont rattachés à de nouveaux identifiants locaux sans collision
avec d’autres projets. Le manifeste ne contient aucun chemin absolu, compte,
identifiant d’agent, secret, droit d’accès local ou état de validation. Un document
importé crée un historique local ; les validations ne sont jamais importées comme
si elles avaient été réalisées sur cette installation.

## Versions, conflits et reprise

- Un enregistrement de version, une modification de titre ou d’étiquettes
  programme un export des **instantanés enregistrés**, pas des brouillons.
  Une modification par un agent exporte vers sa propre copie, avec la barrière Git
  de cet agent. Une modification depuis l’interface programme les copies d’agents
  disponibles sous le verrou global. Une copie occupée attend une nouvelle tentative.
  Les changements entrants restent soumis à validation, même après un pull. Aucun commit ou push
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
- La suppression explicite d’un document dans Mergeron retire son fichier de la
  copie Git et son entrée du manifeste si son contenu correspond encore à la base
  synchronisée. La modification reste non préparée : vous choisissez le commit
  et le push. Les versions Mergeron sont conservées et une restauration du document
  peut réexporter son contenu. Une modification propre à Git bloque le retrait.
- Le fichier retiré est déplacé atomiquement dans le dossier privé
  `.git/mergeron-deliverable-recovery/`, avec un relevé de son chemin d’origine.
  Ces copies de récupération ne sont ni commitables ni purgées automatiquement.
  Une modification tardive ou un changement de branche provoque une restauration
  sans remplacer un nouveau fichier apparu au même chemin ; si cette restauration
  est impossible, les deux contenus restent conservés et une intervention est signalée.
- Une disparition non reconnue, une suppression dans Git ou celle d’un livrable
  entier reste un conflit : elle ne supprime pas les données Mergeron. Un livrable
  finalisé ou archivé ne reçoit pas de modification entrante.

Les dernières erreurs et la date de synchronisation sont affichées dans le
réglage. Les synchronisations abouties sont inscrites dans l’activité du projet.
Après un redémarrage, les fichiers, correspondances et erreurs sont conservés ;
une opération automatique interrompue peut être relancée par une prévisualisation
et une confirmation. La désactivation conserve les fichiers et les historiques.

## Écritures simultanées et suivi des copies

Une application de plan réserve le gestionnaire pendant ses écritures. Une autre
requête qui modifie un document ou ses étiquettes reçoit un conflit temporaire
avant l'enregistrement ; elle peut être réessayée après la synchronisation.
Les contrôles de version et de révision restent actifs, y compris à la fin des
opérations documentaires asynchrones. Un import confirmé ne devient pas un export
parce qu'une nouvelle version a été enregistrée pendant sa préparation.

La prévisualisation est liée à la branche et au commit HEAD examinés. Un changement
de branche ou de commit invalide la confirmation. Chaque copie conserve des bases
de comparaison distinctes par branche. Après changement de branche, le transfert
est recalculé sur la branche courante : les octets reconnus dans une ancienne
version conservée de Mergeron peuvent être remplacés par la version actuelle.
Un plan accepté avant le changement reste invalide.

La comparaison repose sur les empreintes du contenu, pas sur les dates des fichiers.
Une modification Git inconnue est proposée à l’import si Mergeron correspond
encore à la base commune ; si les deux ont changé, le transfert est bloqué en
conflit. Sans base commune, un contenu différent reste à examiner. Les titres et
étiquettes sans historique comparable restent également protégés par un conflit.
Aucun import n’est automatique et aucune ancienne version Mergeron n’est effacée.
La création d’une copie, les actions Git locales et l’inspection de la copie dans
l’interface relancent la comparaison et les exports sûrs. Les changements réalisés
par une commande Git externe sont détectés à la prochaine inspection, pas par une
surveillance permanente du disque.

Le tableau des copies affiche la branche, le commit, la dernière synchronisation,
les erreurs et les exports en attente. Un conflit sur une copie n'empêche pas
l'examen des suivantes. Le succès d'une copie ne masque pas l'erreur d'une autre.
Le bouton **Examiner les livrables Git** ouvre une fenêtre sur la copie concernée.

Les demandes d'export en attente sont conservées dans la configuration du
gestionnaire. Une demande reçue pendant une opération reste à traiter après sa
fin. Après un redémarrage, cet état reste visible : examiner puis confirmer le
plan pour reprendre avec l'identité et les droits actuels. Aucun ancien contexte
d'authentification n'est réutilisé automatiquement.

Un premier export est journalisé avant l'écriture de ses fichiers. S'il est
interrompu avant la création du manifeste, une nouvelle prévisualisation peut
reprendre les fichiers déjà écrits lorsqu'ils correspondent au contenu attendu.
Une suppression de manifeste après un export achevé reste un conflit ; les
fichiers inconnus ou divergents ne sont pas écrasés pour forcer la reprise.

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

## Indicateurs dans la barre latérale Livrables

Le bandeau fixe **Git local** indique la copie sélectionnée et sa branche réelle
(ou la révision en HEAD détachée). Seules les copies de l'agent courant sont
proposées ; plusieurs copies demandent une sélection explicite. Choisir une copie
pour consulter son état ne change ni la référence ni le dossier de travail de
l'agent. Le bouton de vérification relit l'état ; les changements de fichiers et
les fins d'exécution déclenchent une actualisation regroupée. La surveillance
est libérée en quittant la vue. Une attente d'export peut être relue pendant que
la vue est active, sans interrogation continue en arrière-plan.

Chaque livrable porte un indicateur : **À jour localement**, **Export en attente**,
**Synchronisation en cours**, **À examiner**, **Synchronisation indisponible**,
**Copie en lecture seule** ou **Sans copie Git sélectionnée**. Un import proposé
et un conflit demandent une revue. Une exclusion de confidentialité n'est jamais
présentée comme une réussite. Les identités locales distinguent les lignes même
quand les titres sont identiques.

Le vert exige une comparaison de contenu réussie sur la copie, la branche et le
HEAD affichés. Une date ancienne de synchronisation ne suffit pas. Pendant une
nouvelle lecture, lors d'un changement de contexte ou après une erreur, le vert
précédent est remplacé par l'état de vérification ou d'erreur. Cliquer sur l'icône
ou **Examiner les livrables Git** ouvre le détail en modal ; les personnes sans
droit d'administration consultent les informations sans actions de mutation.

**À jour localement ne veut dire ni commité ni publié sur GitHub.** L'index, les
commits, les push et les protections de branche gardent leurs parcours existants.
