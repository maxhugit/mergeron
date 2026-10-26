# Emplacements d’exécution des agents — PR 3/4

## Choix explicite

Le sélecteur de dossier de la conversation envoie un identifiant normalisé
`local:<id>` à `PUT /api/projects/:id/agents/:threadId`. L’API accepte aussi un
chemin relatif contenu dans cet emplacement. Les anciens appels `resourceId` et
`workspacePath` restent compatibles, mais subissent les mêmes validations côté
serveur. Les sélections ambiguës sont refusées, sans repli automatique.

Un emplacement autorisé pour l’exécution est un dossier local rattaché au même
projet, cohérent avec le modèle normalisé, présent et valide sur le disque. Une
connexion Git/SSH/SFTP/FTP distante n’est pas un dossier d’exécution. Une copie
locale explicite reste nécessaire. Les emplacements de projets différents ne
sont pas interchangeables. Le dossier d’une tâche liée reste prioritaire sur le
dossier par défaut de sa conversation, comme auparavant.

## Contrôles appliqués aux conversations existantes

Les contrôles sont effectués à la création, à la reprise et avant chaque tour :

- dossier existant et confinement du chemin relatif ;
- absence de composant symbolique dans le dossier relatif ;
- refus des alias vers un projet, y compris si le dernier composant manque,
  plutôt que de les traiter comme une exécution sans projet ;
- cohérence entre l’emplacement normalisé, son dossier historique et son projet ;
- copie prête et connexion source toujours rattachée au même projet et activée ;
- lecture seule de la source ou de l’emplacement maintenue même si le client
  demande l’accès complet.

Une référence invalide ou révoquée bloque la nouvelle opération ; elle ne choisit
ni l’espace principal ni les outils globaux. La lecture des intégrations MCP est
précédée du contrôle d’emplacement et suivie d’une nouvelle vérification. Une
vérification finale est aussi faite après la préparation asynchrone, juste avant
l’envoi natif. L’identité d’emplacement, la révision source, le dossier effectif
et la lecture seule participent à l’empreinte de session : un ancien contexte
natif n’est pas réutilisé après leur changement. Le mécanisme existant exige un
état inactif avant de remplacer ce contexte.

Le journal d’exécution conserve les anciens identifiants et ajoute `locationId`.
Les protections de publication versionnée et les restrictions MCP du projet ne
sont pas remplacées ni assouplies.

## Limites et transition

Cette PR contrôle le **contexte d’exécution** et conserve les droits existants ;
elle n’ajoute pas une matrice d’ACL par personne/agent ni une nouvelle isolation
de tout le système de fichiers en mode accès complet. Le périmètre de fichiers
effectivement accessible reste régi par les protections et le sandbox existants.
Les documents publiés conservent leur protection spécifique, y compris en accès
complet. Une révocation bloque les prochaines opérations ; elle n’interrompt
pas de force un tour déjà en cours et n’annule pas ses effets passés.

L’explorateur peut naviguer sans modifier le dossier actif. Les conversions
complètes de l’explorateur, des transferts, de Git et de l’import/export restent
dans la PR4. Aucune nouvelle migration ni déplacement de données n’est requis
ici ; les écritures historiques et la synchronisation ajoutée par la PR2 restent
en place.
