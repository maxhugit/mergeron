# Gestion des livrables

Le menu **+** du projet propose **Gestion des livrables**. Cette ressource est
facultative et limitée à un exemplaire par projet. Un nouveau clic ouvre le
gestionnaire existant. La même règle s’applique désormais aux automatisations.
La migration conserve les éventuels anciens gestionnaires d’automatisations
en double et leur contenu ; elle empêche seulement les nouveaux doublons.
Les tableaux de tâches restent multiples.

## Fiches et conversations

Une fiche contient un titre, une description, des critères de validation et un
état : à produire, en cours, à valider ou validé. Elle peut être rattachée à une
tâche principale du projet. Cette tâche pilote le responsable, l’échéance et
l’avancement affichés sur le livrable. La validation nécessite une version
soumise : elle ne peut pas être obtenue en modifiant simplement l’état.

L’onglet **Liens** permet de sélectionner une tâche principale existante ou d’en
créer une dans le premier gestionnaire de tâches disponible. Seules les tâches
principales du projet peuvent remplir ce rôle. La fiche affiche cette tâche et
ses sous-tâches ; un clic ouvre la tâche dans une fenêtre de détail sans quitter
le livrable. D’autres tâches et conversations du projet peuvent aussi rester
associées à la fiche.

À chaque message suivant dans une conversation liée, le modèle reçoit le brief,
les critères et le dossier de travail, en complément des connaissances partagées.
Le bouton **Confier à un agent**, réservé aux administrateurs comme les
autres exécutions serveur, crée et ouvre une conversation liée directement au
livrable, sans tâche ni sous-tâche obligatoire et sans tâche cachée automatique.
Si une tâche principale est associée, on peut aussi sélectionner une de ses
sous-tâches disponibles ou en créer une explicitement : l’agent est alors lié à
la fois à cette sous-tâche et au livrable. Le lien avec une tâche principale ne
force pas l’affectation à une sous-tâche. L’utilisateur
envoie ensuite son message pour lancer le travail. La nouvelle conversation
reprend la sélection de connecteurs MCP et d’applications Codex du projet.

## Interface du gestionnaire

La liste présente pour chaque livrable le nombre de documents, son état de
production, sa validation, le responsable hérité de la tâche principale et sa
dernière modification. La fiche détaillée est organisée en cinq onglets :

- **Aperçu** : description, critères, état et synthèse ;
- **Documents** : ajout, remplacement, aperçu, téléchargement, suppression
  logique, restauration et historique propre à chaque document ;
- **Validation** : préparation des fichiers, soumission et décision sur une
  version ;
- **Historique** : versions soumises et transitions du cycle de vie ;
- **Liens** : tâche principale, sous-tâches et conversations associées.

La séparation entre **Validation** et **Historique** évite de mélanger les
actions en attente avec la consultation des décisions passées.

La validation est facultative et doit être activée explicitement sur chaque
livrable. Elle ne peut être demandée que lorsque le livrable est finalisé : la
demande référence directement l'instantané immuable créé lors de cette
finalisation. Une demande encore en attente doit être annulée avec un motif
avant de pouvoir désactiver la validation. L'activation, la désactivation et
l'annulation restent visibles dans l'historique.

Le dernier instantané approuvé reste référencé séparément de l'instantané
courant. Après réouverture, une absence de modification conserve donc l'état
approuvé ; toute divergence documentaire rend la validation obsolète. Un retour
exact aux versions approuvées restaure l'état approuvé sans créer une décision
artificielle.

## Fichiers et versions

Un livrable est composé de documents possédant chacun un identifiant permanent,
un format, un fichier courant et un historique indépendant. Ajouter ou modifier
un document crée sa propre version sans incrémenter celles des autres documents.
Une restauration crée une nouvelle version référant la version historique
d'origine ; elle ne réécrit jamais l'historique. La suppression d'un document
est logique et réversible.

Les fichiers de travail sont dans le workspace principal permanent :
`/workspaces/<id-projet>/livrables/<id-livrable>/`. Renommer le projet ou la fiche
ne change pas ce chemin. On peut importer/remplacer ces fichiers ou soumettre
des fichiers existants dans les workspaces rattachés au projet.

La soumission historique héritée crée une copie séparée dans
`.mergeron/history/deliverables/<id-livrable>/<id-version>/` du principal.
Une version comprend de 1 à 10 fichiers, de 100 Mio maximum chacun, avec un total
de 200 Mio maximum. Une empreinte SHA-256 détecte les modifications extérieures
avant téléchargement ou validation. Les dossiers réservés et les fichiers hors
des workspaces du projet ne peuvent pas servir de sources.

Une personne valide ou refuse explicitement la version. Préparer ou soumettre
une nouvelle version conserve la version validée de référence précédente.
Le nom du validateur et la date sont conservés dans les métadonnées.

Supprimer une fiche ou son gestionnaire retire les métadonnées et les associations,
mais conserve les fichiers de travail et les copies de versions sur disque.
Ces fichiers ne sont pas automatiquement réimportés lors d’une recréation.
La suppression du projet suit les choix existants de suppression des workspaces.

## Cycle de vie documentaire

Le cycle de vie est indépendant de l'ancien état de production et de la
validation. Un livrable commence en **Brouillon**. L'ajout du premier document
le place en **En constitution**. Il peut ensuite être finalisé explicitement,
rouvert pour modification, archivé, puis désarchivé.

La finalisation exige au moins un document courant. Elle enregistre un
instantané immuable composé des identifiants des documents, de leurs versions et
de leurs empreintes SHA-256. Un livrable finalisé doit être rouvert avant toute
modification documentaire. Un livrable archivé est en lecture seule ; son
désarchivage le replace d'abord dans l'état finalisé.

Les états de validation — non requise, en attente, approuvée, refusée ou
obsolète — restent indépendants du cycle de vie. Une approbation ou un refus ne
peut être créé que par une décision humaine explicite sur une demande active.

Chaque transition conserve l'état de départ et d'arrivée, l'auteur, la date et
l'instantané éventuellement créé. Le livrable peut être renommé depuis son
en-tête tant qu'il n'est pas archivé.

## Migration et sauvegarde

La migration SQLite 0032 ajoute les fiches, anciennes versions groupées et
contraintes d’unicité des gestionnaires. La migration 0039 introduit les
documents et leurs versions indépendantes. Elle convertit les anciennes copies
en regroupant les entrées portant le même chemin source, sans supprimer les
données historiques. La migration 0040 ajoute le cycle de vie, ses événements et
les instantanés de finalisation. Les anciens livrables validés deviennent
finalisés avec un instantané de migration ; les autres sont convertis en
brouillon ou en constitution selon leur état antérieur. La migration 0041 ajoute
la tâche principale et reprend comme tâche principale le premier lien historique
lorsqu’il désigne une tâche principale valide du même projet. Aucun gestionnaire
de livrables n’est créé automatiquement.

Sauvegarder ensemble la base SQLite et le workspace principal, y compris
`.mergeron/history`, pour conserver métadonnées, copies et version de référence.
