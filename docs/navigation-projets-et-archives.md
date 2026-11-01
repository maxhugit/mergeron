# Navigation des projets et archives

Le bouton **+** de l’en-tête **Projets** ouvre les actions suivantes : créer,
importer, fermer les projets et ouvrir les projets. L’import garde ses contrôles
administrateur habituels. Fermer et ouvrir replient ou déplient seulement les
groupes visibles dans la barre latérale : aucun agent ni conteneur n’est arrêté.

## Se concentrer sur un projet

L’œil est placé avant le **+**, qui reste aligné à droite. Il isole un projet
dans la barre latérale, affiche toutes ses conversations et conserve ses outils,
ses menus et ses poignées de déplacement. Les emplacements du projet sont tous
pris en compte ; il ne s’agit pas simplement d’afficher une page de conversations
d’un seul dossier.

Le focus active la navigation rapide personnelle pour ce projet. Il n’est ouvert
qu’après confirmation de l’enregistrement de cette préférence ; une erreur
conserve l’état précédent. Si elle était déjà active, elle n’est pas désactivée.
Le choix reste limité à un seul projet. Seules les vues récemment consultées sont
gardées en mémoire, pas tout l’historique de tous les agents.

**Tous les projets** restaure la liste, les groupes repliés et le point de lecture.
La navigation rapide reste activée. Le focus lui-même est temporaire et ne crée
pas une préférence globale supplémentaire. La création et l’import de projets
ne sont pas proposés dans cette vue ; le **+** du projet reste disponible.

## Consulter les archives

**Conversations archivées** est toujours la dernière entrée du projet, sans
séparateur ni poignée de déplacement. Elle ouvre la page authentifiée
`/projects/:projectId/archives`, comme un gestionnaire de tâches, et non un onglet
dans l’espace de travail d’un agent. La navigation de gauche conserve son état.

Le tableau occupe la hauteur disponible avec son propre défilement et un en-tête
fixe. Il affiche la conversation, son emplacement, sa tâche liée, la date et
l’auteur de l’archivage. Le menu **…**, également accessible par clic droit,
permet de consulter en lecture seule, désarchiver, créer une branche ou demander
une suppression. La suppression conserve l’aperçu de portée, les protections de
topologie et la confirmation déjà utilisés par les conversations.

## Auteur et date

La migration `0065_thread_archival` ajoute quatre colonnes facultatives aux
associations projet–agent. Le serveur enregistre la date et un instantané du nom
et de l’identifiant de la personne après chaque archivage confirmé par le moteur.
Il le fait pour chaque membre réellement archivé de l’arbre de branches, même si
une autre branche échoue. Le client ne choisit ni la date ni l’auteur.

En mode « Tester en tant que », l’administrateur réel est enregistré. Une action
de service ou du système ne reçoit pas une identité humaine fictive. La date est
stockée en millisecondes UTC et affichée dans la langue et le fuseau du navigateur.
Les archives antérieures ou non attribuables restent **Non renseigné**.

Il s’agit des informations du dernier archivage courant, pas d’un journal complet
des cycles d’archivage. Désarchiver efface ces informations ; archiver de nouveau
enregistre la nouvelle action. Les métadonnées disparaissent avec l’association
de la conversation ou la suppression du projet, grâce aux règles existantes.
