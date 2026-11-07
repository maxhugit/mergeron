# Cohérence des projets

[← Documentation](README.md) · [Organisation de l’explorateur](explorateur-projet.md)

## Utilisation

Dans **Paramètres → Outils d’exploitation**, ouvrir **Cohérence des projets**, puis choisir un
projet. Le diagnostic compare les références en base avec l’organisation physique
attendue. **Actualiser le diagnostic** relance la lecture sans modifier de données.
La page et ses API sont réservées aux administrateurs actifs.

Le rapport présente chaque anomalie avec un titre simple, une explication et un
schéma reliant les deux éléments concernés. Le lien indique ce qui bloque
(absence, rattachement manquant, emplacement différent ou contrôle suspendu).
Les 29 types d’anomalies disposent d’une représentation et d’une explication
propres ; une anomalie inconnue conserve un affichage générique.
Les erreurs restent distinguées des avertissements :

- identité, emplacement principal et version d’organisation du projet ;
- dossiers attendus, collisions de chemins et liens symboliques ;
- documents courants, numéro de version et existence des fichiers historiques ;
- copies Git enregistrées, emplacement et présence des métadonnées Git ;
- dossiers de référence des agents, chemins mémorisés et sélections actives ;
- fichiers ou dossiers présents dans les projections de livrables et les copies
  de sources mais non enregistrés en base.

L’absence d’anomalie ne prouve pas l’intégrité du contenu binaire ni la présence
de tous les anciens fichiers libres : aucun inventaire historique de ces fichiers
n’est disponible. Créer un dossier vide ne restaure pas ses anciens fichiers.

Les fichiers libres de `dossiers/`, y compris les dossiers cachés, ne sont pas
considérés comme des anomalies. Les connexions secondaires externes ne sont pas
parcourues. Le diagnostic ne lit pas les contenus documentaires, ne calcule pas
leurs empreintes et ne remplace pas une validation documentaire ou `git fsck`.
Les anciennes organisations et les emplacements non canoniques sont signalés
pour traitement manuel, sans migration implicite.

## Corrections

Cliquer sur une anomalie ouvre **Corrections proposées**. La popup présente
l’élément concerné, les explications et les seules réparations
offertes par le diagnostic serveur. Les chemins, identifiants et intitulés techniques
restent consultables dans **Détails techniques**, replié par défaut.
Lorsqu’une réparation est disponible, **Situation actuelle / Après correction**
permet de visualiser son effet attendu sans écrire de données. Cet aperçu
n’apparaît pas pour les cas manuels ou les diagnostics incomplets et disparaît
si un rafraîchissement retire la réparation. Choisir une réparation ouvre sa confirmation ;
ouvrir la popup ne modifie aucune donnée. Le diagnostic peut aussi être actualisé
depuis cette fenêtre. Si l’anomalie disparaît, ses anciens boutons ne restent pas
disponibles. Une référence d’agent permet également d’ouvrir cet agent pour
choisir un autre dossier dans son explorateur.

Les anomalies sans réparation automatique et les diagnostics incomplets affichent
les indications disponibles, sans proposer une action d’écriture arbitraire. Les
liens en anomalie et le nœud concerné sont signalés en jaune ; les fichiers sans
rattachement ont le côté « enregistrement absent » en jaune. L’aperçu d’une
réparation proposée utilise un lien vert, sans annoncer qu’elle a déjà été faite.

Une action est proposée seulement lorsqu’une correction ciblée peut être vérifiée :

- **Recréer ce dossier vide** : dossier attendu manquant, avec parent existant et
  identité du projet vérifiée. Aucun contenu déclaré ne doit être reconstruit.
  Un historique contenant des versions et un livrable contenant des documents
  ne sont jamais remplacés par des dossiers vides. La création sûre utilise les
  descripteurs Linux et n’est pas proposée sur un serveur non Linux.
- **Réaligner cette référence** : ancien chemin d’un agent ou de sa conversation,
  dont la destination migrée est identifiée et existe. Les fichiers et les
  politiques de sécurité ne sont pas modifiés.

Chaque correction demande confirmation et concerne un seul élément. Un nouveau
contrôle serveur vérifie l’empreinte du diagnostic avant application ; si la base
ou les dossiers ont changé, la correction est refusée avec HTTP 409 et le rapport
est actualisé. Les corrections sont consignées dans le journal du projet avec
l’auteur, le chemin et l’action. Une nouvelle analyse suit chaque correction.

Pour les anomalies sans action automatique, une consigne est donnée : rechercher
ou restaurer le document, retrouver une copie Git et ses changements non publiés,
ou importer un fichier via la gestion documentaire du livrable. L’outil ne supprime
rien définitivement, n’adopte pas un fichier arbitraire en base et ne fait aucun clone, checkout,
reset ou changement de droits. Aucun bouton « tout corriger » n’est proposé.

## Retrait explicite des données sans rattachement

Une action **Mettre ces données à la corbeille** peut être proposée pour un
fichier non enregistré, un dossier de livrable non enregistré ou une copie Git
non enregistrée. Une connexion manquante n’autorise jamais à supprimer un agent,
un document enregistré ou des fichiers supposés inutiles. L’absence de lien
ne prouve pas l’absence de contenu utile.

L’administrateur doit ouvrir la confirmation et saisir le nom exact. Le serveur
relit le diagnostic et son empreinte, vérifie les chemins référencés (y compris
ceux des autres projets, les documents supprimés et leurs historiques), les
sélections actives et les chemins mémorisés. Les éléments techniques cachés,
liens symboliques, liens physiques multiples et arbres non inspectables ne
reçoivent pas cette action. Une analyse incomplète ou un transfert la bloque.
Le contrôle de l’arbre est borné à 5 000 entrées et 16 niveaux ; les métadonnées
sont intégrées à l’empreinte, sans lire les contenus documentaires.

Les fichiers sont renommés, sans purge, sous
`.mergeron-system/operations/integrity-trash/`. Les opérations utilisent des
répertoires ouverts par descripteur sans suivre les liens symboliques et ne sont
proposées que sur Linux. Le journal du projet enregistre d’abord la demande avec
son auteur, sa date, son origine et l’identifiant de récupération, puis son état
final. Si l’écriture finale du journal échoue après le déplacement, l’entrée
préalable reste récupérable et l’interface relit le diagnostic et la corbeille.

La section **Corbeille du projet** affiche les noms, chemins d’origine, dates et
auteurs. **Récupérer dans Dossiers** demande confirmation et conserve le contenu
sous un nouveau nom unique, sans remplacer l’ancien emplacement, écraser un
document ou l’importer automatiquement. Les changements Git non publiés restent
présents dans la copie récupérée. Aucune suppression définitive ni purge
automatique n’est prévue ; l’espace disque reste utilisé pendant la conservation.

## Technique

`ProjectIntegrityController` expose :

- `GET /api/project-integrity` : liste des projets ;
- `GET /api/project-integrity/:id` : rapport, compteurs, anomalies et empreinte ;
- `POST /api/project-integrity/:id/repair` : corps `fingerprint`, `issueId` et
  `confirmation: "REPAIR_PROJECT"`. Les chemins et les actions sont recalculés
  côté serveur ; le client ne fournit jamais un chemin à créer.

Les routes administrateur de corbeille sont `GET /api/project-integrity/:id/trash`,
`POST /api/project-integrity/:id/trash` (empreinte, anomalie, nom et confirmation
`MOVE_TO_PROJECT_TRASH`) et `POST /api/project-integrity/:id/trash/recover`
(identifiant et confirmation `RECOVER_PROJECT_TRASH`). Le client ne transmet
jamais un chemin à déplacer ou une destination de récupération.

`ProjectIntegrityService` utilise les tables réelles et les alias de migration
existants. Les corrections partagent la sérialisation des migrations du projet.
Les mutations de références et leur journal sont transactionnels. La création
Linux traverse les parents avec `O_NOFOLLOW` et des descripteurs de répertoire,
puis crée seulement la dernière composante, sans écrasement ni `mkdir` récursif.

L’analyse ne suit pas les liens symboliques et est bornée : 10 000 sondes de
chemin, 5 000 entrées documentaires, profondeur 16, 1 000 entrées par niveau
administratif et 500 anomalies. Atteindre une limite produit un rapport incomplet
explicite et désactive ses corrections automatiques. Un échec de lecture ne doit
jamais être présenté comme un projet sain. Le résultat reste un instantané ; il
ne verrouille pas le travail des agents pendant la consultation.

Les tests couvrent l’autorisation, l’absence d’écriture pendant l’inspection,
les chemins non conformes et symboliques, les pertes documentaires, les références
obsolètes, les confirmations, le refus d’un diagnostic périmé et l’absence de
modification des politiques de sécurité. Les tests d’interface vérifient la
confirmation, l’annulation, le rafraîchissement et les erreurs de lecture.

## Référence vers une connexion supprimée

Chaque anomalie de connexion absente identifie l’agent, la tâche, le livrable ou
la conversation concernée, ainsi que l’identifiant de la connexion mémorisée.
Les tâches, livrables et conversations affichent leur titre : plusieurs références
vers la même ancienne connexion ne sont plus des cartes indifférenciées.

**Utiliser Dossiers comme référence…** propose explicitement le dossier
`/workspaces/<projet>/dossiers`. La confirmation ne restaure pas la connexion
supprimée ; elle remplace uniquement la référence de cet élément. Pour une autre
destination, choisir la référence dans l’explorateur de l’élément. Aucun fichier
n’est déplacé ni supprimé, aucun droit ni tour déjà en cours n’est modifié.

L’action n’est proposée que pour un contexte encore rattaché au projet et un
dossier principal validé par le service de sélection existant. Le serveur
recalcule le diagnostic, contrôle son empreinte, applique la sélection avec les
contrôles habituels et journalise l’ancienne connexion et la nouvelle destination
dans la même transaction. Les diagnostics incomplets et transferts en cours
continuent de bloquer les corrections.
