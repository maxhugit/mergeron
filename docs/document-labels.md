# Documents, étiquettes et versions

L’onglet **Documents** d’un livrable présente des dossiers virtuels : une étiquette
regroupe des documents sans déplacer leurs fichiers. Un document peut porter
plusieurs étiquettes ; son identité, ses liens et son historique restent uniques.

- **Gérer les étiquettes** permet de créer une étiquette et de la supprimer.
  Une suppression affiche une confirmation lorsque des documents l’utilisent :
  l’étiquette leur sera retirée, sans supprimer de document ni de version.
- Les actions d’un document permettent de choisir ses étiquettes. Glisser une
  ligne vers un dossier virtuel lui ajoute cette étiquette.
- Déposer des fichiers dans la zone d’ajout crée des documents. Un nom déjà
  présent est traité comme une nouvelle version, après confirmation. Déposer
  un fichier sur une ligne crée une version de ce document, en conservant son
  nom et son format. Le serveur vérifie le numéro de version attendu.

## Organisation avec l’IA

Un administrateur peut demander une **proposition d’organisation IA**, même sans
étiquettes existantes. L’IA utilise les noms, formats et étiquettes des documents,
pas leur contenu. La proposition présente les étiquettes à créer, conserver ou
supprimer et le classement de chaque document. Elle doit être validée avant
application. Si un document ou son classement a changé, elle n’est pas appliquée.

Configurer les étiquettes en tant qu’administrateur autorise le classement
automatique sous son identité. Après une affectation, un renommage ou une nouvelle
version, une tâche en arrière-plan peut revoir les étiquettes du document. Elle
peut uniquement utiliser les étiquettes existantes, sans les créer, renommer ou
supprimer. Les droits de l’administrateur sont revérifiés au début et à la fin.
Si ce compte devient inactif ou perd son rôle, la tâche échoue sans modifier le
classement. Les modifications sont inscrites dans l’historique du livrable.

L’inférence utilise le Codex CLI déjà configuré, dans un tour éphémère en lecture
seule. La réponse structurée est validée côté serveur ; aucun chemin ni commande
n’est accepté comme opération de classement. Le traitement est borné et sérialisé.
Un échec ou un redémarrage interrompant une tâche est enregistré ; les documents
et le classement existant sont conservés. L’interface signale les traitements en
cours, les erreurs et les propositions devenues obsolètes.

## Explorateur d’un agent

Dans le répertoire `livrables` ou le dossier d’un livrable, le sélecteur d’affichage
permet de choisir la liste de fichiers habituelle ou les dossiers d’étiquettes.
Les dossiers virtuels s’ouvrent et se ferment. Un document multi-étiqueté apparaît
dans chaque dossier correspondant, mais toutes les actions utilisent son chemin
réel et son historique unique. Les fichiers sans étiquette restent accessibles.
Le classement est conservé dans les sauvegardes et les exports de projet. Lors
d’un import, les affectations sont rattachées aux nouvelles identités des documents ;
l’autorisation de lancer l’IA doit être rétablie par un administrateur.

Le choix de vue est conservé sur le serveur par personne et par agent : il est
retrouvé sur un autre navigateur et n’affecte pas les autres personnes ou agents.

## Versionnement et suppression

Les publications d’un agent restent versionnées même s’il n’est pas lié au
livrable : le catalogue de publication dépend de son projet. Un contrôle de fin
de tour détecte aussi les changements de contenu des sources déjà enregistrées
et les conserve comme versions. Ces changements détectés sont explicitement
marqués comme observations, sans attribuer de façon exclusive une modification
lorsque plusieurs intervenants travaillent simultanément. Les copies de travail
extérieures au livrable restent des brouillons tant qu’elles ne sont pas
explicitement enregistrées. Les protections des fichiers conservés restent actives.

Le menu d’actions permet de supprimer la fiche d’un livrable. Pour les états
**Finalisé** et **Archivé**, cette action est réservée à un administrateur. La
confirmation précise que les fichiers sont conservés ; les enregistrements et
leur historique de gestion sont supprimés, conformément à l’action existante.

Dans une tâche principale existante sans livrable, cliquer sur **Aucun livrable
associé** permet de rattacher un livrable modifiable sans tâche principale, ou de
créer un nouveau livrable directement associé. Le serveur contrôle le projet,
l’état de la tâche et les associations existantes avant l’enregistrement.
