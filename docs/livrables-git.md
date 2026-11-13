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

## Synchronisation par document

Un conflit sur un document ne bloque plus les autres documents du même livrable,
ni ceux des autres livrables. L’export automatique traite les documents dont le
contenu est vérifié et laisse les fichiers divergents intacts. Un fichier inconnu
occupant un chemin ou exclu par `.gitignore` reste protégé ; les autres exports
peuvent continuer. Les métadonnées de livrable non vérifiées ne sont pas remplacées
pour forcer un export. Seules les références nécessaires aux documents exportés
sont ajoutées à `livrable.json`.

Après une interruption ou un redémarrage, ouvrir la vue **Livrables** avec un
compte administrateur relance automatiquement les exports sûrs de la copie
sélectionnée, après une nouvelle comparaison. Un document présent dans Mergeron,
absent de cette copie et sans trace d’un export antérieur est exporté sans
confirmation. Un autre document en conflit ne bloque pas cet export. Les fichiers
Git modifiés, les collisions avec des fichiers non suivis et les suppressions
locales de documents déjà exportés restent à examiner ; aucun import, commit ou
push n’est déclenché par cette reprise. Une session en cours de renouvellement ou
un accès en lecture seule ne lance aucune reprise. Un même diagnostic ne relance
pas continuellement une opération bloquée ; **Actualiser** permet de réessayer.

Une copie en attente du verrou Git affiche une horloge et « Export en attente :
Git occupé par une autre opération ou un agent actif ». Ce n’est pas un transfert
en cours. Le serveur conserve l’export et réessaie toutes les cinq secondes après
un refus temporaire `GIT_BUSY` ; dès que le verrou peut être acquis, les versions
conservées sont exportées sans clic supplémentaire. Une actualisation de l’état
ne transforme pas cette attente en animation de transfert. « Synchronisation en
cours » est réservé à une opération admise par le verrou, pour la copie concernée.
Les erreurs réelles et les conflits restent visibles et ne sont pas assimilés
à une simple attente.

Les imports restent explicites. Si la comparaison contient aussi des conflits,
**Appliquer les documents sans conflit** permet de valider les documents sûrs.
Le résultat affiche les écarts restants, sans prétendre que toute la copie est à
jour. Les opérations portant sur une branche, une copie, un index partagé invalide,
les droits ou les chemins autorisés continuent de bloquer les écritures concernées.
Les empreintes et versions sont revérifiées avant les écritures ; aucun commit,
pull ou push n’est ajouté automatiquement.

Dans l’explorateur des livrables, le fond du badge **V1**, **V2**… est orange pour
un document à exporter ou un import à examiner, rouge pour un conflit ou une erreur
bloquante. Un document vérifié conserve son badge neutre même si un autre document
de sa copie est bloqué. Le survol et le libellé accessible précisent le problème ;
la couleur n’est pas le seul indicateur.

Cliquer sur un badge orange ou rouge ouvre **Synchronisation du document**, sans
passer par les paramètres Git du projet. La fenêtre indique le document, sa version
Mergeron, la branche et les empreintes comparées, avec des liens vers les deux
fichiers. **Conserver la version Mergeron** prépare l’export ; **Importer la version
Git** prépare une nouvelle version documentaire. **Confirmer la correction** est
une seconde action explicite, liée à l’empreinte affichée au moment du choix.
Une édition, un changement de branche ou une révocation de droits impose une
nouvelle comparaison. Une protection de chemin, `.gitignore`, un pointeur LFS ou
une limite de taille ne peuvent pas être contournés par cette fenêtre.

Le remplacement explicite d’un fichier Git conserve d’abord ses octets dans un
répertoire privé `.git/mergeron-deliverable-recovery`, avec le chemin d’origine et
l’empreinte vérifiée ; cette récupération est référencée dans l’activité du projet.
Un import conserve les versions Mergeron précédentes dans l’historique normal.
Le choix ne s’applique qu’au document sélectionné. Les autres documents restent
inchangés et leurs éventuels écarts continuent d’être signalés.

Techniquement, `POST /api/projects/:projectId/git-deliverables/document-preview`
compare `options` (dont la copie explicite) et `documentId`. La correction passe
par `/apply` avec cette empreinte et `resolution: { documentId, direction,
confirmation: "CONFIRM_DOCUMENT_RESOLUTION" }` ; `direction` vaut `mergeron` ou
`git`. Le serveur reconstruit le plan sous le verrou Git, contrôle les droits,
les versions et les contenus, puis limite l’écriture au document choisi.

Les indicateurs et corrections des livrables se trouvent dans **Livrables**.
Le bloc dédié a été retiré de **Sources → Git local** ; cette zone conserve les
opérations Git sur les fichiers, branches et commits.

Le message « Organisation différente sans référence commune vérifiée » concerne
`livrable.json` : titre, description, liste de documents et étiquettes. Il ne prouve
pas que le contenu d’un document commun est différent. Une version commune doit
être établie par comparaison des contenus ; elle n’est jamais inventée pour
supprimer une alerte.

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
Une organisation Git déjà synchronisée pour le même livrable, dans une autre
branche ou copie du projet, est reconnue comme une ancienne version connue et
peut être remplacée par l'organisation actuelle de Mergeron. Les empreintes des
32 organisations précédemment synchronisées sont conservées par affectation,
en plus de l'empreinte courante ; les anciens réglages restent lisibles sans
migration. Une organisation Git inconnue n'est jamais écrasée sur cette seule
présomption. En l'absence de base commune, le détail indique qu'une comparaison
manuelle est nécessaire, sans affirmer que les deux côtés ont été modifiés.
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

La barre compacte fixe des livrables indique la branche réelle de la copie Git
(ou la révision en HEAD détachée). Seules les copies de l'agent courant sont
proposées ; une copie unique est sélectionnée automatiquement. Le choix entre
plusieurs copies reste dans la fenêtre de détails. Choisir une copie
pour consulter son état ne change ni la référence ni le dossier de travail de
l'agent. Cliquer sur l'indicateur Git ouvre les détails et le bouton de vérification.
Les icônes de création et de vue fichiers/étiquettes partagent cette même barre ;
l'indicateur Git disparaît lorsque le mode n'est pas activé. Les changements de fichiers et
les fins d'exécution déclenchent une actualisation regroupée. La surveillance
est libérée en quittant la vue. Une attente d'export peut être relue pendant que
la vue est active, sans interrogation continue en arrière-plan.

Chaque livrable porte un indicateur : **À jour localement**, **Export en attente**,
**Synchronisation en cours**, **À examiner**, **Synchronisation indisponible**,
**Copie en lecture seule** ou **Sans copie Git sélectionnée**. Un import proposé
et un conflit demandent une revue. Une exclusion de confidentialité n'est jamais
présentée comme une réussite. Les identités locales distinguent les lignes même
quand les titres sont identiques.
Un export automatique suspendu pour revue apparaît comme **À examiner**, et non
comme une panne de synchronisation. Les erreurs de lecture ou d'accès restent
des erreurs ; une ancienne proposition ne masque pas une vérification échouée.

Le vert exige une comparaison de contenu réussie sur la copie, la branche et le
HEAD affichés. Une date ancienne de synchronisation ne suffit pas. Pendant une
nouvelle lecture, lors d'un changement de contexte ou après une erreur, le vert
précédent est remplacé par l'état de vérification ou d'erreur dans un emplacement
de taille fixe. Une simple date de rafraîchissement ne relance pas la comparaison
si les références métier sont identiques. Cliquer sur l'icône
ou **Examiner les livrables Git** ouvre le détail en modal ; les personnes sans
droit d'administration consultent les informations sans actions de mutation.

**À jour localement ne veut dire ni commité ni publié sur GitHub.** L'index, les
commits, les push et les protections de branche gardent leurs parcours existants.
