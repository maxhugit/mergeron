# Interface des paramètres d’un projet

Les sept onglets existants sont conservés. Le cadre reprend celui des paramètres Codex : navigation ou en-tête fixe, une zone de contenu défilante et des actions ancrées au bas du panneau. Le bas de page appartient au panneau, sans recouvrir les champs sur mobile.

## Correspondance des champs et actions

| Onglet | Organisation | Champs, informations et opérations conservés |
| --- | --- | --- |
| Informations générales | En-tête fixe, sans sous-onglets | Nom du projet, nombre d’espaces, agents actifs, gestionnaires de tâches et ressources ; liste des espaces, chemins et espace principal ; dates de création et modification. |
| Personnes | Organisation / Participants | Chef de projet et absence de responsable ; groupes, noms, membres actifs, création, modification et suppression avec confirmation ; recherche de personnes, identité, rôle, statut, affectations, ajout et retrait avec confirmation et actions de personne existantes. Les fenêtres existantes sont réutilisées. |
| Journal | En-tête et filtre fixes | Opérations, changements avant/après, libellé, auteur et date ; filtre par personne, états vide, indisponible et chargement. |
| Gestion des agents | Configuration / Connaissances partagées / Propositions / Intégrations | Modèle, défaut du serveur et modèles masqués ; effort et défaut du modèle ; AGENTS.md, CONNAISSANCES.md, DECISIONS.md, chemin, compteur UTF-8, rechargement et sauvegarde avec révision ; propositions détaillées directement, source, état, auteur/date de revue, contenu avant/après, modification, acceptation et rejet, rechargement et pagination ; connecteurs MCP, outils et activation ; applications et activation ; sauvegardes séparées du modèle, des connecteurs et des applications. |
| Navigateur | En-tête fixe, sans sous-onglets | URL d’accueil, vue scindée sur ordinateur, fenêtres secondaires, indication du comportement mobile et de l’application aux sessions suivantes ; sauvegarde, annulation locale, état et erreur. |
| Emplacements et connexions | Espaces locaux / Ressources externes | Espace principal permanent ; secondaires, chemins et agents associés ; ajout local ou Git/SSH/SFTP/FTPS/FTP ; détachement sans suppression des fichiers ; état et test des connexions, activation, désactivation, modification du nom et du jeton Git, création et suppression des copies, transferts existants. Tous les dialogues et contrôles de droits existants sont conservés. |
| Environnement de test | Exécution / Ressources et durée / Configuration avancée | Domaine et disponibilité du service ; activation projet, gestion par les agents, technologies autorisées ; runtime manuel, dossier, installation, compilation, démarrage, port, page, mode de synchronisation ; durée (y compris Jamais et anciennes durées), mémoire et CPU ; limites de stockage fournies par le serveur et isolation ; variables JSON avec valeurs masquées et services JSON ; sauvegarde avec révision, annulation locale, succès et erreurs. |

## Brouillons et propositions

Les changements de sous-onglet conservent les champs montés et leurs brouillons. Le rechargement de la liste des projets ne remonte plus le panneau uniquement parce que la date de modification du projet change. Les brouillons de connaissances gardent leur révision d’origine et restent protégés en cas de conflit.

Les propositions n’ont plus de bouton « Examiner / Fermer » : chaque proposition de la page charge et affiche son avant/après. Chaque proposition possède son propre brouillon, associé à sa version. Une proposition modifiée doit être enregistrée avant acceptation ; une proposition périmée ou un brouillon manuel non enregistré bloque l’acceptation. Les erreurs ne remplacent pas le texte saisi. Les actions de revue restent auprès de leur proposition pour éviter toute ambiguïté lorsque plusieurs propositions sont visibles ; le rechargement et la pagination sont dans le pied fixe.

Les mêmes permissions s’appliquent : un participant conserve ses accès de lecture ; les écritures et opérations réservées aux administrateurs ne deviennent pas accessibles par le réagencement. Le backend et les formats de requête ne changent pas.

## Vérification

Les tests couvrent les sept onglets dans Chromium et WebKit à 320, 390 et 1 100 pixels, la navigation, les zones fixes, les champs de mémoire et leurs brouillons, plusieurs propositions affichées simultanément, les catalogues et les sauvegardes du navigateur et du profil de test avec valeurs masquées. Les tests existants de groupes, participants, connexions, conflits et permissions complètent cet inventaire.
