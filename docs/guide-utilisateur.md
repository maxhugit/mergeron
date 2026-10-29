# Guide utilisateur intégré

Le guide de la plateforme est une aide HTML organisée comme un sommaire CHM,
pas un fichier Windows `.chm`. La route `/help` présente une arborescence de
chapitres et articles, un moteur de recherche local et une lecture séparée.
Les conversations simples et les agents de travail ont des chapitres distincts.

## Sources et organisation

- Interface : [help-route.tsx](../web/src/routes/help-route.tsx).
- Articles français : [manual.fr.json](../web/src/components/guide/manual.fr.json).
- Articles anglais : [manual.en.json](../web/src/components/guide/manual.en.json).
- Modèle, index et recherche : [guide-content.ts](../web/src/components/guide/guide-content.ts).
- Libellés de navigation : espaces de traduction `guide` français et anglais.
- Captures existantes : `web/public/guide`, produites avec des composants réels
  et des données d’exemple par le test de captures.

Les identifiants d’article sont communs aux deux langues et servent aux liens
`/help#guide/<identifiant>`. Ne pas les renommer sans maintenir les liens déjà
partagés. Les liens « Voir aussi » sont vérifiés dans les deux catalogues.

La recherche indexe titre, résumé, mots-clés, titres de sections, procédures,
commandes et précautions. Tous les termes doivent être présents ; casse et
accents sont ignorés. Les correspondances dans le titre sont mieux classées.
La recherche ne transmet aucune requête au serveur ou à un fournisseur IA et
ne consulte pas les données des projets. Les deux manuels sont chargés avec
la route d’aide différée, pas avec l’écran d’accueil.

## Mettre à jour l’aide avec une fonctionnalité

Lorsqu’une interface ou un comportement change :

1. Vérifier les commandes et contrôles réellement disponibles dans le code.
2. Modifier les articles concernés dans les deux langues : point d’entrée,
   prérequis et droits, procédure, effets des commandes, résultat attendu,
   erreurs et conséquences d’un arrêt ou d’une suppression.
3. Distinguer les fonctionnalités disponibles des limites et fonctions non
   implémentées. Ne pas transformer une promesse en mode d’emploi.
4. Ajouter des mots-clés usuels et des liens vers les fonctions connexes.
5. Actualiser les captures lorsqu’elles ne représentent plus les contrôles.
   Utiliser des exemples, jamais une session contenant des secrets.
6. Exécuter les tests de contenu, de navigation et de rendu responsive, ainsi
   que les vérifications de traduction et de poids du frontend.

## Vérifications

Les tests `guide-content.spec.ts` contrôlent les identifiants, les liens,
la parité des langues, les précautions et la recherche. `help-route.spec.tsx`
teste la séparation des chapitres, la navigation, les liens directs et les
résultats de recherche. `guide-captures.browser.tsx` vérifie les dimensions,
le défilement indépendant et le parcours recherche → article dans Chromium.

Le guide décrit la plateforme ; sa consultation ne donne aucun droit sur
les fonctions documentées. Les contrôles du serveur restent la référence.

## Rattrapage documentaire du 28 octobre 2026

Le guide a été créé avec la PR #222, puis complété dans les PR #226, #229
et #232. Ce rattrapage vérifie aussi les changements antérieurs à sa dernière
modification : il couvre les 28 PR fusionnées après la version `v0.4.0`
(`3c95dbf`, PR #214), jusqu'à `54fc34e` (PR #241). Les numéros ci-dessous
proviennent de l'historique Git de `main` ; les fonctionnalités sont recoupées
avec le code et leurs guides spécialisés.

| PR               | Évolution et traitement dans le guide intégré FR/EN                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #215, #216, #217 | Navigateur isolé en direct, premier chargement et contrôle : procédure et limites dans `browser-live`, pointage dans `browser-annotation`.                                                                |
| #218, #219       | Réglages du navigateur par projet et persistance des vues : nouvelles sessions, retour sans rechargement, expiration et reprise explicite dans `browser-live`.                                            |
| #220             | Renommage des documents : article `document-rename` existant conservé, avec historique indépendant.                                                                                                       |
| #222, #223       | Guide et correction de sa navigation : sommaire, recherche locale, liens directs et parcours précédent/suivant expliqués dans `desktop`. Identifiants historiques conservés.                              |
| #213             | PR depuis une branche distante publiée sans copie locale : procédure ajoutée dans `git-pr`.                                                                                                               |
| #221, #227       | Contexte minimal, outils projet et renommage de l'agent : `agent-knowledge`, nouvel article `agent-project-tools`, droits et référence d'administration MCP interne.                                      |
| #224, #225       | Joindre les documents au chat et menus regroupés : `deliverable-versions` et `file-explorer`, avec vérification du brouillon avant envoi.                                                                 |
| #226             | Préparation du commit dans l'explorateur, affichage compact et dossier du livrable : contenu existant de `git-local`, `agent-composer` et `agent-create` conservé, menus de fichiers précisés.            |
| #228, #233       | Extension Chrome/Edge et Safari Mac : nouvel article `browser-local`, installation temporaire Safari, association, lecture, consentement, suspension et limites.                                          |
| #229             | Chat et Audio : `simple-chat` et `admin-chat` corrigés ; choix indépendants, héritage initial audio, dictée CLI expérimentale et absence de repli API. `voice-dictation` déjà actualisé conservé.         |
| #230             | Détection et mises à jour individuelles des images : `server-update` et `infrastructure` corrigés ; arrêt de toute la pile, états inconnus, migration d'image locale et Manager administré depuis l'hôte. |
| #231             | Durcissement de l'image navigateur et contrôles CI : pas de nouvelle commande utilisateur ; protections du navigateur conservées.                                                                         |
| #232             | Suppression du projet et de son espace système : procédure et avertissements existants de `project-archive` conservés.                                                                                    |
| #234             | Suivi préchargé avant l'arrêt et ancien suivi dépassé : procédure de `server-update` complétée.                                                                                                           |
| #235             | Dialogue d'emplacement adapté à la fenêtre : procédure de `locations` inchangée, aucune nouvelle action à apprendre.                                                                                      |
| #236             | Parallélisation CI et isolation des caches : pas de modification du parcours utilisateur.                                                                                                                 |
| #237             | Extension 0.4.0, capture vers le champ normal du chat et association compacte : `browser-local` et `browser-annotation`, conservation du texte et envoi manuel.                                           |
| #238             | Vérifications visuelles dans les workspaces : nouvel article `agent-visual-checks`, vrai site, captures ordinateur/mobile, examen et limites.                                                             |
| #239, #241       | Association Git des agents neufs sans reprise d'un historique absent : `agent-create` complété pour le travail avant le premier message.                                                                  |
| #240             | Consignes communes persistantes : nouvel article `admin-agent-instructions`, bouton indépendant, portée au prochain échange, texte vide et restauration du brouillon.                                     |

Les nouveaux articles sont reliés aux articles existants dans les deux langues.
Les captures de tâches et de cycle des livrables restent valides : les contrôles
qu'elles illustrent n'ont pas changé dans cette série. Les captures de contrôle
du rendu du guide sont des artefacts de test dans `artifacts/visual-check` ;
elles ne font pas partie des fichiers à publier dans Git.
